/**
 * The account mails every tool sends: the workspace invitation, the password
 * reset, the two legs of an email change and the sign-in code. Env-free by
 * design (ported convention from a predecessor template): every env-dependent
 * value (urls, names, dates) arrives as a parameter, so a preview script can
 * render these standalone (`pnpm preview:emails` in a tool's server app).
 *
 * The layout and the blocks live in shell.ts; this file holds what the mails
 * SAY. The voice is the product's, not a log's: say what happened, who did it,
 * and the one thing to do next, in the words a person would use.
 *
 * The chassis spells no product. The name and the footer line arrive as the
 * `brand` (`identity.displayName` + `copy.mail.tagline`), and the two phrases
 * of the invitation that say what the tool IS arrive from `copy.mail` too. A
 * tool's own mails (its app's email folder) compose the same shell and blocks.
 */
import {
  button,
  codePlate,
  esc,
  fine,
  fmtDate,
  makeShell,
  para,
  spelledLink,
  type MailBrand
} from './shell.js';

export interface InviteEmailParams {
  /** The product's name and footer line (`identity.displayName`, `copy.mail.tagline`). */
  brand: MailBrand;
  /** What joining gives, in the tool's words (`copy.mail.invitePitch`). */
  pitch: string;
  /** The end of the inbox preview line, after "Join <workspace> on <name>: " (`copy.mail.invitePreheader`). */
  preheader: string;
  inviteeEmail: string;
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
  expiresAt: Date;
}

export function buildInviteEmail(p: InviteEmailParams): { subject: string; html: string; text: string } {
  const name = p.brand.name;
  const subject = `${p.inviterName} invited you to ${p.workspaceName}`;
  const html = makeShell(p.brand)({
    preheader: `Join ${p.workspaceName} on ${name}: ${p.preheader}`,
    eyebrow: 'Invitation',
    title: `${esc(p.inviterName)} wants you in ${esc(p.workspaceName)}`,
    body:
      para(
        `You have been invited to <strong>${esc(p.workspaceName)}</strong>, a workspace on ${esc(name)}.
         ${esc(p.pitch)}`
      ) +
      button(p.acceptUrl, 'Join the workspace') +
      fine(
        `This invitation was sent to ${esc(p.inviteeEmail)} and stays open until ${fmtDate(p.expiresAt)}.`
      ) +
      spelledLink(p.acceptUrl)
  });
  const text = `${p.inviterName} invited you to join ${p.workspaceName} on ${name}.\n\nJoin the workspace: ${p.acceptUrl}\n\nThe invitation stays open until ${fmtDate(p.expiresAt)}.`;
  return { subject, html, text };
}

export interface PasswordResetEmailParams {
  /** The product's name and footer line (`identity.displayName`, `copy.mail.tagline`). */
  brand: MailBrand;
  resetUrl: string;
  expiresAt: Date;
}

export function buildPasswordResetEmail(p: PasswordResetEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const name = p.brand.name;
  const subject = `Reset your ${name} password`;
  const html = makeShell(p.brand)({
    preheader: 'Choose a new password. If you did not ask for this, nothing changes.',
    eyebrow: 'Your account',
    title: 'Let’s get you a new password',
    body:
      para(
        `Someone asked to reset the password of your ${esc(name)} account. If that was you, choose a new one here:`
      ) +
      button(p.resetUrl, 'Choose a new password') +
      fine(
        `The link works until ${fmtDate(p.expiresAt)}. If you did not ask for this, ignore this email: your password stays as it is.`
      ) +
      spelledLink(p.resetUrl)
  });
  const text = `Reset your ${name} password: ${p.resetUrl}\n\nThe link works until ${fmtDate(p.expiresAt)}. If you did not ask for this, ignore this email: your password stays as it is.`;
  return { subject, html, text };
}

export interface ChangeEmailConfirmEmailParams {
  /** The product's name and footer line (`identity.displayName`, `copy.mail.tagline`). */
  brand: MailBrand;
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
  const name = p.brand.name;
  const subject = `Confirm your ${name} email change`;
  const html = makeShell(p.brand)({
    preheader: `You asked to move your account to ${p.newEmail}. Confirm it here.`,
    eyebrow: 'Your account',
    title: 'Moving to a new address?',
    body:
      para(
        `You asked to change the email of your ${esc(name)} account to <strong>${esc(p.newEmail)}</strong>.
         Confirm it here, and we will send one last link to the new address to finish the move.`
      ) +
      button(p.confirmUrl, 'Yes, change my email') +
      fine(
        `The link works until ${fmtDate(p.expiresAt)}. If you did not ask for this, ignore this email: your address stays as it is.`
      ) +
      spelledLink(p.confirmUrl)
  });
  const text = `Confirm changing your ${name} email to ${p.newEmail}: ${p.confirmUrl}\n\nThe link works until ${fmtDate(p.expiresAt)}. If you did not ask for this, ignore this email: your address stays as it is.`;
  return { subject, html, text };
}

export interface VerifyEmailEmailParams {
  /** The product's name and footer line (`identity.displayName`, `copy.mail.tagline`). */
  brand: MailBrand;
  verifyUrl: string;
  expiresAt: Date;
}

/** To the NEW address: the final leg of every email change (and any plain verification). */
export function buildVerifyEmailEmail(p: VerifyEmailEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const name = p.brand.name;
  const subject = `Verify your ${name} email address`;
  const html = makeShell(p.brand)({
    preheader: 'One click to confirm this address is yours.',
    eyebrow: 'Your account',
    title: 'Is this address yours?',
    body:
      para(
        `One click confirms that this address belongs to you, and it becomes the email of your ${esc(name)} account.`
      ) +
      button(p.verifyUrl, 'Yes, verify this address') +
      fine(`The link works until ${fmtDate(p.expiresAt)}. If you did not ask for this, ignore this email.`) +
      spelledLink(p.verifyUrl)
  });
  const text = `Verify your ${name} email address: ${p.verifyUrl}\n\nThe link works until ${fmtDate(p.expiresAt)}. If you did not ask for this, ignore this email.`;
  return { subject, html, text };
}

export interface OtpEmailParams {
  /** The product's name and footer line (`identity.displayName`, `copy.mail.tagline`). */
  brand: MailBrand;
  otp: string;
  type: string;
}

export function buildOtpEmail(p: OtpEmailParams): { subject: string; html: string; text: string } {
  const name = p.brand.name;
  const subject = `${p.otp} is your ${name} code`;
  const html = makeShell(p.brand)({
    preheader: 'Type it in to continue. It only works once.',
    eyebrow: 'Sign in',
    title: 'Here is your code',
    body:
      para(`Type this into ${esc(name)} to continue:`) +
      codePlate(p.otp) +
      fine('The code works once and only for a few minutes. If you did not ask for it, ignore this email.')
  });
  const text = `Your ${name} code: ${p.otp}\n\nIt works once and only for a few minutes. If you did not ask for it, ignore this email.`;
  return { subject, html, text };
}
