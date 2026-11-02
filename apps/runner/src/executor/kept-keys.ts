import { stat } from "node:fs/promises";
import { messageOf } from "../report.js";
import type { RepoRead } from "./repo.js";
import type { VideoStore } from "./videos.js";

export interface KeptKeyFailure {
  flow: string;
  name: string;
  root: string;
  why: string;
}

/** Gives every kept mark without a repo key the key of its root's repo.
 *  Marks written before the key was recorded, and marks whose repo could
 *  not be read at write time, have none. A root that is gone is skipped
 *  (`keptOf` already treats it as not kept); every other miss is named in
 *  `failed`, and the mark is left as it was. */
export async function keyKeptMarks(
  videos: VideoStore,
  read: (dir: string) => Promise<RepoRead>,
): Promise<{ keyed: number; failed: KeptKeyFailure[] }> {
  let keyed = 0;
  const failed: KeptKeyFailure[] = [];
  for (const rec of await videos.list()) {
    if (!("kept" in rec) || !rec.kept || rec.kept.key !== undefined) continue;
    const mark = { root: rec.kept.root, file: rec.kept.file };
    const miss = (why: string) =>
      failed.push({ flow: rec.id, name: rec.name, root: mark.root, why });
    try {
      await stat(mark.root);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT")
        miss(`its root cannot be checked (${messageOf(error)})`);
      continue;
    }
    try {
      const r = await read(mark.root);
      if (!r.ok) {
        miss(r.none);
        continue;
      }
      const set = await videos.setKeptKey(rec.id, mark, r.repo.key);
      if (set.ok) keyed++;
      else miss(`the mark could not be keyed (${set.reason})`);
    } catch (error) {
      miss(messageOf(error));
    }
  }
  return { keyed, failed };
}
