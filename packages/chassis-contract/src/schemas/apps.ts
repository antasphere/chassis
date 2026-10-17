import { z } from 'zod';
import { toolDescriptorSchema } from '@antasphere/contract';

/**
 * The Apps page and the rail's fold of a tool (PRDCT-3493): the other tools
 * of the person's organization, and the account that signs them in.
 * Client-safe (pure zod): the chassis server answers with it, the SDK and the
 * dashboard type against it.
 *
 * Where the list comes from (`source`):
 *  - `hub`: on the cloud edition, the hub asked AS THE PERSON with their own
 *    grant (`GET /me/apps`: the catalogue as they see it in the workspace's
 *    hub organization, each tool with the access verdict); a tool the
 *    organization does not open to the person is LEFT OUT here, never listed
 *    greyed: the tools' own Apps fold suggests only what the reader can open;
 *  - `file`: the operator's own list (`APPS_FILE`), on a self-hosted instance
 *    or when the hub could not be asked;
 *  - `none`: neither, and the list is empty.
 *
 * Every URL is an http(s) URL the server checked before serving it, and the
 * descriptor is the hub's registry descriptor (or the file's, validated the
 * same way): the sentence, the icon and the drawing names from the closed
 * lists, the accent. The dashboard renders a name through text interpolation,
 * an icon or a drawing through one component per name, nothing else.
 */

/** One tool the person may open. */
export const appEntrySchema = z.object({
  /** The tool's registry slug (`finance`, `hiring`, …). */
  slug: z.string(),
  /** The tool's display name. */
  name: z.string(),
  /** Where opening the tool lands. */
  launchUrl: z.string(),
  /** How the tool presents itself (the registry's descriptor, or the file's); absent when neither declares one. */
  descriptor: toolDescriptorSchema.optional(),
  /** The person has signed in to the tool (the hub source); false when nothing says so. */
  connected: z.boolean(),
  /** When the person first signed in to the tool (the hub source), else null. */
  firstUsedAt: z.string().nullable(),
  /** When the person last signed in to the tool (the hub source), else null. */
  lastUsedAt: z.string().nullable(),
  /** This very tool: the page shows it, with no button. */
  current: z.boolean()
});
export type AppEntry = z.infer<typeof appEntrySchema>;

export const APP_SOURCES = ['hub', 'file', 'none'] as const;
export type AppSource = (typeof APP_SOURCES)[number];

/** GET /apps. */
export const appsListSchema = z.object({
  apps: z.array(appEntrySchema),
  /** The account that signs the person in (the hub), when the instance knows one. */
  hub: z.object({ url: z.string(), name: z.string() }).nullable(),
  source: z.enum(APP_SOURCES)
});
export type AppsList = z.infer<typeof appsListSchema>;
