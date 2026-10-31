// Stopgap until keep writes receipts (share-links Task 3): the runner still
// keeps screens and `from` in the file, as the v1 format held them.
import {
  type KeptScreens,
  type KeptVideo,
  serializeKept,
  serializeReceipt,
} from "@demoman/run-core";

export type KeptFrom = {
  videoId: string;
  takeId: string;
  recordedRevision: string;
};

/** `k` as a v1 file: no flow or deliver, screens and `from` inside. */
export function serializeKeptV1(
  k: KeptVideo,
  screens: KeptScreens,
  from: KeptFrom,
): string {
  const {
    flow: _flow,
    deliver: _deliver,
    ...rest
  } = JSON.parse(serializeKept(k));
  const receipt = JSON.parse(
    serializeReceipt({
      receiptVersion: 1,
      flow: k.flow,
      video: from.takeId,
      filmedCode: { none: "v1 stopgap" },
      screens,
      recordedRevision: from.recordedRevision,
    }),
  );
  return `${JSON.stringify({ ...rest, keptVersion: 1, screens: receipt.screens, from }, null, 2)}\n`;
}
