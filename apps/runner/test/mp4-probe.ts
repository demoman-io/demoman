import { createServer } from "node:http";
import { join } from "node:path";
import type { Page } from "playwright";
import { bundleEntry } from "../src/bundle-js.js";
import type {
  CropReading,
  DecodeProbeEntry,
  FrameReading,
  FrameTimes,
  Point,
  Rect,
  Rgb,
  SampleRequest,
} from "../src/decode-probe-entry.js";
import { DECODE_PROBE_GLOBAL } from "../src/entry-globals.js";
import { launch } from "../src/launch.js";
import { listenOnLoopback } from "../src/loopback.js";

export interface Mp4Sample {
  durationSec: number;
  width: number;
  height: number;
  readings: FrameReading[];
}

let probeBundle: Promise<string> | null = null;
function decodeProbeBundle(): Promise<string> {
  probeBundle ??= bundleEntry(
    join(import.meta.dirname, "..", "src", "decode-probe-entry.ts"),
  ).catch((error: unknown) => {
    probeBundle = null;
    throw error;
  });
  return probeBundle;
}

/**
 * Decodes an mp4 and reads it every quarter second: colour counts for
 * `colors` and block means at `blockPoints` (fractions of the frame). The
 * export tests' one door onto the picture, and `render.slow.test.ts`'s.
 *
 * In a headless browser of its own, on a loopback `http://127.0.0.1` page:
 * node has no WebCodecs, and `about:blank` is not a secure context, so
 * `VideoDecoder` is undefined there (see `decode-probe-entry.ts`). Never on
 * the browser under test, whose pages and windows are what a case measures.
 * Same `DECODE_PROBE_GLOBAL` call as `acceptance.test.ts`'s `sweep`.
 */
export async function sampleMp4(
  bytes: Uint8Array,
  req: { colors: Rgb[]; blockPoints?: Point[] },
): Promise<Mp4Sample> {
  const request = sampleRequest(req);
  const base64 = Buffer.from(bytes).toString("base64");
  return inProbePage((page) =>
    page.evaluate(
      ([globalName, data, sample]) => {
        const entry = (
          globalThis as unknown as Record<string, DecodeProbeEntry | undefined>
        )[globalName as string];
        if (entry === undefined) {
          throw new Error(
            `${globalName} is not installed on this page — the probe must ` +
              "inject decode-probe-entry.ts's bundle before calling into it",
          );
        }
        return entry.sampleFrames(data as string, sample as SampleRequest);
      },
      [DECODE_PROBE_GLOBAL, base64, request] as const,
    ),
  );
}

/**
 * One rect of the frame at each of `atSecs`, resampled to `size`, with its
 * grey variance and Sobel edge energy (`CropReading`); the grey levels too
 * when `withGrey`. Same page, same door.
 */
export async function readMp4Crops(
  bytes: Uint8Array,
  atSecs: number[],
  rect: Rect,
  size: { width: number; height: number },
  withGrey = false,
): Promise<CropReading[]> {
  const base64 = Buffer.from(bytes).toString("base64");
  return inProbePage((page) =>
    page.evaluate(
      ([globalName, data, times, r, s, grey]) => {
        const entry = (
          globalThis as unknown as Record<string, DecodeProbeEntry | undefined>
        )[globalName as string];
        if (entry === undefined) {
          throw new Error(
            `${globalName} is not installed on this page — the probe must ` +
              "inject decode-probe-entry.ts's bundle before calling into it",
          );
        }
        return entry.readCrops(
          data as string,
          times as number[],
          r as Rect,
          s as { width: number; height: number },
          grey as boolean,
        );
      },
      [DECODE_PROBE_GLOBAL, base64, atSecs, rect, size, withGrey] as const,
    ),
  );
}

export interface ImageSample {
  width: number;
  height: number;
  frameCount: number;
  /** One reading per frame read: `tSec` holds the frame's index. */
  readings: FrameReading[];
}

/**
 * Decodes a GIF or PNG with WebCodecs' `ImageDecoder` and reads its frames
 * (first, last and about two dozen between) like `sampleMp4` reads a film.
 * Same page, same door.
 */
export async function sampleImage(
  bytes: Uint8Array,
  type: "image/gif" | "image/png",
  req: { colors: Rgb[]; blockPoints?: Point[] },
): Promise<ImageSample> {
  const request = sampleRequest(req);
  const base64 = Buffer.from(bytes).toString("base64");
  return inProbePage((page) =>
    page.evaluate(
      ([globalName, data, mime, sample]) => {
        const entry = (
          globalThis as unknown as Record<string, DecodeProbeEntry | undefined>
        )[globalName as string];
        if (entry === undefined) {
          throw new Error(
            `${globalName} is not installed on this page — the probe must ` +
              "inject decode-probe-entry.ts's bundle before calling into it",
          );
        }
        return entry.sampleImage(
          data as string,
          mime as string,
          sample as SampleRequest,
        );
      },
      [DECODE_PROBE_GLOBAL, base64, type, request] as const,
    ),
  );
}

function sampleRequest(req: {
  colors: Rgb[];
  blockPoints?: Point[];
}): SampleRequest {
  return {
    spacingSec: 0.25,
    blockPoints: req.blockPoints ?? [],
    blockFraction: 0.01,
    colors: req.colors,
    colorTolerance: 24,
    colorErode: req.colors.map(() => 0),
    rects: [],
    nearWhiteMin: 245,
  };
}

/**
 * Every decoded frame's timestamp in an mp4 (`frameTimes`), read from the
 * file itself: where each picture sits on the film's clock. Same page, same
 * door; the bytes are served at `/film.mp4` on the probe page's own origin,
 * because `frameTimes` reads a URL.
 */
export async function mp4FrameTimes(bytes: Uint8Array): Promise<FrameTimes> {
  return inProbePage(
    (page) =>
      page.evaluate(
        ([globalName, url]) => {
          const entry = (
            globalThis as unknown as Record<
              string,
              DecodeProbeEntry | undefined
            >
          )[globalName as string];
          if (entry === undefined) {
            throw new Error(
              `${globalName} is not installed on this page — the probe must ` +
                "inject decode-probe-entry.ts's bundle before calling into it",
            );
          }
          return entry.frameTimes(new URL(url as string, location.href).href);
        },
        [DECODE_PROBE_GLOBAL, "/film.mp4"] as const,
      ),
    bytes,
  );
}

async function inProbePage<T>(
  fn: (page: Page) => Promise<T>,
  film?: Uint8Array,
): Promise<T> {
  const server = createServer((req, res) => {
    if (film !== undefined && req.url === "/film.mp4") {
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": String(film.byteLength),
      });
      res.end(Buffer.from(film));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><meta charset=utf-8><title>probe</title>");
  });
  const origin = await listenOnLoopback(server);
  const launched = await launch();
  try {
    const { page } = launched;
    await page.goto(origin);
    await page.addScriptTag({ content: await decodeProbeBundle() });
    return await fn(page);
  } finally {
    await launched.close();
    server.close();
  }
}
