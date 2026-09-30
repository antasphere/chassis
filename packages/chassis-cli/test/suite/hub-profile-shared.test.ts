import { describe, expect, it } from 'vitest';
import {
  HUB_TOOL,
  loadConfig as loadCoreConfig,
  resolveBaseUrl,
  saveConfig as saveCoreConfig,
  selectProfile,
  type CliEnv
} from '@antasphere/cli-core';
import { routedHarness, tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import {
  cloudInstanceRoute,
  exchangeRoutes,
  HUB,
  HUB_KEY,
  key,
  meRoute,
  ORG,
  otpRoutes
} from './signin-fixtures.js';

/**
 * Two writers, one config home (verifier round 1, F4): the hub CLI
 * (`antasphere login`) and the tool's inline hub sign-in must write and read
 * the SAME hub profile, so either login signs the other in.
 *
 * `hubCliProfile` and `hubCliLogin` below mirror the hub CLI of lane B:
 * `labs/products/antasphere/wt-onelogin-b-hub/packages/cli/src/context.ts`
 * lines 171-188 (the profile selection and the URL resolution of
 * `resolveContext`, with no --profile and no --api-url given) and
 * `packages/cli/src/index.ts` lines 1171-1180 (the write of `login`: the
 * spread row, then the profile made active). Keep them in step with it.
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
  const config = loadCoreConfig(env, HUB_TOOL);
  config.profiles[ctx.name] = {
    ...config.profiles[ctx.name],
    apiKey,
    baseUrl: ctx.baseUrl,
    email: 'ada@x.co',
    workspaceId: ORG
  };
  config.activeProfile = ctx.name;
  saveCoreConfig(env, HUB_TOOL, config);
}

const CASES = [
  ['a clean machine', {}, 'cloud', DEFAULT_HUB_URL],
  ['ANTASPHERE_URL set', { ANTASPHERE_URL: HUB }, 'hub', HUB]
] as const;

describe('the hub profile is one profile for the hub CLI and the tool CLI', () => {
  it.each(CASES)(
    '%s: `antasphere login` first, then the tool login asks nothing and exchanges that key',
    async (_label, extra, hubProfile, hubUrl) => {
      const env: Record<string, string> = { ...(await tempConfigEnv()), ...extra };
      hubCliLogin(env, HUB_KEY);
      expect(loadCoreConfig(env, HUB_TOOL).activeProfile).toBe(hubProfile);

      const minted = key('tool');
      const h = routedHarness([cloudInstanceRoute, ...exchangeRoutes([minted]), meRoute()], env);
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
      const connectKeys = loadConfig(env).profiles.tool?.connectKeys ?? {};
      expect(Object.keys(connectKeys)).toEqual([hubProfile]);
      expect(connectKeys[hubProfile]?.apiKey).toBe(minted);
    }
  );

  it.each(CASES)(
    '%s: the tool login signs in inline, and the hub CLI then finds that profile, its key and URL',
    async (_label, extra, hubProfile, hubUrl) => {
      const env: Record<string, string> = { ...(await tempConfigEnv()), ...extra };
      const h = routedHarness(
        [cloudInstanceRoute, ...otpRoutes(HUB_KEY, ORG), ...exchangeRoutes([key('tool')]), meRoute()],
        env
      );
      h.io.prompt = async () => '123456';
      expect(await run(['login', '--api-url', 'http://tool', '--email', 'ada@x.co'], h.io)).toBe(0);
      expect(h.wire.find((c) => c.path === '/api/v1/cli/auth/request')?.origin).toBe(hubUrl);

      expect(hubCliProfile(env)).toEqual({ name: hubProfile, baseUrl: hubUrl, apiKey: HUB_KEY });
      expect(loadCoreConfig(env, HUB_TOOL).activeProfile).toBe(hubProfile);
      expect(Object.keys(loadConfig(env).profiles.tool?.connectKeys ?? {})).toEqual([hubProfile]);
    }
  );
});
