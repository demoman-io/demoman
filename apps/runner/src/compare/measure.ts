import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleEntry } from "../bundle-js.js";
import type { DecodeProbeEntry, FrameTimes } from "../decode-probe-entry.js";
import { DECODE_PROBE_GLOBAL } from "../entry-globals.js";
import { launch } from "../launch.js";
import { listenOnLoopback } from "../loopback.js";
import { stills } from "./numbers.js";

/** The in-page decode entry, as this module is running: the .ts under
 *  vite-node/tsx, the .js from the shipped CLI. Same rule as `render.ts`'s
 *  `ENTRY_PATH` — decided from this module's own extension, never by probing
 *  the filesystem. */
const ENTRY_PATH = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../decode-probe-entry.ts"
      : "../decode-probe-entry.js",
    import.meta.url,
  ),
);

export interface FilmMeasure {
  frames: number;
  width: number;
  height: number;
  durationMs: number;
  timesMs: number[];
  /** Per frame, how much its picture changed from the one before (0–255
   *  levels, mean absolute difference at the probe's working size). */
  changes: number[];
  /** The longest stretch the picture held still, in ms (`stills`). */
  longestStillMs: number;
  /** Stretches held still for `LONG_STILL_MS` or longer. */
  longStills: number;
}
export interface Measurer {
  measure(path: string): Promise<FilmMeasure>;
  close(): Promise<void>;
}

/**
 * Decodes films in a headless page: node has no WebCodecs, and CI has no
 * ffmpeg. The page is on a loopback http origin — VideoDecoder is undefined on
 * about:blank (decode-probe-entry.ts) — and fetches the file from it rather
 * than receiving tens of MB through page.evaluate. Headless decode is slow but
 * only measures; nothing here is timed.
 */
export async function createMeasurer(options?: {
  /** Tests only: the in-page entry to bundle, to make setup fail. */
  entryPath?: string;
  /** Tests only: sees the loopback server, to check setup closed it. */
  onServer?: (server: Server) => void;
}): Promise<Measurer> {
  const launched = await launch({ headless: true });
  let served: string | null = null;
  /** Why the server could not hand the page the file, for the measure that
   *  asked; the page sees only a failed fetch. */
  let serveFailed: string | null = null;
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<!doctype html><title>measure</title>");
      return;
    }
    if (
      served === null ||
      req.url !== `/${encodeURIComponent(basename(served))}`
    ) {
      res.writeHead(404).end();
      return;
    }
    const file = served;
    const stream = createReadStream(file);
    stream.once("open", () => {
      res.writeHead(200, { "content-type": "video/mp4" });
      stream.pipe(res);
    });
    stream.on("error", (error) => {
      // Said twice: here for `measure`'s refusal to quote (the page only
      // sees a failed fetch), and to the page as the response itself.
      serveFailed = `reading ${file} for the page failed: ${error.message}`;
      if (res.headersSent) res.destroy(error);
      else res.writeHead(500).end(serveFailed);
    });
  });
  options?.onServer?.(server);
  let origin: string;
  const page = launched.page;
  try {
    origin = await listenOnLoopback(server);
    await page.goto(origin);
    await page.addScriptTag({
      content: await bundleEntry(options?.entryPath ?? ENTRY_PATH),
    });
  } catch (error) {
    // Setup failed with a Chrome and a server already running and nobody
    // holding a handle: close both, and let the original cause lead.
    const cause = error instanceof Error ? error.message : String(error);
    let closeFailed = "";
    server.close();
    try {
      await launched.close();
    } catch (closeError) {
      closeFailed = `; closing the browser also failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`;
    }
    throw new Error(
      `the measure page could not be set up: ${cause}${closeFailed}`,
    );
  }
  return {
    async measure(path) {
      await stat(path); // a missing file is named here, not as a 404 in the page
      served = path;
      serveFailed = null;
      let read: FrameTimes;
      try {
        read = await page.evaluate(
          ([g, url]) => {
            const entry = (
              globalThis as unknown as Record<
                string,
                DecodeProbeEntry | undefined
              >
            )[g as string];
            if (entry === undefined) {
              throw new Error(`${g} is not installed on the measure page`);
            }
            return entry.frameTimes(url as string);
          },
          [
            DECODE_PROBE_GLOBAL,
            new URL(`/${encodeURIComponent(basename(path))}`, origin).href,
          ] as const,
        );
      } catch (error) {
        throw new Error(
          `${path} could not be decoded: ${error instanceof Error ? error.message : String(error)}${serveFailed === null ? "" : ` (${serveFailed})`}`,
        );
      }
      if (serveFailed !== null) {
        // The page decoded something, but not the whole file.
        throw new Error(`${path} could not be decoded: ${serveFailed}`);
      }
      const timesMs = read.timesSec.map((s) => s * 1000);
      const last = timesMs.at(-1) ?? 0;
      const step = timesMs.length > 1 ? last / (timesMs.length - 1) : 0;
      const durationMs = last + step;
      return {
        frames: timesMs.length,
        width: read.width,
        height: read.height,
        durationMs,
        timesMs,
        changes: read.changes,
        ...stills(timesMs, read.changes, durationMs),
      };
    },
    async close() {
      server.close();
      await launched.close();
    },
  };
}
