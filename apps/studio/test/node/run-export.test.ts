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

describe("the studio's run reads Export quality on each export", () => {
  it("passes full for an MP4 when the file says full, and follows a later change", async () => {
    const { run, asked, home } = await runWith('{"exportQuality":"full"}');
    await run("t1", "mp4", "j1", () => {});
    expect(asked[0]).toMatchObject({ takeId: "t1", quality: "full" });
    // Same home, the file changed: the next export sees it.
    await writeFile(join(home, "settings.json"), '{"exportQuality":"share"}');
    await run("t1", "mp4", "j2", () => {});
    expect(asked[1]).toMatchObject({ quality: "share" });
  });

  it("no file exports at share, with nothing logged", async () => {
    const { run, asked, logs } = await runWith(null);
    await run("t1", "mp4", "j1", () => {});
    expect(asked[0]?.quality).toBe("share");
    expect(logs).toEqual([]);
  });

  it("unreadable settings export at share and say why in the log", async () => {
    const { run, asked, logs } = await runWith("{");
    await run("t1", "mp4", "j1", () => {});
    expect(asked[0]?.quality).toBe("share");
    expect(logs.join("\n")).toContain("settings.json is not valid JSON");
    expect(logs.join("\n")).toContain("Sharing");
  });

  it("a GIF and stills are asked without a quality (they refuse one)", async () => {
    const { run, asked } = await runWith('{"exportQuality":"full"}');
    await run("t1", "gif", "j1", () => {});
    await run("t1", "stills", "j2", () => {});
    expect(asked.map((a) => "quality" in a)).toEqual([false, false]);
    expect(asked.map((a) => a.fileType)).toEqual(["gif", "stills"]);
  });
});
