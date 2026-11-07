import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type KeptScreens,
  type KeptWindow,
  messageOf,
} from "@demoman/run-core";
import { screenImageName } from "@demoman/run-core/render";
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
 * refresh-suite.ts's fixture videos (1920x1080 MP4s at share quality),
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
 *
 * Only the app's window is looked at (2026-10-28). That table was measured
 * on a sharp wallpaper. On the blurred one new takes default to, the same
 * encoder leaves its error as a solid offset over a whole 16 px macroblock
 * of the smooth background, which no block average dilutes: unchanged
 * re-films read up to 0.081% faintly there, its 160th-largest move 21.6-25
 * levels, above the grey text's 18, so no `levels` separates the two
 * (refresh-debug-report.md). Each screen records its window
 * (`KeptMoment.window`, drawn by the render's own camera), and pixels
 * outside it, inset `WINDOW_INSET_PX`, count as unchanged. The share stays
 * a share of the WHOLE picture, so `allowed` above means what it was
 * measured to mean. Measured with the window and no inset: the 10 px
 * inside its edge reads at most 31 sharply and 8.6 faintly on the
 * unchanged films, under 60 and 13; the 2 px inset takes out the
 * anti-aliased edge pixel and the resample's spread. Re-films then read
 * 0.0000% sharply and at most 0.0003% faintly; the digit, grey text,
 * button and panel read as in the table. What is outside the window (the
 * background, padding and logo) is judged by its look (`KeptScreens.look`)
 * instead, so a change painted there that the look does not record (an
 * uploaded image's or logo's file changed under the same name, a renderer
 * change to the background) is not seen. A file kept before windows were
 * recorded is compared whole, as before.
 */
/** The two ways a screen is looked at (above), each with the share of the
 *  picture it may count changed before the picture has. `sharply` sees a
 *  small, strong change (one digit of body text); `faintly` a weak change
 *  over an area (text or a fill a few shades off). */
export const LOOKS = [
  { name: "sharply", block: 2, levels: 60, allowed: 0.000008 },
  { name: "faintly", block: 8, levels: 13, allowed: 0.00017 },
] as const;
/** How far inside the recorded window its pixels are compared, at
 *  `PICTURE_OPTIONS.width`: past the anti-aliased rounded edge (measured in
 *  the calibration comment above). */
export const WINDOW_INSET_PX = 2;
type Look = { name: string; block: number; levels: number; allowed: number };
/** The looks for a comparison of screen images: the values of `LOOKS`, kept
 *  after measuring them on stills (2026-11-03). Still screens are PNGs, not
 *  video frames, so they carry none of the encoder's coding error.
 *
 *   share of the picture changed         sharply (allowed 0.0008%)   faintly (allowed 0.017%)
 *   unchanged re-films (order, reports)     0.0000%                  0.0000%
 *   the same, a slower app (macOS only)      0.0000%                  0.0000%
 *   one digit, $1,200.00 to $1,207.00        0.0020% (2.5x over)      -
 *   nav text gray-700 to gray-500            -                        0.0611% (3.6x over)
 *   a button blue to a green as light        0.344%                   -
 *   a dark panel #111827 to #7f1d1d          13.0%                    -
 *
 * A "-" is a look the case did not reach: the detail line names the first
 * look that counts it changed. Locally the numbers are identical over two
 * runs of refresh-unchanged and refresh-restyle. On CI (run 41624628018) the
 * two `package` jobs (ubuntu-22.04, ubuntu-24.04) and the `refresh` job
 * measured only the unchanged order and reports videos, 0.0000% on both
 * looks, and a changed order video at 2.32-2.36% sharply. The digit, grey
 * text, button and panel rows, and the 2.5x below, are LOCAL ONLY: ci-ts.yml
 * has no workflow_dispatch, so the slow restyle lane did not run on CI. The
 * unchanged side reads 0, under `allowed` by its whole value (it has no
 * noise to be clear of); the changed side is at least 2.5x over locally,
 * against the 1.8x and 1.4x `LOOKS` was accepted at. The same limits apply:
 * a glyph moving under about 60 levels or a shade under 13 is not seen.
 */
export const STILL_LOOKS: readonly Look[] = LOOKS;
export const PICTURE_OPTIONS: PictureOptions = {
  width: 1280,
  looks: LOOKS.map(({ block, levels }) => ({ block, levels })),
  inset: WINDOW_INSET_PX,
};
/** What the page reads a comparison of screen images with: the same looks
 *  `comparePictures` judges them by. */
export const STILL_PICTURE_OPTIONS: PictureOptions = {
  ...PICTURE_OPTIONS,
  looks: STILL_LOOKS.map(({ block, levels }) => ({ block, levels })),
};
/** How far, in pixels at `PICTURE_OPTIONS.width`, a moved window edge may
 *  be off and still be the same window: its rect is recorded to 0.01 px,
 *  and an unchanged film's is the same to the last digit. */
export const WINDOW_MOVED_PX = 1;

const LOOK_CHANGED =
  "the look changed: the background, padding or logo round the window is not the one the committed video was filmed with";

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
  deps: {
    session: Pick<BrowserSession, "openWorkPage">;
    /** The kept script's steps, to name a screen by its script step. */
    steps?: readonly { do: string }[];
    /** Where a forgiven failure (a work page that would not close) is said. */
    log: (line: string) => void;
  },
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
  if (
    committedScreens.look !== undefined &&
    freshScreens.look !== undefined &&
    committedScreens.look !== freshScreens.look
  ) {
    return {
      same: false,
      detail: LOOK_CHANGED,
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
      ([name, mime, msA, msB, windows, options]) => {
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
          windows as (KeptWindow | null)[],
          options as PictureOptions,
        );
      },
      [
        DECODE_PROBE_GLOBAL,
        type,
        shared.map((s) => s.msA),
        shared.map((s) => s.msB),
        // The committed film's window: a fresh one that moved is a change
        // (`comparePictures`), so either reads the same pixels.
        shared.map((s) =>
          s.windowB === undefined ? null : (s.windowA ?? null),
        ),
        PICTURE_OPTIONS,
      ] as const,
    );
  } finally {
    server.close();
    // The answer is read; a work page left open is the session's to close.
    await work.page.close().catch((error: unknown) => {
      deps.log(
        `refresh: the comparison's page would not close (${messageOf(error)})`,
      );
    });
  }
  if ("unreadable" in diff) {
    return {
      undecodable: diff.unreadable === "a" ? "committed" : "new",
      detail: diff.error,
    };
  }
  return comparePictures(diff, shared, freshScreens.steps + 1, deps.steps);
}

type ScreenImages = {
  dir: string;
  screens: KeptScreens;
  /** The output target's pixels, which the screens' windows are in. */
  size: { width: number; height: number };
};

/**
 * `samePicture` over the screen images a screens-only render wrote
 * (`screenImageName`), one folder per side. The same early answers; an image
 * a shared screen needs that is missing, or is not a PNG, is `uncomparable`
 * and names the file: never "same".
 */
export async function sameScreens(
  committed: ScreenImages,
  fresh: ScreenImages,
  deps: {
    session: Pick<BrowserSession, "openWorkPage">;
    steps?: readonly { do: string }[];
    log: (line: string) => void;
  },
): Promise<{ same: boolean; detail: string } | { uncomparable: string }> {
  if (committed.screens.steps !== fresh.screens.steps) {
    return {
      same: false,
      detail: `the video's steps changed, ${committed.screens.steps} to ${fresh.screens.steps}`,
    };
  }
  if (
    committed.screens.look !== undefined &&
    fresh.screens.look !== undefined &&
    committed.screens.look !== fresh.screens.look
  ) {
    return { same: false, detail: LOOK_CHANGED };
  }
  const shared = sharedScreens(committed.screens, fresh.screens);
  if (shared.length === 0)
    return { uncomparable: "no screen of the video is still in both films" };
  const files = new Map<string, Buffer>();
  const paths = new Map<string, string>();
  for (const [prefix, side] of [
    ["/a/", committed],
    ["/b/", fresh],
  ] as const) {
    for (const s of shared) {
      const name = screenImageName(s.step);
      const path = join(side.dir, name);
      paths.set(`${prefix}${name}`, path);
      try {
        files.set(`${prefix}${name}`, await readFile(path));
      } catch (error) {
        return {
          uncomparable:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? `${path} is missing`
              : `${path} could not be read (${messageOf(error)})`,
        };
      }
    }
  }
  const urls = (prefix: string) =>
    shared.map((s) => `${prefix}${screenImageName(s.step)}`);
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
      "content-type": "image/png",
      "content-length": String(bytes.byteLength),
    });
    res.end(bytes);
  });
  let diff: ScreensDiff | PictureUnreadable;
  try {
    const origin = await listenOnLoopback(server);
    await work.page.goto(origin);
    await work.page.addScriptTag({ content: await bundleEntry(ENTRY_PATH) });
    diff = await work.page.evaluate(
      ([name, a, b, sizeA, sizeB, windows, options]) => {
        const entry = (
          globalThis as unknown as Record<string, DecodeProbeEntry>
        )[name as string];
        if (entry === undefined) throw new Error(`${name} is not installed`);
        return entry.imagesDiff(
          a as string[],
          b as string[],
          sizeA as ScreenImages["size"],
          sizeB as ScreenImages["size"],
          windows as (KeptWindow | null)[],
          options as PictureOptions,
        );
      },
      [
        DECODE_PROBE_GLOBAL,
        urls("/a/"),
        urls("/b/"),
        committed.size,
        fresh.size,
        shared.map((s) =>
          s.windowB === undefined ? null : (s.windowA ?? null),
        ),
        STILL_PICTURE_OPTIONS,
      ] as const,
    );
  } finally {
    server.close();
    await work.page.close().catch((error: unknown) => {
      deps.log(
        `refresh: the comparison's page would not close (${messageOf(error)})`,
      );
    });
  }
  if ("unreadable" in diff) {
    // The page leads its message with the url it served.
    const at = diff.error.indexOf(": ");
    const url = diff.error.slice(0, at);
    return {
      uncomparable: `${paths.get(url) ?? url} could not be read as a PNG (${diff.error.slice(at + 2)})`,
    };
  }
  return comparePictures(
    diff,
    shared,
    fresh.screens.steps + 1,
    deps.steps,
    STILL_LOOKS,
  );
}

/** A moment of a video, as its messages say it. */
const secs = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

/** The script step a screen's `step` (an index into the film's actions)
 *  comes from: `pause` makes no action (`authoredTotal`), every other step
 *  makes one. Null when the script has no such step. */
export function scriptStep(
  steps: readonly { do: string }[],
  action: number,
): number | null {
  let seen = -1;
  for (const [i, step] of steps.entries()) {
    if (step.do !== "pause") seen++;
    if (seen === action) return i;
  }
  return null;
}

/** Where a step's screen is, in the script's own numbering when the script
 *  is known; else as what it is, the film's Nth action. */
function before(action: number, steps?: readonly { do: string }[]): string {
  const i = steps === undefined ? null : scriptStep(steps, action);
  return i === null ? `before action ${action + 1}` : `before step ${i + 1}`;
}

/** The screens both films have, paired by `step`, in increasing ms, with
 *  each film's window where it recorded one. */
export function sharedScreens(
  a: KeptScreens,
  b: KeptScreens,
): {
  step: number | null;
  msA: number;
  msB: number;
  windowA?: KeptWindow;
  windowB?: KeptWindow;
}[] {
  return a.moments.flatMap((m) => {
    const other = b.moments.find((n) => n.step === m.step);
    return other === undefined
      ? []
      : [
          {
            step: m.step,
            msA: m.ms,
            msB: other.ms,
            ...(m.window === undefined ? {} : { windowA: m.window }),
            ...(other.window === undefined ? {} : { windowB: other.window }),
          },
        ];
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
  steps?: readonly { do: string }[],
  looks: readonly Look[] = LOOKS,
): { same: boolean; detail: string } | { uncomparable: string } {
  const { a, b, changed } = diff;
  if (a.width !== b.width || a.height !== b.height) {
    return {
      same: false,
      detail: `the frame size changed, ${a.width}x${a.height} to ${b.width}x${b.height}`,
    };
  }
  // A window drawn elsewhere is a camera or layout change: a change.
  const k = PICTURE_OPTIONS.width / a.width;
  for (const s of shared) {
    const [wa, wb] = [s.windowA, s.windowB];
    if (wa === undefined || wb === undefined) continue;
    const keys = ["x", "y", "width", "height", "radius"] as const;
    if (keys.every((key) => Math.abs(wa[key] - wb[key]) * k <= WINDOW_MOVED_PX))
      continue;
    const place =
      s.step === null ? "on the final screen" : before(s.step, steps);
    return {
      same: false,
      // Each video's own moment beside its own window: the two reach a
      // screen at different times, and one time for both sent DEM-63 to the
      // wrong frame of the committed video.
      detail: `the window moved ${place}: the committed video has it at ${rectText(wa)} at ${secs(s.msA)}, the new one at ${rectText(wb)} at ${secs(s.msB)}`,
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
  const worst = looks.map((look, j) => {
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
  const place = s.step === null ? "on the final screen" : before(s.step, steps);
  return {
    same: false,
    detail: `${pct(most.share)} of the picture changed ${most.look.name} ${place} at ${(s.msB / 1000).toFixed(2)}s, over the ${pct(most.look.allowed)} allowed, of ${where}`,
  };
}

/** A window as `x,y widthxheight`, in its film's pixels. */
const rectText = (w: KeptWindow) =>
  `${Math.round(w.x)},${Math.round(w.y)} ${Math.round(w.width)}x${Math.round(w.height)}`;
