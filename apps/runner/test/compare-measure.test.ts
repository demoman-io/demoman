// apps/runner/test/compare-measure.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANDSCAPE_1080P } from "@demoman/compositor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import { createMeasurer, type Measurer } from "../src/compare/measure.js";
import { judge, STILL_CHANGE_MAX } from "../src/compare/numbers.js";
import { createFileFrameStore } from "../src/frame-store.js";
import { keyframeOnlyBundle, renderSmallFilm } from "./render-small.js";

// Measured locally (Apple silicon, --reporter=verbose): the whole file took
// 1.2 s on 2026-10-12 and 1.8 s on 2026-10-13, once its beforeAll rendered a
// second (60-frame) film and three cases joined; the longest case is 0.1 s.
// 5x is 9 s; 15 s is the headroom CI's slower browser and compositor asked
// for elsewhere in this lane.
const MEASURE_MS = 15_000;

let dir: string;
let measurer: Measurer;
let whole: Buffer;
let moving: Buffer;
const SMALL = { ...LANDSCAPE_1080P, width: 320, height: 180, fps: 30 };
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "demoman-measure-"));
  measurer = await createMeasurer();
  // A 320x180, 30 fps film of the render lane's keyframe-only bundle: one
  // picture for 9 s, with a cursor gliding over it — a slideshow.
  whole = await renderSmallFilm(SMALL);
  // The same size and rate, 2 s, whose picture changes every frame.
  moving = await renderSmallFilm(SMALL, { ms: 2000 });
}, MEASURE_MS);
afterAll(async () => {
  await measurer.close();
  await rm(dir, { recursive: true, force: true });
});

describe("measure", () => {
  it(
    "decodes every frame of a whole film: size, count and timestamps",
    async () => {
      await writeFile(join(dir, "whole.mp4"), whole);
      const m = await measurer.measure(join(dir, "whole.mp4"));
      expect([m.width, m.height]).toEqual([320, 180]);
      expect(m.frames).toBe(m.timesMs.length);
      expect(m.frames).toBeGreaterThan(30);
      expect(m.durationMs).toBeGreaterThan(1000);
    },
    MEASURE_MS,
  );

  // The export's timestamps are a fixed grid whatever was filmed, so the
  // stills are what tells a slideshow from a film that moves (spec §4).
  it(
    "reads the slideshow's held picture as one long still",
    async () => {
      // Premise: every keyframe of the slideshow is the same picture.
      const store = createFileFrameStore(join(dir, "premise-store"));
      const bundle = await keyframeOnlyBundle(store, readonlyScene());
      const pictures = await Promise.all(
        bundle.keyframes.map(async (k) =>
          Buffer.from(await store.load(k.ref)).toString("base64"),
        ),
      );
      expect(bundle.keyframes.length).toBeGreaterThan(1);
      expect(new Set(pictures).size).toBe(1);

      await writeFile(join(dir, "whole.mp4"), whole);
      const m = await measurer.measure(join(dir, "whole.mp4"));
      // Premise: a 9 s film, so a still of most of it is there to be found.
      expect(m.durationMs).toBeGreaterThan(8000);
      expect(m.changes).toHaveLength(m.frames);
      // Measured 2026-10-13: 7000 ms, 2 stills (an encoder keyframe at 2 s
      // reads 1.25 at this size and splits the first 2 s off).
      expect(m.longestStillMs).toBeGreaterThan(5000);
      expect(m.longStills).toBeGreaterThanOrEqual(1);
    },
    MEASURE_MS,
  );

  it(
    "reads a film whose picture changes every frame as having no still",
    async () => {
      await writeFile(join(dir, "moving.mp4"), moving);
      const m = await measurer.measure(join(dir, "moving.mp4"));
      // Premise: the alternating pictures reached the film — every frame
      // after the first differs from the one before by far more than the
      // threshold (white to black reads ~161 levels), across ~2 s.
      expect(m.frames).toBeGreaterThan(50);
      const after = m.changes.slice(1);
      expect(Math.min(...after)).toBeGreaterThan(STILL_CHANGE_MAX * 20);
      expect(m.longestStillMs).toBe(0);
      expect(m.longStills).toBe(0);
    },
    MEASURE_MS,
  );

  // T9: the server cannot read what it was asked to serve. A directory passes
  // `stat`, opens, and fails on its first read (EISDIR).
  it(
    "refuses, naming the file and the read error, when the server cannot read it",
    async () => {
      const folder = join(dir, "not-a-film.mp4");
      await mkdir(folder, { recursive: true });
      await expect(measurer.measure(folder)).rejects.toThrow(
        /not-a-film\.mp4 could not be decoded.*reading .*not-a-film\.mp4 for the page failed: .*EISDIR/s,
      );
      // The measurer still works after it.
      await writeFile(join(dir, "whole.mp4"), whole);
      expect((await measurer.measure(join(dir, "whole.mp4"))).frames).toBe(270);
    },
    MEASURE_MS,
  );

  // Spec §5, "the gate's own refusals": a truncated MP4. Its premise is the
  // whole film's frame count above; a cut at 60% must not decode as whole.
  it(
    "either refuses a truncated film or decodes fewer frames, and the gate refuses it",
    async () => {
      await writeFile(join(dir, "whole.mp4"), whole);
      const full = await measurer.measure(join(dir, "whole.mp4"));
      await writeFile(
        join(dir, "cut.mp4"),
        whole.subarray(0, Math.floor(whole.byteLength * 0.6)),
      );
      let film: Awaited<ReturnType<Measurer["measure"]>> | null = null;
      let said = "";
      try {
        film = await measurer.measure(join(dir, "cut.mp4"));
      } catch (error) {
        said = String(error);
      }
      if (film === null) {
        expect(said).toMatch(/cut\.mp4/);
        return;
      }
      expect(film.frames).toBeLessThan(full.frames);
      const v = judge([
        {
          executor: "cli",
          run: 1,
          outcome: "complete",
          stopped: null,
          completed: 2,
          total: 2,
          runMs: 1,
          exportMs: 1,
          exportOutcome: "saved",
          film,
          keyframe: null,
          // A span, so the only premise this film breaks is its length.
          span: [320, 180],
          degradations: {},
          framing: {},
          lastStepMs: full.durationMs,
          actingSteps: 2,
          zoomsSkipped: 0,
          detailViolations: 0,
          summary: null,
          bundleFailed: null,
          sceneFailed: null,
        },
      ]);
      expect(v).toMatchObject({ kind: "refused", executor: "cli" });
      if (v.kind === "refused") expect(v.cause).toMatch(/video ends at/);
    },
    MEASURE_MS,
  );
});

describe("createMeasurer setup", () => {
  it(
    "closes its server and rejects, naming the cause, when the page cannot be set up",
    async () => {
      let server: Server | undefined;
      const failed = createMeasurer({
        entryPath: join(dir, "no-such-entry.ts"),
        onServer: (s) => {
          server = s;
        },
      });
      await expect(failed).rejects.toThrow(
        /could not be set up.*no-such-entry/s,
      );
      expect(server, "onServer was never called").toBeDefined();
      expect(server?.listening).toBe(false);
    },
    MEASURE_MS,
  );
});
