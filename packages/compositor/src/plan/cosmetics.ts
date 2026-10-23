import type { SceneDocument } from "@demoman/scene-schema";
import type { AttachedEdit, CosmeticBinding } from "./types.js";

/**
 * Cosmetics are a document layer re-applied on every render (v8 §5), never
 * baked into stored frames. Masks are the only kind.
 *
 * `cutSteps` are the steps inside a removed piece. A RANGED mask that opens
 * on one of them is kept in the document and not drawn, and pushed onto
 * `attached` so the caller can say so (spec §1, "Edits attached to a cut
 * step"). A mask with no range covers the whole take, so it has no step to
 * sit on.
 */
export function planCosmetics(
  scene: SceneDocument,
  cutSteps: ReadonlySet<string>,
  attached: AttachedEdit[],
): CosmeticBinding[] {
  return scene.edits.masks.flatMap((m) => {
    // Both or neither, by the schema's refinement. Neither is the whole take.
    const range = m.start && m.end ? { start: m.start, end: m.end } : null;
    // Matched on the OPENING marker alone. A mask whose start survives and
    // whose end was cut still paints from its start; where it stops is the
    // range resolver's business, and it reports a collapse of its own.
    if (range && cutSteps.has(range.start.actionId)) {
      attached.push({ id: m.id, kind: "mask", actionId: range.start.actionId });
      return [];
    }
    return [{ id: m.id, kind: "mask" as const, rect: m.rect, range }];
  });
}
