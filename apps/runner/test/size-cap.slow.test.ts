// Slow tier: renders the fixture take three times or more in software. `pnpm test:fast` skips it; `pnpm test` and CI run it.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANDSCAPE_1080P } from "@demoman/compositor";
import type { ExportAnswer } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { makeFixtureTake, serveFixtureApp, WALLPAPERS_DIR } from "./fixture.js";
import { sampleMp4 } from "./mp4-probe.js";

/**
 * A cap below what the floor renders to ends on the fit rung (spec
 * 2026-10-29 §3.1): the file is the size asked for, at the floor's frame,
 * and the summary says it is softer. Asserted on the decoded file, not on
 * the report alone. The executor is capped at 1080p, so share is already
 * the floor's frame and the ladder is fit, then its retry if needed.
 *
 * Timing: the fixture run about 6 s, each 1080p export a few seconds here;
 * x5 for CI (fff4505) with margin.
 */
const RUN_MS = 31_000;
const EXPORTS_MS = 300_000;

let app: { url: string; close(): void };
let home: string;
let executor: LocalExecutor;
let takeId: string;

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-size-cap-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
    mp4MaxTier: LANDSCAPE_1080P,
  });
  takeId = await makeFixtureTake(executor, { home, url: app.url });
}, RUN_MS);

afterAll(async () => {
  await executor.close();
  app.close();
  await rm(home, { recursive: true, force: true });
});

async function exported(callId: string, args: object): Promise<ExportAnswer> {
  const out = await executor.request("export", { takeId, callId, ...args });
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.value as ExportAnswer;
}

describe("an MP4 under a cap the floor cannot meet", () => {
  // Red if the fit rung's bitrate ignores the cap or the output length, or
  // the file it keeps is not the one the facts describe.
  it(
    "fits by bitrate, and the decoded file is what the facts say",
    async () => {
      const floor = await exported("e-floor", { quality: "share" });
      if (floor.outcome !== "saved" || floor.fileType !== "mp4")
        throw new Error(JSON.stringify(floor));
      // The premise: 60% of the floor's own size is a cap the floor misses,
      // so the ladder has to reach the fit rung.
      const maxBytes = Math.floor(floor.file.byteLength * 0.6);
      const maxMB = maxBytes / 1_000_000;

      const answer = await exported("e-fit", { maxMB });
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "saved",
        fileType: "mp4",
      });
      if (answer.outcome !== "saved" || answer.fileType !== "mp4") return;
      const cap = answer.warnings.videoSize?.cap;
      expect(cap, JSON.stringify(cap)).toMatchObject({
        maxBytes,
        met: true,
        belowFloor: true,
      });
      const fit = cap?.steps.at(-1);
      expect(fit?.kind, JSON.stringify(cap?.steps)).toBe("fit");
      expect([answer.width, answer.height, answer.fps]).toEqual([
        floor.width,
        floor.height,
        30,
      ]);

      // The picture: the file on disk is under the cap, at the floor's
      // frame, and as long as the length the bitrate was computed from.
      const bytes = await readFile(answer.file.path);
      expect(bytes.byteLength).toBe(answer.file.byteLength);
      expect(bytes.byteLength).toBeLessThanOrEqual(maxBytes);
      const read = await sampleMp4(bytes, { colors: [] });
      expect([read.width, read.height]).toEqual([floor.width, floor.height]);
      if (fit?.kind !== "fit") return;
      expect(
        Math.abs(read.durationSec - fit.durationMs / 1000),
        `decoded ${read.durationSec} s against ${fit.durationMs} ms`,
      ).toBeLessThanOrEqual(1 / 30);

      expect(answer.summary).toContain(
        `softer than usual to fit in ${maxMB} MB`,
      );
    },
    EXPORTS_MS,
  );
});
