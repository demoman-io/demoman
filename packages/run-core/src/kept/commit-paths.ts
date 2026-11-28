// The repo paths a `commit` flow may write: one answer, read by refresh when
// it writes them and by whatever later checks a hand-off against them.

import type { KeptVideo } from "./file.js";
import { RECEIPT_DIR, screensDirOf } from "./receipt.js";

/** `keptFile` is the flow's file in the repo, as `readKeptFlows` gives it.
 *  `files` is every file written (outputs, report, receipt); `screens` is
 *  the receipt's folder of screen images. A `files` flow writes outside the
 *  repo, so asking for its paths is a mistake in the caller, not input. */
export function commitPathsOf(
  kept: KeptVideo,
  keptFile: string,
): { files: string[]; receipt: string; screens: string } {
  if (kept.deliver !== "commit")
    throw new Error(`commitPathsOf: ${kept.name} delivers files, not a commit`);
  const receipt = `${RECEIPT_DIR}/${keptFile.split("/").pop()}`;
  return {
    files: [
      ...kept.outputs.map((o) => o.path),
      ...(kept.report === null ? [] : [kept.report]),
      receipt,
    ],
    receipt,
    screens: `${RECEIPT_DIR}/${screensDirOf(receipt)}`,
  };
}
