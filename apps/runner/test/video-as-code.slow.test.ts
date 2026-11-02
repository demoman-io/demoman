// Slow tier: six runs and five 1080p exports of the fixture app, each export
// read back as decoded frames. `pnpm test:fast` skips it; `pnpm test` and CI run it.
//
// The script's `trim` and per-click `zoom` (spec 2026-11-01 video-as-code),
// asserted on the picture: what the exported video shows, not what the take
// records. The take's records are read only as each case's premise.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANDSCAPE_1080P } from "@demoman/compositor";
import type { ExportAnswer, RunReport } from "@demoman/run-core";
import type {
  DemoScript,
  SceneDocument,
  ScriptStep,
} from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FrameReading, Rgb } from "../src/decode-probe-entry.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { ownVideo, serveFixtureApp, WALLPAPERS_DIR } from "./fixture.js";
import { sampleMp4 } from "./mp4-probe.js";

// Measured as executor-export.test.ts measures its own (x5 for CI): a run
// of the fixture app with two clicks, and a 16:9 export capped at 1080p.
const RUN_MS = 60_000;
const EXPORT_MS = 150_000;

/** The solid background the window sits on. At full frame it shows at all
 *  four edges of the picture; a zoom pushes it off at least two. */
const GREEN: Rgb = [0, 200, 83];
const EDGES: [number, number][] = [
  [0.01, 0.5],
  [0.99, 0.5],
  [0.5, 0.01],
  [0.5, 0.99],
];
const isGreen = (c: Rgb) =>
  c.every((v, i) => Math.abs(v - (GREEN[i] as number)) <= 30);
/** How many of the four edges show the background: 4 is the whole canvas. */
const greenEdges = (r: FrameReading) => r.blocks.filter(isGreen).length;

/** Two clicks far apart in time and place, after an opening of load and a
 *  pause the start trim cuts. Every claim is asserted from the takes. */
const steps = (reports?: { zoom: false }): ScriptStep[] => [
  { do: "waitForLoad" },
  { do: "pause", ms: 1500 },
  { do: "click", on: { text: "Reports" }, ...reports },
  { do: "pause", ms: 2500 },
  { do: "click", on: { text: "Place order" } },
  { do: "pause", ms: 600 },
];
const REPORTS = 2;
const PLACE_ORDER = 4;

let app: { url: string; close(): void };
let home: string;
let executor: LocalExecutor;

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-video-as-code-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
    // 1080p, not the 4K tier: the edges read the same, at a quarter the cost.
    mp4MaxTier: LANDSCAPE_1080P,
  });
});

afterAll(async () => {
  await executor?.close();
  app?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

interface Take {
  takeId: string;
  report: RunReport;
  scene: SceneDocument;
  /** Per script step: its action, its marker on the output axis, and the
   *  walk's measured finish (ms after the marker), from script.json. */
  at(index: number): { actionId: string; outputMs: number; finishMs: number };
}

async function takeOf(report: RunReport): Promise<Take> {
  const takeId = report.provenance.takeId;
  if (report.outcome !== "complete" || takeId === null)
    throw new Error(`the take was not made: ${JSON.stringify(report)}`);
  const library = createLibrary(home);
  const scene = await library.getScene(takeId);
  const read = await library.getSkeleton(takeId);
  if (scene === null || read.kind !== "ok")
    throw new Error(`take ${takeId}: ${JSON.stringify(read)}`);
  const film = report.video;
  if (!("steps" in film)) throw new Error(JSON.stringify(film));
  return {
    takeId,
    report,
    scene,
    at(index) {
      const step = read.skeleton.steps[index];
      const outputMs = film.steps.find(
        (s) => step?.do !== "pause" && s.actionId === step?.actionId,
      )?.outputMs;
      if (
        step === undefined ||
        step.do === "pause" ||
        step.actionId === null ||
        step.finishMs === null ||
        typeof outputMs !== "number"
      )
        throw new Error(
          `step ${index} has no action, marker or finish: ${JSON.stringify({ step, film: film.steps })}`,
        );
      return { actionId: step.actionId, outputMs, finishMs: step.finishMs };
    },
  };
}

async function run(
  callId: string,
  extra: Partial<DemoScript> & { steps?: ScriptStep[] } = {},
): Promise<Take> {
  const out = await executor.request("run", {
    video: ownVideo(),
    callId,
    script: {
      scriptVersion: 8,
      name: callId,
      target: app.url,
      viewport: { width: 1280, height: 800 },
      look: {
        branding: {
          background: { kind: "solid", color: "#00c853" },
          logo: null,
          padding: 0.08,
        },
        canvas: { aspect: "16:9" },
      },
      steps: steps(),
      ...extra,
    },
  });
  if (!out.ok) throw new Error(JSON.stringify(out));
  return takeOf(out.value as RunReport);
}

/** The take's export, read at every quarter second and at its last frame;
 *  exported once per take. */
const pictures = new Map<string, ReturnType<typeof exported>>();
const picture = (take: Take) => {
  if (!pictures.has(take.takeId)) pictures.set(take.takeId, exported(take));
  return pictures.get(take.takeId) as ReturnType<typeof exported>;
};
async function exported(take: Take) {
  const { takeId } = take;
  const callId = `e-${takeId}`;
  const out = await executor.request("export", { takeId, callId });
  if (!out.ok) throw new Error(JSON.stringify(out));
  const answer = out.value as ExportAnswer;
  if (answer.outcome !== "saved" || answer.fileType === "stills")
    throw new Error(JSON.stringify(answer));
  const read = await sampleMp4(await readFile(answer.file.path), {
    colors: [GREEN],
    blockPoints: EDGES,
  });
  const first = read.readings[0];
  const last = read.readings.at(-1);
  if (first === undefined || last === undefined)
    throw new Error(`${callId}: no readings`);
  // The positive control for every edge count below: a video that starts
  // before any zoom opens on the whole canvas, and the measure sees it so.
  // (One trimmed to its first click's marker opens with the camera already
  // on its way in.)
  if (take.scene.edits.trim?.head === undefined)
    expect(greenEdges(first), JSON.stringify(first)).toBe(4);
  const edgesBetween = (fromMs: number, toMs: number) =>
    read.readings
      .filter((r) => r.tSec * 1000 >= fromMs && r.tSec * 1000 <= toMs)
      .map((r) => ({ tSec: r.tSec, green: greenEdges(r) }));
  return {
    durationMs: read.durationSec * 1000,
    first,
    last,
    edgesBetween,
  };
}

const zoomOn = (scene: SceneDocument, actionId: string) =>
  scene.camera.filter(
    (c) => c.kind === "zoom" && c.marker.actionId === actionId,
  );

// The takes several cases share, made once each.
const made = new Map<string, Promise<Take>>();
const once = (key: string, make: () => Promise<Take>) => {
  if (!made.has(key)) made.set(key, make());
  return made.get(key) as Promise<Take>;
};
const untrimmed = () => once("untrimmed", () => run("untrimmed"));
const trimmedToAction = () =>
  once("toAction", () =>
    run("trim-to-action", {
      trim: { start: { ms: 0 }, end: { ms: 0, after: "action" } },
    }),
  );
const trimmedToZoomOut = () =>
  once("toZoomOut", () =>
    run("trim-to-zoom-out", { trim: { end: { ms: 0 } } }),
  );

describe("a script's trim, on the decoded video", () => {
  it(
    "trim start 0 and end 0 after action: the video runs from the first shown marker to the last finish",
    async () => {
      const whole = await untrimmed();
      const cut = await trimmedToAction();
      const wholePicture = await picture(whole);
      const cutPicture = await picture(cut);
      const first = cut.at(REPORTS);
      const last = cut.at(PLACE_ORDER);
      const expected = last.outputMs - first.outputMs + last.finishMs;
      const evidence = JSON.stringify({
        first,
        last,
        expected,
        cut: cutPicture.durationMs,
        whole: wholePicture.durationMs,
        trim: cut.scene.edits.trim,
        opening: cut.report.opening,
      });
      // The premise: the untrimmed video of the same script holds more than
      // a second the trim cuts (the load and the 1.5 s pause before it, and
      // the pull-out after).
      expect(
        wholePicture.durationMs - cutPicture.durationMs,
        evidence,
      ).toBeGreaterThan(1000);
      // One frame at 60 fps (17 ms), plus the walk's 50 ms poll that times a
      // step's finish, plus the encoder rounding the last frame's length.
      expect(Math.abs(cutPicture.durationMs - expected), evidence).toBeLessThan(
        150,
      );
    },
    2 * RUN_MS + 2 * EXPORT_MS,
  );

  it(
    "end after zoomOut ends at full frame, after action ends cropped",
    async () => {
      const toAction = await trimmedToAction();
      const toZoomOut = await trimmedToZoomOut();
      // The premise: the last click zoomed in both takes, so the end has a
      // zoom to stop inside or after.
      for (const take of [toAction, toZoomOut]) {
        const lastClick = take.at(PLACE_ORDER).actionId;
        expect(
          zoomOn(take.scene, lastClick),
          JSON.stringify(take.scene.camera),
        ).toHaveLength(1);
      }
      const cropped = await picture(toAction);
      const full = await picture(toZoomOut);
      const evidence = JSON.stringify({
        action: cropped.last,
        zoomOut: full.last,
        trims: [toAction.scene.edits.trim, toZoomOut.scene.edits.trim],
      });
      expect(greenEdges(full.last), evidence).toBe(4);
      expect(greenEdges(cropped.last), evidence).toBeLessThanOrEqual(2);
      // And the zoomOut video did zoom on that click before it came back:
      // its end being full frame is the pull-out, not a zoom that never was.
      const clickMs = toZoomOut.at(PLACE_ORDER).outputMs;
      const during = full.edgesBetween(clickMs, clickMs + 1000);
      expect(during.length, JSON.stringify(during)).toBeGreaterThanOrEqual(3);
      expect(
        Math.min(...during.map((d) => d.green)),
        JSON.stringify(during),
      ).toBeLessThanOrEqual(2);
    },
    2 * RUN_MS + 2 * EXPORT_MS,
  );
});

/** The quarter-second readings from just before a click's zoom would lead
 *  in (350 ms) to past where it would hold (1.2 s). */
const AROUND_MS = { before: 500, after: 1500 };

describe("a click's zoom, on the decoded video", () => {
  it(
    "zoom false leaves the frames around that click uncropped",
    async () => {
      const zoomed = await untrimmed();
      const off = await once("off", () =>
        run("zoom-off", { steps: steps({ zoom: false }) }),
      );
      // The premise: the same script without it zooms on that click, and
      // the next click is far enough on that its zoom is outside the window.
      const zoomedAt = zoomed.at(REPORTS);
      const offAt = off.at(REPORTS);
      expect(zoomOn(zoomed.scene, zoomedAt.actionId)).toHaveLength(1);
      expect(zoomOn(off.scene, offAt.actionId)).toEqual([]);
      expect(off.scene.zoomsSkipped).toContainEqual({
        actionId: offAt.actionId,
        reason: "off",
      });
      for (const take of [zoomed, off]) {
        expect(
          take.at(PLACE_ORDER).outputMs - take.at(REPORTS).outputMs,
        ).toBeGreaterThan(AROUND_MS.after + 500);
      }
      const zoomedPicture = await picture(zoomed);
      const offPicture = await picture(off);
      const window = (outputMs: number) =>
        [outputMs - AROUND_MS.before, outputMs + AROUND_MS.after] as const;
      const withZoom = zoomedPicture.edgesBetween(...window(zoomedAt.outputMs));
      const without = offPicture.edgesBetween(...window(offAt.outputMs));
      const evidence = JSON.stringify({ zoomedAt, offAt, withZoom, without });
      expect(withZoom.length, evidence).toBeGreaterThanOrEqual(6);
      expect(without.length, evidence).toBeGreaterThanOrEqual(6);
      expect(
        Math.min(...withZoom.map((r) => r.green)),
        evidence,
      ).toBeLessThanOrEqual(2);
      expect(
        without.every((r) => r.green === 4),
        evidence,
      ).toBe(true);
    },
    2 * RUN_MS + 2 * EXPORT_MS,
  );
});

describe("a re-record writes the Studio's trim and zoom edits back", () => {
  it(
    "write-back end to end",
    async () => {
      const first = await run("write-back-first");
      const videoId = first.report.videoVersion?.id;
      if (videoId === undefined) throw new Error(JSON.stringify(first.report));
      const reports = first.at(REPORTS);
      const placeOrder = first.at(PLACE_ORDER);
      const skeleton = await createLibrary(home).getSkeleton(first.takeId);
      if (skeleton.kind !== "ok") throw new Error(JSON.stringify(skeleton));
      const lastStep = skeleton.skeleton.steps[PLACE_ORDER];
      const zoomOutMs =
        lastStep !== undefined && lastStep.do !== "pause"
          ? lastStep.zoomOutMs
          : null;
      // The Studio tail 200 ms past the click's finish and before its
      // zoom-out, which R11 writes back as `{ ms: 200, after: "action" }`.
      const tailMs = placeOrder.finishMs + 200;
      const clickZoom = zoomOn(first.scene, reports.actionId);
      // The premise: the first take zoomed on Reports, a zoom the click made,
      // and the last click's zoom-out lands past the tail.
      expect(clickZoom, JSON.stringify(first.scene.camera)).toMatchObject([
        { source: "click" },
      ]);
      expect(zoomOutMs, JSON.stringify(lastStep)).not.toBeNull();
      expect(tailMs).toBeLessThan(zoomOutMs as number);

      // The author's edits, as Task 8's `removeZoom` and the trim handle
      // write them: the click zoom gone with an `off` in its place, a tail.
      const library = createLibrary(home);
      await library.putScene({
        ...first.scene,
        camera: first.scene.camera.filter((c) => c !== clickZoom[0]),
        zoomsSkipped: [
          ...(first.scene.zoomsSkipped ?? []).filter(
            (s) => s.actionId !== reports.actionId,
          ),
          { actionId: reports.actionId, reason: "off" },
        ],
        edits: {
          ...first.scene.edits,
          trim: { tail: { actionId: placeOrder.actionId, offsetMs: tailMs } },
        },
      });

      const out = await executor.request("run", {
        callId: "write-back-again",
        video: { id: videoId },
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const report = out.value as RunReport;
      expect(report.rerecord, JSON.stringify(report.rerecord)).toMatchObject({
        from: first.takeId,
        notes: [],
        notCarried: [],
      });
      const again = await takeOf(report);
      const againSkeleton = await library.getSkeleton(again.takeId);
      if (againSkeleton.kind !== "ok")
        throw new Error(JSON.stringify(againSkeleton));
      expect(againSkeleton.skeleton.trim).toEqual({
        end: { ms: 200, after: "action" },
      });
      const newReports = again.at(REPORTS);
      const newPlaceOrder = again.at(PLACE_ORDER);
      expect(zoomOn(again.scene, newReports.actionId)).toEqual([]);
      expect(again.scene.edits.trim).toEqual({
        tail: {
          actionId: newPlaceOrder.actionId,
          offsetMs: newPlaceOrder.finishMs + 200,
        },
      });

      // On the picture: no zoom around Reports, and the video ends 200 ms
      // after the last click's finish (the tolerance is the duration case's).
      const shown = await picture(again);
      const around = shown.edgesBetween(
        newReports.outputMs - AROUND_MS.before,
        newReports.outputMs + AROUND_MS.after,
      );
      const expected = newPlaceOrder.outputMs + newPlaceOrder.finishMs + 200;
      const evidence = JSON.stringify({
        around,
        expected,
        durationMs: shown.durationMs,
        newPlaceOrder,
      });
      expect(around.length, evidence).toBeGreaterThanOrEqual(6);
      expect(
        around.every((r) => r.green === 4),
        evidence,
      ).toBe(true);
      expect(Math.abs(shown.durationMs - expected), evidence).toBeLessThan(150);
    },
    2 * RUN_MS + EXPORT_MS,
  );
});
