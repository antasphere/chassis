import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmailDriver, type EmailMessage } from '@antasphere/chassis-server/email';
import type { Logger } from '@antasphere/chassis-server/logger';

const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

/** The factory takes a Pick of Env, so the tests build exactly that shape. */
type FactoryEnv = Parameters<typeof createEmailDriver>[0];
const env = (over: Partial<FactoryEnv> = {}): FactoryEnv => ({ EMAIL_DRIVER: 'none', ...over }) as FactoryEnv;

describe('createEmailDriver', () => {
  it('defaults to the none driver, which never delivers', () => {
    const driver = createEmailDriver(env(), logger);
    expect(driver.name).toBe('none');
    expect(driver.delivers).toBe(false);
  });

  it('builds each delivering driver when its credential and sender are present', () => {
    const from = 'Slideless <noreply@example.com>';
    expect(
      createEmailDriver(env({ EMAIL_DRIVER: 'smtp', SMTP_URL: 'smtp://h:25', EMAIL_FROM: from }), logger).name
    ).toBe('smtp');
    expect(
      createEmailDriver(env({ EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_x', EMAIL_FROM: from }), logger)
        .name
    ).toBe('resend');
    const brevo = createEmailDriver(
      env({ EMAIL_DRIVER: 'brevo', BREVO_API_KEY: 'xkeysib-x', EMAIL_FROM: from }),
      logger
    );
    expect(brevo.name).toBe('brevo');
    expect(brevo.delivers).toBe(true);
  });

  // A driver that boots without its credential would fail at the first send,
  // which is the flow a user is waiting on; it must fail at boot instead.
  it('refuses a delivering driver that is missing its credential or its sender', () => {
    const from = 'Slideless <noreply@example.com>';
    expect(() => createEmailDriver(env({ EMAIL_DRIVER: 'brevo', EMAIL_FROM: from }), logger)).toThrow(
      'EMAIL_DRIVER=brevo requires BREVO_API_KEY'
    );
    expect(() =>
      createEmailDriver(env({ EMAIL_DRIVER: 'brevo', BREVO_API_KEY: 'xkeysib-x' }), logger)
    ).toThrow('EMAIL_DRIVER=brevo requires EMAIL_FROM');
    expect(() => createEmailDriver(env({ EMAIL_DRIVER: 'resend', EMAIL_FROM: from }), logger)).toThrow(
      'EMAIL_DRIVER=resend requires RESEND_API_KEY'
    );
    expect(() => createEmailDriver(env({ EMAIL_DRIVER: 'smtp', EMAIL_FROM: from }), logger)).toThrow(
      'EMAIL_DRIVER=smtp requires SMTP_URL'
    );
  });
});

describe('the brevo driver on the wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const send = async (
    from: string,
    response: Response,
    message: EmailMessage = { to: 'her@example.com', subject: 'Subject', html: '<p>Body</p>' }
  ) => {
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    const driver = createEmailDriver(
      { EMAIL_DRIVER: 'brevo', BREVO_API_KEY: 'xkeysib-secret', EMAIL_FROM: from } as FactoryEnv,
      logger
    );
    const result = await driver.send(message).then(
      () => null,
      (error: Error) => error
    );
    return { result, fetchMock };
  };

  it('posts the message to Brevo with the key in the api-key header', async () => {
    const { result, fetchMock } = await send(
      'Slideless <noreply@example.com>',
      new Response('{}', { status: 201 })
    );
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-secret');
    const body = JSON.parse(init.body as string);
    // `Name <addr>` is split into Brevo's own sender shape.
    expect(body.sender).toEqual({ name: 'Slideless', email: 'noreply@example.com' });
    expect(body.to).toEqual([{ email: 'her@example.com' }]);
    expect(body.subject).toBe('Subject');
    expect(body.htmlContent).toBe('<p>Body</p>');
    // An absent text part is omitted, never sent as undefined/null.
    expect('textContent' in body).toBe(false);
  });

  it('passes a bare sender address through and carries the text part when there is one', async () => {
    const { fetchMock } = await send('noreply@example.com', new Response('{}', { status: 201 }), {
      to: 'her@example.com',
      subject: 'Subject',
      html: '<p>Body</p>',
      text: 'Body'
    });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.sender).toEqual({ email: 'noreply@example.com' });
    expect(body.textContent).toBe('Body');
  });

  // The response body names the reason and may echo the request, so it must not
  // reach the thrown message a caller could relay onward.
  it('maps a refusal to its cause without leaking the response body', async () => {
    const leak = 'unverified sender her@example.com and xkeysib-secret';
    const cases: [number, string][] = [
      [401, 'brevo: authentication failed'],
      [429, 'brevo: rate limited'],
      [503, 'brevo: temporarily unavailable'],
      [400, 'brevo: refused the message (400)']
    ];
    for (const [status, expected] of cases) {
      const { result } = await send('noreply@example.com', new Response(leak, { status }));
      expect(result?.message).toBe(expected);
      expect(result?.message).not.toContain('xkeysib-secret');
      expect(result?.message).not.toContain('her@example.com');
    }
  });
});
