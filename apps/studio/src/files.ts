import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const sha256 = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** A file's bytes, or null when there is no file. Any other failure throws. */
export async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * Written beside, then renamed over: a process killed mid-write leaves the
 * old file or the new one, never half of one. Throws naming the path; the
 * temp file is removed on the way out, and the old file is untouched.
 */
export async function writeAtomic(
  path: string,
  bytes: string | Uint8Array,
): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Owner-only: everything under the home is (audit run 1).
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    // The rename's failure is the one being reported; a temp file that will
    // not go either sits beside it in the same folder the error names.
    await rm(temp, { force: true }).catch(() => undefined);
    throw new Error(`could not write ${path} (${messageOf(error)})`);
  }
}

/**
 * Runs `work` after every earlier call with the same key has settled, so two
 * writes of one file never interleave their read-check-write. A failed call
 * does not stop the next; its failure belongs to its own caller.
 */
export function createChains(): <T>(
  key: string,
  work: () => Promise<T>,
) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return (key, work) => {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.then(work, work);
    // The tail only orders; the caller awaits `next` and sees its rejection.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}
