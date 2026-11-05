import { z } from 'zod';

/**
 * The docs source (PRDCT-4098): what a tool answers on its public
 * `GET /docs-source`, read from the `docs/` folder its image carries. A
 * reader (the Handbook) validates the answer with this schema, the way
 * `toolOriginsSchema` guards the fleet read.
 *
 * - `product`, `description`: `docs/nav.yml`'s own keys.
 * - `version`: the instance's reported version (`APP_VERSION`); `slug`: the
 *   tool identity's slug. Together they say what was read.
 * - `groups`: `nav.yml`'s groups in order, each page with its `path` (as
 *   `nav.yml` lists it, no `.md`), its `title` (the page's leading H1) and its
 *   `description` (the intro paragraph under the H1, inline markdown
 *   flattened to text: the public docs site's page contract; empty when the
 *   page has none). A page `nav.yml` lists but the folder lacks is left out.
 *
 * A page's markdown is `GET /docs-source/pages/<path>` for a `path` listed
 * here, `text/markdown; charset=utf-8`; every other path answers 404.
 */
export const docsSourcePageSchema = z.object({
  path: z.string().min(1),
  title: z.string(),
  description: z.string()
});
export type DocsSourcePage = z.infer<typeof docsSourcePageSchema>;

export const docsSourceGroupSchema = z.object({
  title: z.string(),
  pages: z.array(docsSourcePageSchema)
});
export type DocsSourceGroup = z.infer<typeof docsSourceGroupSchema>;

export const docsSourceManifestSchema = z.object({
  product: z.string(),
  description: z.string(),
  version: z.string(),
  slug: z.string(),
  groups: z.array(docsSourceGroupSchema)
});
export type DocsSourceManifest = z.infer<typeof docsSourceManifestSchema>;

/** The route's paths, for a reader that builds the URLs. */
export const DOCS_SOURCE_PATH = '/docs-source';
export const DOCS_SOURCE_PAGES_PATH = '/docs-source/pages';
