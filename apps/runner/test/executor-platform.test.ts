// apps/runner/test/executor-platform.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { makeDiskTake } from "./disk-take.js";
import { ownVideo, WALLPAPERS_DIR } from "./fixture.js";

// arm64 Linux with the MCP server wired by hand (no setup): every call that
// needs a browser answers unsupportedPlatform before launching one, never a
// run of encodeRefused spans.
let home: string;
let executor: LocalExecutor;
let launches = 0;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-platform-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
    host: { platform: "linux", arch: "arm64" },
    launchFn: async () => {
      launches++;
      throw new Error("launched");
    },
  });
});

afterAll(async () => {
  await executor.close();
  await rm(home, { recursive: true, force: true });
});

describe("an executor on arm64 Linux", () => {
  it("refuses a snapshot by name, launching nothing", async () => {
    const out = await executor.request("snapshot", {
      url: "http://127.0.0.1:9/",
      callId: "arm-snapshot",
    });
    expect(JSON.stringify(out)).toContain('"reason":"unsupportedPlatform"');
    expect(launches).toBe(0);
  });

  it("refuses a run by name, launching nothing", async () => {
    const out = await executor.request("run", {
      video: ownVideo(),
      callId: "arm-run",
      script: {
        scriptVersion: 1,
        name: "x",
        target: "http://127.0.0.1:9/",
        steps: [{ do: "click", on: { text: "Go" } }],
      },
    });
    expect(out, JSON.stringify(out)).toMatchObject({
      ok: true,
      value: { outcome: "refusedBeforeRun", reason: "unsupportedPlatform" },
    });
    expect(launches).toBe(0);
  });

  it("refuses an export by name, launching nothing", async () => {
    const take = await makeDiskTake(home);
    const out = await executor.request("export", {
      takeId: take.takeId,
      callId: "arm-export",
    });
    expect(out, JSON.stringify(out)).toMatchObject({
      ok: true,
      value: { outcome: "refusedBeforeExport", reason: "unsupportedPlatform" },
    });
    expect(launches).toBe(0);
  });
});
