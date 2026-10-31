// The kept files of a checkout, read as flows: a run joins the kept flow by
// its committed id instead of minting one (share-links design, seam 1).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  KEPT_DIR,
  type KeptReceipt,
  type KeptVideo,
  parseKept,
} from "@demoman/run-core";
import type { VideoRepo, VideoStore } from "./videos.js";

export type KeptEntry =
  | { file: string; kept: KeptVideo; migrated: KeptReceipt | null }
  | { file: string; unreadable: string };

/** Every `.json` in the checkout's kept folder, sorted. A flow named by two
 *  or more files is in `duplicates`: neither file is then the flow's. */
export async function readKeptFlows(root: string): Promise<{
  entries: KeptEntry[];
  duplicates: Array<{ flow: string; files: string[] }>;
}> {
  let names: string[] = [];
  try {
    names = (await readdir(join(root, KEPT_DIR)))
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entries: KeptEntry[] = [];
  const byFlow = new Map<string, string[]>();
  for (const name of names) {
    const file = `${KEPT_DIR}/${name}`;
    let text: string;
    try {
      text = await readFile(join(root, file), "utf8");
    } catch (error) {
      entries.push({
        file,
        unreadable: `${file} could not be read (${error instanceof Error ? error.message : String(error)})`,
      });
      continue;
    }
    const parsed = parseKept(text, file);
    if (!parsed.ok) {
      entries.push({ file, unreadable: parsed.detail });
      continue;
    }
    entries.push({ file, kept: parsed.kept, migrated: parsed.migrated });
    byFlow.set(parsed.kept.flow, [
      ...(byFlow.get(parsed.kept.flow) ?? []),
      file,
    ]);
  }
  const duplicates = [...byFlow]
    .filter(([, files]) => files.length > 1)
    .map(([flow, files]) => ({ flow, files }));
  return { entries, duplicates };
}

/** One line per file that would not read: its path and why. */
export const unreadableOf = (entries: KeptEntry[]): string[] =>
  entries.flatMap((e) => ("unreadable" in e ? [e.unreadable] : []));

export async function findKept(
  root: string,
  flowId: string,
): Promise<
  | { file: string; kept: KeptVideo }
  | { duplicate: string[] }
  | { unreadable: string[] }
  | null
> {
  const { entries, duplicates } = await readKeptFlows(root);
  const dup = duplicates.find((d) => d.flow === flowId);
  if (dup !== undefined) return { duplicate: dup.files };
  for (const e of entries) {
    if ("kept" in e && e.kept.flow === flowId) {
      return { file: e.file, kept: e.kept };
    }
  }
  // No file keeps this flow, but one that will not read might.
  const unreadable = unreadableOf(entries);
  if (unreadable.length > 0) return { unreadable };
  return null;
}

export const adoptKept = (
  videos: VideoStore,
  root: string,
  found: { file: string; kept: KeptVideo },
  repo: VideoRepo,
): ReturnType<VideoStore["adopt"]> =>
  videos.adopt({
    id: found.kept.flow,
    name: found.kept.name,
    repo,
    startPage: found.kept.script.target,
    kept: { root, file: found.file },
  });
