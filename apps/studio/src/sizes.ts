import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LibraryError } from "@demoman/runner/studio";
import { isMissing, messageOf } from "./files.js";

/**
 * Bytes on disk under `dir`: every regular file, nested ones too. Symlinks
 * are measured as links (lstat), never followed, so a link out of the
 * folder cannot count someone else's bytes or loop. A file that vanishes
 * during the walk (a run pruning, a delete) is gone and counts as 0; any
 * other error throws, because a size that silently came out low would read
 * as a smaller take.
 */
export async function folderBytes(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw unmeasured(dir, error);
  }
  // Every entry at once: a take's frames are hundreds of files, and one
  // lstat after another made each listing wait on all of them in turn.
  const sizes = await Promise.all(
    names.map(async (name): Promise<number> => {
      const path = join(dir, name);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error) {
        if (isMissing(error)) return 0;
        throw unmeasured(path, error);
      }
      if (info.isDirectory()) return folderBytes(path);
      return info.isFile() ? info.size : 0;
    }),
  );
  return sizes.reduce((sum, n) => sum + n, 0);
}

const unmeasured = (path: string, error: unknown): LibraryError =>
  new LibraryError(
    "libraryUnreadable",
    `could not measure ${path} (${messageOf(error)})`,
  );
