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
 *  moved within `REST_SEC` either side of it: about 18 pixels of 1280x720.
 *  Mid-move reads 1-16%; the pointer alone gliding reads 0.01-0.08% from
 *  one frame to the next, and two films place it apart enough to read
 *  0.04% changed (measured), so a moment with the pointer moving is not at
 *  rest. */
export const REST_SHARE = 0.00002;
/**
 * How long the film must hold one picture before and after a moment for it
 * to be at rest: `REST_SEC` each way, so a hold of more than 0.5 s.
 *
 * Not one frame back. The export holds each screencast capture until the
 * next, so a capture slower than its 30 fps leaves runs of equal frames
 * in the middle of an animation, each a phase of it the other film never
 * caught. CI on 2026-10-27 (PR #9, ubuntu "runner (1)") judged such a frame
 * of the fixture's 800 ms panel slide at rest and read "5.127% of the
 * picture changed at 4.00s": the slide fills 3.5-4.6 s of that film.
 *
 * Why 0.25 s. The holds inside motion, measured: on a Mac these films hold
 * a frame 2-6 frames (at most 0.2 s) between camera moves; a step's full
 * still stalls the screencast 87-272 ms (`constants.ts`, beside
 * `SPAN_QUIET_MS`); ubuntu CI caught the same slide in 22 frames against 34,
 * and once split it at a pause of 250 ms or more. A hold must outlast twice
 * the longest of those to read as rest. The other way, the rest a film is
 * judged on: the fixture films' opening holds 1.3 s, so 6 moments at rest
 * (0.4 s: 5; one frame: 9, the 3 more all brief holds between moves).
 * Larger would judge fewer moments after the first step, and a change shown
 * only there would go unseen; smaller brings a stalled slide within reach.
 * A runner whose screencast falls silent for over 0.5 s mid-animation would
 * still read that hold as rest: none measured so far comes near it.
 */
export const REST_SEC = 0.25;
export const PICTURE_OPTIONS: PictureOptions = {
  spacingSec: 0.25,
  width: 1280,
  levels: 48,
  windowSec: SLACK_SEC,
  restShare: REST_SHARE,
  restSec: REST_SEC,
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
      [DECODE_PROBE_GLOBAL, type, PICTURE_OPTIONS] as const,
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
        detail: `${pct}% of the picture changed at ${worst.t.toFixed(2)}s, over the ${(CHANGED_SHARE * 100).toFixed(3)}% allowed, of ${where}`,
      }
    : {
        same: true,
        detail: `at most ${pct}% of the picture changed, over ${where}`,
      };
}
