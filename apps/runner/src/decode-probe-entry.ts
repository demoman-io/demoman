/**
 * The test-only DECODE probe: everything in this lane that has to look at
 * the pixels of an mp4 the runner produced goes through this file.
 *
 * Split out of `mux-entry.ts` on Task 11's fix round 1 (as
 * `mux-probe-entry.ts`) after a reviewer measured what folding a probe into
 * a production entry costs: `mux-entry.ts` alone (`muxSpan`/`readChunk`,
 * what a real replay run actually needs) is 987,225 bytes; with mediabunny's
 * demux side added it was 1,657,504 — ~654 KB, ~40%, of dead weight injected
 * into the page on every real run for a codepath only a test ever calls.
 * Renamed on Task 13, when the acceptance test needed the same decode with
 * the pixels read back: two probe files would have been the same 654 KB
 * duplicated behind two globals, and `decodeFrame` and `sampleFrames` are
 * the same `Input`/`CanvasSink` open with different questions asked of it.
 *
 * No production path bundles or injects this file. `mux.test.ts` and
 * `acceptance.slow.test.ts` do, via the same `bundleEntry` + `page.addScriptTag`
 * mechanism `mux.ts`/`render.ts` use for their own entries — additively, so
 * `MUX_ENTRY_GLOBAL` (production) and `DECODE_PROBE_GLOBAL` (this file) can
 * coexist on one page without either overwriting the other.
 *
 * Node has no WebCodecs, so the page is the only place any of this can
 * happen; and it must be a `http://127.0.0.1` page rather than
 * `about:blank`, which is not a secure context and where `VideoDecoder` is
 * therefore undefined ("VideoDecoder is not available in this environment"
 * — measured 2026-09-09, the first thing Task 13's probe hit).
 *
 * CLAUDE.md: "assert on the picture, not the bundle." This file is how that
 * assertion gets made.
 */
import {
  ALL_FORMATS,
  BufferSource,
  CanvasSink,
  Input,
  UrlSource,
  VideoSampleSink,
} from "mediabunny";
import { DECODE_PROBE_GLOBAL } from "./entry-globals.js";

/** One fractional point, rect or colour. Fractions of the frame's own width
 *  and height, never absolute pixels: a target-size change must not silently
 *  move a sample off the thing it samples. */
export type Point = [fx: number, fy: number];
export type Rect = [fx0: number, fy0: number, fx1: number, fy1: number];
export type Rgb = [r: number, g: number, b: number];

export interface FrameReading {
  /** The timestamp this reading was asked for, in seconds. */
  tSec: number;
  /** Mean colour of a small square block centred on each requested point,
   *  in request order. A block mean, not a single pixel: the fixture app's
   *  own body text is `#111827` — the exact colour of the panel this lane
   *  samples for — so a one-pixel sample that lands on a glyph reads as
   *  "panel" over a white table. Averaging a block puts thin dark text back
   *  where it belongs, a few levels off white. */
  blocks: Rgb[];
  /** For each requested colour, how many pixels of the (downscaled, see
   *  `WORK_WIDTH`) frame are within `colorTolerance` of it, per channel —
   *  after that colour's `colorErode` radius, if any, has thrown away the
   *  matches that are not part of a flat fill. */
  colorCounts: number[];
  /** For each requested rect, at FULL resolution. */
  rects: RectReading[];
}

export interface RectReading {
  nearWhite: number;
  meanLuma: number;
  total: number;
  /**
   * The bounding box of the near-white pixels, as fractions of the FRAME
   * (not of the rect), or null when there are none.
   *
   * A count alone cannot tell a small bright THING from a bright EDGE. Task
   * 13 found that out: the cursor rect's left side can come to rest on the
   * panel's own left edge as the camera pulls out, and the few columns of
   * white table that leak in are more near-white pixels than the whole
   * pointer — so a count-only check passed a render with the cursor
   * deliberately switched off. A 31x56 arrow and a 5x389 sliver of table
   * differ in shape, and this is the shape.
   */
  nearWhiteBox: { width: number; height: number } | null;
}

export interface FrameTimes {
  width: number;
  height: number;
  timesSec: number[];
  /** Per frame, in the same order as `timesSec`: how much its picture
   *  differs from the frame before it — the mean absolute difference per
   *  channel, in 0–255 levels, over a `CHANGE_WORK_WIDTH`-wide copy of both.
   *  The first frame has nothing before it and reads 0. */
  changes: number[];
}

/**
 * One rect of one decoded frame, resampled to a size and reduced to grey:
 * how much detail it holds. `readCrops`' answer, one per instant.
 */
export interface CropReading {
  /** The decoded frame's own size, and the timestamp of the frame read. */
  frameWidth: number;
  frameHeight: number;
  frameSec: number;
  /** The crop as read, in the frame's pixels, before resampling. */
  source: { x: number; y: number; width: number; height: number };
  width: number;
  height: number;
  /** Variance of the grey levels (0-255), over every pixel: a flat patch is
   *  ~0, a patch of text over a page is hundreds. */
  lumaVariance: number;
  /** Sum over the interior pixels of |Gx| + |Gy|, the 3x3 Sobel responses
   *  on the grey levels. What a soft encode of text loses first. */
  edgeEnergy: number;
  /** The grey levels, row-major, base64, when asked for (`withGrey`): for
   *  a caller that writes the crop out to look at it. */
  grey?: string;
}

export interface DecodeProbeEntry {
  /** Every frame of the film at `url`, decoded in order: its timestamp, and
   *  how much its picture changed from the frame before. */
  frameTimes(url: string): Promise<FrameTimes>;
  decodeFrame(
    base64: string,
    atSec: number,
  ): Promise<{ width: number; height: number; decoded: boolean }>;
  sampleFrames(
    base64: string,
    request: SampleRequest,
  ): Promise<{
    durationSec: number;
    width: number;
    height: number;
    readings: FrameReading[];
  }>;
  readCrops(
    base64: string,
    atSecs: number[],
    rect: Rect,
    size: { width: number; height: number },
    withGrey: boolean,
  ): Promise<CropReading[]>;
  sampleImage(
    base64: string,
    type: string,
    request: SampleRequest,
  ): Promise<{
    width: number;
    height: number;
    frameCount: number;
    readings: FrameReading[];
  }>;
}

export interface SampleRequest {
  /**
   * Read one frame every this many seconds, across the whole file.
   *
   * A spacing, not a count. It was a count, spread over whatever duration
   * the file turned out to have — so when recorded paces took the fixture's
   * render from ~7.7s to ~13.3s, the same 120 frames landed half as densely
   * and the ~250ms window the acceptance test needs caught one sample or
   * two, and the test flaked. The density a window needs is a property of
   * the window, not of the file.
   */
  spacingSec: number;
  blockPoints: Point[];
  /** Block side, as a fraction of the frame's width. */
  blockFraction: number;
  colors: Rgb[];
  colorTolerance: number;
  /**
   * Per colour, in working-canvas pixels: how far from a matching pixel the
   * colour must STILL match, up, down, left and right, for that pixel to be
   * counted. 0 counts every match.
   *
   * A plus-shaped erosion, and the cheapest honest answer to "is this a flat
   * FILL of the colour, or just some pixels of it". The fixture app's body
   * text is `#111827`, the panel's exact colour, and the camera magnifies
   * that text as it zooms into the table — enough that a plain match count
   * on a panel-CLOSED frame reached 1,637 against a 5,000 threshold meant to
   * mean "the panel is on screen". A radius of `r` removes any stroke
   * narrower than `2r`, and leaves the interior of a fill wider than that
   * almost untouched. Out-of-bounds counts as no match, which is the
   * conservative direction.
   */
  colorErode: number[];
  rects: Rect[];
  /** A pixel counts as near-white when every channel is at or above this. */
  nearWhiteMin: number;
}

/**
 * The colour counts run over a quarter-scale copy of each frame rather than
 * the 3840x2160 original: at full size one frame is 8.3M pixels and 33 MB of
 * `ImageData`, and a sweep reads dozens of frames. Every colour this lane
 * counts is a large flat fill (a 4K-composed button is ~420x65 output px,
 * the panel is a fifth of the frame), so its interior survives the area
 * average intact and only the one-pixel-wide antialiased rim is lost. The
 * cursor is the exception — 31x56 output px of white with a dark stroke,
 * which a quarter-scale average blends into its background — so `rects` is
 * read from the full-resolution canvas instead.
 */
const WORK_WIDTH = 960;

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function openTrack(base64: string) {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(decodeBase64(base64)),
  });
  const track = await input.getPrimaryVideoTrack();
  return { input, track };
}

/**
 * Takes the mp4's bytes as base64, not a raw `Uint8Array` argument — the
 * same reason `mux-entry.ts`'s `readChunk` hands bytes back as base64
 * rather than risking an untested serialization path for a binary typed
 * array across `page.evaluate`'s boundary. Fixture-sized in every caller,
 * so the crossing `mux.ts`'s own docblock warns about never applies here.
 */
async function decodeFrame(
  base64: string,
  atSec: number,
): Promise<{ width: number; height: number; decoded: boolean }> {
  try {
    const { track } = await openTrack(base64);
    if (!track || !(await track.canDecode())) {
      return { width: 0, height: 0, decoded: false };
    }
    const sink = new CanvasSink(track);
    const result = await sink.getCanvas(atSec);
    if (!result) return { width: 0, height: 0, decoded: false };
    return {
      width: result.canvas.width,
      height: result.canvas.height,
      decoded: true,
    };
  } catch {
    // A probe answers "can this be decoded", so a thrown demux/decode
    // error becomes a false verdict rather than an uncaught rejection the
    // test would have to unwrap for the same fact.
    return { width: 0, height: 0, decoded: false };
  }
}

/**
 * Reads a frame every `request.spacingSec` and answers, for each, only
 * the handful of numbers the caller asked for.
 *
 * Deliberately never hands a frame back. One 4K frame is 33 MB of
 * `ImageData` and `page.evaluate` serializes its result through JSON; a
 * sweep of them would cost more to move than to decode, and node could not
 * look at the pixels anyway. Every reduction that decides an assertion
 * happens here, next to the pixels.
 *
 * Unlike `decodeFrame` this does NOT swallow: a caller sweeping a file it
 * has already decoded once is asking a question a false verdict cannot
 * answer, and "the mp4 the runner just wrote could not be demuxed" must
 * reach the test as that sentence rather than as an empty reading list.
 */
async function sampleFrames(
  base64: string,
  request: SampleRequest,
): Promise<{
  durationSec: number;
  width: number;
  height: number;
  readings: FrameReading[];
}> {
  const { input, track } = await openTrack(base64);
  if (!track) throw new Error("this mp4 has no video track to sample");
  if (!(await track.canDecode())) {
    throw new Error(
      `this mp4's video track (${track.codec ?? "unknown codec"}) cannot be decoded in this browser`,
    );
  }
  const durationSec = await input.computeDuration();

  // The last timestamp is pulled a frame's-width back off the end: a
  // request for exactly `durationSec` is past the last frame's start and
  // `canvasesAtTimestamps` answers it with `null`.
  if (!(request.spacingSec > 0)) {
    throw new Error(
      `spacingSec must be a positive number of seconds, not ${request.spacingSec}`,
    );
  }
  const timestamps: number[] = [];
  const span = Math.max(0, durationSec - 1 / 30);
  const steps = Math.ceil(span / request.spacingSec);
  for (let i = 0; i <= steps; i++) {
    timestamps.push(steps === 0 ? 0 : (span * i) / steps);
  }

  const readings: FrameReading[] = [];
  let width = 0;
  let height = 0;
  let index = 0;
  const sink = new CanvasSink(track);
  for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
    const tSec = timestamps[index++] as number;
    if (!wrapped) {
      throw new Error(
        `no frame decoded at ${tSec.toFixed(3)}s of a ${durationSec.toFixed(3)}s mp4`,
      );
    }
    const full = wrapped.canvas as OffscreenCanvas;
    width = full.width;
    height = full.height;
    readings.push(readCanvas(full, request, tSec));
  }
  return { durationSec, width, height, readings };
}

/**
 * The frame at each of `atSecs`, cut at `rect` (fractions of the frame) and
 * drawn at `size` with high-quality smoothing, so two renders of different
 * sizes are compared at one scale. Throws, like `sampleFrames`: a caller
 * comparing two files' detail cannot use a false verdict.
 */
async function readCrops(
  base64: string,
  atSecs: number[],
  rect: Rect,
  size: { width: number; height: number },
  withGrey: boolean,
): Promise<CropReading[]> {
  const { track } = await openTrack(base64);
  if (!track) throw new Error("this mp4 has no video track to read");
  if (!(await track.canDecode())) {
    throw new Error(
      `this mp4's video track (${track.codec ?? "unknown codec"}) cannot be decoded in this browser`,
    );
  }
  const readings: CropReading[] = [];
  let index = 0;
  for await (const wrapped of new CanvasSink(track).canvasesAtTimestamps(
    atSecs,
  )) {
    const atSec = atSecs[index++] as number;
    if (!wrapped) throw new Error(`no frame decoded at ${atSec.toFixed(3)}s`);
    readings.push(
      cropReading(
        wrapped.canvas as OffscreenCanvas,
        wrapped.timestamp,
        rect,
        size,
        withGrey,
      ),
    );
  }
  return readings;
}

function cropReading(
  full: OffscreenCanvas,
  frameSec: number,
  [fx0, fy0, fx1, fy1]: Rect,
  { width, height }: { width: number; height: number },
  withGrey: boolean,
): CropReading {
  const source = {
    x: Math.round(fx0 * full.width),
    y: Math.round(fy0 * full.height),
    width: Math.max(1, Math.round((fx1 - fx0) * full.width)),
    height: Math.max(1, Math.round((fy1 - fy0) * full.height)),
  };
  const out = new OffscreenCanvas(width, height);
  const ctx = out.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    full,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    width,
    height,
  );
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const grey = new Uint8Array(width * height);
  let sum = 0;
  for (let i = 0; i < grey.length; i++) {
    const p = i * 4;
    const y = Math.round(
      0.299 * (pixels[p] as number) +
        0.587 * (pixels[p + 1] as number) +
        0.114 * (pixels[p + 2] as number),
    );
    grey[i] = y;
    sum += y;
  }
  const mean = sum / grey.length;
  let squares = 0;
  for (const y of grey) squares += (y - mean) ** 2;
  let edgeEnergy = 0;
  const at = (x: number, y: number) => grey[y * width + x] as number;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1);
      edgeEnergy += Math.abs(gx) + Math.abs(gy);
    }
  }
  const reading: CropReading = {
    frameWidth: full.width,
    frameHeight: full.height,
    frameSec,
    source,
    width,
    height,
    lumaVariance: squares / grey.length,
    edgeEnergy,
  };
  if (withGrey) {
    let binary = "";
    for (const y of grey) binary += String.fromCharCode(y);
    reading.grey = btoa(binary);
  }
  return reading;
}

/** One frame, read the way every probe reads it: rects at full resolution,
 *  block means and colour counts on a `WORK_WIDTH`-wide copy. */
function readCanvas(
  full: OffscreenCanvas,
  request: SampleRequest,
  tSec: number,
): FrameReading {
  // Full resolution, for the rects only — see WORK_WIDTH's docblock.
  const fullCtx = full.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const rects = request.rects.map((rect) =>
    readRect(fullCtx, full, rect, request.nearWhiteMin),
  );

  const work = new OffscreenCanvas(
    WORK_WIDTH,
    Math.max(1, Math.round((WORK_WIDTH * full.height) / full.width)),
  );
  const workCtx = work.getContext("2d") as OffscreenCanvasRenderingContext2D;
  workCtx.imageSmoothingEnabled = true;
  workCtx.imageSmoothingQuality = "high";
  workCtx.drawImage(full, 0, 0, work.width, work.height);
  const pixels = workCtx.getImageData(0, 0, work.width, work.height).data;

  return {
    tSec,
    blocks: request.blockPoints.map((point) =>
      blockMean(pixels, work.width, work.height, point, request.blockFraction),
    ),
    colorCounts: countColors(
      pixels,
      work.width,
      work.height,
      request.colors,
      request.colorTolerance,
      request.colorErode,
    ),
    rects,
  };
}

/** A GIF's frames or a PNG's one frame, read like `sampleFrames` reads an
 *  mp4. `ImageDecoder` is WebCodecs: secure contexts only, like the rest. */
async function sampleImage(
  base64: string,
  type: string,
  request: SampleRequest,
): Promise<{
  width: number;
  height: number;
  frameCount: number;
  readings: FrameReading[];
}> {
  const decoder = new ImageDecoder({ data: decodeBase64(base64), type });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  if (!track) throw new Error(`this ${type} has no image track to sample`);
  const frameCount = track.frameCount;
  if (frameCount === 0) throw new Error(`this ${type} has no frames`);
  // First, last, and every `step`-th between: a GIF of a minute is ~900 frames.
  const step = Math.max(1, Math.floor(frameCount / 24));
  const indices = new Set<number>([0, frameCount - 1]);
  for (let i = 0; i < frameCount; i += step) indices.add(i);
  const readings: FrameReading[] = [];
  let width = 0;
  let height = 0;
  for (const index of [...indices].sort((a, b) => a - b)) {
    const { image } = await decoder.decode({ frameIndex: index });
    width = image.displayWidth;
    height = image.displayHeight;
    const full = new OffscreenCanvas(width, height);
    (full.getContext("2d") as OffscreenCanvasRenderingContext2D).drawImage(
      image,
      0,
      0,
    );
    image.close();
    readings.push(readCanvas(full, request, index));
  }
  decoder.close();
  return { width, height, frameCount, readings };
}

function blockMean(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  [fx, fy]: Point,
  blockFraction: number,
): Rgb {
  const side = Math.max(1, Math.round(blockFraction * width));
  const half = Math.floor(side / 2);
  const cx = Math.round(fx * width);
  const cy = Math.round(fy * height);
  const x0 = Math.max(0, cx - half);
  const y0 = Math.max(0, cy - half);
  const x1 = Math.min(width - 1, cx + half);
  const y1 = Math.min(height - 1, cy + half);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = (y * width + x) * 4;
      r += pixels[p] as number;
      g += pixels[p + 1] as number;
      b += pixels[p + 2] as number;
      n++;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function matches(
  pixels: Uint8ClampedArray,
  index: number,
  [cr, cg, cb]: Rgb,
  tolerance: number,
): boolean {
  const p = index * 4;
  return (
    Math.abs((pixels[p] as number) - cr) <= tolerance &&
    Math.abs((pixels[p + 1] as number) - cg) <= tolerance &&
    Math.abs((pixels[p + 2] as number) - cb) <= tolerance
  );
}

function countColors(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  colors: Rgb[],
  tolerance: number,
  erode: number[],
): number[] {
  const counts = colors.map(() => 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      for (let c = 0; c < colors.length; c++) {
        const color = colors[c] as Rgb;
        if (!matches(pixels, index, color, tolerance)) continue;
        const r = erode[c] ?? 0;
        if (
          r > 0 &&
          (x - r < 0 ||
            x + r >= width ||
            y - r < 0 ||
            y + r >= height ||
            !matches(pixels, index - r, color, tolerance) ||
            !matches(pixels, index + r, color, tolerance) ||
            !matches(pixels, index - r * width, color, tolerance) ||
            !matches(pixels, index + r * width, color, tolerance))
        ) {
          continue;
        }
        counts[c] = (counts[c] as number) + 1;
      }
    }
  }
  return counts;
}

function readRect(
  ctx: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  [fx0, fy0, fx1, fy1]: Rect,
  nearWhiteMin: number,
): RectReading {
  const x = Math.round(fx0 * canvas.width);
  const y = Math.round(fy0 * canvas.height);
  const w = Math.max(1, Math.round((fx1 - fx0) * canvas.width));
  const h = Math.max(1, Math.round((fy1 - fy0) * canvas.height));
  const pixels = ctx.getImageData(x, y, w, h).data;
  let nearWhite = 0;
  let luma = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let p = 0; p < pixels.length; p += 4) {
    const r = pixels[p] as number;
    const g = pixels[p + 1] as number;
    const b = pixels[p + 2] as number;
    luma += 0.299 * r + 0.587 * g + 0.114 * b;
    if (r >= nearWhiteMin && g >= nearWhiteMin && b >= nearWhiteMin) {
      nearWhite++;
      const index = p / 4;
      const px = index % w;
      const py = (index - px) / w;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  const total = pixels.length / 4;
  return {
    nearWhite,
    meanLuma: luma / total,
    total,
    nearWhiteBox:
      maxX < 0
        ? null
        : {
            width: (maxX - minX + 1) / canvas.width,
            height: (maxY - minY + 1) / canvas.height,
          },
  };
}

/**
 * The width `frameTimes` compares consecutive frames at. The compositor
 * writes every exported frame on a fixed grid, so an export's timestamps
 * are the same for a film that moves and one that is a slideshow of stills;
 * only the pictures differ. A small copy is what makes reading every frame
 * of a 4K film affordable (one 4K frame is 33 MB of `ImageData`; this is
 * ~92 KB), and the area average it takes also flattens the encoder's grain,
 * which would otherwise read as change on a picture that has not moved.
 */
const CHANGE_WORK_WIDTH = 160;

/** Every frame decoded, in order: the gate's cadence comes from these
 *  timestamps, so they are DECODED frames, not the container's index — a
 *  sample that will not decode is not a frame anyone sees. Each frame is
 *  also drawn at `CHANGE_WORK_WIDTH` and compared with the one before, so
 *  the gate can see stretches where the picture did not move. */
async function frameTimes(url: string): Promise<FrameTimes> {
  // No retries: the file is on a loopback server in this process, so a
  // failed fetch is the server saying it could not read it. mediabunny's
  // default backs off and retries forever, which turned that into a measure
  // that never returned (found 2026-10-13 by the EISDIR case in
  // compare-measure.test.ts).
  const input = new Input({
    source: new UrlSource(url, { getRetryDelay: () => null }),
    formats: ALL_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  if (track === null) throw new Error(`${url} has no video track`);
  const width = track.displayWidth;
  const height = track.displayHeight;
  const work = new OffscreenCanvas(
    CHANGE_WORK_WIDTH,
    Math.max(1, Math.round((CHANGE_WORK_WIDTH * height) / width)),
  );
  const ctx = work.getContext("2d", {
    willReadFrequently: true,
  }) as OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const timesSec: number[] = [];
  const changes: number[] = [];
  let previous: Uint8ClampedArray | null = null;
  for await (const sample of new VideoSampleSink(track).samples()) {
    try {
      timesSec.push(sample.timestamp);
      sample.draw(ctx, 0, 0, work.width, work.height);
    } finally {
      sample.close();
    }
    const pixels = ctx.getImageData(0, 0, work.width, work.height).data;
    changes.push(
      previous === null ? 0 : meanAbsoluteDifference(previous, pixels),
    );
    previous = pixels;
  }
  return { width, height, timesSec, changes };
}

/** Mean absolute difference per colour channel (alpha left out), 0–255. */
function meanAbsoluteDifference(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
): number {
  let sum = 0;
  for (let p = 0; p < a.length; p += 4) {
    sum +=
      Math.abs((a[p] as number) - (b[p] as number)) +
      Math.abs((a[p + 1] as number) - (b[p + 1] as number)) +
      Math.abs((a[p + 2] as number) - (b[p + 2] as number));
  }
  return sum / ((a.length / 4) * 3);
}

const entry: DecodeProbeEntry = {
  decodeFrame,
  readCrops,
  sampleFrames,
  sampleImage,
  frameTimes,
};
(globalThis as unknown as Record<string, unknown>)[DECODE_PROBE_GLOBAL] = entry;
