import {
  HUB_TOOL,
  updateConfig as updateCoreConfig,
  type CliConfig,
  type CliSiteFacts
} from '@antasphere/cli-core';
import { routedHarness, type Route } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';

/**
 * The shared fixtures of the sign-in suites (PRDCT-2947): `login`, `logout`,
 * `whoami`, `profiles`, the profile selection and the stranded-key recovery.
 * Every literal that spells the tool is read from `cli.identity`, so the same
 * files run under the chassis host and the tool's.
 */

const { keyPrefix: K, displayName } = cli.identity;

export const HUB = 'http://hub';
export const HUB_KEY = 'ant_hubkey12_secretsecretsecret1234';
export const ORG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** A tool key of the host's prefix, long enough for `redactKey` to shorten. */
export const key = (tag: string) =>
  `${K}_${tag.padEnd(8, '0').slice(0, 8)}_0123456789abcdefghijklmnopqrstuvwxyz`;

export const INSTANCE_BASE = {
  name: 'Inst',
  instanceId: 'i1',
  version: '1.0.0',
  apiVersion: 'v1',
  setupRequired: false,
  features: { mcp: true, oauth: true, files: true }
};

/** The discovery of a site that signs in through a hub; `hub` is the hub it names (`auth.hub`, R1). */
export function cloudInstanceBody(hub?: string): Record<string, unknown> {
  return {
    ...INSTANCE_BASE,
    edition: 'cloud',
    auth: {
      methods: ['antasphere', 'api-key', 'oauth'],
      passwordReset: false,
      emailChange: false,
      twoFactor: false,
      ...(hub ? { hub } : {})
    }
  };
}

/** A site from before sites named their hub: it signs in through one, and names none. */
export const cloudInstanceRoute: Route = {
  method: 'GET',
  path: /\/api\/v1\/instance$/,
  reply: () => ({ body: cloudInstanceBody() })
};

/** A site that names the hub it trusts (R1), on any origin unless one is given. */
export function namingInstanceRoute(hub: string, origin?: string): Route {
  return {
    method: 'GET',
    path: /\/api\/v1\/instance$/,
    ...(origin ? { origin } : {}),
    reply: () => ({ body: cloudInstanceBody(hub) })
  };
}

export const ossInstanceRoute: Route = {
  method: 'GET',
  path: /\/api\/v1\/instance$/,
  reply: () => ({
    body: {
      ...INSTANCE_BASE,
      edition: 'oss',
      auth: {
        methods: ['password', 'email-otp', 'api-key', 'oauth'],
        passwordReset: true,
        emailChange: true,
        twoFactor: true
      }
    }
  })
};

export function wsRow(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name,
    role: 'owner',
    hubOrigin: false,
    centralAccountId: null as string | null,
    look: { theme: null, pattern: null, field: null, grain: null },
    suspended: false,
    default: false,
    ...over
  };
}

/** `/me` as the server answers it, for a person in the given workspaces (the first is active). */
export function meBody(
  opts: { name?: string; email?: string; workspaces?: ReturnType<typeof wsRow>[]; via?: string } = {}
): Record<string, unknown> {
  const workspaces = opts.workspaces ?? [wsRow('w1', 'Acme', { default: true })];
  const active = workspaces[0]!;
  return {
    user: { id: 'u1', name: opts.name ?? 'Ada', email: opts.email ?? 'ada@x.co' },
    workspace: { id: active.id, name: active.name, hubOrigin: active.hubOrigin, look: active.look },
    role: 'owner',
    origin: 'local',
    via: opts.via ?? 'api_key',
    scopes: ['a:read'],
    apiKeyExpiresAt: null,
    workspaces,
    activeWorkspaceId: active.id,
    hubManageUrl: null,
    canCreateWorkspace: false
  };
}

export const meRoute = (body: Record<string, unknown> = meBody()): Route => ({
  method: 'GET',
  path: /\/api\/v1\/me$/,
  reply: () => ({ body })
});

export const filesRoute: Route = {
  method: 'GET',
  path: /\/api\/v1\/files$/,
  reply: () => ({ body: { files: [], nextCursor: null } })
};

export const MINTED_META = {
  id: '44444444-4444-4444-4444-444444444444',
  name: 'CLI login',
  keyId: 'minted12',
  scopes: ['a:read'],
  createdBy: 'u1',
  createdAt: '2026-07-10T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null
};

/** The email-code pair of an instance (or of the hub), minting `minted`. */
export function otpRoutes(minted: string, workspaceId: string | null = 'w1'): Route[] {
  return [
    { method: 'POST', path: /\/api\/v1\/cli\/auth\/request$/, reply: () => ({ body: { sent: true } }) },
    {
      method: 'POST',
      path: /\/api\/v1\/cli\/auth\/complete$/,
      reply: () => ({
        status: 201,
        body: {
          key: minted,
          apiKey: MINTED_META,
          user: { id: 'u1', email: 'ada@x.co', name: 'Ada' },
          workspaceId
        }
      })
    }
  ];
}

/** The hub → tool exchange, minting the keys in order (the last one repeats). */
export function exchangeRoutes(
  minted: string[],
  opts: { toolToken?: (n: number) => { status: number; body: unknown } | undefined } = {}
): Route[] {
  let tokenSeq = 0;
  let connectSeq = 0;
  return [
    {
      method: 'POST',
      path: /\/api\/v1\/sso\/tool-token$/,
      reply: () => {
        tokenSeq += 1;
        const refusal = opts.toolToken?.(tokenSeq);
        if (refusal) return refusal;
        return {
          body: {
            token: `jwt-${tokenSeq}`,
            expiresAt: '2026-07-13T00:02:00.000Z',
            hubRefreshToken: `hrt-${tokenSeq}`
          }
        };
      }
    },
    {
      method: 'POST',
      path: /\/api\/v1\/sso\/cli-connect$/,
      reply: () => {
        connectSeq += 1;
        return {
          status: 201,
          body: {
            key: minted[Math.min(connectSeq, minted.length) - 1],
            apiKey: MINTED_META,
            user: { id: 'u1', email: 'ada@x.co', name: 'Ada' },
            workspaceId: null
          }
        };
      }
    }
  ];
}

/** The hub's refusal of the person (a restricted tool): exit 3, its own sentence. */
export const TOOL_ACCESS_DENIED = {
  status: 403,
  body: {
    error: {
      code: 'tool_access_denied',
      message: `This account has no access to ${displayName} in any of its organizations`
    }
  }
};

/** Write the tool's file as given (through the one writer, cli-core `updateConfig`). */
export function seedTool(env: Record<string, string | undefined>, config: CliConfig): string {
  return cli.updateConfig(env, () => config).path;
}

/** Write the hub's file (`config.json`) as given. */
export function seedHub(env: Record<string, string | undefined>, config: CliConfig): void {
  updateCoreConfig(env, HUB_TOOL, () => config);
}

/** What `antasphere login` leaves behind: the login at `HUB`, active. */
export function seedHubLogin(env: Record<string, string | undefined>, name = 'default'): void {
  seedHub(env, {
    activeProfile: name,
    profiles: { [name]: { apiKey: HUB_KEY, baseUrl: HUB, email: 'ada@x.co' } }
  });
}

/** What a site said of itself, remembered just now: a kept key is then served with no request. */
export function fresh(hub: string | null, federated = true): CliSiteFacts {
  return { hub, federated, name: 'Inst', cliVersion: '1.0.0', seenAt: new Date().toISOString() };
}

/** The version of the CLI under test, as its own `--version` prints it (each host's own). */
export async function cliVersionOf(): Promise<string> {
  const h = routedHarness([]);
  await run(['--version'], h.io);
  return h.out().trim();
}

/** A version newer than `version` (its major, plus one). */
export const newerThan = (version: string): string => `${Number(version.split('.')[0]) + 1}.0.0`;

/** A kept key of a profile, filed by hub and account (cli-core 0.7.0 `hubKeys`). */
export function kept(hub: string, email: string, apiKey: string) {
  return { hub, email, apiKey, mintedAt: '2026-11-01T00:00:00.000Z' };
}
