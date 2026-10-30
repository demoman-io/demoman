import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportAnswer } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { makeFixtureTake, serveFixtureApp, WALLPAPERS_DIR } from "./fixture.js";
import { sampleMp4 } from "./mp4-probe.js";

/**
 * The one end-to-end proof that a CLI export takes the 4K tier from the
 * keyframes. `executor-export.test.ts` caps its executor at 1080p
 * (`mp4MaxTier`) to render landscape in software at a quarter of the
 * pixels; this executor sets no cap, as production never does.
 *
 * Timing: measured 2026-10-17 inside the full runner suite (M-series Mac,
 * headless): the fixture take's run about 6 s, the 16:9 export 114 s (128 s at the
 * slowest on 2026-10-17's first pass), x5 for CI (fff4505) with margin.
 */
const RUN_MS = 31_000;
const EXPORT_4K_MS = 900_000;

const MAGENTA: [number, number, number] = [255, 0, 255];
const GREEN: [number, number, number] = [0, 200, 83];

let app: { url: string; close(): void };
let home: string;
let executor: LocalExecutor;
let takeId: string;

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-export-4k-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
  takeId = await makeFixtureTake(executor, { home, url: app.url });
}, RUN_MS);

afterAll(async () => {
  await executor.close();
  app.close();
  await rm(home, { recursive: true, force: true });
});

describe("an uncapped export", () => {
  it(
    "saves 16:9 at 3840x2160, with the logo and the kit's background",
    async () => {
      const out = await executor.request("export", {
        takeId,
        callId: "e-4k",
        // The 4K tier is `full`; the default export is share-sized.
        quality: "full",
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as ExportAnswer;
      expect(answer).toMatchObject({ outcome: "saved", aspect: "16:9" });
      if (answer.outcome !== "saved" || answer.fileType === "stills") return;
      expect([answer.width, answer.height]).toEqual([3840, 2160]);
      const read = await sampleMp4(await readFile(answer.file.path), {
        colors: [MAGENTA, GREEN],
        blockPoints: [[0.01, 0.5]],
      });
      expect([read.width, read.height]).toEqual([3840, 2160]);
      const most = (i: number) =>
        Math.max(...read.readings.map((r) => r.colorCounts[i] ?? 0));
      expect(most(0), "logo (magenta) pixels").toBeGreaterThan(50);
      const margin = read.readings[0]?.blocks[0] as [number, number, number];
      expect(
        Math.max(...margin.map((c, k) => Math.abs(c - (GREEN[k] as number)))),
        JSON.stringify(margin),
      ).toBeLessThan(24);
    },
    EXPORT_4K_MS,
  );
});
