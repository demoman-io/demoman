import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderBytes } from "../../src/sizes.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-sizes-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("folderBytes", () => {
  it("sums every file under the folder, nested ones too", async () => {
    // Red: stop recursing into subfolders and the total is 8, not 15.
    await writeFile(join(dir, "a"), "abc");
    await writeFile(join(dir, "b"), "abcde");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "c"), "abcdefg");
    expect(await folderBytes(dir)).toBe(15);
  });

  it("a folder that is not there measures 0, as a vanished file does", async () => {
    expect(await folderBytes(join(dir, "gone"))).toBe(0);
  });

  // Root opens a mode-000 folder anyway, so there is nothing to refuse.
  it.skipIf(process.getuid?.() === 0)(
    "a subfolder that will not open throws libraryUnreadable naming it, never a low total",
    async () => {
      await writeFile(join(dir, "a"), "abc");
      const locked = join(dir, "locked");
      await mkdir(locked);
      await writeFile(join(locked, "b"), "abcde");
      await chmod(locked, 0o000);
      try {
        // Red: treat any readdir error as a vanished folder (return 0) —
        // the walk answers 3 and the take reads as smaller than it is.
        await expect(folderBytes(dir)).rejects.toMatchObject({
          reason: "libraryUnreadable",
          message: expect.stringContaining(
            `could not measure ${locked} (EACCES`,
          ),
        });
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );
});
