// Client-safe entry: pure zod schemas + seam types. No Hono anywhere on this
// path — the dashboard and SDK import from here and must stay server-free.
//
// The generic half of the platform contract. Everything is a static export
// EXCEPT what carries the tool's scope vocabulary: that comes out of
// `defineChassisContract({ scopes })`, instantiated once by the tool from its
// identity (`ToolIdentity`, ./identity.ts: the type only, the value is the tool's).
export * from './schemas/common.js';
export * from './schemas/scope.js';
export * from './schemas/instance.js';
export * from './schemas/setup.js';
export { onboardingDismissedSchema, type OnboardingDismissed } from './schemas/me.js';
export * from './schemas/workspaces.js';
export * from './schemas/members.js';
export {
  cliAuthRequestSchema,
  cliAuthRequestedSchema,
  cliAuthCompleteSchema,
  cliAuthRevokedSchema,
  type CliAuthRequest,
  type CliAuthRequested,
  type CliAuthComplete,
  type CliAuthRevoked
} from './schemas/cli-auth.js';
export * from './schemas/sso-connect.js';
export * from './schemas/sso-logout.js';
export * from './schemas/invitations.js';
export * from './schemas/audit.js';
export * from './schemas/break-glass.js';
export * from './schemas/files.js';
export * from './schemas/projects.js';
export * from './seams.js';
export * from './entitlements.js';
export * from './define.js';
export type { ToolIdentity } from './identity.js';
