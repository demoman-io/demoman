import { basename, join, resolve } from "node:path";
import { RECEIPT_DIR } from "@demoman/run-core";
import { readReceiptFile } from "./keep.js";
import { readKeptFlows } from "./kept-flows.js";

/**
 * `demoman refresh --check`: whether anything a repo flow shows can have
 * changed since its last recording, read from the receipts alone, so a
 * daily run can stop before it starts the app (spec 2026-11-03, decision 2).
 *
 * A flow is current when every path changed between the commit its receipt
 * was recorded at and HEAD is one a refresh writes itself: a repo flow's
 * outputs and report, or a receipt. Merging the refresh's own pull request
 * changes exactly those, so it never reads as new. Anything that cannot be
 * read is a flow to record, never a current one.
 */
export async function checkCurrent(
  args: { repoRoot: string; previous?: string },
  deps: {
    /** The paths git says changed between `commit` and HEAD. */
    changedSince(commit: string): Promise<string[] | { none: string }>;
  },
): Promise<{ current: boolean; lines: string[] }> {
  const root = resolve(args.repoRoot);
  const { entries } = await readKeptFlows(root);
  if (entries.length === 0) return { current: false, lines: ["no repo flows"] };
  const written = new Set<string>();
  for (const e of entries) {
    if ("unreadable" in e || e.kept.deliver === "files") continue;
    for (const o of e.kept.outputs) written.add(o.path);
    if (e.kept.report !== null) written.add(e.kept.report);
  }
  const ours = (p: string) => written.has(p) || p.startsWith(`${RECEIPT_DIR}/`);
  const lines: string[] = [];
  let current = true;
  const say = (line: string, isCurrent = false) => {
    lines.push(line);
    if (!isCurrent) current = false;
  };
  for (const e of entries) {
    const n = basename(e.file);
    if ("unreadable" in e) {
      say(`${e.file}: ${e.unreadable}`);
      continue;
    }
    const { kept } = e;
    // Where refresh reads it: beside the outputs for a files flow.
    const receiptFile =
      kept.deliver === "files"
        ? `${n.replace(/\.json$/, "")}.receipt.json`
        : `${RECEIPT_DIR}/${n}`;
    const from =
      kept.deliver === "files"
        ? args.previous === undefined
          ? null
          : resolve(args.previous)
        : root;
    const had =
      from === null
        ? ({ missing: true } as const)
        : await readReceiptFile(join(from, receiptFile), receiptFile);
    if ("missing" in had) {
      say(`${kept.name}: no receipt yet`);
      continue;
    }
    if ("detail" in had) {
      say(`${kept.name}: ${had.detail}`);
      continue;
    }
    const code = had.receipt.filmedCode;
    if ("none" in code) {
      say(`${kept.name}: its recording names no commit (${code.none})`);
      continue;
    }
    if (code.dirty) {
      say(`${kept.name}: recorded from uncommitted changes`);
      continue;
    }
    if (code.commit === null) {
      say(`${kept.name}: its recording names no commit`);
      continue;
    }
    const short = code.commit.slice(0, 7);
    const paths = await deps.changedSince(code.commit);
    if (!Array.isArray(paths)) {
      say(
        `${kept.name}: recorded at ${short}, which git cannot compare with HEAD (${paths.none})`,
      );
      continue;
    }
    const other = paths.filter((p) => !ours(p)).length;
    if (other === 0) say(`${kept.name}: current (recorded at ${short})`, true);
    else
      say(
        `${kept.name}: recorded at ${short}; ${other} other file${other === 1 ? "" : "s"} changed since`,
      );
  }
  lines.sort((a, b) => a.localeCompare(b));
  return { current, lines };
}
