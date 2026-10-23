// packages/run-core/src/runs-route.ts
import type { SceneDocument } from "@demoman/scene-schema";

// Moved from apps/extension/src/shell/runs-link.ts (launch prep defect 2,
// 2026-10-14), so every wording stays one copy.

/** Whether a script made this take. The one decision every "re-shoot it" /
 *  "run its script again" wording reads, so no surface keeps its own. */
export function isAuthoredScene(scene: SceneDocument): boolean {
  return scene.meta.capture.mode === "authored";
}

/** What Runs does for this take, as a clause: "re-shoot it in Runs" or
 *  "run its script again in Runs". */
export function runsRouteClause(authored: boolean): string {
  return authored ? "run its script again in Runs" : "re-shoot it in Runs";
}
