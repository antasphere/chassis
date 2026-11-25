import { describe, expect, it } from 'vitest';
import {
  HUB_TOOL,
  loadConfig as loadCoreConfig,
  resolveBaseUrl,
  selectProfile,
  updateConfig as updateCoreConfig,
  type CliEnv
} from '@antasphere/cli-core';
import { routedHarness, tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  exchangeRoutes,
  HUB,
  HUB_KEY,
  key,
  meRoute,
  namingInstanceRoute,
  ORG,
  otpRoutes
} from './signin-fixtures.js';

/**
 * Two writers, one config home (verifier round 1, F4): the hub CLI
 * (`antasphere login`) and the tool's inline hub sign-in must write and read
 * the SAME login, so either login signs the other in. The tool finds a
 * login by the hub its site names (R2), whatever its entry is called.
 *
 * `hubCliProfile` and `hubCliLogin` below mirror the hub CLI of lane B:
 * `labs/products/antasphere/wt-onelogin-b-hub/packages/cli/src/context.ts`
 * lines 171-188 (the profile selection and the URL resolution of
 * `resolveContext`, with no --profile and no --api-url given) and
 * `packages/cli/src/index.ts` lines 1171-1180 (the write of `login`: the
 * spread row, then the profile made active), now one locked updater
 * (cli-core 0.7.0, R0). Keep them in step with it.
 */

const { loadConfig } = cli;
const DEFAULT_HUB_URL = 'https://account.antasphere.com';

/** The hub CLI's `resolveContext` selection (context.ts 171-188). */
function hubCliProfile(env: CliEnv): { name: string; baseUrl: string; apiKey: string | undefined } {
  const config = loadCoreConfig(env, HUB_TOOL);
  const selected = selectProfile({
    config,
    requested: undefined,
    apiUrl: env.ANTASPHERE_URL,
    cloudUrl: DEFAULT_HUB_URL
  });
  const name = selected.name ?? 'cloud';
  const baseUrl = resolveBaseUrl({
    env,
    envVar: 'ANTASPHERE_URL',
    profile: selected.profile,
    cloudUrl: DEFAULT_HUB_URL
  });
  return { name, baseUrl, apiKey: selected.profile?.apiKey };
}

/** The hub CLI's `login` write (index.ts 1171-1180), after its email code minted `apiKey`. */
function hubCliLogin(env: CliEnv, apiKey: string): void {
  const ctx = hubCliProfile(env);
  updateCoreConfig(env, HUB_TOOL, (config) => {
    config.profiles[ctx.name] = {
      ...config.profiles[ctx.name],
      apiKey,
      baseUrl: ctx.baseUrl,
      email: 'ada@x.co',
      workspaceId: ORG
    };
    config.activeProfile = ctx.name;
  });
}

const CASES = [
  ['a clean machine', {}, 'cloud', DEFAULT_HUB_URL],
  ['ANTASPHERE_URL set', { ANTASPHERE_URL: HUB }, 'hub', HUB]
] as const;

describe('the login is one login for the hub CLI and the tool CLI', () => {
  it.each(CASES)(
    '%s: `antasphere login` first, then the tool login at a site naming that hub asks nothing and exchanges that key',
    async (_label, extra, hubProfile, hubUrl) => {
      const env: Record<string, string> = { ...(await tempConfigEnv()), ...extra };
      hubCliLogin(env, HUB_KEY);
      expect(loadCoreConfig(env, HUB_TOOL).activeProfile).toBe(hubProfile);

      const minted = key('tool');
      const h = routedHarness([namingInstanceRoute(hubUrl), ...exchangeRoutes([minted]), meRoute()], env);
      const asked: string[] = [];
      h.io.prompt = async (q) => {
        asked.push(q);
        return '';
      };
      expect(await run(['login', '--api-url', 'http://tool'], h.io)).toBe(0);
      expect(asked).toEqual([]);
      expect(h.wire.some((c) => c.path.startsWith('/api/v1/cli/auth/'))).toBe(false);
      expect(h.wire.find((c) => c.path.endsWith('/sso/tool-token'))).toMatchObject({
        origin: hubUrl,
        auth: `Bearer ${HUB_KEY}`
      });
      expect(loadConfig(env).profiles.tool?.hubKeys).toEqual([
        { hub: hubUrl, email: 'ada@x.co', apiKey: minted, mintedAt: expect.any(String) }
      ]);
    }
  );

  it.each(CASES)(
    '%s: the tool login signs in inline at the hub its site names, and the hub CLI then finds that login, its key and URL',
    async (_label, extra, hubProfile, hubUrl) => {
      const env: Record<string, string> = { ...(await tempConfigEnv()), ...extra };
      const h = routedHarness(
        [
          namingInstanceRoute(hubUrl),
          ...otpRoutes(HUB_KEY, ORG),
          ...exchangeRoutes([key('tool')]),
          meRoute()
        ],
        env
      );
      h.io.prompt = async () => '123456';
      expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
      expect(h.wire.find((c) => c.path === '/api/v1/cli/auth/request')?.origin).toBe(hubUrl);

      expect(hubCliProfile(env)).toEqual({ name: hubProfile, baseUrl: hubUrl, apiKey: HUB_KEY });
      // The first login of a machine is its active one; no later login moves it.
      expect(loadCoreConfig(env, HUB_TOOL).activeProfile).toBe(hubProfile);
      expect(loadConfig(env).profiles.tool?.hubKeys?.map((k) => k.hub)).toEqual([hubUrl]);
    }
  );
});
