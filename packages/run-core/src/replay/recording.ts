// packages/run-core/src/replay/recording.ts (was apps/extension/src/adapters/recording.ts)
import type { FrameBundle } from "@demoman/compositor";
import type { AuthoredStep } from "@demoman/replay-engine";
import type { SceneDocument } from "@demoman/scene-schema";
import {
  againstRecording,
  type RecordingReport,
  type StepLink,
} from "./fidelity.js";

/** Where a run reads its recording from: the take's document and its capture
 *  frames. `null` means "no such thing stored"; a throw means the store
 *  refused, and the two are reported differently. */
export interface RecordingSource {
  getScene(takeId: string): Promise<SceneDocument | null>;
  getCaptureBundle(takeId: string): Promise<FrameBundle | null>;
}

export type LoadedRecording =
  | { ok: true; scene: SceneDocument; bundle: FrameBundle }
  | { ok: false; report: RecordingReport };

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function loadRecording(
  takeId: string,
  source: RecordingSource,
): Promise<LoadedRecording> {
  try {
    const scene = await source.getScene(takeId);
    if (scene === null)
      return { ok: false, report: { unavailable: "recordingDeleted" } };
    const bundle = await source.getCaptureBundle(takeId);
    if (bundle === null)
      return { ok: false, report: { unavailable: "noRecordingFrames" } };
    return { ok: true, scene, bundle };
  } catch (error) {
    // A store refusing a read is a fault (CLAUDE.md console levels): the
    // report carries the words, and the Errors list gets them too.
    console.error(
      `demoman run: the recording ${takeId} could not be read`,
      error,
    );
    return {
      ok: false,
      report: { unavailable: "recordingUnreadable", error: describe(error) },
    };
  }
}

export function recordingForRun(args: {
  loaded: LoadedRecording | null; // null: the run named no recording
  run: {
    scene: SceneDocument | null;
    bundle: FrameBundle | null;
    links: StepLink[];
    unlinked: string[];
  };
}): RecordingReport {
  if (args.loaded === null) return { unavailable: "noRecording" };
  if (!args.loaded.ok) return args.loaded.report;
  const { scene, bundle } = args.run;
  if (scene === null || bundle === null) return { unavailable: "noRunVideo" };
  // Report-only, like `filmForRun`: the run has already happened, so a
  // comparison that throws is said in the field and on the Errors list, and
  // never costs the caller its report.
  try {
    return againstRecording(
      { scene, bundle, links: args.run.links, unlinked: args.run.unlinked },
      args.loaded,
    );
  } catch (error) {
    console.error(
      "demoman run: the comparison with the recording failed",
      error,
    );
    return { unavailable: "checkFailed", error: describe(error) };
  }
}

/** Pairs an authored run's steps with the recording through each step's
 *  `recorded` (spec §3.2). Steps that reached no action are skipped; steps
 *  with no `recorded` are the agent's own, returned as `unlinked`. */
export function linksOf(steps: readonly AuthoredStep[]): {
  links: StepLink[];
  unlinked: string[];
} {
  const links: StepLink[] = [];
  const unlinked: string[] = [];
  for (const step of steps) {
    // A step that reached no action is not in the run's film to compare.
    if (step.actionId === null) continue;
    const recorded = "recorded" in step.step ? step.step.recorded : undefined;
    if (recorded === undefined) unlinked.push(step.actionId);
    else links.push({ runActionId: step.actionId, recordedActionId: recorded });
  }
  return { links, unlinked };
}
