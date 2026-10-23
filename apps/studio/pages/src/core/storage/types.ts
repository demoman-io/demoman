/**
 * What the take's own motion recording managed to capture.
 *
 * This exists because `motionSpans: []` used to be the correct success
 * value for every capture bundle and is now ambiguous across five states:
 * the page never painted, the screencast was never accepted, the debugger
 * detached mid-take, the byte budget was spent, or the mux failed. Four are
 * failures and all five render identically. `degradations` cannot carry the
 * distinction to a person — its only two consumers are the compositor's
 * retiming and motion probing, neither of which is a surface.
 *
 * `motion: "none"` with `reason: null` is the honest static-page case.
 * `motion: "none"` with a reason is a failure. Nothing else can say that.
 */
export interface CaptureStatus {
  motion: "full" | "partial" | "none";
  /** Null only when nothing went wrong. */
  reason: string | null;
  /** Milliseconds of the take covered by a kept motion span. */
  coveredMs: number;
  /** Milliseconds the take ran, so coverage can be stated as a fraction. */
  takeMs: number;
}

export interface DemoFootprint {
  sceneId: string;
  /** keyframes + spans across both sources. */
  frameBytes: number;
  /** Spans only — what tier 3 could free. */
  spanBytes: number;
  outputBytes: number;
  hosted: boolean;
  recoverable: boolean;
  motion: "complete" | "reclaimed" | "keyframesOnly";
  /** The scene's own createdAt; reclaim orders oldest first by it. */
  createdAt: string;
}

export interface StorageSummary {
  budgetBytes: number;
  usedBytes: number;
  assetBytes: number;
  demos: DemoFootprint[];
}

export type DeleteStep =
  | "bundles"
  | "statuses"
  | "outputs"
  | "flags"
  | "hosted"
  | "scene"
  | "drift";

export interface DeleteResult {
  ok: boolean;
  steps: Array<{ step: DeleteStep; ok: boolean; error: string | null }>;
}
