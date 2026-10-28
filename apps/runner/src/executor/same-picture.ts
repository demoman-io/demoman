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
 * refresh.slow.test.ts's fixture videos (1920x1080 MP4s at share quality),
 * drawn 1280 wide by Chrome's own decoder. Each pixel's colour is averaged
 * over a block around it in both films (`blockMoves`); a "move" is how far
 * that mean moved in its most-moved channel. What decides a look is the
 * Nth-largest move on a screen against `levels`, N its allowed pixels:
 *
 *   Nth-largest move, worst screen     block 2, 8th   block 8, 160th
 *   re-films and slower apps (x7)          33-35          9.4-9.5
 *   one digit, $1,200.00 to $1,207.00      107            2
 *   nav text gray-700 to gray-500          39             18
 *   a button blue to a green as light      165            156
 *   a dark panel #111827 to #7f1d1d        117            112
 *
 * over two full runs of that file. The noise is the encoder's: a still
 * screen a few frames after a camera move still carries that move's coding
 * error, single pixels up to 77 levels scattered along edges, and it fades
 * over about six frames. The short ending's last still
 * stretch is four frames, all inside that fade, so placing its screen at
 * the end of the stretch rather than the middle did not help. Averaging
 * does: noise is scattered, a change moves together. A small block keeps a
 * glyph strong (`sharply`, 60 levels, 1.8x clear of both sides); a wide
 * block over many pixels sees a few shades on a whole word or fill
 * (`faintly`, 13 levels, 1.4x clear of both). No single block measured
 * better than 1.7x for both the digit and the grey text.
 *
 * At those settings, locally: re-films and slower apps read at most 0.0000%
 * sharply and 0.0021% faintly; the digit 0.0027% sharply (allowed 0.0008%,
 * about 7 pixels); the grey text 0.097% faintly (allowed 0.017%, about 157
 * pixels); the button 0.42% and the panel 16%. Colour, not grey, is
 * compared: the button keeps its grey level (4.9 apart).
 *
 * What this cannot see: one changed glyph whose strokes move less than
 * about 60 levels (a digit in light grey on white), and a change of shade
 * that moves its block average 13 levels or less, or covers fewer than
 * about 157 pixels at 1280 wide (a thin border's colour, a small icon's
 * tint).
 */
/** The two ways a screen is looked at (above), each with the share of the
 *  picture it may count changed before the picture has. `sharply` sees a
 *  small, strong change (one digit of body text); `faintly` a weak change
 *  over an area (text or a fill a few shades off). */
export const LOOKS = [
  { name: "sharply", block: 2, levels: 60, allowed: 0.000008 },
  { name: "faintly", block: 8, levels: 13, allowed: 0.00017 },
] as const;
export const PICTURE_OPTIONS: PictureOptions = {
  width: 1280,
  looks: LOOKS.map(({ block, levels }) => ({ block, levels })),
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
 * The decision, on what the page read: per look, the largest share changed
 * over the shared screens, against that look's `allowed`. `total` is the
 * screens a film can have (its steps and the final one), for "k of n
 * screens".
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
  for (const [i, shares] of changed.entries()) {
    if (shares !== null) continue;
    const s = shared[i] as (typeof shared)[number];
    const past = s.msA / 1000 >= a.length;
    return {
      uncomparable: `the ${past ? "committed" : "new"} video ends at ${(past ? a : b).length.toFixed(3)}s, before its screen at ${((past ? s.msA : s.msB) / 1000).toFixed(3)}s`,
    };
  }
  const pct = (share: number) => `${(share * 100).toFixed(4)}%`;
  // Per look: its largest share, and the screen it was read at.
  const worst = LOOKS.map((look, j) => {
    let share = 0;
    let at = 0;
    for (const [i, shares] of changed.entries()) {
      const v = (shares as number[])[j] as number;
      if (v > share) {
        share = v;
        at = i;
      }
    }
    return { look, share, at, over: share / look.allowed };
  });
  const where = `${shared.length} of ${total} screens`;
  const most = worst.reduce((x, y) => (y.over > x.over ? y : x));
  if (most.over <= 1)
    return {
      same: true,
      detail: `at most ${worst.map((w) => `${pct(w.share)} ${w.look.name}`).join(" and ")} of the picture changed, over ${where}`,
    };
  const s = shared[most.at] as (typeof shared)[number];
  const place =
    s.step === null ? "on the final screen" : `before step ${s.step + 1}`;
  return {
    same: false,
    detail: `${pct(most.share)} of the picture changed ${most.look.name} ${place} at ${(s.msB / 1000).toFixed(2)}s, over the ${pct(most.look.allowed)} allowed, of ${where}`,
  };
}
