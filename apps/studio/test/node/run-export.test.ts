import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { exportTake } from "@demoman/runner/studio";
import { afterEach, describe, expect, it } from "vitest";
import { createRunExport } from "../../src/run-export.js";

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0))
    await rm(h, { recursive: true, force: true });
});

/** A run built over a fake `exportTake` that records what it was asked. */
async function runWith(settings: string | null) {
  const home = await mkdtemp(join(tmpdir(), "studio-run-export-"));
  homes.push(home);
  if (settings !== null) await writeFile(join(home, "settings.json"), settings);
  const asked: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const fake = (async (args: Record<string, unknown>) => {
    asked.push(args);
    return { outcome: "saved" };
  }) as unknown as typeof exportTake;
  const run = createRunExport({
    exportTake: fake,
    deps: {
      library: {} as never,
      session: {} as never,
      home,
      outDir: join(home, "out"),
      log: (l) => void logs.push(l),
      door: "studio",
    },
  });
  return { run, asked, logs, home };
}

// The Export quality setting itself is read by `exportTake` (the runner's
// executor-export test); this run only forwards the editor's pick.
describe("the Studio's run passes the editor's quality", () => {
  it("passes the quality the editor picked for this export", async () => {
    const { run, asked } = await runWith('{"exportQuality":"full"}');
    await run("t1", "mp4", "j1", () => {}, "share");
    expect(asked[0]).toMatchObject({
      takeId: "t1",
      fileType: "mp4",
      quality: "share",
    });
  });

  it("passes no quality when the editor sent none, so exportTake reads Settings", async () => {
    const { run, asked, logs } = await runWith('{"exportQuality":"full"}');
    await run("t1", "mp4", "j1", () => {});
    await run("t1", "gif", "j2", () => {});
    expect(asked.map((a) => "quality" in a)).toEqual([false, false]);
    expect(asked.map((a) => a.fileType)).toEqual(["mp4", "gif"]);
    expect(logs).toEqual([]);
  });
});
