import type { FrameBundle } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import type { SessionSnapshot } from "./session";

/**
 * What the motion hints and the hover check were last computed against:
 * the bundle, and the scene's action-id shape (ids and order).
 *
 * Gating on `bundle` alone meant that once `hoverReport` retired — undo,
 * redo or a removed piece null it (state.ts) — nothing ever ran the check
 * again for the same bundle: the banner just disappeared for the rest of
 * the session. Keying on the id shape too means an id-changing scene is
 * itself what re-arms the check, and `hintsCurrent`'s null test re-arms it
 * for the rest.
 */
export interface HintMark {
  bundle: FrameBundle;
  actionIds: string;
}

export function actionIdsKey(scene: SceneDocument): string {
  return scene.actions.map((action) => action.id).join(" ");
}

export function markHints(
  snapshot: Pick<SessionSnapshot, "scene"> & { bundle: FrameBundle },
): HintMark {
  return { bundle: snapshot.bundle, actionIds: actionIdsKey(snapshot.scene) };
}

/**
 * Whether the hints `mark` records still describe `snapshot` — in which
 * case there is nothing to recompute.
 *
 * `hoverReport !== null` is not redundant with the two identity checks:
 * undo/redo (state.ts) null `hoverReport` unconditionally WITHOUT changing
 * the id shape — undoing a rename leaves both the bundle and the ids
 * matching — and an id-preserving edit (a rename) landing while a check is
 * in flight makes `runCommand` build a NEW `SceneDocument` so the in-flight
 * result is dropped as stale, with `hoverReport` still `null` for the scene
 * actually on screen. Terminates rather than thrashing: the only way
 * `hoverReport` becomes `null` is an edit, undo, or redo (never a completed
 * check, which always writes a non-null report), so each retirement
 * re-opens the gate for exactly one settled recompute, not a recurring one.
 */
export function hintsCurrent(
  mark: HintMark | null,
  snapshot: Pick<SessionSnapshot, "scene" | "bundle" | "hoverReport">,
): boolean {
  return (
    mark !== null &&
    snapshot.bundle === mark.bundle &&
    actionIdsKey(snapshot.scene) === mark.actionIds &&
    snapshot.hoverReport !== null
  );
}
