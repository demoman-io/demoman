import type { SceneDocument } from "@demoman/scene-schema";
import type { CosmeticBinding } from "./types.js";

/**
 * Cosmetics are a document layer re-applied on every render (v8 §5), never
 * baked into stored frames. Masks are the only kind.
 *
 * Every mask is planned, a cut or not: a redaction never fails open. One
 * whose step was removed still covers whatever of its frames survive, which
 * `resolveMaskRange` finds in source time (audit run 1).
 */
export function planCosmetics(scene: SceneDocument): CosmeticBinding[] {
  return scene.edits.masks.map((m) => ({
    id: m.id,
    kind: "mask" as const,
    rect: m.rect,
    // Both or neither, by the schema's refinement. Neither is the whole take.
    range: m.start && m.end ? { start: m.start, end: m.end } : null,
  }));
}
