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
