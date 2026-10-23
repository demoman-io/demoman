import type { SceneAspect } from "@demoman/scene-schema";
import type { ExportAnswer } from "./report.js";
import type { FileType } from "./target.js";

/** One export a take has made, as the library's `outputs.json` records it. */
export interface OutputRecord {
  /** The file, or the stills folder. */
  path: string;
  fileType: FileType;
  aspect: SceneAspect;
  /** Stills: the sum of the PNGs. */
  byteLength: number;
  /** ISO. */
  renderedAt: string;
  /** `sceneDigest(scene)` of the scene rendered. */
  sceneDigest: string;
  /** The saved answer, summary included. */
  report: ExportAnswer;
}

/** A record plus whether its file is still on disk at read time. */
export type OutputListing = OutputRecord & { exists: boolean };
