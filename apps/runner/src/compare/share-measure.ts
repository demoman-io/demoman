/**
 * `pnpm share:measure -- --take <id> [--take <id>…] --out <dir>`
 *
 * Renders a take at a grid of candidate sizes, frame rates, bitrates and
 * encoder hints, through the CLI's own render path (`renderToFiles` on a
 * headed work page), and writes `<dir>/index.html` for the author to judge:
 * a card per candidate with the video, two 1:1 crops of the densest text, and
 * the file's real size and bitrate. Launch F1's go/no-go evidence
 * (spec 2026-10-18 §3.4). Manual: it needs a display and an existing take.
 *
 * A combination the browser refuses is listed on the page with its error,
 * never dropped; a crop whose pixels hold no text says so on its card rather
 * than passing for a clean one.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ENCODER_USED_GLOBAL,
  LANDSCAPE_1080P,
  LANDSCAPE_1440P,
  landscapeFrame,
  type Mp4EncoderHints,
  type RenderTarget,
  VERTICAL_1080,
} from "@demoman/compositor";
import { frameOf, messageOf, targetFor } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { createBrowserSession } from "../executor/browser.js";
import { createLibrary } from "../executor/library.js";
import { readLogo } from "../executor/logo-ref.js";
import { type LogoInput, renderToFiles } from "../render.js";
import {
  type Candidate,
  type Crop,
  type Refused,
  type TakeRow,
  writePage,
} from "./share-page.js";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe";

/**
 * A crop is text only when enough of it is small, sharp edges. Measured on
 * this repo's sample take (scene-1792276910170-aazlt2wg76i, 1920x1348 frame,
 * crops 384x112 and 730x214), `strongEdgeShare` was 0.068, 0.100 and 0.077 on
 * three real text crops (invoice table rows, KPI cards), 0.037 on the plain
 * crop with the most edge in it (the window's rounded corner, border and
 * shadow over the gradient) and 0.000 on the bare gradient. The floor sits
 * between the text and the corner; the margin is thin on the low side, so a
 * crop of sparse text can read as "no text" -- which the card says in those
 * words, with the number.
 */
export const STRONG_STEP = 40;
export const TEXT_EDGE_FLOOR = 0.05;

/** The share of pixels with a neighbour (right or below) differing by at
 *  least `STRONG_STEP` grey levels. A border or shadow is a line or a ramp:
 *  few such pixels. Text is a crowd of them. */
export function strongEdgeShare(grey: Uint8Array, width: number): number {
  if (grey.length === 0 || width <= 0) return 0;
  const height = Math.floor(grey.length / width);
  let strong = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const here = grey[y * width + x] as number;
      const right = x + 1 < width ? (grey[y * width + x + 1] as number) : here;
      const below =
        y + 1 < height ? (grey[(y + 1) * width + x] as number) : here;
      if (
        Math.abs(here - right) >= STRONG_STEP ||
        Math.abs(here - below) >= STRONG_STEP
      )
        strong++;
    }
  }
  return strong / (width * height);
}

export interface Spec {
  frame: string;
  target: RenderTarget;
  fps: number;
  /** Multiplier on the frame's own bitrate; null for a quality-driven one. */
  mult: number | null;
  encoderLabel: string;
  encoder: Mp4EncoderHints | undefined;
}

const ENCODERS: Record<string, Mp4EncoderHints | undefined> = {
  default: undefined,
  software: { hardwareAcceleration: "prefer-software" },
  "q0.5": { quality: 0.5 },
  "q0.35": { quality: 0.35 },
};

/** A 9:16 frame at another size: the preset's shape and bitrate per pixel. */
function verticalAt(width: number, height: number): RenderTarget {
  const area = (width * height) / (VERTICAL_1080.width * VERTICAL_1080.height);
  return {
    ...VERTICAL_1080,
    width,
    height,
    bitrate: Math.round(VERTICAL_1080.bitrate * area),
    cornerRadius: Math.round(VERTICAL_1080.cornerRadius * (width / 1080)),
  };
}

/** The three frames to compare: today's, and the two smaller ones. */
export function framesFor(
  scene: SceneDocument,
  viewport: { width: number; height: number },
  today: RenderTarget,
): { name: string; target: RenderTarget }[] {
  const aspect = scene.canvas.aspect;
  const padding = scene.branding.padding;
  const list =
    aspect === "9:16"
      ? [
          { name: "today (1080×1920)", target: today },
          { name: "720×1280", target: verticalAt(720, 1280) },
        ]
      : [
          { name: "today", target: today },
          {
            name: "1440p",
            target: landscapeFrame(aspect, LANDSCAPE_1440P, viewport, padding),
          },
          {
            name: "1080p",
            target: landscapeFrame(aspect, LANDSCAPE_1080P, viewport, padding),
          },
        ];
  // A frame the same size as an earlier one adds nothing: dropped here, so
  // `gridFor` sees each size once.
  const seen = new Set<string>();
  return list.filter((f) => {
    const key = `${f.target.width}x${f.target.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One factor at a time around today's render, then the combinations a
 *  share-sized export would actually be. Not the full cross product: 96
 *  renders a take is a day. */
export function gridFor(
  frames: { name: string; target: RenderTarget }[],
): Spec[] {
  const today = frames[0];
  if (today === undefined) throw new Error("no frame to render at");
  const small = frames[frames.length - 1] ?? today;
  const mid = frames[1] ?? today;
  const full = today.target.fps;
  const half = 30;
  const spec = (
    f: { name: string; target: RenderTarget },
    fps: number,
    mult: number | null,
    enc: keyof typeof ENCODERS,
  ): Spec => ({
    frame: f.name,
    target: f.target,
    fps,
    mult,
    encoderLabel: enc,
    encoder: ENCODERS[enc],
  });
  const all: Spec[] = [
    spec(today, full, 1, "default"),
    ...frames.slice(1).map((f) => spec(f, full, 1, "default")),
    spec(today, half, 1, "default"),
    ...[0.5, 0.35, 0.25].map((m) => spec(today, full, m, "default")),
    spec(today, full, 1, "software"),
    spec(today, full, null, "q0.5"),
    spec(today, full, null, "q0.35"),
    // The small frame is where a share-sized file lives: its bitrate ladder
    // goes down to the bottom, at both frame rates.
    spec(small, half, 1, "default"),
    ...[0.5, 0.35, 0.25].map((m) => spec(small, half, m, "default")),
    ...[0.5, 0.35].map((m) => spec(small, full, m, "default")),
    spec(small, half, 0.5, "software"),
    spec(small, half, null, "q0.5"),
    spec(small, half, null, "q0.35"),
    // The middle frame, with each encoder.
    spec(mid, half, 0.5, "default"),
    spec(mid, half, 0.5, "software"),
    spec(mid, half, null, "q0.5"),
    spec(mid, half, null, "q0.35"),
  ];
  const seen = new Set<string>();
  return all.filter((s) => {
    const key = `${s.target.width}x${s.target.height}|${s.fps}|${s.mult}|${s.encoderLabel}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface Probed {
  durationSec: number;
  realMbps: number;
  width: number;
  height: number;
}

export async function probe(file: string): Promise<Probed> {
  const { stdout } = await run(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration,bit_rate:stream=width,height",
    "-select_streams",
    "v:0",
    "-of",
    "json",
    file,
  ]);
  const read = JSON.parse(stdout) as {
    format?: Record<string, string>;
    streams?: { width?: number; height?: number }[];
  };
  const format = read.format;
  const duration = Number(format?.duration);
  const bitRate = Number(format?.bit_rate);
  const width = Number(read.streams?.[0]?.width);
  const height = Number(read.streams?.[0]?.height);
  if (!(duration > 0) || !(bitRate > 0) || !(width > 0) || !(height > 0)) {
    throw new Error(
      `ffprobe could not read a duration, bit rate and size from ${file}: ${stdout.trim()}`,
    );
  }
  return { durationSec: duration, realMbps: bitRate / 1e6, width, height };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A frame as grey levels, row by row. */
export interface Grey {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * The window (a fifth of the frame wide, a twelfth tall) with the most edge
 * energy: the densest run of text or icons on a UI. Text is edges, a flat
 * panel or the gradient background is not, so this finds the table, not the
 * margin. Scanned on an integral image, so every position costs four reads.
 */
export function densestRect(frame: Grey): Rect {
  const { width, height, data } = frame;
  const stride = width + 1;
  const sums = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const here = data[y * width + x] as number;
      const dx =
        x + 1 < width
          ? Math.abs(here - (data[y * width + x + 1] as number))
          : 0;
      const dy =
        y + 1 < height
          ? Math.abs(here - (data[(y + 1) * width + x] as number))
          : 0;
      row += dx + dy;
      sums[(y + 1) * stride + x + 1] =
        (sums[y * stride + x + 1] as number) + row;
    }
  }
  const w = Math.max(2, 2 * Math.round(width / 10));
  const h = Math.max(2, 2 * Math.round(height / 24));
  const at = (x: number, y: number) => sums[y * stride + x] as number;
  const step = Math.max(2, Math.round(width / 240));
  let best = { x: 0, y: 0, score: -1 };
  for (let y = 0; y + h <= height; y += step) {
    for (let x = 0; x + w <= width; x += step) {
      const score = at(x + w, y + h) - at(x, y + h) - at(x + w, y) + at(x, y);
      if (score > best.score) best = { x, y, score };
    }
  }
  return { x: best.x, y: best.y, width: w, height: h };
}

/** The same rectangle in another frame size, as the content it covered. */
export function scaleRect(
  rect: Rect,
  from: { width: number; height: number },
  to: { width: number; height: number },
): Rect {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));
  const width = Math.min(even(rect.width * sx), to.width);
  const height = Math.min(even(rect.height * sy), to.height);
  return {
    x: Math.min(Math.round(rect.x * sx), to.width - width),
    y: Math.min(Math.round(rect.y * sy), to.height - height),
    width,
    height,
  };
}

/** The instants worth cropping, read off a reference render: a held frame,
 *  and the frame the picture changes most at (the zoom's move). Sampled at
 *  10 fps on a 64-wide grey copy. */
export function pickInstants(frames: Uint8Array[]): {
  stillSec: number;
  moveSec: number;
} {
  const FPS = 10;
  const diffs = frames.map((f, i) => {
    const prev = frames[i - 1];
    if (prev === undefined) return 0;
    let sum = 0;
    for (let k = 0; k < f.length; k++)
      sum += Math.abs((f[k] as number) - (prev[k] as number));
    return sum / f.length;
  });
  // The still is the quietest frame after the first half second; the move is
  // the loudest one. Both are reported by the page, with their times.
  let still = Math.min(FPS / 2, frames.length - 1);
  let move = 1;
  for (let i = 1; i < frames.length; i++) {
    if (i >= FPS / 2 && (diffs[i] as number) < (diffs[still] as number))
      still = i;
    if ((diffs[i] as number) > (diffs[move] as number)) move = i;
  }
  return { stillSec: still / FPS, moveSec: move / FPS };
}

async function greyFrame(
  file: string,
  atSec: number,
  size: { width: number; height: number },
): Promise<Grey> {
  const out = await run(
    FFMPEG,
    [
      "-v",
      "error",
      "-ss",
      atSec.toFixed(3),
      "-i",
      file,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  const data = new Uint8Array(out.stdout as Buffer);
  if (data.length !== size.width * size.height) {
    throw new Error(
      `ffmpeg gave ${data.length} grey bytes for ${size.width}x${size.height} at ${atSec.toFixed(2)} s`,
    );
  }
  return { ...size, data };
}

async function motionFrames(file: string): Promise<Uint8Array[]> {
  const W = 64;
  const H = 36;
  const out = await run(
    FFMPEG,
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `fps=10,scale=${W}:${H}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  const all = new Uint8Array(out.stdout as Buffer);
  const frames: Uint8Array[] = [];
  for (let i = 0; i + W * H <= all.length; i += W * H)
    frames.push(all.slice(i, i + W * H));
  if (frames.length < 2)
    throw new Error(`ffmpeg sampled ${frames.length} frame(s) from ${file}`);
  return frames;
}

/** What every candidate is cropped by, read once off a reference render. */
export interface CropPlan {
  stillSec: number;
  moveSec: number;
  still: { rect: Rect; of: { width: number; height: number } };
  move: { rect: Rect; of: { width: number; height: number } };
}

export async function planCrops(
  file: string,
  size: { width: number; height: number },
): Promise<CropPlan> {
  const { stillSec, moveSec } = pickInstants(await motionFrames(file));
  return {
    stillSec,
    moveSec,
    still: {
      rect: densestRect(await greyFrame(file, stillSec, size)),
      of: size,
    },
    move: { rect: densestRect(await greyFrame(file, moveSec, size)), of: size },
  };
}

async function cropAt(
  file: string,
  outPng: string,
  atSec: number,
  r: Rect,
): Promise<Crop> {
  const filter = `crop=${r.width}:${r.height}:${r.x}:${r.y}`;
  try {
    await rm(outPng, { force: true });
    await run(FFMPEG, [
      "-v",
      "error",
      "-y",
      "-ss",
      atSec.toFixed(3),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      filter,
      outPng,
    ]);
    const grey = await run(
      FFMPEG,
      ["-v", "error", "-i", outPng, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
      { encoding: "buffer", maxBuffer: 1 << 26 },
    );
    const bytes = new Uint8Array(grey.stdout as Buffer);
    if (bytes.length === 0) {
      return { kind: "none", why: `no frame at ${atSec.toFixed(2)} s` };
    }
    const share = strongEdgeShare(bytes, r.width);
    if (share < TEXT_EDGE_FLOOR) {
      return {
        kind: "none",
        why: `crop holds no text (sharp edges on ${(share * 100).toFixed(1)}% of pixels, under ${TEXT_EDGE_FLOOR * 100}%, at ${atSec.toFixed(2)} s)`,
      };
    }
    return {
      kind: "png",
      file: outPng.split("/").pop() as string,
      width: r.width,
      height: r.height,
    };
  } catch (error) {
    return {
      kind: "none",
      why: `ffmpeg could not cut the crop: ${messageOf(error)}`,
    };
  }
}

/** What the sink should report for a spec: the same shape `createMp4Sink`
 *  leaves in `ENCODER_USED_GLOBAL`. */
export function expectedEncoder(
  encoder: Mp4EncoderHints | undefined,
  bitrate: number,
): Record<string, unknown> {
  return {
    ...(encoder?.quality === undefined
      ? { bitrate }
      : { quality: encoder.quality }),
    ...(encoder?.bitrateMode === undefined
      ? {}
      : { bitrateMode: encoder.bitrateMode }),
    ...(encoder?.hardwareAcceleration === undefined
      ? {}
      : { hardwareAcceleration: encoder.hardwareAcceleration }),
  };
}

/**
 * The sink's record (`EncoderUsed`) against what the spec asked for. `ok`
 * says the hints arrived as asked and an encoder was opened with them;
 * `rateControl` says what the encoder was
 * opened with, which a `quality` does not decide: where the browser refuses
 * quantizer mode (headless Chromium on macOS, 2026-10-18), mediabunny falls
 * back to a bitrate it computes, and the card has to say so.
 */
export function encoderCheck(
  used: unknown,
  want: Record<string, unknown>,
): { text: string; ok: boolean; rateControl: string } {
  if (used === undefined || used === null) {
    return {
      text: "NOT REPORTED by the sink",
      ok: false,
      rateControl: "NOT REPORTED",
    };
  }
  if (typeof used !== "object") {
    return { text: String(used), ok: false, rateControl: "NOT REPORTED" };
  }
  const { rateControl, ...asked } = used as Record<string, unknown>;
  if (typeof rateControl !== "string") {
    return {
      text: `${JSON.stringify(asked)}, and no rate control: the encoder was never opened`,
      ok: false,
      rateControl: "NOT REPORTED",
    };
  }
  return JSON.stringify(asked) === JSON.stringify(want)
    ? { text: JSON.stringify(asked), ok: true, rateControl }
    : {
        text: `${JSON.stringify(asked)} but asked ${JSON.stringify(want)}`,
        ok: false,
        rateControl,
      };
}

/** A missing tool is said before the first render, not as a refused row. */
async function preflightTools(): Promise<void> {
  for (const [name, bin] of [
    ["ffmpeg", FFMPEG],
    ["ffprobe", FFPROBE],
  ] as const) {
    try {
      await run(bin, ["-version"]);
    } catch (error) {
      throw new Error(
        `${name} is needed to measure and crop the candidates and could not run at ${bin} (${messageOf(error)}); install it or set ${name.toUpperCase()}=<path>`,
      );
    }
  }
}

function parseArgs(argv: string[]): {
  takes: string[];
  out: string;
  home: string;
} {
  const takes: string[] = [];
  let out: string | null = null;
  let home = join(homedir(), ".demoman");
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined) {
      throw new Error(`share:measure: "${flag}" needs a value`);
    }
    if (flag === "--take") takes.push(value);
    else if (flag === "--out") out = value;
    else if (flag === "--home") home = value;
    else throw new Error(`share:measure: unknown argument "${flag}"`);
  }
  if (takes.length === 0 || out === null) {
    throw new Error(
      "usage: pnpm share:measure -- --take <id> [--take <id>…] --out <dir> [--home <dir>]",
    );
  }
  return { takes, out: resolve(out), home };
}

async function main(): Promise<void> {
  const { takes, out, home } = parseArgs(process.argv.slice(2));
  await preflightTools();
  await mkdir(out, { recursive: true });
  const library = createLibrary(home);
  const say = (line: string) => process.stderr.write(`${line}\n`);
  const session = createBrowserSession({
    headless: false,
    log: (line) => say(`browser: ${line}`),
  });
  const rows: TakeRow[] = [];
  try {
    for (const takeId of takes) {
      const scene = await library.getScene(takeId);
      if (scene === null)
        throw new Error(`there is no take ${takeId} in ${home}/takes`);
      const store = library.frameStore(takeId);
      const bundle = await store.getBundle(takeId);
      if (bundle === null) throw new Error(`take ${takeId} has no frames`);
      const viewport = bundle.viewport ?? scene.meta.capture.viewport;
      const today = targetFor(
        "mp4",
        scene.canvas.aspect,
        bundle,
        frameOf(scene),
      );
      const specs = gridFor(framesFor(scene, viewport, today));
      // As a real export renders it: the take's own logo, so a candidate's
      // size includes what it costs.
      const logo: LogoInput | null =
        scene.branding.logo === null
          ? null
          : await readLogo(home, scene.branding.logo.ref);
      const renderNotes: string[] = [
        logo === null
          ? "no logo"
          : logo.ok
            ? "logo drawn"
            : `logo left out (${logo.error})`,
      ];
      let plan: CropPlan | null = null;
      let planFailed: string | null = null;
      say(`${takeId}: ${specs.length} candidates`);
      const candidates: (Candidate | Refused)[] = [];
      let n = 0;
      for (const s of specs) {
        n++;
        const bitrate =
          s.mult === null
            ? s.target.bitrate
            : Math.round(s.target.bitrate * s.mult);
        const label = `${s.frame} · ${s.fps} fps · ${
          s.mult === null ? "no bitrate" : `${(bitrate / 1e6).toFixed(1)} Mbps`
        } · ${s.encoderLabel}`;
        const base = `${takeId.slice(-8)}-${n}`;
        const target: RenderTarget = {
          ...s.target,
          fps: s.fps,
          bitrate,
          ...(s.encoder === undefined ? {} : { encoder: s.encoder }),
        };
        say(`  ${n}/${specs.length} ${label}`);
        const work = await session.openWorkPage();
        if (!work.ok) {
          say(`    refused: ${work.detail}`);
          candidates.push({ kind: "refused", label, error: work.detail });
          continue;
        }
        try {
          const rendered = await renderToFiles({
            scene,
            bundle,
            store,
            page: work.page,
            target,
            fileType: "mp4",
            logo,
          });
          // The options the sink was really built with, read back from the
          // render page before it closes.
          const used: unknown = await work.page
            .evaluate(
              (g) => (globalThis as Record<string, unknown>)[g],
              ENCODER_USED_GLOBAL,
            )
            .catch(
              (e: unknown) => `the page could not be read (${messageOf(e)})`,
            );
          const { rateControl, ...encoderUsed } = encoderCheck(
            used,
            expectedEncoder(s.encoder, bitrate),
          );
          if (!encoderUsed.ok)
            say(`    encoder check failed: ${encoderUsed.text}`);
          say(`    rate control: ${rateControl}`);
          const file = rendered.files[0];
          if (file === undefined)
            throw new Error("the render produced no file");
          const name = `${base}.mp4`;
          const path = join(out, name);
          await writeFile(path, file.bytes);
          const probed = await probe(path);
          // The crops are planned once, off the first file that rendered:
          // its held frame and its biggest move, and the densest text in
          // each. Every candidate is cut at the same two instants, at the
          // same place in the picture, so the cards compare like with like.
          let still: Crop;
          let zoom: Crop;
          try {
            plan ??= await planCrops(path, probed);
            const size = { width: probed.width, height: probed.height };
            still = await cropAt(
              path,
              join(out, `${base}-still.png`),
              plan.stillSec,
              scaleRect(plan.still.rect, plan.still.of, size),
            );
            zoom = await cropAt(
              path,
              join(out, `${base}-zoom.png`),
              plan.moveSec,
              scaleRect(plan.move.rect, plan.move.of, size),
            );
          } catch (error) {
            const why = `the crops could not be planned: ${messageOf(error)}`;
            planFailed ??= why;
            still = { kind: "none", why };
            zoom = still;
          }
          candidates.push({
            kind: "file",
            file: name,
            frame: s.frame,
            width: target.width,
            height: target.height,
            fps: s.fps,
            encoder: s.encoderLabel,
            encoderUsed,
            rateControl,
            askedMbps: s.mult === null ? null : bitrate / 1e6,
            bytes: file.bytes.byteLength,
            realMbps: probed.realMbps,
            durationSec: probed.durationSec,
            still,
            zoom,
          });
        } catch (error) {
          const said = messageOf(error);
          say(`    refused: ${said}`);
          candidates.push({ kind: "refused", label, error: said });
        } finally {
          if (!work.page.isClosed()) {
            await work.page.close().catch((e: unknown) => {
              say(`    the render's page would not close (${messageOf(e)})`);
            });
          }
        }
      }
      rows.push({
        takeId,
        name: scene.meta.name ?? takeId,
        cropNote:
          (plan === null
            ? (planFailed ?? "No crops: no candidate rendered.")
            : `Crops: the densest text of a held frame at ${plan.stillSec.toFixed(1)} s (still) and of the frame the picture changes most at, ${plan.moveSec.toFixed(1)} s (mid-zoom), found on the first render and cut at the same place from every candidate.`) +
          ` Rendered with: ${renderNotes.join("; ")}.`,
        candidates,
      });
    }
  } finally {
    await session.close();
  }
  const page = await writePage(out, rows);
  const refused = rows
    .flatMap((r) => r.candidates)
    .filter((c) => c.kind === "refused");
  say(`wrote ${page} (${refused.length} refused)`);
  const unproven = rows
    .flatMap((r) => r.candidates)
    .filter((c) => c.kind === "file" && !c.encoderUsed.ok).length;
  if (unproven > 0)
    say(`${unproven} candidate(s) did not show the encoder asked for`);
  if (refused.length > 0 || unproven > 0) process.exitCode = 2;
}

// Run only as the entry: the tests import the pure parts.
if (process.argv[1]?.endsWith("share-measure.js")) {
  main().catch((error) => {
    process.stderr.write(`share:measure failed: ${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}
