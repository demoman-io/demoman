import {
  type FrameBundle,
  planScene,
  resolvePlan,
  sampleCursor,
  toOutputMs,
  type Vec,
} from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";

export type RecordingUnavailable =
  | "noRecording"
  | "recordingDeleted"
  | "noRecordingFrames"
  | "recordingUnreadable"
  | "noRunVideo"
  /** The comparison itself threw. The run is unaffected; `error` says what. */
  | "checkFailed";
export interface StepLink {
  runActionId: string;
  recordedActionId: string;
}
export interface RecordingStep {
  runActionId: string;
  recordedActionId: string;
  landing:
    | { dx: number; dy: number }
    | { unavailable: "noRecordedRect" | "noRunRect" };
  cursor:
    | { distancePx: number; recorded: Vec; run: Vec }
    | {
        unavailable:
          | "noTrail"
          | "noTrailNearStep"
          | "noRunCursor"
          | "notInRunVideo";
      };
  pace:
    | { recordedGapMs: number; runGapMs: number; diffMs: number }
    | { unavailable: "firstStep" | "notInRecordingVideo" | "notInRunVideo" };
}
export type RecordingReport =
  | { unavailable: RecordingUnavailable; error?: string }
  | {
      recordingTakeId: string;
      steps: RecordingStep[];
      notInRecording: string[];
    };

/** A trail sample farther than this from a step's moment says nothing about it. */
export const TRAIL_WINDOW_MS = 250;

/** Output time of each marked action, through the film's own retiming. */
function filmTimes(
  scene: SceneDocument,
  bundle: FrameBundle,
): Map<string, number> {
  const timeline = resolvePlan(planScene(scene), bundle, scene).timeline;
  return new Map(
    bundle.markers.map((m) => [
      m.actionId,
      toOutputMs(timeline, m.sourceTimeMs),
    ]),
  );
}

function nearestSample(samples: FrameBundle["cursorSamples"], atMs: number) {
  let best: (typeof samples)[number] | null = null;
  for (const s of samples) {
    if (
      best === null ||
      Math.abs(s.sourceTimeMs - atMs) < Math.abs(best.sourceTimeMs - atMs)
    )
      best = s;
  }
  return best;
}

export function againstRecording(
  run: {
    scene: SceneDocument;
    bundle: FrameBundle;
    links: StepLink[];
    unlinked: string[];
  },
  recording: { scene: SceneDocument; bundle: FrameBundle },
): RecordingReport {
  const recTimes = filmTimes(recording.scene, recording.bundle);
  const runTimes = filmTimes(run.scene, run.bundle);
  const recAction = new Map(recording.scene.actions.map((a) => [a.id, a]));
  // Not `inScreenSpace`: a run's rect is subtracted from the recording's,
  // both in the same page's own px, and the threshold is in page px too.
  const runRect = new Map(
    run.bundle.anchorRects.map((a) => [a.actionId, a.rect]),
  );
  const runMarker = new Map(
    run.bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
  );
  const trail = recording.bundle.cursorSamples;

  // A link naming an action the recording does not have cannot be measured
  // against anything: it is reported with the agent's own steps, not as a
  // step whose rect or trail is "missing" (it is the action that is).
  const notInRecording = [...run.unlinked];
  const linked: StepLink[] = [];
  for (const link of run.links) {
    if (recAction.has(link.recordedActionId)) linked.push(link);
    else notInRecording.push(link.runActionId);
  }

  // Pace pairs each step with the previous LINKED step, so an agent-added
  // step between two linked ones puts its time into `runGapMs` and `diffMs`;
  // `notInRecording` tells the reader which steps are the agent's.
  //
  // Both sides are measured as their films show them (`filmTimes`), and the
  // recording's film carries the author's own edits: a hold they lengthened
  // or a stretch they cut changes `recordedGapMs`. So pace drift includes
  // those edits — it is "how differently the two videos are paced", not
  // "how differently the page ran". And a step the author cut has no time
  // of its own on film: `toOutputMs` clamps its marker to the seam, so a gap
  // measured to or from a cut step is measured to that seam.
  let previous: StepLink | null = null;
  const steps: RecordingStep[] = linked.map((link) => {
    const recorded = recAction.get(link.recordedActionId);
    const rr = runRect.get(link.runActionId);
    const landing: RecordingStep["landing"] =
      recorded?.rect === undefined
        ? { unavailable: "noRecordedRect" }
        : rr === undefined
          ? { unavailable: "noRunRect" }
          : { dx: rr.x - recorded.rect.x, dy: rr.y - recorded.rect.y };

    // `noTrail` outranks `notInRunVideo`: a recording with no trail cannot
    // be compared however the run fared, so the reason that holds for every
    // step of the take is named first.
    let cursor: RecordingStep["cursor"];
    const markedAt = runMarker.get(link.runActionId);
    if (trail.length === 0) cursor = { unavailable: "noTrail" };
    else if (markedAt === undefined) cursor = { unavailable: "notInRunVideo" };
    else {
      const near =
        recorded === undefined
          ? null
          : nearestSample(trail, recorded.timestamp);
      const runAt = sampleCursor(run.bundle.cursorSamples, markedAt);
      if (
        near === null ||
        Math.abs(near.sourceTimeMs - (recorded?.timestamp ?? 0)) >
          TRAIL_WINDOW_MS
      ) {
        cursor = { unavailable: "noTrailNearStep" };
      } else if (runAt === null) {
        cursor = { unavailable: "noRunCursor" };
      } else {
        const rec: Vec = { x: near.x, y: near.y };
        cursor = {
          distancePx: Math.hypot(runAt.x - rec.x, runAt.y - rec.y),
          recorded: rec,
          run: runAt,
        };
      }
    }

    let pace: RecordingStep["pace"];
    const recNow = recTimes.get(link.recordedActionId);
    const runNow = runTimes.get(link.runActionId);
    if (previous === null) pace = { unavailable: "firstStep" };
    else if (
      recNow === undefined ||
      recTimes.get(previous.recordedActionId) === undefined
    )
      pace = { unavailable: "notInRecordingVideo" };
    else if (
      runNow === undefined ||
      runTimes.get(previous.runActionId) === undefined
    )
      pace = { unavailable: "notInRunVideo" };
    else {
      const recordedGapMs =
        recNow - (recTimes.get(previous.recordedActionId) as number);
      const runGapMs = runNow - (runTimes.get(previous.runActionId) as number);
      pace = { recordedGapMs, runGapMs, diffMs: runGapMs - recordedGapMs };
    }
    previous = link;
    return {
      runActionId: link.runActionId,
      recordedActionId: link.recordedActionId,
      landing,
      cursor,
      pace,
    };
  });

  return {
    recordingTakeId: recording.scene.meta.id,
    steps,
    notInRecording,
  };
}
