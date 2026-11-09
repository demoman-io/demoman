import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A slow disk for settings.json reads: every save reads the file, then waits
// 100 ms before it writes, so two saves that are not ordered both read the
// file before either writes it.
const slow = vi.hoisted(() => ({ reads: 0 }));
vi.mock("../../src/files.js", async (importOriginal) => {
  const files = await importOriginal<typeof import("../../src/files.js")>();
  return {
    ...files,
    readIfPresent: async (path: string) => {
      const bytes = await files.readIfPresent(path);
      if (path.endsWith("settings.json")) {
        slow.reads++;
        await new Promise((r) => setTimeout(r, 100));
      }
      return bytes;
    },
  };
});

/** settings.ts loaded afresh: its own in-process queue, as in another
 *  process (setup beside an open Studio). */
async function anotherProcess() {
  vi.resetModules();
  return import("../../src/settings.js");
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-settings-"));
  slow.reads = 0;
});
afterEach(() => rm(home, { recursive: true, force: true }));

describe("writeSetting across processes", () => {
  // Red (DEM-87): saves queued per process only. Setup's save and the
  // Studio's both read the file, and the second write drops the first key.
  it("two processes saving different keys keep both", async () => {
    const setup = await anotherProcess();
    const studio = await anotherProcess();
    // Premise: two module instances, so two separate queues.
    expect(setup.writeSetting).not.toBe(studio.writeSetting);
    const answers = await Promise.all([
      setup.writeSetting(home, "pullRequests", "attach"),
      studio.writeSetting(home, "exportQuality", "share"),
    ]);
    expect(answers).toEqual([{}, {}]);
    // Premise: both saves read the file through the slow read.
    expect(slow.reads).toBe(2);
    expect(
      JSON.parse(await readFile(join(home, "settings.json"), "utf8")),
    ).toEqual({ pullRequests: "attach", exportQuality: "share" });
  });

  it("a lock that cannot be taken is a failed save, never a saved one", async () => {
    const { writeSetting } = await anotherProcess();
    // A live holder (this process) that never lets go.
    await writeFile(join(home, "settings.json.lock"), `${process.pid} held\n`);
    const answer = await writeSetting(home, "pullRequests", "attach");
    expect(answer).toMatchObject({ reason: "studioUnwritable" });
    expect((answer as { detail: string }).detail).toMatch(
      /Pull requests setting was not saved: .*settings\.json\.lock.*process \d+/,
    );
    await expect(
      readFile(join(home, "settings.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
