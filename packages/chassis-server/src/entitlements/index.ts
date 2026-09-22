export {
  entitlementGate,
  honoPath,
  registerEntitlementGate,
  type EntitlementCloud,
  type EntitlementGateDeps
} from './gate.js';
export {
  DEFAULT_FAILURE_HOLD_MS,
  HUB_USAGE_SCOPE,
  HubMachineToken,
  HubMachineTokenError,
  type HubMachineTokenOptions
} from './hub-machine-token.js';
export { hubSubjectResolver } from './hub-subject.js';
export { HubUsagePoster, HubUsagePostError, type HubUsagePosterOptions } from './poster.js';
export {
  DEFAULT_PROFILE_DIALS,
  EntitlementProfiles,
  defaultProfile,
  type EntitlementProfileDials,
  type EntitlementProfilesOptions,
  type ResolvedProfile
} from './profiles.js';
export { assertToolEntitlements, EMPTY_TOOL_ENTITLEMENTS, type ToolEntitlementDeclaration } from './slot.js';
