export { type EmailDriver, type EmailMessage, createEmailDriver } from './driver.js';
export {
  PRODUCT_NAME,
  buildChangeEmailConfirmEmail,
  buildInviteEmail,
  buildOtpEmail,
  buildPasswordResetEmail,
  buildVerifyEmailEmail,
  esc,
  shell
} from './templates.js';
