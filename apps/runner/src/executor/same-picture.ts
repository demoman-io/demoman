import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pngSize } from "@demoman/replay-engine";
import { messageOf, type PageScreens } from "@demoman/run-core";
import { screenImageName } from "@demoman/run-core/render";
import { bundleEntry } from "../bundle-js.js";
import type {
  DecodeProbeEntry,
  ImagesDiff,
  PictureUnreadable,
} from "../decode-probe-entry.js";
import { DECODE_PROBE_GLOBAL } from "../entry-globals.js";
import { listenOnLoopback } from "../loopback.js";
import type { BrowserSession } from "./browser.js";

type Look = { name: string; block: number; levels: number; allowed: number };
/**
 * The two ways a screen is looked at, each with the share of the picture it
 * may count changed before the picture has. Each pixel's colour is averaged
 * over a block around it in both images (`blockMoves`); a "move" is how far
 * that mean moved in its most-moved channel. `sharply` (a small block, a
 * high level) sees a small, strong change, one digit of body text;
 * `faintly` (a wide block, a low level) a weak change over an area, text or
 * a fill a few shades off.
 *
 * Set 2026-10-28 on MP4 frames, and re-measured on page screens on
 * 2026-11-11 (the page at CSS 1x, compared at its own size, with no window
 * and no inset: spec 2026-11-10, decisions 2 and 4), where the levels held:
 * every unchanged case reads 0 and the least-changed case is 2.5x over. The
 * refresh lanes (restyle, unchanged, own, settle), run twice on macOS,
 * gave the same shares both times:
 *
 *   share of the picture changed         sharply (allowed 0.0008%)   faintly (allowed 0.017%)
 *   unchanged, 14 readings: order and       0.0000%                  0.0000%
 *     reports, each again slower; GIF
 *     alone, and slower; short ending,
 *     slower; caret, hover, spinner,
 *     stream, toast, debounce, never
 *     settles
 *   a digit beside a spinner, 3 to 4         0.0020% (2.5x over)      -
 *   one digit, $1,200.00 to $1,207.00        0.0047% (5.9x over)      -
 *   small grey text, 14:11 to 05:00          0.0070% (8.8x over)      -
 *   nav text gray-700 to gray-500            -                        0.1226% (7.2x over)
 *   a button blue to a green as light        0.6735%                  -
 *   a dark panel #111827 to #7f1d1d          25.37%                   -
 *
 * CI's numbers (ubuntu, the GPU off) are pending: they come from the
 * branch's pull request, and an unchanged case above 0 there stops it.
 *
 * A "-" is a look the case did not reach: the detail line names the first
 * look that counts it changed. Still not seen: a glyph moving under about
 * 60 levels or a shade under 13, and anything on a screen that never
 * settled, which is named and skipped, never compared.
 */
export const STILL_LOOKS: readonly Look[] = [
  { name: "sharply", block: 2, levels: 60, allowed: 0.000008 },
  { name: "faintly", block: 8, levels: 13, allowed: 0.00017 },
];

const LOOK_CHANGED =
  "the look changed: the background, padding or logo round the window is not the one the committed video was recorded with";

const ENTRY_PATH = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../decode-probe-entry.ts"
      : "../decode-probe-entry.js",
    import.meta.url,
  ),
);

type ScreenImages = { dir: string; screens: PageScreens };

/** "6 of 7 screens settled", then each unsettled one where it is and why:
 *  the one way a set of page screens is said, by keep and by refresh. */
export function screensNote(
  screens: PageScreens | null | undefined,
  steps?: readonly { do: string }[],
): string {
  if (screens === null || screens === undefined) return "no screens";
  const unsettled = screens.screens.filter((s) => s.unsettled !== undefined);
  return [
    `${screens.screens.length - unsettled.length} of ${screens.steps + 1} screens settled`,
    ...unsettled.map((s) => `${screenPlace(s.step, steps)}: ${s.unsettled}`),
  ].join("; ");
}

/** The screens settled in both recordings, by step; and each one left out,
 *  in words: never settled on a side (named when only one), or missing. */
export function pairScreens(
  committed: PageScreens,
  fresh: PageScreens,
  steps?: readonly { do: string }[],
): { pairs: (number | null)[]; skipped: string[] } {
  const pairs: (number | null)[] = [];
  const skipped: string[] = [];
  const where = (step: number | null) => screenPlace(step, steps);
  for (const a of committed.screens) {
    const b = fresh.screens.find((s) => s.step === a.step);
    if (b === undefined) {
      skipped.push(`${where(a.step)}: no screen in the new video`);
    } else if (a.unsettled === undefined && b.unsettled === undefined) {
      pairs.push(a.step);
    } else if (b.unsettled === undefined) {
      skipped.push(`${where(a.step)}: ${a.unsettled} in the committed video`);
    } else if (a.unsettled === undefined) {
      skipped.push(`${where(a.step)}: ${b.unsettled} in the new video`);
    } else {
      skipped.push(
        a.unsettled === b.unsettled
          ? `${where(a.step)}: ${a.unsettled}`
          : `${where(a.step)}: ${a.unsettled} in the committed video, ${b.unsettled} in the new one`,
      );
    }
  }
  for (const b of fresh.screens) {
    if (!committed.screens.some((a) => a.step === b.step))
      skipped.push(`${where(b.step)}: no screen in the committed video`);
  }
  return { pairs, skipped };
}

/**
 * Whether two recordings' page screens (`screenImageName` PNGs, one folder
 * per side) show the same page once each step settled (spec 2026-11-10,
 * decision 4). In order: a different step count, then a different look,
 * is a change; only the screens settled in both are compared, and each one
 * left out is named in `skipped` and on the detail line, never forgiven;
 * none left is `uncomparable`; an image missing or not a PNG is
 * `uncomparable`, naming the file; a different page size is a change; else
 * `STILL_LOOKS` judges the images at their own size. Anything else that
 * stops the comparison (no page to decode on) throws: neither is an answer.
 */
export async function sameScreens(
  committed: ScreenImages,
  fresh: ScreenImages,
  deps: {
    session: Pick<BrowserSession, "openWorkPage">;
    /** The kept script's steps, to name a screen by its script step. */
    steps?: readonly { do: string }[];
    /** Where a forgiven failure (a work page that would not close) is said. */
    log: (line: string) => void;
  },
): Promise<
  | { same: boolean; detail: string; skipped: string[] }
  | { uncomparable: string }
> {
  if (committed.screens.steps !== fresh.screens.steps) {
    return {
      same: false,
      detail: `the video's steps changed, ${committed.screens.steps} to ${fresh.screens.steps}`,
      skipped: [],
    };
  }
  if (
    committed.screens.look !== undefined &&
    fresh.screens.look !== undefined &&
    committed.screens.look !== fresh.screens.look
  ) {
    return { same: false, detail: LOOK_CHANGED, skipped: [] };
  }
  const { pairs, skipped } = pairScreens(
    committed.screens,
    fresh.screens,
    deps.steps,
  );
  const withSkipped = (detail: string) =>
    skipped.length === 0 ? detail : `${detail}; ${skipped.join("; ")}`;
  if (pairs.length === 0)
    return {
      uncomparable: withSkipped(
        "no screen settled in both the committed video and the new one",
      ),
    };
  const files = new Map<string, Buffer>();
  const paths = new Map<string, string>();
  for (const step of pairs) {
    const name = screenImageName(step);
    const sizes: string[] = [];
    for (const [prefix, side] of [
      ["/a/", committed],
      ["/b/", fresh],
    ] as const) {
      const path = join(side.dir, name);
      paths.set(`${prefix}${name}`, path);
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (error) {
        return {
          uncomparable:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? `${path} is missing`
              : `${path} could not be read (${messageOf(error)})`,
        };
      }
      try {
        const { width, height } = pngSize(bytes);
        sizes.push(`${width}x${height}`);
      } catch (error) {
        return {
          uncomparable: `${path} could not be read as a PNG (${messageOf(error)})`,
        };
      }
      files.set(`${prefix}${name}`, bytes);
    }
    if (sizes[0] !== sizes[1])
      return {
        same: false,
        detail: withSkipped(
          `the page size changed, ${sizes[0]} to ${sizes[1]}, ${screenPlace(step, deps.steps)}`,
        ),
        skipped,
      };
  }
  const urls = (prefix: string) =>
    pairs.map((step) => `${prefix}${screenImageName(step)}`);
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
  let diff: ImagesDiff | PictureUnreadable;
  try {
    // Loopback: `about:blank` is not a secure context.
    const origin = await listenOnLoopback(server);
    await work.page.goto(origin);
    await work.page.addScriptTag({ content: await bundleEntry(ENTRY_PATH) });
    diff = await work.page.evaluate(
      ([name, a, b, looks]) => {
        const entry = (
          globalThis as unknown as Record<string, DecodeProbeEntry>
        )[name as string];
        if (entry === undefined) throw new Error(`${name} is not installed`);
        return entry.imagesDiff(
          a as string[],
          b as string[],
          looks as { block: number; levels: number }[],
        );
      },
      [
        DECODE_PROBE_GLOBAL,
        urls("/a/"),
        urls("/b/"),
        STILL_LOOKS.map(({ block, levels }) => ({ block, levels })),
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
    // The page leads its message with the url it served.
    const at = diff.error.indexOf(": ");
    const url = diff.error.slice(0, at);
    return {
      uncomparable: `${paths.get(url) ?? url} could not be read as a PNG (${diff.error.slice(at + 2)})`,
    };
  }
  const judged = comparePictures(
    diff.changed,
    pairs,
    fresh.screens.steps + 1,
    deps.steps,
  );
  return { ...judged, detail: withSkipped(judged.detail), skipped };
}

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

/** Where a screen is, as every line about one says it: before a step in
 *  the script's numbering, or on the final screen. */
export function screenPlace(
  step: number | null,
  steps?: readonly { do: string }[],
): string {
  return step === null ? "on the final screen" : before(step, steps);
}

/**
 * The decision, on what the page read: per look, the largest share changed
 * over the compared screens (`changed[i]` is `pairs[i]`'s, in `looks`
 * order), against that look's `allowed`. `total` is the screens a recording
 * can have (its steps and the final one), for "k of n screens".
 */
export function comparePictures(
  changed: readonly (readonly number[])[],
  pairs: readonly (number | null)[],
  total: number,
  steps?: readonly { do: string }[],
  looks: readonly Look[] = STILL_LOOKS,
): { same: boolean; detail: string } {
  const pct = (share: number) => `${(share * 100).toFixed(4)}%`;
  // Per look: its largest share, and the screen it was read at.
  const worst = looks.map((look, j) => {
    let share = 0;
    let at = 0;
    for (const [i, shares] of changed.entries()) {
      const v = shares[j] as number;
      if (v > share) {
        share = v;
        at = i;
      }
    }
    return { look, share, at, over: share / look.allowed };
  });
  const where = `${pairs.length} of ${total} screens`;
  const most = worst.reduce((x, y) => (y.over > x.over ? y : x));
  if (most.over <= 1)
    return {
      same: true,
      detail: `at most ${worst.map((w) => `${pct(w.share)} ${w.look.name}`).join(" and ")} of the picture changed, over ${where}`,
    };
  const place = screenPlace(pairs[most.at] as number | null, steps);
  return {
    same: false,
    detail: `${pct(most.share)} of the picture changed ${most.look.name} ${place}, over the ${pct(most.look.allowed)} allowed, of ${where}`,
  };
}
