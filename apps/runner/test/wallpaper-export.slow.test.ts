// Slow tier: exports MP4s in software through exportTake. `pnpm test:fast`
// skips it; `pnpm test` and CI run it.
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAMERA_DEFAULTS,
  composeForTarget,
  contentScale,
  type FrameBundle,
  frameCamera,
  LANDSCAPE_4K,
  LANDSCAPE_1080P,
  planScene,
  type RenderTarget,
  sampleTrack,
} from "@demoman/compositor";
import { type ExportAnswer, frameOf, targetFor } from "@demoman/run-core";
import {
  BRANDING_DEFAULTS,
  DEFAULT_WALLPAPER_BLUR,
  NEUTRAL_BACKGROUND,
  type SceneBackground,
  type SceneDocument,
} from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import type { Rgb } from "../src/decode-probe-entry.js";
import { type ExportDeps, exportTake } from "../src/executor/export.js";
import { createLibrary } from "../src/executor/library.js";
import { createVideoStore } from "../src/executor/videos.js";
import { launch } from "../src/launch.js";
import { putTake } from "./disk-take.js";
import { WALLPAPERS_DIR } from "./fixture.js";
import {
  LARGE_FIXTURE_HEIGHT,
  LARGE_FIXTURE_WIDTH,
  largeJpeg,
} from "./fixtures/jpeg.js";
import { readMp4Crops, sampleMp4 } from "./mp4-probe.js";

// Measured locally (Apple silicon, 2026-10-28): one 1080p export of this
// take took about 5 s, the three-export case 13 s. CI is ~5x slower at
// composing frames (CLAUDE.md, `fff4505`); 120 s per export leaves margin.
const EXPORT_MS = 120_000;

const VIEWPORT = { width: 1280, height: 800 };
const TAKE_ID = readonlyScene().meta.id;

let home: string;

/**
 * `readonlyScene`'s take on 3840x2400 keyframes (`largeJpeg`, DPR 3 of the
 * 1280x800 viewport), so a 2.5x zoom has the source detail to stand on at
 * 1080p. Put on disk the way the CLI stores a take.
 */
async function takeBundle(): Promise<FrameBundle> {
  const store = createLibrary(home).frameStore(TAKE_ID);
  const times = [0, 400, 3200, 9000];
  const actionIds = [null, "act-1", "act-2", "act-3"];
  const keyframes = await Promise.all(
    times.map(async (sourceTimeMs, i) => ({
      sourceTimeMs,
      ref: await store.putKeyframe(TAKE_ID, i, largeJpeg()),
      width: LARGE_FIXTURE_WIDTH,
      height: LARGE_FIXTURE_HEIGHT,
      actionId: actionIds[i] as string | null,
      byteLength: 0,
    })),
  );
  return {
    bundleVersion: 1,
    sceneId: TAKE_ID,
    source: "replay",
    dpr: 3,
    viewport: VIEWPORT,
    keyframes,
    motionSpans: [],
    cursorSamples: [
      { sourceTimeMs: 0, x: 1180, y: 40 },
      { sourceTimeMs: 400, x: 1180, y: 42 },
      { sourceTimeMs: 3200, x: 640, y: 328 },
      { sourceTimeMs: 9000, x: 1060, y: 642 },
    ],
    cursorGaps: [],
    anchorRects: [
      {
        actionId: "act-1",
        anchorId: "a-search",
        rect: { x: 1000, y: 24, width: 240, height: 36 },
      },
      {
        actionId: "act-2",
        anchorId: "a-row",
        rect: { x: 60, y: 300, width: 1160, height: 56 },
      },
      {
        actionId: "act-3",
        anchorId: "a-checkout",
        rect: { x: 980, y: 620, width: 160, height: 44 },
      },
    ],
    markers: [
      { actionId: "act-1", sourceTimeMs: 400 },
      { actionId: "act-2", sourceTimeMs: 3200 },
      { actionId: "act-3", sourceTimeMs: 9000 },
    ],
    degradations: [],
  };
}

/** The take on `background`, zoomed 2.5x (the deepest the camera goes) on
 *  the search field in the page's top-left corner, so the zoomed shot
 *  leaves the window and shows the margin. */
function sceneOn(
  background: SceneBackground,
  aspect: "16:9" | "9:16" = "16:9",
  zoom = true,
): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    canvas: { aspect },
    branding: { ...scene.branding, background, padding: 0.15 },
    // A camera that holds still on the plateau: no follow drift and no
    // camera blur to soften the frame measured.
    motion: { smoothness: 0.5, blur: 0, follow: false },
    camera: zoom
      ? [
          {
            id: "cam-search",
            kind: "zoom",
            anchorId: "a-search",
            marker: { actionId: "act-1", offsetMs: 0 },
            scale: 2.5,
          },
        ]
      : [],
  };
}

/** Each export's work page in a browser of its own, closed after. */
async function exportOf(
  scene: SceneDocument,
  wallpapersDir: string,
): Promise<{ answer: ExportAnswer; bytes: Uint8Array }> {
  const bundle = await takeBundle();
  await putTake(home, TAKE_ID, scene, bundle);
  const opened: Awaited<ReturnType<typeof launch>>[] = [];
  const library = createLibrary(home);
  const deps: ExportDeps = {
    library,
    videos: createVideoStore(home, library),
    door: "agent",
    home,
    wallpapersDir,
    outDir: join(home, "out"),
    log: () => undefined,
    maxTier: LANDSCAPE_1080P,
    session: {
      headless: true,
      async openWorkPage() {
        const launched = await launch({ headless: true });
        opened.push(launched);
        return { ok: true as const, page: launched.page };
      },
    },
  };
  try {
    const answer = await exportTake(
      { takeId: TAKE_ID, fileType: "mp4", quality: "full" },
      deps,
      () => undefined,
    );
    if (answer.outcome !== "saved" || answer.fileType === "stills") {
      throw new Error(`not a saved file: ${JSON.stringify(answer)}`);
    }
    return { answer, bytes: new Uint8Array(await readFile(answer.file.path)) };
  } finally {
    await Promise.all(opened.map((l) => l.close()));
  }
}

/** The target exportTake renders this scene at: the function it uses. */
async function targetOf(scene: SceneDocument): Promise<RenderTarget> {
  return targetFor(
    "mp4",
    scene.canvas.aspect,
    await takeBundle(),
    frameOf(scene),
    {
      maxTier: LANDSCAPE_1080P,
      quality: "full",
    },
  );
}

const deepestOf = (
  scene: SceneDocument,
  bundle: FrameBundle,
  target: RenderTarget,
) =>
  composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target,
  }).resolved.cameraKeys.reduce((m, k) => Math.max(m, k.scale), 1);

type Box = { x: number; y: number; width: number; height: number };

/**
 * Where the camera puts things at `outputMs`: the window's rect in output
 * pixels, and the map from a canvas point to an output pixel — the scene
 * transform `renderFrame` draws the background and window through.
 */
function cameraAt(
  scene: SceneDocument,
  bundle: FrameBundle,
  target: RenderTarget,
  outputMs: number,
) {
  const { resolved, presentation } = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target,
  });
  const fr = presentation.frameRect;
  const camera = frameCamera(
    sampleTrack(resolved, outputMs),
    contentScale(fr, VIEWPORT),
    fr,
    VIEWPORT,
    target,
  );
  const centre = { x: fr.x + fr.width / 2, y: fr.y + fr.height / 2 };
  const toOutput = (p: { x: number; y: number }) => ({
    x: centre.x + camera.scale * (p.x - camera.focus.x),
    y: centre.y + camera.scale * (p.y - camera.focus.y),
  });
  const toCanvas = (o: { x: number; y: number }) => ({
    x: camera.focus.x + (o.x - centre.x) / camera.scale,
    y: camera.focus.y + (o.y - centre.y) / camera.scale,
  });
  const a = toOutput({ x: fr.x, y: fr.y });
  const b = toOutput({ x: fr.x + fr.width, y: fr.y + fr.height });
  return {
    scale: camera.scale,
    window: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y } as Box,
    toOutput,
    toCanvas,
  };
}

/** The middle frame of the longest hold at `deepest`, and the first frame
 *  at scale 1, by index. */
function plateauAndRest(
  scene: SceneDocument,
  bundle: FrameBundle,
  target: RenderTarget,
  deepest: number,
) {
  const { resolved } = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target,
  });
  const frameMs = 1000 / target.fps;
  const frames = Math.floor(resolved.timeline.outputDurationMs / frameMs);
  let run: number[] = [];
  let best: number[] = [];
  let rest: number | null = null;
  for (let i = 0; i < frames; i++) {
    const s = sampleTrack(resolved, i * frameMs).scale;
    if (Math.abs(s - deepest) < 1e-9) {
      run.push(i);
      if (run.length > best.length) best = run;
    } else run = [];
    if (s === 1 && rest === null) rest = i;
  }
  const zoomed = best[Math.floor(best.length / 2)];
  return { zoomed, rest, plateauFrames: best.length, frameMs };
}

const outside = (r: Box, w: Box) =>
  r.x >= w.x + w.width ||
  r.x + r.width <= w.x ||
  r.y >= w.y + w.height ||
  r.y + r.height <= w.y;

/** Up to 400x400 of the widest margin band the zoomed shot shows beside
 *  the window, `gap` px clear of it, 8 px in from the frame's edge, and
 *  starting `along` px down (or across) the band: where vivid-1's band
 *  edges, its sharpest detail, cross it. */
function marginRegion(
  w: Box,
  target: RenderTarget,
  gap: number,
  along: number,
): Box {
  const bands: Box[] = [
    { x: 8, y: 8, width: w.x - gap - 8, height: target.height - 16 },
    {
      x: w.x + w.width + gap,
      y: 8,
      width: target.width - 8 - (w.x + w.width + gap),
      height: target.height - 16,
    },
    { x: 8, y: 8, width: target.width - 16, height: w.y - gap - 8 },
    {
      x: 8,
      y: w.y + w.height + gap,
      width: target.width - 16,
      height: target.height - 8 - (w.y + w.height + gap),
    },
  ];
  const best = bands.reduce((a, b) =>
    b.width * b.height > a.width * a.height ? b : a,
  );
  const tall = best.height > best.width;
  const x = tall ? best.x : best.x + along;
  const y = tall ? best.y + along : best.y;
  // A size the decode probe reads quickly.
  const width = Math.floor(Math.min(best.x + best.width - x, 400));
  const height = Math.floor(Math.min(best.y + best.height - y, 400));
  return { x: Math.round(x), y: Math.round(y), width, height };
}

/** The 4-neighbour Laplacian's variance over a crop's interior: how much
 *  pixel-scale detail it holds. */
function laplacianVariance(
  grey: Uint8Array,
  width: number,
  height: number,
): number {
  const at = (x: number, y: number) => grey[y * width + x] as number;
  const values: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      values.push(
        at(x - 1, y) +
          at(x + 1, y) +
          at(x, y - 1) +
          at(x, y + 1) -
          4 * at(x, y),
      );
    }
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
}

async function varianceOf(
  bytes: Uint8Array,
  atSec: number,
  r: Box,
  target: RenderTarget,
): Promise<number> {
  const [reading] = await readMp4Crops(
    bytes,
    [atSec],
    [
      r.x / target.width,
      r.y / target.height,
      (r.x + r.width) / target.width,
      (r.y + r.height) / target.height,
    ],
    { width: r.width, height: r.height },
    true,
  );
  if (reading?.grey === undefined)
    throw new Error("the crop came back without its pixels");
  return laplacianVariance(
    new Uint8Array(Buffer.from(reading.grey, "base64")),
    r.width,
    r.height,
  );
}

/** A folder holding only `file` of the built-ins: a read of any other
 *  shape fails, and the export says so. */
async function onlyFile(file: string): Promise<string> {
  const dir = join(home, `only-${file}`);
  await mkdir(dir, { recursive: true });
  await copyFile(join(WALLPAPERS_DIR, file), join(dir, file));
  return dir;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-wallpaper-export-"));
  await mkdir(join(home, "out"), { recursive: true });
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Sharp, said rather than left to the absent field: these cases guard the
 *  resolution rule, which the blur would hide. */
const VIVID: SceneBackground = { kind: "wallpaper", id: "vivid-1", blur: 0 };

describe.each([
  {
    aspect: "16:9",
    file: "vivid-1-landscape.webp",
    deepest: CAMERA_DEFAULTS.maxScale,
    along: 0,
  },
  // A 9:16 frame's camera goes no deeper than its own cap, which leaves
  // the raster's 2.5x headroom unused: halving it does not show here, and
  // the 16:9 case is the one that goes red.
  {
    aspect: "9:16",
    file: "vivid-1-portrait.webp",
    deepest: CAMERA_DEFAULTS.verticalMaxScale,
    along: 700,
  },
] as const)(
  "a $aspect export on a wallpaper",
  ({ aspect, file, deepest, along }) => {
    it(
      "keeps the background's detail at the deepest zoom",
      async () => {
        const scene = sceneOn(VIVID, aspect);
        const bundle = await takeBundle();
        const target = await targetOf(scene);
        // Ruling R8: 1080p (1920x1080 16:9, 1080x1920 9:16), the largest
        // size whose source detail backs the zoom. The keyframes hold 3
        // source px per CSS px; at 4K the 16:9 window would need 5.7 at 2.5x,
        // and the zoom is lowered.
        expect(deepestOf(scene, bundle, target)).toBe(deepest);
        if (aspect === "16:9") {
          expect(
            deepestOf(scene, bundle, { ...target, ...LANDSCAPE_4K }),
          ).toBeLessThan(2.5);
        }
        const { zoomed, rest, plateauFrames, frameMs } = plateauAndRest(
          scene,
          bundle,
          target,
          deepest,
        );
        // The fixture: the camera holds 2.5 for a while, and is at 1 somewhere.
        expect(plateauFrames).toBeGreaterThan(5);
        if (zoomed === undefined || rest === null)
          throw new Error("no plateau or no rest frame");
        const atZoom = cameraAt(scene, bundle, target, zoomed * frameMs);
        const atRest = cameraAt(scene, bundle, target, rest * frameMs);
        expect(atZoom.scale).toBe(deepest);
        expect(atRest.scale).toBe(1);
        // A margin band in the zoomed shot, clear of the window's shadow, and
        // the same canvas area in the shot at scale 1.
        const zoomRegion = marginRegion(atZoom.window, target, 24, along);
        const a = atRest.toOutput(
          atZoom.toCanvas({ x: zoomRegion.x, y: zoomRegion.y }),
        );
        const b = atRest.toOutput(
          atZoom.toCanvas({
            x: zoomRegion.x + zoomRegion.width,
            y: zoomRegion.y + zoomRegion.height,
          }),
        );
        const restRegion = {
          x: Math.round(a.x),
          y: Math.round(a.y),
          width: Math.round(b.x - a.x),
          height: Math.round(b.y - a.y),
        };
        // The fixture: both regions are wallpaper, not window, and big
        // enough to measure.
        expect(
          outside(zoomRegion, atZoom.window),
          JSON.stringify({ zoomRegion, w: atZoom.window }),
        ).toBe(true);
        expect(
          outside(restRegion, atRest.window),
          JSON.stringify({ restRegion, w: atRest.window }),
        ).toBe(true);
        expect(Math.min(zoomRegion.width, zoomRegion.height)).toBeGreaterThan(
          100,
        );
        expect(Math.min(restRegion.width, restRegion.height)).toBeGreaterThan(
          30,
        );

        // Only the shape this target draws is there: a read of the other
        // would leave the wallpaper out and say so.
        const { answer, bytes } = await exportOf(scene, await onlyFile(file));
        expect(
          answer.outcome === "saved" && [answer.width, answer.height],
        ).toEqual([target.width, target.height]);
        expect(
          answer.outcome === "saved" && answer.warnings.wallpaperWarning,
        ).toBeUndefined();

        const half = frameMs / 2000;
        const zoomedVar = await varianceOf(
          bytes,
          (zoomed * frameMs) / 1000 + half,
          zoomRegion,
          target,
        );
        const restVar = await varianceOf(
          bytes,
          (rest * frameMs) / 1000 + half,
          restRegion,
          target,
        );
        const said = JSON.stringify({
          zoomedVar,
          restVar,
          zoomRegion,
          restRegion,
          zoomed,
          rest,
        });
        // The fixture: the region really has detail to lose.
        expect(restVar, said).toBeGreaterThan(VARIANCE_FLOOR);
        // The background kept its detail under the zoom (`SHARP_RATIO`).
        expect(zoomedVar, said).toBeGreaterThanOrEqual(SHARP_RATIO * restVar);
      },
      EXPORT_MS,
    );
  },
);

/**
 * The regions straddle a band edge, vivid-1's sharpest detail: measured
 * 2.3 and 10.7 at scale 1 there, where its smooth fields read 0.16-0.47
 * (the codec's blocks). Below the floor, the region lost its edge.
 */
const VARIANCE_FLOOR = 1.5;
/**
 * Zoomed over scale-1 Laplacian variance, same canvas area. A sharp zoom is
 * not 1 here: the detail is edges, and at 2.5x the area holds 2.5x fewer
 * edge pixels per pixel. Measured 2026-10-28, 16:9 at 2.5x: 0.44 sharp,
 * 0.18 with `wallpaperRasterSize` halved (red); the master itself gives
 * 0.43-0.5 between native and 1/2.5. 9:16 at its 1.15x cap: 1.17.
 *
 * Those are GPU canvases (`HEADLESS_GPU_ARGS`). CI's draw on the CPU, whose
 * scale-1 downsample keeps more edge, so the denominator rises and the
 * zoomed shot does not fall: CI read 5.23 / 15.51 = 0.337 sharp (run
 * 40820520425, 2026-10-29); this Mac with the GPU left off 5.29 / 16.21 =
 * 0.327 sharp and 2.01 / 14.05 = 0.143 halved; with it on, 4.73 / 10.71
 * = 0.442 sharp and 1.97 / 10.71 = 0.184 halved. 0.25 is under both sharp
 * readings and over both halved ones.
 */
const SHARP_RATIO = 0.25;

describe("the default take's wallpaper", () => {
  it(
    "is blurred: the margin holds well under a quarter of the sharp detail",
    async () => {
      const blurred = sceneOn(BRANDING_DEFAULTS.background, "16:9", false);
      const sharp = sceneOn(VIVID, "16:9", false);
      // The fixture: the default is vivid-1 at 1, the case below at 0.
      expect(BRANDING_DEFAULTS.background).toEqual({
        ...VIVID,
        blur: DEFAULT_WALLPAPER_BLUR,
      });
      const bundle = await takeBundle();
      const target = await targetOf(blurred);
      expect(await targetOf(sharp)).toEqual(target);
      const atRest = cameraAt(blurred, bundle, target, 0);
      expect(atRest.scale).toBe(1);
      // The left margin from 508 px down, where vivid-1's band edges cross
      // it. Measured 2026-10-28: 5.0 sharp, 0.83 at the 0.3 default (0.61 at
      // blur 1, 0.73 at 0.5; the codec's own floor is 0.16-0.47), so the
      // 0.25 x sharp = 1.25 ceiling clears both sides; its top 300 px read 0.43-0.48
      // sharp, no edge.
      const region = marginRegion(atRest.window, target, 24, 500);
      expect(
        outside(region, atRest.window),
        JSON.stringify({ region, w: atRest.window }),
      ).toBe(true);
      expect(Math.min(region.width, region.height)).toBeGreaterThan(100);
      const at = 0.5;
      const sharpExport = await exportOf(sharp, WALLPAPERS_DIR);
      const blurExport = await exportOf(blurred, WALLPAPERS_DIR);
      for (const e of [sharpExport, blurExport]) {
        expect(
          e.answer.outcome === "saved" && e.answer.warnings.wallpaperWarning,
        ).toBeUndefined();
      }
      const sharpVar = await varianceOf(sharpExport.bytes, at, region, target);
      const blurVar = await varianceOf(blurExport.bytes, at, region, target);
      const said = JSON.stringify({ sharpVar, blurVar, region });
      // The fixture: the sharp margin really has detail to lose.
      expect(sharpVar, said).toBeGreaterThan(VARIANCE_FLOOR);
      expect(blurVar, said).toBeLessThan(0.25 * sharpVar);
    },
    EXPORT_MS * 2,
  );
});

/** The 1080p export's left-margin point at scale 1: background, not window. */
const MARGIN_POINT: [number, number] = [0.04, 0.5];

describe("a wallpaper the export cannot have", () => {
  it(
    "saves the video on the gradient and names the missing file",
    async () => {
      const scene = sceneOn(
        { kind: "image", ref: "assets/gone.webp" },
        "16:9",
        false,
      );
      const { answer, bytes } = await exportOf(scene, WALLPAPERS_DIR);
      if (answer.outcome !== "saved") throw new Error("not saved");
      expect(answer.warnings.wallpaperWarning?.kind).toBe("leftOut");
      expect(answer.warnings.wallpaperWarning?.sentence).toMatch(
        /^The wallpaper was left out: .*gone\.webp could not be read/,
      );
      expect(answer.summary).toContain("gone.webp");
      // The control: the same take on the gradient itself.
      const control = await exportOf(
        sceneOn(NEUTRAL_BACKGROUND, "16:9", false),
        WALLPAPERS_DIR,
      );
      expect(
        control.answer.outcome === "saved" &&
          control.answer.warnings.wallpaperWarning,
      ).toBeUndefined();
      const read = async (b: Uint8Array) =>
        (await sampleMp4(b, { colors: [], blockPoints: [MARGIN_POINT] }))
          .readings[0]?.blocks[0] as Rgb;
      const [got, want] = [await read(bytes), await read(control.bytes)];
      for (let c = 0; c < 3; c++) {
        expect(
          Math.abs((got[c] as number) - (want[c] as number)),
          JSON.stringify({ got, want }),
        ).toBeLessThanOrEqual(2);
      }
      // ...and the gradient is not what vivid-1 would have painted.
      const vivid = await exportOf(
        sceneOn(VIVID, "16:9", false),
        WALLPAPERS_DIR,
      );
      const v = await read(vivid.bytes);
      expect(
        Math.max(
          ...[0, 1, 2].map((c) =>
            Math.abs((v[c] as number) - (want[c] as number)),
          ),
        ),
        JSON.stringify({ v, want }),
      ).toBeGreaterThan(40);
    },
    EXPORT_MS * 3,
  );
});

describe("an upload smaller than the zoom needs", () => {
  it(
    "is drawn, and the export says it will look soft",
    async () => {
      const green: Rgb = [0, 160, 80];
      const launched = await launch({ headless: true });
      let webp: Uint8Array;
      try {
        const base64 = await launched.page.evaluate(async ([r, g, b]) => {
          const canvas = new OffscreenCanvas(640, 480);
          const ctx = canvas.getContext(
            "2d",
          ) as OffscreenCanvasRenderingContext2D;
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(0, 0, 640, 480);
          const blob = await canvas.convertToBlob({
            type: "image/webp",
            quality: 0.95,
          });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (const x of bytes) binary += String.fromCharCode(x);
          return btoa(binary);
        }, green);
        webp = new Uint8Array(Buffer.from(base64, "base64"));
      } finally {
        await launched.close();
      }
      await mkdir(join(home, "assets"), { recursive: true });
      await writeFile(join(home, "assets", "small.webp"), webp);
      const { answer, bytes } = await exportOf(
        sceneOn(
          { kind: "image", ref: "assets/small.webp", blur: 0 },
          "16:9",
          false,
        ),
        WALLPAPERS_DIR,
      );
      if (answer.outcome !== "saved") throw new Error("not saved");
      expect(answer.warnings.wallpaperWarning?.kind).toBe("soft");
      expect(answer.warnings.wallpaperWarning?.sentence).toMatch(
        /small\.webp" is 640×480, .*look soft\.$/,
      );
      expect(answer.summary).toContain("look soft");
      // Drawn, not left out: the margin is the upload's green.
      const [reading] = (
        await sampleMp4(bytes, { colors: [], blockPoints: [MARGIN_POINT] })
      ).readings;
      const block = reading?.blocks[0] as Rgb;
      for (let c = 0; c < 3; c++) {
        expect(
          Math.abs((block[c] as number) - (green[c] as number)),
          JSON.stringify(block),
        ).toBeLessThanOrEqual(12);
      }
    },
    EXPORT_MS,
  );
});
