// Telemetry — the event a completed replay reports, not replay itself.
// The replay engine moved to `@demoman/replay-engine`; this file only
// consumes it.
import { COMPOSITOR_VERSION } from "@demoman/compositor";
import type { ReplayResult } from "@demoman/replay-engine";
import { RESOLVER_VERSION } from "@demoman/resolver";
import type { SceneDocument } from "@demoman/scene-schema";
import type { TelemetryEvent } from "../telemetry-event.js";

/**
 * v9's telemetry list, per replay: frame-source mix, budget breaches and
 * degradations, occlusion pauses, replay-through rate. Counters only — this
 * event rides an upload envelope, and `sanitizeEvent` would drop anything
 * else on the way into the store.
 */
export function replayEvent(
  scene: SceneDocument,
  result: ReplayResult,
  ids: { id: string; at: string },
): TelemetryEvent {
  const c = result.counters;
  return {
    id: ids.id,
    producer: "replay",
    kind: "replay",
    sceneId: scene.meta.id,
    at: ids.at,
    data: {
      // outcome and reason are independent facts, not restatements of one
      // another: a run can execute every action and still fail to *store*
      // its bundle, which reports `outcome: "complete"` with a `reason`.
      // Neither is derived from the other here.
      outcome: result.outcome,
      // A stop reason is one of a fixed set; null becomes absence rather
      // than a string the sanitizer would have to allow.
      ...(result.reason === null ? {} : { reason: result.reason }),
      // A third independent fact: the store can refuse a bundle after a run
      // has already claimed its own stop reason (or none at all). `reason`
      // never gets overwritten to say so, so this is the only place that
      // information survives into telemetry — a boolean needs no allow-list
      // entry, and this is exactly the storage-exhaustion signal telemetry
      // could not otherwise see.
      storageRefused: result.storageRefused,
      actions: c.actions,
      completed: c.completed,
      replayThrough: Math.round(c.replayThrough * 1000) / 1000,
      keyframes: c.keyframes,
      motionSpans: c.motionSpans,
      motionFrames: c.motionFrames,
      droppedMotionFrames: c.droppedMotionFrames,
      surfaceMismatchFrames: c.surfaceMismatchFrames,
      encodeRefusedFrames: c.encodeRefusedFrames,
      budgetBreaches: c.budgetBreaches,
      keyframeOnlySpans: c.keyframeOnlySpans,
      occlusionPauses: c.occlusionPauses,
      occlusionMs: Math.round(c.occlusionMs),
      heapHighWater: Math.round(c.heapHighWater * 100) / 100,
      // SP1 left the motion stream's resolution on a 1x display as an open
      // question. Recording what actually arrived answers it from the field.
      motionWidth: c.motionWidth,
      motionHeight: c.motionHeight,
      dpr: c.dpr,
      viewportWidth: c.viewportWidth,
      viewportHeight: c.viewportHeight,
      durationMs: Math.round(c.durationMs),
      originClass: scene.meta.capture.originClass,
      resolverVersion: RESOLVER_VERSION,
      compositorVersion: COMPOSITOR_VERSION,
      ...(scene.meta.toolchain.captureVersion === null
        ? {}
        : { captureVersion: scene.meta.toolchain.captureVersion }),
    },
  };
}
