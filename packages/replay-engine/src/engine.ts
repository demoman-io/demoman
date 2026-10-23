/**
 * Replaying a recorded document: the walk's first source.
 *
 * Everything that is common to replaying and to running an authored script
 * lives in `walk.ts`. What is left here is the part that is about a
 * `SceneDocument` and nothing else — the plan, the anchor a step names, and
 * the text a redacted `type` is allowed to perform.
 */
import {
  type CursorSegment,
  type MadeFromStep,
  planScene,
} from "@demoman/compositor";
import type { SceneAction, SceneDocument } from "@demoman/scene-schema";
import type { ReplayResult } from "./types.js";
import {
  type EngineDeps,
  REDACTED_WITHOUT_REPLACEMENT,
  runWalk,
  type WalkStep,
} from "./walk.js";

// `replayOutcome` and `EngineDeps` moved into `walk.ts` with the walk itself
// and are re-exported here, so that every importer of this module —
// `index.ts` among them — still reads them from where it always has.
export { replayOutcome } from "./walk.js";
export type { EngineDeps };

export async function runReplay(
  scene: SceneDocument,
  deps: EngineDeps,
): Promise<ReplayResult> {
  // Behind the policy gate, so no planning happens for a run `runWalk` is
  // about to refuse. Tidiness rather than a fix: the reviewer verified the
  // earlier ordering is inert for every schema-valid document — `planScene`
  // reads the document and writes nothing — and `runWalk`'s own
  // `if (!deps.mayReplay)` is still the one place the rule lives.
  const plan = deps.mayReplay ? planScene(scene) : null;
  // Segments are planned per *positioned* action, so a navigation waitFor —
  // which names no element and gets no waypoint — shifts every later index.
  // Key by the action the segment arrives at instead.
  const segments = new Map<string, CursorSegment>(
    plan?.cursorSegments.map((segment) => [segment.toActionId, segment]) ?? [],
  );

  return runWalk(
    {
      // Every step is known up front here — that is exactly what an authored
      // run cannot do, and the whole reason the source is an interface.
      *steps() {
        let previous: SceneAction | null = null;
        for (const action of scene.actions) {
          yield {
            action,
            target:
              action.anchorId === null
                ? null
                : (scene.anchors.find((a) => a.id === action.anchorId) ?? null),
            segment: segments.get(action.id),
            text: textFor(action),
            // A drag rebuilds from the spots and end the take kept.
            ...(action.kind === "drag"
              ? {
                  drag: {
                    fromAt: action.fromAt,
                    to: action.to,
                    end:
                      action.toAnchorId === null
                        ? null
                        : (scene.anchors.find(
                            (a) => a.id === action.toAnchorId,
                          ) ?? null),
                  },
                }
              : {}),
            // The take's own spacing, for the walk to wait out live in
            // continuous recording (spec 2026-10-03 §5).
            ...(previous === null
              ? {}
              : intervalBetween(previous, action, scene, deps.madeFrom)),
          };
          previous = action;
        }
      },
    },
    deps,
    {
      sceneId: scene.meta.id,
      viewport: scene.meta.capture.viewport,
      // A take filmed as a phone rebuilds as that phone, never the desktop.
      device: scene.meta.capture.device ?? null,
      total: scene.actions.length,
      hoverSensitive: scene.flags.hoverSensitive,
      // The compositor's deliberate entry point, not the origin. See the
      // comment on `cursor` in `walk.ts` for what a (0, 0) seed costs.
      firstCursor: plan?.cursorSegments[0]?.from ?? { x: 0, y: 0 },
    },
  );
}

/**
 * How long the walk should leave between two performed steps' markers, or
 * undefined for "no pacing".
 *
 * Undefined when the two were not neighbours in the take's own order,
 * `madeFrom`.
 *
 * Otherwise the author's edited gap for the pair when there is one — the
 * pause they chose over the one they recorded, which on a page that never
 * stops moving no compositor rescale can deliver — and the recorded
 * interval when there is not. An edited gap comes back as `pacedGap` too:
 * the walk records each one it waits out in the bundle, so the compositor
 * does not apply it a second time (review of 2026-10-03).
 */
function intervalBetween(
  previous: SceneAction,
  action: SceneAction,
  scene: SceneDocument,
  madeFrom: readonly MadeFromStep[],
): Pick<WalkStep, "recordedIntervalMs" | "pacedGap"> {
  const at = madeFrom.findIndex((step) => step.actionId === action.id);
  if (at <= 0 || madeFrom[at - 1]?.actionId !== previous.id) return {};
  const gap = (scene.edits.gaps ?? []).find(
    (g) => g.afterActionId === previous.id,
  );
  if (gap === undefined) {
    return { recordedIntervalMs: action.timestamp - previous.timestamp };
  }
  return {
    recordedIntervalMs: gap.durationMs,
    pacedGap: { afterActionId: previous.id, durationMs: gap.durationMs },
  };
}

function textFor(
  action: SceneAction,
): string | null | typeof REDACTED_WITHOUT_REPLACEMENT {
  if (action.kind !== "type") return null;
  // A value the take never recorded: nothing in the document supplies one
  // since replacements left with schema 12, so the walk refuses it by name.
  return action.redacted ? REDACTED_WITHOUT_REPLACEMENT : action.text;
}
