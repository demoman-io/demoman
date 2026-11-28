import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RefreshResult } from "@demoman/runner/package";
import { toCommit } from "./deliver.js";

export const HANDOFF_VERSION = 1;

/** What the refresh job leaves for the deliver job: the result, and the
 *  files the commit takes, each stored under a plain numbered name. */
export type HandOff = {
  handoffVersion: 1;
  demoman: string;
  commit: string;
  named: boolean;
  result: RefreshResult;
  files: { path: string; stored: string }[];
  folders: string[];
};

const said = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export async function writeHandOff(
  dir: string,
  a: {
    repoRoot: string;
    result: RefreshResult;
    named: boolean;
    commit: string;
    version: string;
  },
): Promise<{ written: number } | { failed: string }> {
  const exists = await stat(dir).then(
    () => true,
    () => false,
  );
  if (exists) return { failed: `${dir} already exists` };
  let tmp: string | null = null;
  let step = "creating the temporary folder";
  try {
    tmp = await mkdtemp(join(dirname(dir), ".demoman-handoff-"));
    await mkdir(join(tmp, "files"));
    const files: HandOff["files"] = [];
    const folders: string[] = [];
    // Every carried file is also a numbered copy: names under the hand-off never start with a dot.
    const carry = async (path: string) => {
      const stored = `files/${files.length}`;
      step = `copying ${path}`;
      await copyFile(join(a.repoRoot, path), join(tmp as string, stored));
      files.push({ path, stored });
    };
    for (const v of a.result.videos.filter(toCommit)) {
      for (const out of v.outputs) {
        step = `reading ${out}`;
        const s = await stat(join(a.repoRoot, out)).catch(() => null);
        if (!s)
          return await undo(
            tmp,
            `${out}, which refresh says it wrote, is not in the checkout`,
          );
        if (!s.isDirectory()) {
          await carry(out);
          continue;
        }
        folders.push(out);
        const entries = await readdir(join(a.repoRoot, out), {
          withFileTypes: true,
        });
        for (const e of entries)
          if (e.isFile()) await carry(`${out}/${e.name}`);
      }
    }
    step = "writing handoff.json";
    const handoff: HandOff = {
      handoffVersion: HANDOFF_VERSION,
      demoman: a.version,
      commit: a.commit,
      named: a.named,
      result: a.result,
      files,
      folders,
    };
    await writeFile(join(tmp, "handoff.json"), JSON.stringify(handoff));
    step = `moving the hand-off to ${dir}`;
    await rename(tmp, dir);
    return { written: files.length };
  } catch (e) {
    return await undo(tmp, `${step}: ${said(e)}`);
  }
}

async function undo(tmp: string | null, failed: string) {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  return { failed };
}
