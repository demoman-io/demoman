import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFailed } from "vitest";
import { messageOf } from "../src/report.js";

/** Where a failing picture test leaves what it judged. CI uploads this
 *  folder when a runner job fails (ci-ts.yml); it is gitignored. */
export const FAILURES_DIR = fileURLToPath(
  new URL("../test-failures/", import.meta.url),
);

/** A file on disk, or bytes the test holds, with the name to keep them by. */
export type Kept = string | { name: string; bytes: Uint8Array };

/**
 * Keeps `files` if the running test fails, as `<label>-<name>` in
 * FAILURES_DIR, so a red CI run arrives with the film it read. DEM-272: a
 * picture failure only the MP4 could explain arrived with none. Call it in
 * the test, once the files exist; `files` is read when the test fails. A
 * file that cannot be kept says so on stderr and does not hide the failure.
 */
export function keepOnFailure(label: string, files: () => Kept[]): void {
  onTestFailed(async () => {
    await mkdir(FAILURES_DIR, { recursive: true });
    for (const f of files()) {
      const name = typeof f === "string" ? basename(f) : f.name;
      const to = join(FAILURES_DIR, `${label}-${name}`);
      try {
        if (typeof f === "string") await copyFile(f, to);
        else await writeFile(to, f.bytes);
        console.error(`keepOnFailure: kept ${to}`);
      } catch (error) {
        console.error(
          `keepOnFailure: ${name} could not be kept (${messageOf(error)})`,
        );
      }
    }
  });
}
