// A repo's `recordingFrameRate` reaches the picture. One page with a
// 600 ms CSS transition started by a click, recorded held through the real
// executor twice, its project's `.demoman/config.json` at 30 and then 60,
// each exported at "high" (60 fps) and read from decoded frames. At 30 the
// page paints every other frame of the export, so the transition's frames
// come in repeated pairs; at 60 every frame of it is new.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportAnswer } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { listenOnLoopback } from "../src/loopback.js";
import { ownVideo, WALLPAPERS_DIR } from "./fixture.js";
import { greyDiff, NOISE } from "./held-record.js";
import { mp4FrameTimes, readMp4Crops } from "./mp4-probe.js";

// Measured locally (2026-11-23, Mac): the case 17 s, two runs and two
// exports. The timeout is x5 for CI's slower frame composing (fff4505),
// with margin.
const CASE_MS = 120_000;
const VIEWPORT = { width: 1280, height: 800 };
/** The bar's band on the page, in CSS px: after the click, the bar is the
 *  only thing in it that moves. */
const BAND = { top: 400, height: 120 };
/** 600 ms at the export's 60 fps. */
const SPAN_FRAMES = 36;

/** A black bar that slides across the page, linearly over 600 ms, when Go
 *  is clicked. Positions and sizes are explicit, so no font moves it; the
 *  cursor crosses the bar's band on its way to Go, then rests far above it. */
const PAGE = `<!doctype html><meta charset=utf-8><title>rate</title><link rel=icon href="data:,">
<style>
body{margin:0;background:#fff}
#go{position:absolute;left:40px;top:40px;width:160px;height:40px;background:#eee;border:1px solid #888}
#bar{position:absolute;left:40px;top:${BAND.top}px;width:80px;height:${BAND.height}px;background:#000;transition:transform .6s linear}
#bar.on{transform:translateX(1080px)}
</style>
<button id=go>Go</button><div id=bar></div>
<script>document.getElementById("go").addEventListener("click", () => document.getElementById("bar").classList.add("on"))</script>`;

let server: Server;
let home: string;
let url: string;
let executor: LocalExecutor;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  url = `${await listenOnLoopback(server)}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-frame-rate-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    standInDisplay: true,
    env: { ...process.env, DEMOMAN_DISPLAY: "1440x900@1" },
    outDir: join(home, "out"),
    log: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  await executor?.close();
  server?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

interface Read {
  recording: unknown;
  /** The export's frames per second, from its own frame times. */
  fps: number;
  /** The frames from the first that left the bar's start to the first at
   *  its end: the transition's span. */
  span: number;
  /** Frames of the span the same as the one before, within the noise. */
  repeats: number;
  /** How far the bar's band changed from its start to its end. */
  travelled: number;
  file: string;
}

/** Records the page with the project's config asking for `rate`, exports it
 *  at "high", and reads the bar's band from every decoded frame. */
async function recordAt(rate: 30 | 60): Promise<Read> {
  const project = join(home, `project-${rate}`);
  await mkdir(join(project, ".demoman"), { recursive: true });
  await writeFile(
    join(project, ".demoman", "config.json"),
    JSON.stringify({ recordingFrameRate: rate }),
  );
  const run = await executor.request("run", {
    video: ownVideo(),
    callId: `rate-${rate}`,
    project,
    script: {
      scriptVersion: 9,
      name: `Rate ${rate}`,
      target: url,
      viewport: VIEWPORT,
      look: {
        branding: {
          background: { kind: "solid", color: "#ffffff" },
          logo: null,
        },
      },
      steps: [
        { do: "waitForLoad" },
        { do: "click", on: { stableId: "go" }, zoom: false },
      ],
    },
  });
  const report = run.ok
    ? (run.value as {
        provenance?: { takeId?: unknown };
        run?: { recording?: unknown };
      })
    : undefined;
  const takeId = report?.provenance?.takeId;
  if (typeof takeId !== "string") {
    throw new Error(`the take was not made: ${JSON.stringify(run)}`);
  }
  const out = await executor.request("export", {
    takeId,
    callId: `rate-${rate}-export`,
    quality: "high",
  });
  if (!out.ok) throw new Error(JSON.stringify(out));
  const answer = out.value as ExportAnswer;
  if (answer.outcome !== "saved" || answer.fileType === "stills") {
    throw new Error(JSON.stringify(answer));
  }
  const win = answer.screens?.moments[0]?.window;
  if (win === undefined) throw new Error(JSON.stringify(answer.screens));
  const bytes = new Uint8Array(await readFile(answer.file.path));
  const { timesSec } = await mp4FrameTimes(bytes);
  // The bar's band across the whole frame, as grey levels.
  const scale = win.height / VIEWPORT.height;
  const band = await readMp4Crops(
    bytes,
    timesSec,
    [
      0,
      (win.y + BAND.top * scale) / answer.height,
      1,
      (BAND.height * scale) / answer.height,
    ],
    { width: 192, height: 16 },
    true,
  );
  const grey = band.map((c) => c.grey ?? "");
  const start = grey[0] ?? "";
  const end = grey.at(-1) ?? "";
  // Found from the end: the pointer crosses the band on its way to Go
  // before the click. The span is the run of frames off the bar's start
  // that ends on the first frame at its end.
  let atEnd = grey.length - 1;
  while (atEnd > 0 && greyDiff(grey[atEnd - 1] ?? "", end) <= NOISE) atEnd--;
  let first = atEnd;
  while (first > 0 && greyDiff(grey[first - 1] ?? "", start) > NOISE) first--;
  const frames = grey.slice(first, atEnd + 1);
  const repeats = frames.filter(
    (g, i) => i > 0 && greyDiff(g, frames[i - 1] ?? "") <= NOISE,
  ).length;
  const last = timesSec.at(-1) ?? 0;
  return {
    recording: report?.run?.recording,
    fps: last > 0 ? (timesSec.length - 1) / last : 0,
    span: frames.length,
    repeats,
    travelled: greyDiff(start, end),
    file: answer.file.path,
  };
}

describe("the recording frame rate in the picture", () => {
  it(
    "a 60 fps recording shows the page's transition with no repeated frame, where 30 repeats",
    async () => {
      const at30 = await recordAt(30);
      const at60 = await recordAt(60);
      const said = JSON.stringify({ at30, at60 });
      // The setting was read from each project's config.json, not defaulted.
      expect(at30.recording, said).toEqual({
        clock: "held",
        frameRate: 30,
        from: "repo",
      });
      expect(at60.recording, said).toEqual({
        clock: "held",
        frameRate: 60,
        from: "repo",
      });
      for (const r of [at30, at60]) {
        // Premise: the export is 60 fps, so a 30 fps page must repeat in it.
        expect(Math.round(r.fps), said).toBe(60);
        // Premise: the bar crossed its band, and the transition spans the
        // 36 frames read (600 ms at 60). A 30 fps page starts and ends it on
        // its own frames, up to one apart each end (measured 34 at 30, 36
        // at 60).
        expect(r.travelled, said).toBeGreaterThan(NOISE * 4);
        expect(r.span, said).toBeGreaterThanOrEqual(SPAN_FRAMES - 3);
        expect(r.span, said).toBeLessThanOrEqual(SPAN_FRAMES + 1);
      }
      // Premise: the 30 fps page steps, every other frame a repeat.
      expect(at30.repeats, said).toBeGreaterThanOrEqual(8);
      // The point: at 60 every frame of the transition is new.
      expect(at60.repeats, said).toBe(0);
    },
    CASE_MS,
  );
});
