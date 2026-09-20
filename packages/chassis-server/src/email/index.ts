export { type EmailDriver, type EmailMessage, createEmailDriver } from './driver.js';
export {
  buildChangeEmailConfirmEmail,
  buildInviteEmail,
  buildOtpEmail,
  buildPasswordResetEmail,
  buildVerifyEmailEmail,
  esc,
  makeShell
} from './templates.js';
