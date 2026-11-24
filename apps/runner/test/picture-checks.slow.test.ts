// DEM-217: one fixture take recorded the way a user's is (held clock, a
// 1440x900@2 display, headless, the default export; the look is white around
// the window, so nothing dark sits outside it), and each defect the author
// caught by watching a video asserted on its decoded frames:
// typing that appeared all at once (four sessions), the cursor typing the
// instant it arrived, the camera moving before typing ended, text pixelated
// when zoomed out, a 58-second video, and jagged mouse movement after 0.9.6.
//
// Every phase is found in the picture, not in the take's markers, so a
// wrong record cannot vouch for itself. Measured 2026-11-20 on the Mac
// (about 35 s); its numbers are beside each bound. Held time is designed,
// not measured (spec 2026-11-13), so the same take films the same on CI.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTLE_MS } from "@demoman/replay-engine";
import type { ExportAnswer } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { listenOnLoopback } from "../src/loopback.js";
import { ownVideo, WALLPAPERS_DIR } from "./fixture.js";
import { keepOnFailure } from "./keep-on-failure.js";
import { mp4FrameTimes, readMp4Crops } from "./mp4-probe.js";

// x5 for CI (fff4505) on the Mac's ~10 s run and ~15 s export.
const RUN_MS = 120_000;
const EXPORT_MS = 240_000;
const TYPED = "48004800";
const VIEWPORT = { width: 1280, height: 800 };
/** How far the found cursor's centre wanders while it stands still: 1-3 px
 *  on ubuntu-latest (its darkest pixels shift with the encode), under 1 on
 *  the Mac. */
const REST_JITTER_PX = 4;
/** The longest this script's video may run (measured 7417 ms). */
const LENGTH_MAX_MS = 9_000;
/** The grating's least edge energy per pixel at the whole page (measured
 *  167-175; a 0.7 px blur on the page reads 82). */
const GRATING_EDGE_MIN = 120;

// Everything the page paints is lighter than grey 128, so the drawn cursor
// is the only dark thing in a frame (asserted below). The grating is 1 CSS
// px stripes: what a 2x recording holds and a 1x one blurs, and the same
// on any machine, which glyphs are not.
const PAGE = `<!doctype html><meta charset=utf-8><title>Picture checks</title>
<style>
  body { margin: 0; background: #fff; }
  #amount { position: absolute; left: 80px; top: 80px; width: 280px;
    height: 40px; font: 20px monospace; color: #60a5fa; background: #fff;
    border: 1px solid #dbeafe; outline: none; }
  #grating { position: absolute; left: 80px; top: 560px; width: 400px;
    height: 120px; background: repeating-linear-gradient(90deg,
    #93c5fd 0 1px, #fff 1px 2px); }
  #create { position: absolute; left: 1000px; top: 680px; width: 180px;
    height: 44px; background: #dbeafe; color: #60a5fa; border: 0; }
</style>
<input id="amount" aria-label="Amount">
<div id="grating"></div>
<button id="create">Create invoice</button>`;

let server: Server;
let home: string;
let executor: LocalExecutor;
let takeId: string;
let recording: unknown;
/** The run's final still, when it made one: kept beside the film. */
let stillPath: string | undefined;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  const url = `${await listenOnLoopback(server)}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-picture-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    // The CLI's own stand-in: a 2x display on any machine.
    standInDisplay: true,
    env: { ...process.env, DEMOMAN_DISPLAY: "1440x900@2" },
    outDir: join(home, "out"),
    log: () => undefined,
  });
  const run = await executor.request("run", {
    video: ownVideo(),
    callId: "picture-take",
    script: {
      scriptVersion: 1,
      name: "Picture checks",
      target: url,
      viewport: VIEWPORT,
      // White around the window, so nothing outside the page is dark either.
      look: {
        branding: {
          background: { kind: "solid", color: "#ffffff" },
          logo: null,
        },
      },
      steps: [
        { do: "waitForLoad" },
        { do: "type", into: { stableId: "amount" }, text: TYPED },
        { do: "click", on: { text: "Create invoice" } },
        { do: "pause", ms: 800 },
      ],
    },
  });
  const report = run.ok
    ? (run.value as {
        provenance?: { takeId?: unknown };
        run?: { recording?: unknown };
        still?: { path?: unknown };
      })
    : undefined;
  const id = report?.provenance?.takeId;
  if (typeof id !== "string") {
    throw new Error(`the take was not made: ${JSON.stringify(run)}`);
  }
  takeId = id;
  recording = report?.run?.recording;
  const still = report?.still?.path;
  stillPath = typeof still === "string" ? still : undefined;
}, RUN_MS);

afterAll(async () => {
  await executor?.close();
  server?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

const greyOf = (c: { grey?: string }) => Buffer.from(c.grey ?? "", "base64");

describe("a typed field and a far zoomed click, recorded as a user's is", () => {
  it(
    "types key by key after the cursor settles, holds the camera until the value is in, keeps the cursor smooth and the page sharp, and stays short",
    async () => {
      // Premise: held, as every headless take is unless the page refuses.
      expect(recording, JSON.stringify(recording)).toEqual({
        clock: "held",
        frameRate: 30,
        from: "default",
      });
      const out = await executor.request("export", {
        takeId,
        callId: "picture-export",
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as ExportAnswer;
      if (answer.outcome !== "saved" || answer.fileType === "stills") {
        throw new Error(JSON.stringify(answer));
      }
      // A red run keeps the film it judged, and the still (DEM-272).
      const film = answer.file.path;
      keepOnFailure("picture-checks", () =>
        stillPath === undefined ? [film] : [film, stillPath],
      );
      const bytes = new Uint8Array(await readFile(answer.file.path));
      const read = await mp4FrameTimes(bytes);
      const ms = read.timesSec.map((t) => t * 1000);
      const frameMs =
        ms.length > 1 ? (ms.at(-1) as number) / (ms.length - 1) : 0;

      // The page's window in the film, before the camera moves: a CSS rect
      // as a fraction of the frame.
      const win = answer.screens?.moments[0]?.window;
      expect(win, JSON.stringify(answer.screens)).toBeDefined();
      const w = win as { x: number; y: number; width: number; height: number };
      const at = (l: number, t: number, r: number, b: number) =>
        [
          (w.x + (l * w.width) / VIEWPORT.width) / answer.width,
          (w.y + (t * w.height) / VIEWPORT.height) / answer.height,
          (w.x + (r * w.width) / VIEWPORT.width) / answer.width,
          (w.y + (b * w.height) / VIEWPORT.height) / answer.height,
        ] as [number, number, number, number];
      const pxPerCss = w.width / VIEWPORT.width;
      // Each frame read whole 640 wide, at the film's own aspect, for the
      // cursor: pointer-lag.test.ts reads 640 wide too.
      const READ = {
        width: 640,
        height: Math.round((640 * read.height) / read.width),
      };

      // The cursor: the dark pixels' centre, in READ's pixels, never counting
      // the page's own darkest blue (grey 154).
      const whole = await readMp4Crops(
        bytes,
        read.timesSec,
        [0, 0, 1, 1],
        READ,
        true,
      );
      const cursor = whole.map((c) => {
        const grey = greyOf(c);
        const darkest = grey.reduce((m, g) => Math.min(m, g), 255);
        let n = 0;
        let sx = 0;
        let sy = 0;
        for (let i = 0; i < grey.length; i++) {
          if ((grey[i] as number) < Math.min(darkest + 40, 150)) {
            n++;
            sx += i % READ.width;
            sy += Math.floor(i / READ.width);
          }
        }
        return { darkest, n, x: sx / n, y: sy / n };
      });
      // The field's ink: pixels darker than the page's white, the glyphs
      // (the cursor rests right of the crop, asserted below). 4 px inside
      // the border, and left of the field's middle, where the cursor comes
      // to rest: the eight keys fill 96 px of it.
      const fieldRect = at(85, 85, 205, 115);
      const field = await readMp4Crops(
        bytes,
        read.timesSec,
        fieldRect,
        { width: 120, height: 30 },
        true,
      );
      const ink = field.map((c) => greyOf(c).filter((g) => g < 200).length);
      // The grating, read at its own size in the film: nothing resampled.
      const grating = await readMp4Crops(
        bytes,
        read.timesSec,
        at(88, 568, 472, 672),
        {
          width: Math.round(384 * pxPerCss),
          height: Math.round(104 * pxPerCss),
        },
      );
      const camera = 0.15;
      const table = () =>
        ms
          .map(
            (t, i) =>
              `${Math.round(t)}:${(read.changes[i] ?? 0).toFixed(2)}/${Math.round(cursor[i]?.x ?? -1)},${Math.round(cursor[i]?.y ?? -1)}/${ink[i]}/${Math.round((grating[i]?.edgeEnergy ?? 0) / Math.max(1, (grating[i]?.width ?? 1) * (grating[i]?.height ?? 1)))}`,
          )
          .join(" ");
      const said = (facts: object) =>
        `${JSON.stringify({ size: [read.width, read.height], window: w, ...facts })} ms:change/cursor/ink/gratingEdge ${table()}`;

      // Premise: the cursor is the only dark thing, found in every frame:
      // one cursor's worth of pixels, darker than anything the page paints
      // (grey 154 at its darkest, #60a5fa). 22-37 on the Mac; a shrunk
      // cursor reads lighter on ubuntu-latest (pointer-lag.test.ts).
      for (const c of cursor) {
        expect(c.darkest, said({})).toBeLessThan(140);
        expect(c.n, said({})).toBeGreaterThan(0);
        expect(c.n, said({})).toBeLessThan(200);
      }

      // The phases, from the picture. The camera: a frame whose picture
      // moved more than a cursor's journey moves it (0.12 at most measured;
      // the camera's own 0.2-0.84). Its eased first and last frames read
      // under that (0.10 and 0.13 on ubuntu-latest), so a frame is read as
      // standing only `margin` ms clear of every frame over it.
      const margin = 250;
      const firstCamera = read.changes.findIndex((c) => c >= camera);
      const lastCamera = read.changes.reduce(
        (last, c, i) => (c >= camera ? i : last),
        -1,
      );
      // Premise: the camera moves, after the typing (the field's changes
      // below come before it), and comes back: the export's closing screen
      // is the whole page, the window its first screen showed.
      expect(firstCamera, said({})).toBeGreaterThan(0);
      expect(
        answer.screens?.moments.at(-1)?.window,
        `the camera did not come back to the whole page: ${JSON.stringify(answer.screens)}`,
      ).toEqual(win);
      const fieldChanges = ink
        .map((e, i) => ({ i, d: e - (ink[i - 1] ?? e) }))
        .filter(({ i, d }) => i > 0 && i < firstCamera && Math.abs(d) > 8);
      const firstInField = fieldChanges[0]?.i ?? -1;
      // Premise: the field changes before the camera moves.
      expect(firstInField, said({})).toBeGreaterThan(0);

      // 1. Typing appears key by key: the field's ink rises in at least six
      // separate frames before the camera moves, where all at once is one.
      // Measured: eight, one per key, 2717-3217 ms. The focus pulse is a
      // single rise and then falls, so it is not counted twice. With every
      // key at one instant (`typeGapMs` 0) it read two.
      const before = ink.slice(0, firstCamera);
      const peak = Math.max(...before);
      const rises = fieldChanges.filter(({ d }) => d > 0.05 * peak);
      expect(rises.length, said({ rises })).toBeGreaterThanOrEqual(6);
      // The whole value: the last rise, the last key (the pulse is the
      // first). Premise: the field holds it until the camera moves.
      const full = rises.at(-1)?.i ?? -1;
      expect(full, said({ rises })).toBeGreaterThan(firstInField);
      let standing = firstCamera;
      while (
        standing > 0 &&
        (ms[standing] as number) >= (ms[firstCamera] as number) - margin
      ) {
        standing--;
      }
      // A camera off within `margin` of the last key is check 3's to say.
      const typed = ink[Math.max(standing, full)] as number;
      expect(typed, said({ rises, typed })).toBeGreaterThanOrEqual(
        0.95 * (ink[full] as number),
      );

      // 2. The cursor rests before the field reacts: from the first frame it
      // stood where it is when the field first changes, to that change, at
      // least the designed arrive (ARRIVE_MS, which is SETTLE_MS: 300).
      // Measured 367 ms to the focus pulse, about 700 to the first key; with
      // ARRIVE_MS 0, 67.
      const restAt = cursor[firstInField - 1] as { x: number; y: number };
      // Premise: it rests right of the field's crop, so its pixels are not
      // counted as typed ink.
      expect(
        restAt.x,
        said({ restAt, cropRight: fieldRect[2] * READ.width }),
      ).toBeGreaterThan(fieldRect[2] * READ.width);
      let arrived = firstInField - 1;
      while (
        arrived > 0 &&
        Math.hypot(
          (cursor[arrived - 1]?.x ?? 0) - restAt.x,
          (cursor[arrived - 1]?.y ?? 0) - restAt.y,
        ) <= REST_JITTER_PX
      ) {
        arrived--;
      }
      // Premise: it walked there: it stood elsewhere earlier.
      expect(arrived, said({ arrived })).toBeGreaterThan(0);
      const restMs = (ms[firstInField] as number) - (ms[arrived] as number);
      expect(
        restMs,
        said({ arrivedMs: ms[arrived], restMs }),
      ).toBeGreaterThanOrEqual(SETTLE_MS - frameMs);

      // 3. The camera holds until the whole value is in and has settled.
      // Measured: 500 ms after it on the Mac, 516 on ubuntu-latest. With neither the plan's room before the
      // click (`restBefore`) nor the renderer's act-end hold (`actEnds`),
      // 133; either one alone keeps the camera off the typing.
      const settledMs = (ms[firstCamera] as number) - (ms[full] as number);
      expect(
        settledMs,
        said({ fullMs: ms[full], settledMs }),
      ).toBeGreaterThanOrEqual(SETTLE_MS - frameMs);

      // 4. The cursor never jumps. Measured: 17 px a frame at most, on the
      // Mac and ubuntu-latest alike, on
      // its journeys and through the push-in; the jumps 0.9.6 drew were 85
      // and 261 (pointer-lag.test.ts reads 640 wide with the same bound). The
      // cursor sampled every 200 ms (`sampleCursor`) drew 181.
      const steps = cursor
        .slice(1)
        .map((c, i) =>
          Math.hypot(c.x - (cursor[i]?.x ?? c.x), c.y - (cursor[i]?.y ?? c.y)),
        );
      // Premise: it travelled: the click is most of the frame from the field.
      const first = cursor[0] as { x: number; y: number };
      const last = cursor.at(-1) as { x: number; y: number };
      expect(
        Math.hypot(last.x - first.x, last.y - first.y),
        said({}),
      ).toBeGreaterThan(150);
      expect(
        Math.max(...steps),
        said({ steps: steps.map(Math.round) }),
      ).toBeLessThanOrEqual(40);

      // 5. Sharp when zoomed out: the grating's edges (Sobel energy per
      // pixel), on every frame the camera stands at the whole page, before
      // its push-in and after its pull-back. Measured 167-175 on all of them
      // (171-177 on ubuntu-latest); the camera's eased ends, under the camera
      // threshold, read 83-134 (its motion blur), hence the margin.
      // Premise: frames at the whole page after the pull-back.
      const cameraMs = ms.filter((_, i) => (read.changes[i] ?? 0) >= camera);
      const atRest = ms
        .map((t, i) => ({ t, i }))
        .filter(
          ({ t, i }) =>
            (i < firstCamera || i > lastCamera) &&
            cameraMs.every((c) => Math.abs(t - c) > margin),
        );
      const edges = atRest.map(({ i }) => {
        const g = grating[i] as {
          edgeEnergy: number;
          width: number;
          height: number;
        };
        return g.edgeEnergy / (g.width * g.height);
      });
      const afterZoom = atRest.filter(({ i }) => i > lastCamera);
      expect(afterZoom.length, said({ edges })).toBeGreaterThan(5);
      const sharpest = Math.max(...edges);
      const softest = Math.min(...edges);
      const sharpSaid = () =>
        said({
          sharpest,
          softest,
          edges: atRest.map(({ t }, k) => [
            Math.round(t),
            Math.round(edges[k] as number),
          ]),
        });
      // None softer than the film's own sharpest: a pull-back, a final still
      // or a motion frame drawn from less than the stills is (measured 0.95;
      // a 0.7 px blur on the frames after 6.5 s read 0.45).
      expect(softest / sharpest, sharpSaid()).toBeGreaterThanOrEqual(0.9);
      // And the sharpest is sharp: the grating is drawn the same on any
      // machine, unlike glyphs. A 0.7 px blur on the page reads 82.
      expect(sharpest, sharpSaid()).toBeGreaterThanOrEqual(GRATING_EDGE_MIN);

      // The value was whole before the camera set off: back at the whole
      // page, the field holds what it held then (nothing typed while the
      // camera was away, where the crop above cannot see it).
      const endInk = ink.at(-1) as number;
      expect(endInk, said({ endInk, typed })).toBeGreaterThanOrEqual(
        0.95 * typed,
      );
      expect(endInk, said({ endInk, typed })).toBeLessThanOrEqual(1.05 * typed);

      // 6. Short: held time is designed, so this script's length is the same
      // on any machine. Measured 7417 ms; the room is for a deliberate change
      // of pacing, which should move this number with it. A 3.5 s
      // camera lead-in, which the plan makes room for, read 10300.
      expect(ms.at(-1) as number, said({})).toBeLessThanOrEqual(LENGTH_MAX_MS);
    },
    EXPORT_MS,
  );
});
