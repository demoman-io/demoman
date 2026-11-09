import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A slow disk for settings.json: every read takes 100 ms more, and each read
// and write is logged in order. `duringRead` runs inside the next read.
const disk = vi.hoisted(() => ({
  log: [] as string[],
  duringRead: null as null | (() => Promise<void>),
}));
vi.mock("../../src/files.js", async (importOriginal) => {
  const files = await importOriginal<typeof import("../../src/files.js")>();
  return {
    ...files,
    readIfPresent: async (path: string) => {
      const bytes = await files.readIfPresent(path);
      if (path.endsWith("settings.json")) {
        disk.log.push("read");
        const during = disk.duringRead;
        disk.duringRead = null;
        await during?.();
        await new Promise((r) => setTimeout(r, 100));
      }
      return bytes;
    },
    writeAtomic: async (path: string, bytes: string | Uint8Array) => {
      await files.writeAtomic(path, bytes);
      if (path.endsWith("settings.json")) disk.log.push("write");
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
  disk.log = [];
  disk.duringRead = null;
});
afterEach(() => rm(home, { recursive: true, force: true }));

describe("writeSetting across processes", () => {
  // Red (DEM-87): saves queued per process only. Setup's save and the
  // Studio's both read the file, and the second write drops the first key
  // (the log reads read, read, write, write).
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
    // Each read-modify-write ran whole before the other began.
    expect(disk.log).toEqual(["read", "write", "read", "write"]);
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

  // Red (review): a release that failed after the write answered the save
  // as refused, while the file held the new value.
  it("a save whose lock was replaced while held stands, and the lock is said", async () => {
    const { writeSetting } = await anotherProcess();
    const lock = join(home, "settings.json.lock");
    disk.duringRead = () => writeFile(lock, "1 someone-else\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await writeSetting(home, "pullRequests", "attach")).toEqual({});
      // Premise: the lock really was replaced during the save.
      expect(await readFile(lock, "utf8")).toBe("1 someone-else\n");
      expect(
        JSON.parse(await readFile(join(home, "settings.json"), "utf8")),
      ).toEqual({ pullRequests: "attach" });
      expect(warn.mock.calls.flat().join("\n")).toMatch(
        /Pull requests setting: .*no longer this process's lock/,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
