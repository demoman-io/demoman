import { type SceneDocument, stepsInsideRemoved } from "@demoman/scene-schema";
import type { Rect } from "../geometry.js";
import { COMPOSITOR_VERSION } from "../version.js";
import { planCameraIntents } from "./camera.js";
import { planCosmetics } from "./cosmetics.js";
import { planCursorSegments } from "./cursor.js";
import type {
  AttachedEdit,
  PlannedPace,
  PlanOptions,
  RenderPlan,
  RetimingPolicy,
} from "./types.js";

export const RETIMING_DEFAULTS: RetimingPolicy = {
  motionDiffThreshold: 0.02,
};

/**
 * The frameless stage. Everything here is derivable from the scene document
 * alone, which is what lets SP5 consume `cursorSegments` before a single
 * frame exists — and what lets SP6 develop against fixtures rather than
 * serializing behind SP5.
 */
export function planScene(
  scene: SceneDocument,
  opts: PlanOptions = {},
): RenderPlan {
  const anchorRects = new Map<string, Rect>();
  for (const anchor of scene.anchors) {
    const rect = anchor.fingerprint.boundingRect;
    if (rect) anchorRects.set(anchor.id, rect);
  }
  const actionRects = new Map<string, Rect>();
  for (const action of scene.actions) {
    if (action.rect) actionRects.set(action.id, action.rect);
  }
  const rectOf = (anchorId: string, actionId: string): Rect | null =>
    actionRects.get(actionId) ?? anchorRects.get(anchorId) ?? null;

  const lastAction = scene.actions[scene.actions.length - 1];

  // `?? []` for the reason `gapAfter` below states.
  const removed = scene.edits.removed ?? [];
  const cutSteps = stepsInsideRemoved(scene);
  const attachedToCuts: AttachedEdit[] = [];

  // `?? []` for the reason `migrateHoldsToGaps` writes it: the frame store
  // casts raw IndexedDB rows, so Zod's `.default([])` never runs on a
  // document written before either field existed. `planScene` takes any
  // `SceneDocument`, and a TypeError here would take the whole render down
  // rather than degrade.
  const gapAfter = new Map(
    (scene.edits.gaps ?? []).map((gap) => [gap.afterActionId, gap] as const),
  );
  const paces: PlannedPace[] = [];
  for (let i = 0; i + 1 < scene.actions.length; i++) {
    const from = scene.actions[i];
    const to = scene.actions[i + 1];
    if (!from || !to) continue;
    const authored = gapAfter.get(from.id);
    const anchors = { afterActionId: from.id, beforeActionId: to.id };
    paces.push(
      authored
        ? { ...anchors, origin: "authored", idleTargetMs: authored.durationMs }
        : {
            ...anchors,
            origin: "recorded",
            // Raw, and negative when the log does not ascend. This carried a
            // `max(0, …)` until 2026-09-25, under a comment claiming the
            // floor "cannot fire through any path the editor offers" —
            // `resequence` rewrites timestamps after a reorder, the trims
            // only remove entries, `insertedAt` interpolates. All true, and
            // all about the EDITOR; the capture path was never checked.
            // `expandWaits` (extension `core/reduce.ts`) stamped a readiness
            // wait at the moment its element appeared, which for anything
            // present at page load is the take's origin, and placed it
            // beside the action it gates — dropping an early timestamp into
            // the middle of an otherwise ascending log. The floor turned
            // that pair's interval into a clean 0, indistinguishable from
            // two simultaneous actions, while the pair AFTER it went on to
            // claim the dead air this pair should have carried. A rebuild
            // froze for both and rendered 0:44 against a 0:31 take.
            //
            // The stamp is fixed at its source. The floor moves to
            // `idleTargetMsFor`, which needs it anyway (a negative target
            // would walk the output cursor backwards and break the
            // monotonicity of `toSourceMs`/`toOutputMs`), and the fact
            // survives the trip so `buildTimeline` can count it into
            // `Timeline.nonMonotonicPaces` rather than smooth it away.
            recordedSpanMs: to.timestamp - from.timestamp,
          },
    );
  }

  return {
    planVersion: 1,
    compositorVersion: COMPOSITOR_VERSION,
    sceneId: scene.meta.id,
    viewport: scene.meta.capture.viewport,
    // Deliberately NOT filtered by `cutSteps`. This is SP5's replay
    // instruction list, not a drawing decision: a rebuild performs every
    // step the take holds, and the cut removes the frames it produced
    // afterwards. Skipping a cut step here would drive the app down a path
    // the author never recorded.
    cursorSegments: planCursorSegments(scene, rectOf),
    cameraIntents: planCameraIntents(scene, cutSteps, attachedToCuts),
    cosmetics: planCosmetics(scene),
    holds: (scene.edits.holds ?? []).flatMap((hold) => {
      if (cutSteps.has(hold.marker.actionId)) {
        attachedToCuts.push({
          id: hold.id,
          kind: "hold",
          actionId: hold.marker.actionId,
        });
        return [];
      }
      return [
        {
          id: hold.id,
          actionId: hold.marker.actionId,
          offsetMs: hold.marker.offsetMs,
          durationMs: hold.durationMs,
        },
      ];
    }),
    paces,
    removed,
    removedSteps: [...cutSteps],
    attachedToCuts,
    trim: {
      head: scene.edits.trim?.head ?? null,
      tail: scene.edits.trim?.tail ?? null,
    },
    retiming: { ...RETIMING_DEFAULTS, ...opts.retiming },
    hoverSensitive: scene.flags.hoverSensitive,
    durationHintMs: lastAction?.timestamp ?? 0,
  };
}
