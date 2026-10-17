/**
 * The catalogue of tools, as the hub publishes it (PRDCT-3493). The hub owns
 * these shapes and publishes them as `@antasphere/contract`; the chassis
 * re-exports them under the same names so a tool's dashboard and server read
 * one definition of a tool's descriptor: the closed lists of icons and
 * drawings the sidebar and the Apps page render (one component per name), the
 * descriptor itself (a sentence, an icon, a drawing, a hex accent, all
 * optional, all validated by the hub's registry parse), and the answer of
 * `GET /me/apps` the Apps service reads with the person's own grant. Nothing
 * here redefines a shape.
 */
export {
  TOOL_DRAWINGS,
  TOOL_ICONS,
  meAppsEntrySchema,
  meAppsSchema,
  toolDescriptorSchema,
  type MeApps,
  type MeAppsEntry,
  type ToolDescriptor,
  type ToolDrawing,
  type ToolIcon
} from '@antasphere/contract';
