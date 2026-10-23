import type { SceneDocument } from "@demoman/scene-schema";

/**
 * Author-facing, these are **Recording** (`screen`) and **Rebuild** (`demo`).
 * The enum values are deliberately NOT renamed — see the 2026-09-08 spec §0:
 * the rename buys nothing an author sees and would cost a schema migration
 * across `renderModeOf`'s "absent is NOT the default" contract below.
 */
export type RenderMode = "screen" | "demo";

/**
 * Which render this scene wants.
 *
 * `finalize` writes `"screen"` on every new take, so a document with no
 * `renderMode` is one written before the field existed — and every one of
 * those was made under a regime where Stop always replayed. Absent therefore
 * reads as `"demo"`: a migration rule over a closed set of documents, not a
 * default over an open one.
 *
 * Reading absent as `"screen"` would silently stop serving the replay bundle
 * that every such take already has on disk — a downgrade with no event, no
 * message and nothing for the author to act on.
 */
export function renderModeOf(scene: SceneDocument): RenderMode {
  return scene.meta.renderMode ?? "demo";
}
