import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CameraKey,
  composeForTarget,
  ENCODER_USED_GLOBAL,
  type EncoderUsed,
  type FrameBundle,
  LANDSCAPE_1080P,
  planScene,
  type RenderTarget,
  SHARE_LANDSCAPE,
  sampleCamera,
  toOutputMs,
} from "@demoman/compositor";
import { frameOf, targetFor } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  Input,
} from "mediabunny";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CropReading, Rect } from "../src/decode-probe-entry.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import type { RunnerStore } from "../src/frame-store.js";
import { launch } from "../src/launch.js";
import { renderToFiles } from "../src/render.js";
import { makeFixtureTake, serveFixtureApp, WALLPAPERS_DIR } from "./fixture.js";
import { readMp4Crops } from "./mp4-probe.js";

/**
 * The share target keeps text crisp and makes a smaller file (spec
 * 2026-10-18 §3, §8). The fixture take is rendered through `renderToFiles`
 * (the CLI export's own render, called directly so the encoder quality can be chosen past the two `exportTake` offers)
 * four times in one run: `quality: "full"`, `"share"`, and two controls at
 * the share frame, `quality: 0.2` (known to lose detail) and `0.35` (the
 * floor a long video's cap may drop to, §8). The same frames of each are
 * decoded and compared.
 *
 * Capped at 1080p (`CAP`), as the software lanes are (`mp4MaxTier`):
 * uncapped, full is the 4K tier these keyframes back, 128 s a render in
 * software. So the comparison is the narrowest one a share export makes:
 * full's 1080p at 60 fps and 10 Mbps against share's 1080p at 30 fps. The
 * run logs which case ran.
 *
 * Headless, as every software lane renders. That matters here: headless
 * Chromium on macOS refuses AVC quantizer mode, so `quality` runs as
 * mediabunny's variable-bitrate fallback (`EncoderUsed.rateControl`), where
 * the headed window the CLI renders in runs a quantizer. The thresholds
 * below were measured under the fallback, and "encoded as measured" fails,
 * saying to re-measure, if a run's encoder opens otherwise.
 *
 * Timing: measured 2026-10-18 (M-series Mac, headless): the take's run
 * about 6 s, the four renders and the probes about 90 s together; x5 for CI
 * (fff4505) with margin.
 */
const RUN_MS = 31_000;
const RENDERS_MS = 700_000;

const CAP: RenderTarget = LANDSCAPE_1080P;

/** The rate control the thresholds were measured under (see above). */
const MEASURED_RATE_CONTROL = /^bitrate \d+$/;

/** The known-bad control: share's frame at a quality that loses detail. */
const CONTROL_QUALITY = 0.2;
/** The lowest quality a cap may drop a share export to (spec §8). */
const FLOOR_QUALITY = 0.35;

/**
 * Where the text is compared: the upper three quarters of the frame's left
 * side, as fractions of it. Through the camera's push-in toward the click
 * this holds the invoice table (customer names, status pills, amounts),
 * magnified from 1x to 1.8x.
 */
const CROP: Rect = [0, 0.02, 0.75, 0.46];

/**
 * A text-free control: the left margin of the frame at a held frame before
 * the push-in. At scale 1 the 1280x800 window is drawn 1453 px wide in a
 * 1920 frame, so 233 px of the take's solid green background show on each
 * side; this rect is the outer 154.
 */
const BACKGROUND: Rect = [0, 0.2, 0.08, 0.8];

/**
 * Which frames are read: every 30 fps frame from the push-in's departure up
 * to the first keyframe at or after the camera arrives. The move is where
 * an encoder spends its bits, and where the renders differ.
 *
 * Why the window runs on to a keyframe rather than stopping at the arrival:
 * under the bitrate fallback the encoder overspends on the move's first
 * frames and on any keyframe (one every 2 s, mediabunny's default), then
 * starves the frames after them to pay it back. Where that starved stretch
 * falls depends on where the move sits against the 2 s keyframe grid, not
 * on the encode. Measured 2026-11-11 on one fixture take, two timings: with
 * the move departing at 1.60-1.63 s (origin/main 4527caf8) the 0.35 floor
 * keeps 0.26-0.40 over the move alone; with the walk's settle after load
 * moving it to 1.89 s, just before the 2.0 s keyframe, the floor spends no
 * more bytes
 * than the 0.2 control from 2.17 to 2.77 s (packet sizes within about 12%,
 * kept fraction about 0 there) and keeps 0.09-0.17 over the move alone.
 * Read to the end of the GOP, the bits it withheld and spent later in it,
 * on the arrived picture, count too (numbers at `KEPT_FRACTION_MIN`).
 * Frames before departure are left out because every render holds the
 * same picture there (asserted: "reads every render ..."), and frames
 * every render agrees on add nothing to `keptFraction`.
 *
 * Not the frame at the click's instant, which the plan first asked for.
 * The camera has arrived by then and the picture is held, and on a held
 * picture each encode converges on the same detail: there, share's edge
 * energy was 0.985-1.0 of full's at `quality: 0.5` AND at `0.2`, and
 * 0.988-0.99 on each of the nine frames after the camera lands (measured
 * 2026-10-18, headless, so under the bitrate fallback), so a crispness
 * check on a held frame could not fail. Through the move, `0.2` loses
 * detail `0.5` keeps. The compositor blurs the camera's motion, so the text
 * in these frames is smeared in every render; what is compared is how much
 * of that picture each encode keeps. `DEMOMAN_SHARE_CROPS` shows them.
 */
const FRAME_SEC = 1 / 30;

/** How close every render's held frame before departure is to full's
 *  edge energy, the premise for leaving those frames out. Measured
 *  2026-11-11: control 1.0032, share and floor 1.0062 of full's. */
const HELD_AGREEMENT = 0.02;

/**
 * "The crop holds text", at a held, unblurred frame before the push-in:
 * Sobel edge energy per pixel of CROP over the table, and of BACKGROUND,
 * the text-free control. Measured 2026-10-18 (full render, 1080p): CROP
 * 22.96 and BACKGROUND 0 on every run (the frame before the move is the
 * same picture each time). The floor and ceiling sit well inside that gap.
 */
const TEXT_EDGE_PER_PX_FLOOR = 10;
const BACKGROUND_EDGE_PER_PX_CEILING = 1;

/**
 * The metric can tell a known-bad encode on this machine, this run: share's
 * edge ratio (share / full, summed over the frames read) is at least this
 * much above the 0.2 control's. Measured 2026-10-18 over the move alone,
 * headless, same-run pairs: share 0.9097 / control 0.8407 (gap 0.069),
 * 0.9416 / 0.8385 (0.103), 0.9268 / 0.8450 (0.082). Over the window to the
 * keyframe (2026-11-11): 0.073 with the move at 1.89 s, 0.067 at 1.61 s.
 */
const DISCRIMINATION_MIN = 0.03;

/**
 * Of the detail the 0.2 control loses against full, the share of it a
 * render keeps: (ratio(r) − ratio(control)) / (1 − ratio(control)), at
 * least. Relative to a control rendered in the same run, so it holds on an
 * encoder that scores every render lower or higher.
 *
 * One floor for share and for the cap's floor (0.35), which the author
 * accepted, so the check never calls 0.35 soft. Measured 2026-10-18,
 * headless (bitrate fallback: 0.5 ran at 3.23 Mbps, 0.35 at 2.20, 0.2 at
 * 1.50): share 0.43, 0.64, 0.53; floor 0.19, 0.21, 0.16, over the move
 * alone. Share's spread is wide run to run (its edge ratio 0.910-0.942).
 * 0.10 sat 0.056 under the floor's lowest. Over the window to the keyframe
 * (`FRAME_SEC` says why), 2026-11-11, three runs at each timing: move at
 * 1.87-1.90 s, share 0.59-0.64, floor 0.30-0.34; move at 1.60-1.63 s,
 * share 0.62-0.74, floor 0.36-0.42. It fails a share encode that keeps
 * less than a tenth of what 0.2 loses: one well below 0.35, as 0.2 itself
 * (0 by definition).
 */
const KEPT_FRACTION_MIN = 0.1;

/**
 * share bytes / full bytes, at most. Measured 2026-10-18 over eight runs at
 * the pick, both at 1080p, headless: 0.282-0.294 (e.g. 1,206,013 against
 * 4,107,869 bytes). 0.35 leaves 0.056 for the encoder's run-to-run spread;
 * full itself is 1.0, and `quality: 0.2` measured 0.18.
 */
const SIZE_RATIO = 0.35;

interface Render {
  target: RenderTarget;
  bytes: Buffer;
  encoderUsed: EncoderUsed | undefined;
  /** Its keyframes' timestamps, in seconds, from the file's packets. */
  keySecs: number[];
  crops: CropReading[];
  /** CROP at `held.sec`, the picture before the move. */
  held: CropReading;
}

let app: { url: string; close(): void };
let home: string;
let executor: LocalExecutor;
let full: Render;
let share: Render;
let control: Render;
let floor: Render;
let held: { sec: number; text: CropReading; background: CropReading };
let pushIn: { key: CameraKey; departMs: number; keys: CameraKey[] };
let clickMs: number;
/** Where the frames read end: full's first keyframe at or after arrival. */
let windowEndSec: number;
let instants: number[];
const notes: string[] = [];

const sum = (crops: CropReading[]) =>
  crops.reduce((total, c) => total + c.edgeEnergy, 0);
/** Share of full's edge energy a render keeps, over the sampled frames. */
const edgeRatio = (r: Render) => sum(r.crops) / sum(full.crops);
/** Of what the control loses, the share `r` keeps. */
const keptFraction = (r: Render) =>
  (edgeRatio(r) - edgeRatio(control)) / (1 - edgeRatio(control));
const perPixel = (c: CropReading) =>
  c.edgeEnergy / ((c.width - 2) * (c.height - 2));

/** What every failure message carries: both sizes, the edge energies and
 *  ratios, the crop rect, the instants, the camera and the encoders. */
function evidence(): string {
  const of = (r: Render) => ({
    target: `${r.target.width}x${r.target.height}@${r.target.fps}`,
    bytes: r.bytes.byteLength,
    edgeEnergy: sum(r.crops),
    edgeRatio: edgeRatio(r),
    perFrame: r.crops.map((c) => c.edgeEnergy),
    lumaVariance: r.crops.map((c) => Math.round(c.lumaVariance)),
    frames: r.crops.map(
      (c) => `${c.frameWidth}x${c.frameHeight}@${c.frameSec}`,
    ),
    keySecs: r.keySecs,
    heldRatio: r.held.edgeEnergy / full.held.edgeEnergy,
    encoderUsed: r.encoderUsed,
  });
  return JSON.stringify({
    crop: CROP,
    pushIn: {
      departMs: pushIn.departMs,
      arriveMs: pushIn.key.outputTimeMs,
      scale: pushIn.key.scale,
    },
    clickMs,
    windowEndSec,
    instants,
    scales: instants.map((t) => sampleCamera(pushIn.keys, t * 1000).scale),
    size: { width: share.crops[0]?.width, height: share.crops[0]?.height },
    held: {
      sec: held.sec,
      textPerPx: perPixel(held.text),
      backgroundPerPx: perPixel(held.background),
    },
    keptFraction: { share: keptFraction(share), floor: keptFraction(floor) },
    full: of(full),
    share: of(share),
    control: of(control),
    floor: of(floor),
    notes,
  });
}

/** The timestamps of an mp4's keyframes, in seconds, read from its packets. */
async function keySecsOf(bytes: Uint8Array): Promise<number[]> {
  const input = new Input({
    source: new BufferSource(bytes),
    formats: ALL_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  if (track === null) throw new Error("the render has no video track");
  const secs: number[] = [];
  for await (const packet of new EncodedPacketSink(track).packets(
    undefined,
    undefined,
    { metadataOnly: true },
  )) {
    if (packet.type === "key") secs.push(packet.timestamp);
  }
  return secs;
}

async function render(
  scene: SceneDocument,
  bundle: FrameBundle,
  store: RunnerStore,
  target: RenderTarget,
): Promise<Omit<Render, "crops" | "held" | "keySecs">> {
  const launched = await launch();
  try {
    const rendered = await renderToFiles({
      wallpaper: null,
      scene,
      bundle,
      store,
      page: launched.page,
      target,
      fileType: "mp4",
      logo: null,
    });
    const file = rendered.files[0];
    if (file === undefined) throw new Error("the render produced no file");
    // The sink's record: what it asked the encoder for and the rate control
    // the encoder was opened with.
    const encoderUsed = await launched.page.evaluate(
      (name) => (globalThis as Record<string, unknown>)[name],
      ENCODER_USED_GLOBAL,
    );
    return {
      target,
      bytes: file.bytes,
      encoderUsed: encoderUsed as EncoderUsed | undefined,
    };
  } finally {
    await launched.close();
  }
}

/** The camera's first push-in, when its move departs, and the first
 *  click's instant, in output milliseconds, as `target` plans them. */
function pushInOf(
  scene: SceneDocument,
  bundle: FrameBundle,
  target: RenderTarget,
): {
  pushIn: { key: CameraKey; departMs: number; keys: CameraKey[] };
  clickMs: number;
} {
  const click = scene.actions.find((a) => a.kind === "click");
  if (click === undefined) throw new Error("the fixture take has no click");
  const marker = bundle.markers.find((m) => m.actionId === click.id);
  if (marker === undefined) {
    throw new Error(`no marker for the click ${click.id}`);
  }
  const { resolved } = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target,
  });
  const keys = resolved.cameraKeys;
  const index = keys.findIndex((k) => k.scale > 1.01);
  const key = keys[index];
  const before = keys[index - 1];
  if (key === undefined || before === undefined) {
    throw new Error(
      `the fixture take's camera never pushes in from a key: ${JSON.stringify(keys)}`,
    );
  }
  // The move departs `transitionMs` before it arrives, or at the previous
  // key if that is nearer (`CameraKey.transitionMs`).
  const departMs = Math.max(
    before.outputTimeMs,
    key.outputTimeMs - key.transitionMs,
  );
  return {
    pushIn: { key, departMs, keys },
    clickMs: toOutputMs(resolved.timeline, marker.sourceTimeMs),
  };
}

/** Snapped to a 30 fps frame, so every render (60 and 30 fps) holds a
 *  frame drawn for exactly that instant; a millisecond in, so rounding
 *  cannot fall back to the frame before. */
const onFrame = (sec: number) => Math.round(sec * 30) / 30 + 0.001;

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-share-quality-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
  const takeId = await makeFixtureTake(executor, { home, url: app.url });
  const library = createLibrary(home);
  const scene = await library.getScene(takeId);
  if (scene === null) throw new Error(`take ${takeId} has no scene`);
  const store = library.frameStore(takeId);
  const bundle = await store.getBundle(takeId);
  if (bundle === null) throw new Error(`take ${takeId} has no frames`);

  const fullTarget = targetFor("mp4", "16:9", bundle, frameOf(scene), {
    maxTier: CAP,
    quality: "full",
  });
  const shareTarget = targetFor("mp4", "16:9", bundle, frameOf(scene), {
    maxTier: CAP,
    quality: "share",
  });
  const line =
    fullTarget.width === shareTarget.width &&
    fullTarget.height === shareTarget.height
      ? `both renders at ${shareTarget.height}p: ratio from bitrate and fps alone`
      : `full at ${fullTarget.width}x${fullTarget.height}, share at ${shareTarget.width}x${shareTarget.height}`;
  notes.push(line);
  console.info(`share-quality: ${line}`);

  ({ pushIn, clickMs } = pushInOf(scene, bundle, shareTarget));
  const fullPlan = pushInOf(scene, bundle, fullTarget).pushIn;
  if (
    fullPlan.key.outputTimeMs !== pushIn.key.outputTimeMs ||
    fullPlan.departMs !== pushIn.departMs
  ) {
    throw new Error(
      `the push-in runs ${fullPlan.departMs}-${fullPlan.key.outputTimeMs} ms in the full render and ${pushIn.departMs}-${pushIn.key.outputTimeMs} ms in the share one`,
    );
  }
  const departSec = pushIn.departMs / 1000;
  // A held frame before the move: the camera at rest, nothing blurred.
  const heldSec = onFrame(Math.max(0.1, departSec - 0.2));

  const size = {
    width: Math.round((CROP[2] - CROP[0]) * shareTarget.width),
    height: Math.round((CROP[3] - CROP[1]) * shareTarget.height),
  };
  const out = process.env.DEMOMAN_SHARE_CROPS;
  const dump = out !== undefined && out !== "";
  const at = (quality: number): RenderTarget => ({
    ...shareTarget,
    encoder: { ...shareTarget.encoder, quality },
  });
  const files = [
    await render(scene, bundle, store, fullTarget),
    await render(scene, bundle, store, shareTarget),
    await render(scene, bundle, store, at(CONTROL_QUALITY)),
    await render(scene, bundle, store, at(FLOOR_QUALITY)),
  ];
  const keySecs = await Promise.all(files.map((f) => keySecsOf(f.bytes)));
  const arriveSec = pushIn.key.outputTimeMs / 1000;
  const end = keySecs[0]?.find((s) => s >= arriveSec);
  if (end === undefined) {
    throw new Error(
      `full has no keyframe at or after the camera arrives (${arriveSec}s): ${JSON.stringify(keySecs[0])}`,
    );
  }
  windowEndSec = end;
  const first = Math.ceil(departSec / FRAME_SEC - 1e-6);
  const last = Math.round(windowEndSec / FRAME_SEC);
  instants = Array.from({ length: last - first }, (_, i) =>
    onFrame((first + i) * FRAME_SEC),
  );
  const read = async (
    file: Omit<Render, "crops" | "held" | "keySecs">,
    i: number,
  ): Promise<Render> => {
    const [heldCrop, ...crops] = await readMp4Crops(
      file.bytes,
      [heldSec, ...instants],
      CROP,
      size,
      dump,
    );
    if (heldCrop === undefined) {
      throw new Error(`no held frame was read at ${heldSec}s`);
    }
    return { ...file, keySecs: keySecs[i] ?? [], crops, held: heldCrop };
  };
  const reads: Render[] = [];
  for (const [i, f] of files.entries()) reads.push(await read(f, i));
  [full, share, control, floor] = reads as [Render, Render, Render, Render];
  const bgSize = {
    width: Math.round((BACKGROUND[2] - BACKGROUND[0]) * fullTarget.width),
    height: Math.round((BACKGROUND[3] - BACKGROUND[1]) * fullTarget.height),
  };
  const [heldBackground] = await readMp4Crops(
    full.bytes,
    [heldSec],
    BACKGROUND,
    bgSize,
  );
  if (heldBackground === undefined) {
    throw new Error(`no held frame was read at ${heldSec}s`);
  }
  held = { sec: heldSec, text: full.held, background: heldBackground };
  console.info(`share-quality: ${evidence()}`);

  // DEMOMAN_SHARE_CROPS=<dir>: every render and crop, as PGM, to look at.
  // How CROP was chosen.
  if (dump) {
    await mkdir(out, { recursive: true });
    for (const [name, r] of [
      ["full", full],
      ["share", share],
      ["control", control],
      ["floor", floor],
    ] as const) {
      await writeFile(join(out, `${name}.mp4`), r.bytes);
      for (const [i, crop] of r.crops.entries()) {
        const header = `P5\n${crop.width} ${crop.height}\n255\n`;
        await writeFile(
          join(out, `${name}-${i}.pgm`),
          Buffer.concat([
            Buffer.from(header, "ascii"),
            Buffer.from(crop.grey ?? "", "base64"),
          ]),
        );
      }
    }
    console.info(`share-quality: written to ${out}`);
  }
}, RUN_MS + RENDERS_MS);

afterAll(async () => {
  await executor?.close();
  app?.close();
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});

describe("the share render", () => {
  // The thresholds below hold only for the rate control they were measured
  // under; a run whose encoder opened otherwise has to be re-measured, not
  // compared.
  it("is encoded as the thresholds were measured", () => {
    expect(share.target, evidence()).toMatchObject({
      fps: SHARE_LANDSCAPE.fps,
      encoder: SHARE_LANDSCAPE.encoder,
    });
    for (const [r, quality] of [
      [share, SHARE_LANDSCAPE.encoder?.quality],
      [control, CONTROL_QUALITY],
      [floor, FLOOR_QUALITY],
    ] as const) {
      expect(r.encoderUsed?.quality, evidence()).toBe(quality);
      expect(
        r.encoderUsed?.rateControl,
        `the thresholds were measured under mediabunny's bitrate fallback (headless, quantizer mode refused); this run's encoder opened with ${JSON.stringify(r.encoderUsed?.rateControl)}: re-measure KEPT_FRACTION_MIN, DISCRIMINATION_MIN and SIZE_RATIO for it. ${evidence()}`,
      ).toMatch(MEASURED_RATE_CONTROL);
    }
    // Pinned by render-entry's `softwareEncoded`, so a GPU that offers a
    // hardware encoder cannot change which one ran.
    expect(full.encoderUsed, evidence()).toEqual({
      hardwareAcceleration: "prefer-software",
      bitrate: full.target.bitrate,
      rateControl: `bitrate ${full.target.bitrate}`,
    });
  });

  // The premises the comparisons stand on: the frames read are every frame
  // of one push-in toward the first click and on to the end of its GOP, at
  // one set of instants, decoded at the size each render was asked for; and
  // the frames left out before it are ones every render agrees on.
  it("reads every render at the same instants, departure to keyframe, at its own size", () => {
    expect(pushIn.key.outputTimeMs, evidence()).toBeLessThanOrEqual(clickMs);
    expect(pushIn.key.outputTimeMs, evidence()).toBeGreaterThan(clickMs - 1500);
    // Every frame from departure: the first read is the first frame at or
    // after it, and none is skipped after that.
    const firstMs = (instants[0] ?? -1) * 1000;
    expect(firstMs, evidence()).toBeGreaterThanOrEqual(pushIn.departMs);
    expect(firstMs, evidence()).toBeLessThan(
      pushIn.departMs + FRAME_SEC * 1000 + 1,
    );
    for (const [i, t] of instants.entries()) {
      if (i > 0) {
        expect(
          Math.abs(t - (instants[i - 1] as number) - FRAME_SEC),
          evidence(),
        ).toBeLessThan(0.0005);
      }
    }
    // ... through the move, which the camera completes inside the window ...
    const scales = instants.map(
      (t) => sampleCamera(pushIn.keys, t * 1000).scale,
    );
    expect(
      scales.filter((s) => s > 1 && s < pushIn.key.scale).length,
      evidence(),
    ).toBeGreaterThan(
      (pushIn.key.outputTimeMs - pushIn.departMs) / (FRAME_SEC * 1000) - 2,
    );
    expect(windowEndSec * 1000, evidence()).toBeGreaterThanOrEqual(
      pushIn.key.outputTimeMs,
    );
    // ... to the last frame before a keyframe every render holds.
    expect(
      windowEndSec - (instants.at(-1) ?? -1),
      evidence(),
    ).toBeLessThanOrEqual(FRAME_SEC);
    for (const r of [full, share, control, floor]) {
      expect(
        r.keySecs.some((s) => Math.abs(s - windowEndSec) < 0.001),
        `no keyframe at ${windowEndSec}s in the ${r.target.fps} fps render at quality ${r.encoderUsed?.quality}: ${evidence()}`,
      ).toBe(true);
    }
    // Before departure every render holds the same picture, so leaving
    // those frames out changes no `keptFraction`.
    for (const r of [share, control, floor]) {
      expect(
        Math.abs(r.held.edgeEnergy / full.held.edgeEnergy - 1),
        evidence(),
      ).toBeLessThan(HELD_AGREEMENT);
    }
    for (const r of [full, share, control, floor]) {
      expect(r.crops, evidence()).toHaveLength(instants.length);
      for (const [i, crop] of r.crops.entries()) {
        expect([crop.frameWidth, crop.frameHeight], evidence()).toEqual([
          r.target.width,
          r.target.height,
        ]);
        expect([crop.frameWidth, crop.frameHeight], evidence()).toEqual([
          full.target.width,
          full.target.height,
        ]);
        expect(
          Math.abs(crop.frameSec - (full.crops[i]?.frameSec ?? -1)),
          evidence(),
        ).toBeLessThan(0.001);
      }
    }
  });

  it("the fixture's crop holds text", () => {
    expect(sampleCamera(pushIn.keys, held.sec * 1000).scale).toBe(1);
    expect(perPixel(held.text), evidence()).toBeGreaterThan(
      TEXT_EDGE_PER_PX_FLOOR,
    );
    // The control: the same measure finds next to nothing where there is
    // no text.
    expect(perPixel(held.background), evidence()).toBeLessThan(
      BACKGROUND_EDGE_PER_PX_CEILING,
    );
  });

  // Without this the cases below could not fail here: a metric that cannot
  // tell 0.2 from the pick says nothing about the pick.
  it("the metric tells a known-bad encode apart, this run", () => {
    expect(edgeRatio(share) - edgeRatio(control), evidence()).toBeGreaterThan(
      DISCRIMINATION_MIN,
    );
  });

  it("share text stays crisp", () => {
    expect(keptFraction(share), evidence()).toBeGreaterThan(KEPT_FRACTION_MIN);
  });

  // The cap's floor (§8) is a file the author accepted; the check must not
  // call it soft. Only on macOS, where KEPT_FRACTION_MIN was measured: CI's
  // Linux encoder, at the same three bitrates, puts 0.35 barely above 0.2
  // (edge ratios 0.827 and 0.815 in run 39919278451, so it kept 0.07, where
  // this Mac keeps 0.30), a gap inside the measure's own run-to-run spread,
  // so there the case passed or failed by chance. `pnpm test` runs it here
  // before a release; vitest reports it skipped on CI.
  it.skipIf(process.platform !== "darwin")(
    "the cap's floor, quality 0.35, is not called soft (macOS's encoder)",
    () => {
      expect(keptFraction(floor), evidence()).toBeGreaterThan(
        KEPT_FRACTION_MIN,
      );
    },
  );

  it("share is smaller by the measured ratio", () => {
    expect(
      share.bytes.byteLength / full.bytes.byteLength,
      evidence(),
    ).toBeLessThanOrEqual(SIZE_RATIO);
  });
});
