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
 * Auto at the uncapped tier, encoded for real. `executor-export.test.ts`
 * caps its executor at 1080p, and executor-export-4k.test.ts proves
 * 16:9 at 3840x2160; Auto is the recording's shape plus an even margin, so
 * its 4K frame is taller than 16:9 and sits near the H.264 level 5.2 limit
 * `autoTarget` fits it under (36,864 macroblocks). A change that let that
 * frame past the limit would have Chrome's encoder refuse every real Auto
 * export, and only an encode of it can say so (review, 2026-10-17). Its own
 * file, so it runs beside the 16:9 proof rather than after it.
 *
 * Timing: about 6 s for the run and an export of the same order as the 16:9
 * one (114-128 s here, 2026-10-17), x5 for CI (fff4505) with margin.
 */
const RUN_MS = 31_000;
const EXPORT_4K_MS = 900_000;

/** H.264 level 5.2's frame size, which `autoTarget` keeps Auto under. */
const MAX_MACROBLOCKS = 36_864;
/** `LANDSCAPE_1440P`'s width: an Auto frame wider than this took the 4K tier. */
const TIER_1440_WIDTH = 2560;

let app: { url: string; close(): void };
let home: string;
let executor: LocalExecutor;
let takeId: string;

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-export-4k-auto-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
  takeId = await makeFixtureTake(executor, {
    home,
    url: app.url,
    aspect: "auto",
  });
}, RUN_MS);

afterAll(async () => {
  await executor.close();
  app.close();
  await rm(home, { recursive: true, force: true });
});

describe("an uncapped Auto export", () => {
  it(
    "encodes the recording's shape at the 4K tier, under the encoder's limit",
    async () => {
      const out = await executor.request("export", {
        takeId,
        callId: "e-4k-auto",
        // The 4K tier is `full`; the default export is share-sized.
        quality: "full",
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as ExportAnswer;
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "saved",
        aspect: "auto",
      });
      if (answer.outcome !== "saved" || answer.fileType === "stills") return;
      const { width, height } = answer;
      const size = `${width}x${height}`;
      expect(width, `${size}: the 4K tier, not 1440p's`).toBeGreaterThan(
        TIER_1440_WIDTH,
      );
      expect(Math.abs(width / height - 16 / 9), size).toBeGreaterThan(0.05);
      expect(
        Math.ceil(width / 16) * Math.ceil(height / 16),
        `${size} in macroblocks`,
      ).toBeLessThanOrEqual(MAX_MACROBLOCKS);
      const read = await sampleMp4(await readFile(answer.file.path), {
        colors: [],
      });
      expect([read.width, read.height], "the decoded file").toEqual([
        width,
        height,
      ]);
    },
    EXPORT_4K_MS,
  );
});
