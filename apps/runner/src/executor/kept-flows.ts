// The kept files of a checkout, read as flows: a run joins the kept flow by
// its committed id instead of minting one (share-links design, seam 1).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FLOWS_DIR,
  type KeptReceipt,
  type KeptVideo,
  LEGACY_FLOWS_DIR,
  parseKept,
} from "@demoman/run-core";
import type { VideoRepo, VideoStore } from "./videos.js";

export type KeptEntry =
  | { file: string; kept: KeptVideo; migrated: KeptReceipt | null }
  | { file: string; unreadable: string };

/** Every `.json` DemoScript in the checkout, repo-relative: `.demoman/flows/`
 *  first, then the old `.demoman/videos/`, each sorted. A folder that is
 *  not there has none; any other read error throws. */
export async function repoFlowFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const dir of [FLOWS_DIR, LEGACY_FLOWS_DIR]) {
    try {
      const names = (await readdir(join(root, dir)))
        .filter((n) => n.endsWith(".json"))
        .sort();
      files.push(...names.map((n) => `${dir}/${n}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}

/** Every repo flow file, read. A flow named by two or more files is in
 *  `duplicates`, and so is a file name in both folders: neither file is
 *  then the flow's. */
export async function readKeptFlows(root: string): Promise<{
  entries: KeptEntry[];
  /** `sameName`: one file name in both folders, as two different flows. */
  duplicates: Array<{ flow: string; files: string[]; sameName?: true }>;
}> {
  const files = await repoFlowFiles(root);
  const entries: KeptEntry[] = [];
  const byFlow = new Map<string, string[]>();
  for (const file of files) {
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
  const duplicates: Array<{ flow: string; files: string[]; sameName?: true }> =
    [...byFlow]
      .filter(([, files]) => files.length > 1)
      .map(([flow, files]) => ({ flow, files }));
  // One name in both folders, as two flows: two recipes for one name. Both
  // ids are marked, so neither resolves to one of the two files.
  for (const e of entries) {
    if (!e.file.startsWith(`${FLOWS_DIR}/`)) continue;
    const name = e.file.slice(FLOWS_DIR.length + 1);
    const legacy = entries.find(
      (o) => o.file === `${LEGACY_FLOWS_DIR}/${name}`,
    );
    if (legacy === undefined) continue;
    const pair = [e.file, legacy.file];
    if (duplicates.some((d) => pair.every((f) => d.files.includes(f))))
      continue;
    for (const one of [e, legacy]) {
      const flow = "kept" in one ? one.kept.flow : name;
      if (!duplicates.some((d) => d.flow === flow && d.sameName === true))
        duplicates.push({ flow, files: pair, sameName: true });
    }
  }
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
    kept: {
      root,
      file: found.file,
      ...("key" in repo && { key: repo.key }),
    },
  });
