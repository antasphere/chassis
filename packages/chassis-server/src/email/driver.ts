import type { Logger } from '../logger.js';
import type { Env } from '../env.js';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailDriver {
  readonly name: 'none' | 'smtp' | 'resend' | 'brevo';
  /** True when this driver actually delivers mail. */
  readonly delivers: boolean;
  send(message: EmailMessage): Promise<void>;
}

/**
 * Default driver: no SMTP required, ever. Flows that would email (invitations,
 * OTP) must always offer a copyable-link alternative; this driver just logs.
 */
class NoneDriver implements EmailDriver {
  readonly name = 'none' as const;
  readonly delivers = false;
  constructor(private readonly logger: Logger) {}
  async send(message: EmailMessage): Promise<void> {
    this.logger.info({ to: message.to, subject: message.subject }, 'email driver=none: not sending');
  }
}

class SmtpDriver implements EmailDriver {
  readonly name = 'smtp' as const;
  readonly delivers = true;
  // Loaded lazily so the none/resend paths never import nodemailer.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  private transporterPromise: Promise<import('nodemailer').Transporter> | null = null;
  constructor(
    private readonly url: string,
    private readonly from: string
  ) {}
  private transporter() {
    this.transporterPromise ??= import('nodemailer').then((m) => m.default.createTransport(this.url));
    return this.transporterPromise;
  }
  async send(message: EmailMessage): Promise<void> {
    const t = await this.transporter();
    await t.sendMail({ from: this.from, ...message });
  }
}

class ResendDriver implements EmailDriver {
  readonly name = 'resend' as const;
  readonly delivers = true;
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  private clientPromise: Promise<import('resend').Resend> | null = null;
  constructor(
    private readonly apiKey: string,
    private readonly from: string
  ) {}
  private client() {
    this.clientPromise ??= import('resend').then((m) => new m.Resend(this.apiKey));
    return this.clientPromise;
  }
  async send(message: EmailMessage): Promise<void> {
    const client = await this.client();
    const { error } = await client.emails.send({ from: this.from, ...message });
    if (error) throw new Error(`resend: ${error.message}`);
  }
}

/**
 * Brevo over its REST API, no SDK: the endpoint takes one JSON body and answers
 * 2xx or an error, and a dependency buys nothing on top of that. Brevo is the
 * house provider across the Antasphere templates (PRDCT-2431); `resend` and
 * `smtp` stay supported for the instances already on them.
 */
class BrevoDriver implements EmailDriver {
  readonly name = 'brevo' as const;
  readonly delivers = true;
  constructor(
    private readonly apiKey: string,
    private readonly from: string
  ) {}
  async send(message: EmailMessage): Promise<void> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        sender: parseSender(this.from),
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        ...(message.text ? { textContent: message.text } : {})
      })
    });
    if (res.ok) return;
    // The body names the reason (bad key, unverified sender, malformed
    // recipient) and may echo the request, so it never reaches the thrown
    // message a caller might relay onward.
    if (res.status === 401) throw new Error('brevo: authentication failed');
    if (res.status === 429) throw new Error('brevo: rate limited');
    if (res.status >= 500) throw new Error('brevo: temporarily unavailable');
    throw new Error(`brevo: refused the message (${res.status})`);
  }
}

/** `Name <addr>` → Brevo's split `{ name, email }`; a bare address passes through. */
function parseSender(from: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(from);
  if (!match) return { email: from.trim() };
  const [, name, email] = match;
  return name ? { name, email: email!.trim() } : { email: email!.trim() };
}

export function createEmailDriver(
  env: Pick<Env, 'EMAIL_DRIVER' | 'SMTP_URL' | 'RESEND_API_KEY' | 'BREVO_API_KEY' | 'EMAIL_FROM'>,
  logger: Logger
): EmailDriver {
  switch (env.EMAIL_DRIVER) {
    case 'smtp':
      if (!env.SMTP_URL) throw new Error('EMAIL_DRIVER=smtp requires SMTP_URL');
      if (!env.EMAIL_FROM) throw new Error('EMAIL_DRIVER=smtp requires EMAIL_FROM');
      return new SmtpDriver(env.SMTP_URL, env.EMAIL_FROM);
    case 'resend':
      if (!env.RESEND_API_KEY) throw new Error('EMAIL_DRIVER=resend requires RESEND_API_KEY');
      if (!env.EMAIL_FROM) throw new Error('EMAIL_DRIVER=resend requires EMAIL_FROM');
      return new ResendDriver(env.RESEND_API_KEY, env.EMAIL_FROM);
    case 'brevo':
      if (!env.BREVO_API_KEY) throw new Error('EMAIL_DRIVER=brevo requires BREVO_API_KEY');
      if (!env.EMAIL_FROM) throw new Error('EMAIL_DRIVER=brevo requires EMAIL_FROM');
      return new BrevoDriver(env.BREVO_API_KEY, env.EMAIL_FROM);
    default:
      return new NoneDriver(logger);
  }
}
