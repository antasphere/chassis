export { type EmailDriver, type EmailMessage, createEmailDriver } from './driver.js';
export {
  type EmailAssets,
  type MailBrand,
  type ShellParts,
  button,
  codePlate,
  emailAssetsAt,
  esc,
  facts,
  fine,
  fmtDate,
  makeShell,
  para,
  quietButton,
  quote,
  setEmailAssets,
  spelledLink
} from './shell.js';
export {
  buildChangeEmailConfirmEmail,
  buildInviteEmail,
  buildOtpEmail,
  buildPasswordResetEmail,
  buildVerifyEmailEmail
} from './templates.js';
