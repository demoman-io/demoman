import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { KeptScreens } from "@demoman/run-core";
import { bundleEntry } from "../bundle-js.js";
import type {
  DecodeProbeEntry,
  PictureOptions,
  PictureUnreadable,
  ScreensDiff,
} from "../decode-probe-entry.js";
import { DECODE_PROBE_GLOBAL } from "../entry-globals.js";
import { listenOnLoopback } from "../loopback.js";
import type { BrowserSession } from "./browser.js";

/**
 * Measured 2026-10-28 (M-series Mac, headless) at the recorded screens, on
 * refresh.slow.test.ts's fixture videos (1920x1080 MP4s at share quality):
 * the largest share of a screen changed, in %, at each width and grey level
 * (Chrome's own decode and scaling), over one full run of that file; 1280/48
 * read the same on two runs before it.
 *
 *   pair                              1280/48  1280/64  1280/80  1280/96  1920/96
 *   re-film, nothing changed (x4)       0.000    0.000    0.000    0.000    0.000
 *   a 600 ms slower app, 2 clicks       0.0088   0.0010   0.0001   0.000    0.0007
 *   slower, ending 1500 ms after it     0.0167   0.0007   0.000    0.000    0.0015
 *   one digit, $1,200.00 to $1,207.00   0.0034   0.0027   0.0025   0.0017   0.0024
 *   a nav link removed                  0.029    0.024    0.019    0.015    0.017
 *
 * The slower apps' noise is the encoder's, not the page's: a still screen
 * that follows a camera move by a few frames still carries that move's
 * coding error, which differs between two films and fades over about six
 * frames (decoded frame by frame with ffmpeg: up to 77 grey levels, scattered,
 * against the digit's 190 in one 6x9 block). Placing the final screen at the end of
 * its still stretch rather than its middle did not help: the short ending's
 * stretch is four frames, all of them inside that fade (0.019% and 0.016% at
 * 1280/48 on two runs). So only a grey move of more than 96 levels counts,
 * and 1280 wide, where the fade averages out more than at 1920.
 * `CHANGED_SHARE` sits at half the digit, about 7 pixels at 1280x720.
 *
 * What this cannot see: a change of colour that moves a pixel's grey level
 * 96 or less, about 38% of the range — text from gray-700 to gray-500, a
 * button from blue to green, a dark panel from #111827 to #7f1d1d.
 */
/** The share of a recorded screen that may change before the picture has:
 *  half of one digit of body text (above). */
export const CHANGED_SHARE = 0.000008;
export const PICTURE_OPTIONS: PictureOptions = { width: 1280, levels: 96 };

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
 * the kept output: never guessed from a name), show the same picture at the
 * still screens both films recorded, paired by step. A different step
 * count or frame size is a different picture; no shared screen, or one past
 * a film's end, is no comparison (`uncomparable`). The films' lengths are
 * not judged. A file that cannot be decoded as its type is named
 * (`undecodable`); anything else that stops the comparison (no page, no
 * decode bundle) throws: neither is an answer.
 */
export async function samePicture(
  committed: string,
  fresh: string,
  fileType: "mp4" | "gif",
  committedScreens: KeptScreens,
  freshScreens: KeptScreens,
  deps: { session: Pick<BrowserSession, "openWorkPage"> },
): Promise<
  | { same: boolean; detail: string }
  | { undecodable: "committed" | "new"; detail: string }
  | { uncomparable: string }
> {
  if (committedScreens.steps !== freshScreens.steps) {
    return {
      same: false,
      detail: `the video's steps changed, ${committedScreens.steps} to ${freshScreens.steps}`,
    };
  }
  const shared = sharedScreens(committedScreens, freshScreens);
  if (shared.length === 0)
    return { uncomparable: "no screen of the video is still in both films" };
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
  let diff: ScreensDiff | PictureUnreadable;
  try {
    // Loopback: `about:blank` is not a secure context, and has no decoder.
    const origin = await listenOnLoopback(server);
    await work.page.goto(origin);
    await work.page.addScriptTag({ content: await bundleEntry(ENTRY_PATH) });
    diff = await work.page.evaluate(
      ([name, mime, msA, msB, options]) => {
        const entry = (
          globalThis as unknown as Record<string, DecodeProbeEntry>
        )[name as string];
        if (entry === undefined) throw new Error(`${name} is not installed`);
        return entry.screensDiff(
          "/a",
          "/b",
          mime as "video/mp4" | "image/gif",
          msA as number[],
          msB as number[],
          options as PictureOptions,
        );
      },
      [
        DECODE_PROBE_GLOBAL,
        type,
        shared.map((s) => s.msA),
        shared.map((s) => s.msB),
        PICTURE_OPTIONS,
      ] as const,
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
  return comparePictures(diff, shared, freshScreens.steps + 1);
}

/** The screens both films have, paired by `step`, in increasing ms. */
export function sharedScreens(
  a: KeptScreens,
  b: KeptScreens,
): { step: number | null; msA: number; msB: number }[] {
  return a.moments.flatMap((m) => {
    const other = b.moments.find((n) => n.step === m.step);
    return other === undefined
      ? []
      : [{ step: m.step, msA: m.ms, msB: other.ms }];
  });
}

/**
 * The decision, on what the page read: the largest share changed over the
 * shared screens, against `CHANGED_SHARE`. `total` is the screens a film can
 * have (its steps and the final one), for "k of n screens".
 */
export function comparePictures(
  diff: ScreensDiff,
  shared: ReturnType<typeof sharedScreens>,
  total: number,
): { same: boolean; detail: string } | { uncomparable: string } {
  const { a, b, changed } = diff;
  if (a.width !== b.width || a.height !== b.height) {
    return {
      same: false,
      detail: `the frame size changed, ${a.width}x${a.height} to ${b.width}x${b.height}`,
    };
  }
  for (const [i, share] of changed.entries()) {
    if (share !== null) continue;
    const s = shared[i] as (typeof shared)[number];
    const past = s.msA / 1000 >= a.length;
    return {
      uncomparable: `the ${past ? "committed" : "new"} video ends at ${(past ? a : b).length.toFixed(3)}s, before its screen at ${((past ? s.msA : s.msB) / 1000).toFixed(3)}s`,
    };
  }
  let worst = 0;
  let at = 0;
  for (const [i, share] of changed.entries()) {
    if ((share as number) > worst) {
      worst = share as number;
      at = i;
    }
  }
  const where = `${shared.length} of ${total} screens`;
  const pct = (worst * 100).toFixed(4);
  if (worst <= CHANGED_SHARE)
    return {
      same: true,
      detail: `at most ${pct}% of the picture changed, over ${where}`,
    };
  const s = shared[at] as (typeof shared)[number];
  const place =
    s.step === null ? "on the final screen" : `before step ${s.step + 1}`;
  return {
    same: false,
    detail: `${pct}% of the picture changed ${place} at ${(s.msB / 1000).toFixed(2)}s, over the ${(CHANGED_SHARE * 100).toFixed(4)}% allowed, of ${where}`,
  };
}
