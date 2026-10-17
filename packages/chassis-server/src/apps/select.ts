import { toolDescriptorSchema, type AppEntry, type ToolDescriptor } from '@antasphere/chassis-contract';

/**
 * The Apps page's selection rules (PRDCT-3493), pure so the unit tests hold
 * them without a hub or a file (`test/unit/apps.test.ts`): which URL may be
 * served, what an operator's file may list, and which of the hub's answer
 * the person may open. `./service.ts` does the reading.
 */

/** The name the hub's card carries. */
export const HUB_APP_NAME = 'Antasphere Account';

/** The slugs a file entry names the account with: that entry is the hub's card, not a tool's. */
const HUB_SLUGS = new Set(['hub', 'account']);

/** A registry slug, as the hub spells one (lowercase letters, digits, dashes). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * An http(s) URL with no credentials in it, normalised; null for anything
 * else (a `javascript:` or `data:` URL, a relative path, a blank, a non-string).
 * Every URL the route serves passes here first.
 */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

const text = (raw: unknown, max: number): string | null =>
  typeof raw === 'string' && raw.trim() !== '' && raw.length <= max ? raw.trim() : null;

/**
 * A descriptor as the hub's contract validates it, or undefined when the
 * value is not one (an older or newer hub, a typo in a file): the entry is
 * kept without a descriptor rather than refused, since the page is a
 * convenience and the name alone renders. An empty descriptor is undefined too.
 */
export function readDescriptor(raw: unknown): ToolDescriptor | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = toolDescriptorSchema.safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return undefined;
  return parsed.data;
}

/** What an operator's file yields: the tools, the hub's card when an entry names it, the entries left out. */
export interface FileApps {
  apps: AppEntry[];
  hub: { url: string; name: string } | null;
  /** The entries left out, each with why (the log says them). */
  rejected: { index: number; reason: string }[];
}

/**
 * The operator's list (`APPS_FILE`): `[{ slug, name, launchUrl, description?,
 * icon?, drawing?, accent? }]`, the last four the descriptor's own keys, read
 * by the hub's rule (an invalid one is dropped, the entry kept). An entry
 * without a slug, a name or an http(s) `launchUrl` is left out, and so is a
 * second entry of the same slug; an entry whose slug is `hub` or `account` is
 * the account's card. `current` marks this tool's own slug.
 */
export function appsFromFile(raw: unknown, selfSlug: string): FileApps {
  const out: FileApps = { apps: [], hub: null, rejected: [] };
  if (!Array.isArray(raw)) {
    out.rejected.push({ index: -1, reason: 'the file is not a JSON array' });
    return out;
  }
  const seen = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const slug = typeof entry.slug === 'string' && SLUG.test(entry.slug) ? entry.slug : null;
    const name = text(entry.name, 120);
    const launchUrl = safeHttpUrl(entry.launchUrl);
    if (!slug) return out.rejected.push({ index, reason: 'no valid slug' });
    if (!name) return out.rejected.push({ index, reason: 'no name' });
    if (!launchUrl) return out.rejected.push({ index, reason: 'launchUrl is not an http(s) URL' });
    if (seen.has(slug)) return out.rejected.push({ index, reason: `slug ${slug} listed twice` });
    seen.add(slug);
    if (HUB_SLUGS.has(slug)) {
      out.hub = { url: launchUrl, name };
      return;
    }
    const descriptor = readDescriptor({
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
      ...(entry.drawing !== undefined ? { drawing: entry.drawing } : {}),
      ...(entry.accent !== undefined ? { accent: entry.accent } : {})
    });
    out.apps.push({
      slug,
      name,
      launchUrl,
      ...(descriptor ? { descriptor } : {}),
      connected: false,
      firstUsedAt: null,
      lastUsedAt: null,
      current: slug === selfSlug
    });
  });
  return out;
}

/**
 * The hub's `GET /me/apps` as the page reads it: the tools the organization
 * lets the person open (`open` true), in the hub's order, each with its
 * descriptor and the person's connection facts; a tool not open is LEFT OUT
 * (the hub's own page greys it, a tool's fold hides it); an entry without a
 * valid slug or an http(s) launch URL is dropped; a second entry of a slug is
 * dropped. `current` marks this tool's own slug. Null when the body does not
 * carry the list.
 */
export function selectHubApps(body: unknown, selfSlug: string): AppEntry[] | null {
  const raw = (body as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(raw)) return null;
  const apps: AppEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const tool = (item ?? {}) as Record<string, unknown>;
    if (typeof tool.slug !== 'string' || !SLUG.test(tool.slug) || seen.has(tool.slug)) continue;
    if (tool.open !== true) continue;
    const launchUrl = safeHttpUrl(tool.launchUrl);
    if (!launchUrl) continue;
    seen.add(tool.slug);
    const descriptor = readDescriptor(tool.descriptor);
    apps.push({
      slug: tool.slug,
      name: text(tool.name, 120) ?? tool.slug,
      launchUrl,
      ...(descriptor ? { descriptor } : {}),
      connected: tool.connected === true,
      firstUsedAt: typeof tool.connectedAt === 'string' ? tool.connectedAt : null,
      lastUsedAt: typeof tool.lastUsedAt === 'string' ? tool.lastUsedAt : null,
      current: tool.slug === selfSlug
    });
  }
  return apps;
}
