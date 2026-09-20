/**
 * Transactional email builders. Env-free by design (ported convention from
 * a predecessor template): every env-dependent value (urls, names) arrives as
 * a parameter, so a preview script can render these standalone. The PRODUCT'S
 * NAME is one of them (`productName`, the tool's `identity.displayName`): the
 * chassis spells no product, and the shell takes the name as a parameter too.
 */

/** User-controlled values never reach email HTML unescaped. */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The layout every mail shares, for one product: `makeShell({ name })(title, bodyHtml)`. */
export const makeShell = (product: { name: string }) => (title: string, bodyHtml: string) => `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#18181b;padding:20px 32px">
  <span style="color:#ffffff;font-size:16px;font-weight:600">${product.name}</span>
</td></tr>
<tr><td style="padding:32px">
  <h1 style="margin:0 0 16px;font-size:20px;color:#18181b">${title}</h1>
  ${bodyHtml}
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e4e4e7">
  <span style="color:#a1a1aa;font-size:12px">${product.name}</span>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

export interface InviteEmailParams {
  /** The product's name, as the mail says it (`identity.displayName`). */
  productName: string;
  inviteeEmail: string;
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
  expiresAt: Date;
}

export function buildInviteEmail(p: InviteEmailParams): { subject: string; html: string; text: string } {
  const subject = `${p.inviterName} invited you to ${p.workspaceName}`;
  const html = makeShell({ name: p.productName })(
    `Join ${esc(p.workspaceName)}`,
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       ${esc(p.inviterName)} invited you (${esc(p.inviteeEmail)}) to join
       <strong>${esc(p.workspaceName)}</strong> on ${p.productName}.</p>
     <p style="margin:0 0 24px">
       <a href="${p.acceptUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Accept invitation</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       This link expires on ${p.expiresAt.toUTCString()}. If the button does not work, open:<br>
       <span style="word-break:break-all">${p.acceptUrl}</span></p>`
  );
  const text = `${p.inviterName} invited you to join ${p.workspaceName} on ${p.productName}.\n\nAccept: ${p.acceptUrl}\n\nExpires ${p.expiresAt.toUTCString()}.`;
  return { subject, html, text };
}

export interface PasswordResetEmailParams {
  /** The product's name, as the mail says it (`identity.displayName`). */
  productName: string;
  resetUrl: string;
  expiresAt: Date;
}

export function buildPasswordResetEmail(p: PasswordResetEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Reset your ${p.productName} password`;
  const html = makeShell({ name: p.productName })(
    'Reset your password',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       We received a request to reset your ${p.productName} password. Click below to choose a new one.</p>
     <p style="margin:0 0 24px">
       <a href="${p.resetUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Reset password</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       This link expires on ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email —
       your password stays unchanged.<br>
       <span style="word-break:break-all">${p.resetUrl}</span></p>`
  );
  const text = `Reset your ${p.productName} password: ${p.resetUrl}\n\nExpires ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email.`;
  return { subject, html, text };
}

export interface ChangeEmailConfirmEmailParams {
  /** The product's name, as the mail says it (`identity.displayName`). */
  productName: string;
  newEmail: string;
  confirmUrl: string;
  expiresAt: Date;
}

/** To the OLD address: a verified user must confirm the change first (two-leg flow). */
export function buildChangeEmailConfirmEmail(p: ChangeEmailConfirmEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Confirm your ${p.productName} email change`;
  const html = makeShell({ name: p.productName })(
    'Confirm your email change',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       We received a request to change your ${p.productName} email to
       <strong>${esc(p.newEmail)}</strong>. Confirm below — a verification link will then be
       sent to the new address.</p>
     <p style="margin:0 0 24px">
       <a href="${p.confirmUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Confirm email change</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       This link expires on ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email —
       your address stays unchanged.<br>
       <span style="word-break:break-all">${p.confirmUrl}</span></p>`
  );
  const text = `Confirm changing your ${p.productName} email to ${p.newEmail}: ${p.confirmUrl}\n\nExpires ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email.`;
  return { subject, html, text };
}

export interface VerifyEmailEmailParams {
  /** The product's name, as the mail says it (`identity.displayName`). */
  productName: string;
  verifyUrl: string;
  expiresAt: Date;
}

/** To the NEW address: the final leg of every email change (and any plain verification). */
export function buildVerifyEmailEmail(p: VerifyEmailEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Verify your ${p.productName} email address`;
  const html = makeShell({ name: p.productName })(
    'Verify your email address',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       Click below to verify this address for your ${p.productName} account.</p>
     <p style="margin:0 0 24px">
       <a href="${p.verifyUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Verify email</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       This link expires on ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email.<br>
       <span style="word-break:break-all">${p.verifyUrl}</span></p>`
  );
  const text = `Verify your ${p.productName} email address: ${p.verifyUrl}\n\nExpires ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email.`;
  return { subject, html, text };
}

export interface OtpEmailParams {
  /** The product's name, as the mail says it (`identity.displayName`). */
  productName: string;
  otp: string;
  type: string;
}

export function buildOtpEmail(p: OtpEmailParams): { subject: string; html: string; text: string } {
  const subject = `${p.otp} is your ${p.productName} code`;
  const html = makeShell({ name: p.productName })(
    'Your sign-in code',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px">Enter this code to continue:</p>
     <p style="margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:6px;
        color:#18181b;border:2px dashed #e4e4e7;border-radius:8px;padding:16px;text-align:center">${p.otp}</p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">If you did not request this, ignore this email.</p>`
  );
  const text = `Your ${p.productName} code: ${p.otp}`;
  return { subject, html, text };
}
