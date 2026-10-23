import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SavedTo, StillsSavedTo } from "@demoman/run-core";
import { messageOf } from "../report.js";

/** Chrome's own ceiling for `conflictAction: "uniquify"`. */
export const MAX_UNIQUIFY = 100;

const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/**
 * The CLI's save, shaped like the extension's (`downloads.ts`): `name` if it
 * is free, else Chrome's uniquify rule — `name (1).ext`, `name (2).ext` — so
 * an export never overwrites a file. Each candidate is created exclusively
 * (`wx`), so two saves racing for one name cannot both win it.
 *
 * Answers `failed` with the path and the OS's words for every refusal, and
 * removes a file it started and could not finish: a half-written MP4 at a
 * path the answer does not name is a file nobody knows is broken.
 */
export async function saveExport(
  dir: string,
  name: string,
  bytes: Uint8Array,
): Promise<SavedTo> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    return {
      kind: "failed",
      error: `could not create the export folder ${dir} (${messageOf(error)})`,
    };
  }
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  for (let n = 0; n <= MAX_UNIQUIFY; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    const path = join(dir, candidate);
    try {
      await writeFile(path, bytes, { flag: "wx" });
      return { kind: "saved", downloadId: null, savedAs: candidate, path };
    } catch (error) {
      if (code(error) === "EEXIST") continue;
      const said = `could not write ${path} (${messageOf(error)})`;
      // ENOENT/EACCES: nothing was created. Anything later (ENOSPC) may have
      // left a partial file under this name.
      try {
        await rm(path, { force: true });
        return { kind: "failed", error: said };
      } catch (removing) {
        return {
          kind: "failed",
          error: `${said} — and the partial file could not be removed (${messageOf(removing)})`,
        };
      }
    }
  }
  return {
    kind: "failed",
    error: `${dir} already holds ${name} and ${MAX_UNIQUIFY} numbered copies of it — move or delete some, then export again`,
  };
}

/**
 * Stills are one file per step, so they get a folder of their own, named
 * by the same uniquify rule `saveExport` gives a file: `name`, then
 * `name (1)`... The folder is created exclusively (`mkdir` without
 * `recursive` refuses one that exists), so two exports racing for a name
 * cannot share it. A still that cannot be written stops the save, and the
 * answer names the stills on disk and the ones not written: a half-full
 * folder never reads as saved. What was written stays, because each file
 * is a whole PNG; the one that failed is removed, since it may be half of
 * one.
 */
export async function saveStillsFolder(
  dir: string,
  folderName: string,
  files: { name: string; bytes: Uint8Array }[],
  write: (path: string, bytes: Uint8Array) => Promise<void> = (path, bytes) =>
    writeFile(path, bytes, { flag: "wx" }),
): Promise<StillsSavedTo> {
  // A still's name becomes a path inside the new folder; one that is not a
  // plain file name could write outside it. Refuse before creating anything.
  for (const file of files) {
    if (
      file.name === "." ||
      file.name === ".." ||
      basename(file.name) !== file.name
    ) {
      return {
        kind: "failed",
        error: `refused to save a still named ${JSON.stringify(file.name)}: a still's name must be a plain file name, not a path`,
      };
    }
  }
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    return {
      kind: "failed",
      error: `could not create the export folder ${dir} (${messageOf(error)})`,
    };
  }
  let folder: string | null = null;
  for (let n = 0; n <= MAX_UNIQUIFY && folder === null; n++) {
    const candidate = join(dir, n === 0 ? folderName : `${folderName} (${n})`);
    try {
      await mkdir(candidate);
      folder = candidate;
    } catch (error) {
      if (code(error) === "EEXIST") continue;
      return {
        kind: "failed",
        error: `could not create ${candidate} (${messageOf(error)})`,
      };
    }
  }
  if (folder === null) {
    return {
      kind: "failed",
      error: `${dir} already holds ${folderName} and ${MAX_UNIQUIFY} numbered copies of it — move or delete some, then export again`,
    };
  }
  const written: string[] = [];
  for (const [index, file] of files.entries()) {
    const path = join(folder, file.name);
    try {
      await write(path, file.bytes);
      written.push(file.name);
    } catch (error) {
      let said = `could not write ${path} (${messageOf(error)})`;
      if (code(error) === "EEXIST") {
        // The file in the way is not ours to remove: it may be an earlier
        // still of this very folder, which `written` lists.
        said = `could not write ${path} (the name was already taken in this folder)`;
      } else {
        try {
          await rm(path, { force: true });
        } catch (removing) {
          said += ` — and the partial file could not be removed (${messageOf(removing)})`;
        }
      }
      return {
        kind: "failed",
        error: said,
        partial: {
          folder,
          written,
          notWritten: files.slice(index).map((f) => f.name),
        },
      };
    }
  }
  return {
    kind: "saved",
    path: folder,
    files: files.map((f) => ({ name: f.name, byteLength: f.bytes.byteLength })),
  };
}

/**
 * The export folder, made if missing and checked writable, BEFORE anything
 * renders: a bad `--out-dir` used to be found only after minutes of render.
 * Null when it can take a file; else `failed` with the folder and the OS's
 * words. (A folder that passes can still refuse the file later — a full
 * disk — and `saveExport` says that one.)
 */
export async function checkExportFolder(
  dir: string,
): Promise<Extract<SavedTo, { kind: "failed" }> | null> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    return {
      kind: "failed",
      error: `could not create the export folder ${dir} (${messageOf(error)})`,
    };
  }
  try {
    await access(dir, constants.W_OK);
  } catch (error) {
    return {
      kind: "failed",
      error: `the export folder ${dir} cannot be written to (${messageOf(error)})`,
    };
  }
  return null;
}
