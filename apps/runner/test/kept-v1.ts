// A kept file as the runner writes it until receipts land (share-links
// Task 3): the recipe with `screens` and `from` beside it, as v1 held them.
import { type KeptScreens, type KeptVideo, parseKept } from "@demoman/run-core";
import { type KeptFrom, serializeKeptV1 } from "../src/executor/kept-v1.js";

export type V1Kept = KeptVideo & { screens: KeptScreens; from: KeptFrom };

export const FLOW_ID = "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90";

export const writeV1 = (v: V1Kept): string =>
  serializeKeptV1(v, v.screens, v.from);

export function readV1(text: string, file: string): V1Kept {
  const parsed = parseKept(text, file);
  if (!parsed.ok) throw new Error(parsed.detail);
  if (parsed.migrated === null)
    throw new Error(`${file} carries no screens: it is not a v1 file`);
  const m = parsed.migrated;
  return {
    ...parsed.kept,
    screens: m.screens,
    from: {
      videoId: m.flow,
      takeId: m.video,
      recordedRevision: m.recordedRevision ?? "",
    },
  };
}
