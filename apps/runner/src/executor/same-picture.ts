import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { bundleEntry } from "../bundle-js.js";
import type {
  DecodeProbeEntry,
  PictureDiff,
  PictureOptions,
  PictureUnreadable,
} from "../decode-probe-entry.js";
import { DECODE_PROBE_GLOBAL } from "../entry-globals.js";
import { listenOnLoopback } from "../loopback.js";
import type { BrowserSession } from "./browser.js";

/**
 * Measured 2026-10-27 (M-series Mac, headless) on refresh.slow.test.ts's two
 * fixture videos (1920x1080 MP4s at share quality, and a GIF). First, the
 * largest share changed at rest at each width and level tried, on one
 * capture of each pair (window 0.1 s, a looser rest):
 *
 *   pair                          640/24  1280/32  1280/48  1920/32
 *   re-film, nothing changed       0.013    0.009    0.006    0.010
 *   a nav link's word removed      0.035    0.035    0.029    0.035
 *   the page's heading rewritten   0.184    0.195    0.177    0.174
 *
 * 1280 wide at 48 levels leaves the most room between the first two rows.
 * Then, as set here, over three full runs of that file: every re-film with
 * nothing changed read 0.000% (nine comparisons), the nav word 0.029-0.031%,
 * the heading 0.177-0.505%. `CHANGED_SHARE` sits at half the smallest
 * change. Mid-move the same pairs read up to 7%: the camera runs a fraction
 * of a frame apart, which is why only moments at rest are judged.
 */
/** How far apart two films of one script may place a moment, and end:
 *  measured, re-films of one unchanged script ran 4.533 s, 4.567 s,
 *  4.600 s, 4.767 s and 4.800 s long (the run's own waits differ), 0.27 s
 *  apart at most. */
export const SLACK_SEC = 0.4;
/** The share of a moment at rest that may change before the picture has. */
export const CHANGED_SHARE = 0.00015;
/** A moment is at rest when less than this share of the film's own picture
 *  moved since the frame before: about 18 pixels of 1280x720. Mid-move
 *  reads 1-16%; the pointer alone gliding reads 0.01-0.08%, and two films
 *  place it apart enough to read 0.04% changed (measured), so a moment
 *  with the pointer moving is not at rest. */
export const REST_SHARE = 0.00002;
const OPTIONS: PictureOptions = {
  spacingSec: 0.25,
  width: 1280,
  levels: 48,
  windowSec: SLACK_SEC,
  restShare: REST_SHARE,
};

const ENTRY_PATH = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../decode-probe-entry.ts"
      : "../decode-probe-entry.js",
    import.meta.url,
  ),
);

/**
 * Whether `committed` and `fresh`, two MP4s or two GIFs (`fileType`, from
 * the kept output: never guessed from a name), show the same picture,
 * decoded side by side. A different frame size, or lengths further apart
 * than `SLACK_SEC`, is a different picture. A file that cannot be decoded
 * as its type is named (`undecodable`); anything else that stops the
 * comparison (no page, no decode bundle) throws: neither is an answer.
 */
export async function samePicture(
  committed: string,
  fresh: string,
  fileType: "mp4" | "gif",
  deps: { session: Pick<BrowserSession, "openWorkPage"> },
): Promise<
  | { same: boolean; detail: string }
  | { undecodable: "committed" | "new"; detail: string }
> {
  const type = fileType === "gif" ? "image/gif" : "video/mp4";
  const files = new Map([
    ["/a", await readFile(committed)],
    ["/b", await readFile(fresh)],
  ]);
  const work = await deps.session.openWorkPage();
  if (!work.ok) throw new Error(`no page to decode on: ${work.detail}`);
  const server = createServer((req, res) => {
    const bytes = files.get(req.url ?? "");
    if (bytes === undefined) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><meta charset=utf-8><title>compare</title>");
      return;
    }
    res.writeHead(200, {
      "content-type": type,
      "content-length": String(bytes.byteLength),
    });
    res.end(bytes);
  });
  let diff: PictureDiff | PictureUnreadable;
  try {
    // Loopback: `about:blank` is not a secure context, and has no decoder.
    const origin = await listenOnLoopback(server);
    await work.page.goto(origin);
    await work.page.addScriptTag({ content: await bundleEntry(ENTRY_PATH) });
    diff = await work.page.evaluate(
      ([name, mime, options]) => {
        const entry = (
          globalThis as unknown as Record<string, DecodeProbeEntry>
        )[name as string];
        if (entry === undefined) throw new Error(`${name} is not installed`);
        return entry.pictureDiff(
          "/a",
          "/b",
          mime as "video/mp4" | "image/gif",
          options as PictureOptions,
        );
      },
      [DECODE_PROBE_GLOBAL, type, OPTIONS] as const,
    );
  } finally {
    server.close();
    // The answer is read; a work page left open is the session's to close.
    await work.page.close().catch(() => undefined);
  }
  if ("unreadable" in diff) {
    return {
      undecodable: diff.unreadable === "a" ? "committed" : "new",
      detail: diff.error,
    };
  }
  return comparePictures(diff);
}

/**
 * The decision, on what the page read: the moments it compared, which are
 * those at rest. Two films of one script run the camera a fraction of a
 * frame apart, so the same pan reads as several per cent changed mid-move,
 * while an app's own picture shows where the film holds still. A film never
 * at rest is compared at every moment, and says so.
 */
export function comparePictures(diff: PictureDiff): {
  same: boolean;
  detail: string;
} {
  const { a, b, samples } = diff;
  if (a.width !== b.width || a.height !== b.height) {
    return {
      same: false,
      detail: `the frame size changed, ${a.width}x${a.height} to ${b.width}x${b.height}`,
    };
  }
  if (Math.abs(a.length - b.length) > Math.max(a.frame, b.frame, SLACK_SEC)) {
    return {
      same: false,
      detail: `the length changed, ${a.length.toFixed(3)}s to ${b.length.toFixed(3)}s`,
    };
  }
  const judged = samples.flatMap((s) =>
    s.changed === null ? [] : [{ t: s.t, changed: s.changed }],
  );
  const still = samples.some((s) => s.moving < REST_SHARE);
  const where = `${judged.length} moment${judged.length === 1 ? "" : "s"}${still ? " at rest" : " (the film is never at rest)"}`;
  const [first] = judged;
  if (first === undefined)
    return { same: false, detail: "no moment of the film could be compared" };
  const worst = judged.reduce((w, s) => (s.changed > w.changed ? s : w), first);
  const pct = (worst.changed * 100).toFixed(3);
  return worst.changed > CHANGED_SHARE
    ? {
        same: false,
        detail: `${pct}% of the picture changed at ${worst.t.toFixed(2)}s, of ${where}`,
      }
    : {
        same: true,
        detail: `at most ${pct}% of the picture changed, over ${where}`,
      };
}
