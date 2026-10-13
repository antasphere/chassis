import { button, esc, fine, fmtDate, makeShell, para, spelledLink, type MailBrand } from '../email/shell.js';

/**
 * The one mail of the webhooks: an endpoint was switched off after failing
 * for days, sent once to the person who registered it. Env-free like the
 * account mails (`email/templates.ts`): every value arrives as a parameter,
 * so a tool's mail wall renders it standalone.
 */
export interface WebhookDisabledEmailParams {
  brand: MailBrand;
  recipientName: string;
  url: string;
  description: string;
  workspaceName: string;
  consecutiveFailures: number;
  firstFailureAt: Date;
  /** The endpoint on its page in the dashboard: where it is re-enabled. */
  manageUrl: string;
}

export function buildWebhookDisabledEmail(p: WebhookDisabledEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const name = p.brand.name;
  const what = p.description ? `${p.description} (${p.url})` : p.url;
  const subject = `A webhook of ${p.workspaceName} was switched off`;
  const html = makeShell(p.brand)({
    preheader: `${what} has not accepted a delivery since ${fmtDate(p.firstFailureAt)}.`,
    eyebrow: 'Webhooks',
    title: 'A webhook was switched off',
    body:
      para(
        `${esc(name)} has stopped delivering to <strong>${esc(what)}</strong>, a webhook of
         <strong>${esc(p.workspaceName)}</strong>: every delivery since ${fmtDate(p.firstFailureAt)}
         failed, ${p.consecutiveFailures} in a row.`
      ) +
      para(
        'The deliveries it missed are kept on its page. Once the receiver answers again, switch the webhook back on there and redeliver what matters.'
      ) +
      button(p.manageUrl, 'Open the webhook') +
      fine(`You receive this because you registered the webhook, ${esc(p.recipientName)}.`) +
      spelledLink(p.manageUrl)
  });
  const text = `${name} has stopped delivering to ${what}, a webhook of ${p.workspaceName}: every delivery since ${fmtDate(p.firstFailureAt)} failed, ${p.consecutiveFailures} in a row.\n\nOpen the webhook: ${p.manageUrl}\n\nThe deliveries it missed are kept on its page. Once the receiver answers again, switch the webhook back on there and redeliver what matters.`;
  return { subject, html, text };
}
