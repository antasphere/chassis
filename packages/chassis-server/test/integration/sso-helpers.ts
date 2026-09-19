import { makeOauthBearer } from '@antasphere/chassis-server/testing';
import { host } from '@chassis-test/host';

/** The shared SSO dances, with the OAuth dance requesting the HOST's read scope. */
export {
  json,
  nextIp,
  seedLocalWorkspace,
  ssoInitiate,
  ssoDance,
  ssoLogin,
  expectFailedLogin
} from '@antasphere/chassis-server/testing';

export const oauthBearer = makeOauthBearer(`openid ${host.scopes.read}`);
