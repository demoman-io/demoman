/**
 * What the video draws for keys and clicks (DEM-154/155, spec 2026-11-21
 * "What the video draws", option K1): a keycap pill at the bottom centre for
 * every press and every click with a key held, two or three ripples and a
 * ×2/×3 tag for a multi-click, and a small mouse for a right-click. Each is
 * read off the take's record (`modifiers`, `clicks`, `button`), never
 * guessed from the frames.
 *
 * A press without `modifiers` is from a take before schema 17: it keeps its
 * ripple and draws no pill, so a saved take renders as it did.
 */
import {
  MODIFIERS,
  type Modifier,
  type SceneDocument,
} from "@demoman/scene-schema";
import type { OutputRange } from "./ranges.js";

/** How long before a press's marker its pill appears, in output ms. */
export const KEYCAP_LEAD_MS = 150;
/** How long after a press's marker its pill stays, in output ms. */
export const KEYCAP_HOLD_MS = 1100;
/** Each mark fades in and out over this much of its own range. */
export const KEY_MARK_FADE_MS = 120;
/** Between one ripple of a double or triple click and the next. */
export const MULTI_CLICK_GAP_MS = 140;
/** How long a right-click's mouse stays by the pointer. */
export const MOUSE_MARK_MS = 700;

export type KeyGlyph =
  | "command"
  | "shift"
  | "option"
  | "control"
  | "return"
  | "tab"
  | "backspace"
  | "delete";

export type KeyCap = { glyph: KeyGlyph } | { text: string };

export type ResolvedKeycaps = {
  range: OutputRange;
  caps: KeyCap[];
  suffix?: "+ click";
  /** Starts where the pill before it ends: up at once, no fade in. */
  handedIn?: true;
  /** Ends where the next pill starts: gone at once, no fade out. */
  handedOut?: true;
}[];

const MODIFIER_GLYPH: Record<Modifier, KeyGlyph> = {
  Ctrl: "control",
  Alt: "option",
  Shift: "shift",
  Mod: "command",
};

/** The named keys as a Mac keyboard prints them; any other key is its own
 *  text (a letter, a digit, F5). */
const NAMED_CAP: Record<string, KeyCap> = {
  Enter: { glyph: "return" },
  Tab: { glyph: "tab" },
  Backspace: { glyph: "backspace" },
  Delete: { glyph: "delete" },
  Escape: { text: "esc" },
  Space: { text: "Space" },
  ArrowUp: { text: "↑" },
  ArrowDown: { text: "↓" },
  ArrowLeft: { text: "←" },
  ArrowRight: { text: "→" },
  PageUp: { text: "Page Up" },
  PageDown: { text: "Page Down" },
};

/** One cap per modifier, in Apple's order (⌃ ⌥ ⇧ ⌘), then the key's. */
export function capsOf(modifiers: readonly Modifier[], key?: string): KeyCap[] {
  const caps: KeyCap[] = MODIFIERS.filter((m) => modifiers.includes(m)).map(
    (m) => ({ glyph: MODIFIER_GLYPH[m] }),
  );
  if (key !== undefined) caps.push(NAMED_CAP[key] ?? { text: key });
  return caps;
}

/** Whether a render of this take draws text, and so needs Geist loaded
 *  first: a dialog card, a key pill, or a ×2/×3 tag or "+ click". */
export function needsTextFont(scene: SceneDocument): boolean {
  return scene.actions.some(
    (a) =>
      ("dialogs" in a && (a.dialogs?.length ?? 0) > 0) ||
      (a.kind === "press" && a.modifiers !== undefined) ||
      (a.kind === "click" &&
        (a.clicks !== undefined || a.modifiers !== undefined)),
  );
}

export interface KeyMarks {
  /** Output times of every click ripple, sorted: what the pulse and the
   *  pointer's press read. */
  pulseOutputMs: number[];
  keycaps: ResolvedKeycaps;
  clickTags: { outputMs: number; count: 2 | 3 }[];
  rightClicks: number[];
}

/**
 * The marks for each step's marker, already in output ms (as
 * `clickOutputMs` is mapped). `pulseKinds` are the kinds that ripple on
 * this bundle: a replay's type, drag and press press where a capture's do
 * not.
 */
export function planKeyMarks(
  actions: SceneDocument["actions"],
  markers: readonly { actionId: string; outputMs: number }[],
  pulseKinds: ReadonlySet<string>,
): KeyMarks {
  const byId = new Map(actions.map((a) => [a.id, a] as const));
  const pulses: number[] = [];
  const pills: ResolvedKeycaps = [];
  const clickTags: KeyMarks["clickTags"] = [];
  const rightClicks: number[] = [];
  const pill = (m: number, caps: KeyCap[], suffix?: "+ click") =>
    pills.push({
      range: { startMs: m - KEYCAP_LEAD_MS, endMs: m + KEYCAP_HOLD_MS },
      caps,
      ...(suffix ? { suffix } : {}),
    });

  for (const { actionId, outputMs: m } of markers) {
    const a = byId.get(actionId);
    if (a === undefined) continue;
    if (a.kind === "press") {
      if (a.modifiers === undefined) {
        if (pulseKinds.has("press")) pulses.push(m);
      } else {
        pill(m, capsOf(a.modifiers, a.key));
      }
      continue;
    }
    if (!pulseKinds.has(a.kind)) continue;
    if (a.kind !== "click") {
      pulses.push(m);
      continue;
    }
    if (a.modifiers !== undefined) pill(m, capsOf(a.modifiers), "+ click");
    // Only a replay's right-click gets the mouse. A capture recorded `right`
    // before schema 17 and drew a ripple, and a saved take renders as it
    // did. A replay is the bundle whose presses ripple (`clickKinds`).
    if (a.button === "right" && pulseKinds.has("press")) {
      rightClicks.push(m);
      continue;
    }
    const count = a.clicks ?? 1;
    for (let i = 0; i < count; i++) pulses.push(m + i * MULTI_CLICK_GAP_MS);
    if (a.clicks !== undefined)
      clickTags.push({ outputMs: m, count: a.clicks });
  }

  // One pill at a time: a later one cuts the earlier short at its start.
  pills.sort((p, q) => p.range.startMs - q.range.startMs);
  pills.forEach((p, i) => {
    const next = pills[i + 1];
    if (next) p.range.endMs = Math.min(p.range.endMs, next.range.startMs);
  });

  // A pill that hands over to the next does not fade: presses 300 ms apart
  // would otherwise blink, each at full opacity for about 60 ms.
  const keycaps = pills.filter((p) => p.range.endMs > p.range.startMs);
  keycaps.forEach((p, i) => {
    const next = keycaps[i + 1];
    if (next && next.range.startMs === p.range.endMs) {
      p.handedOut = true;
      next.handedIn = true;
    }
  });

  const byTime = (x: number, y: number) => x - y;
  return {
    pulseOutputMs: pulses.sort(byTime),
    keycaps,
    clickTags: clickTags.sort((p, q) => p.outputMs - q.outputMs),
    rightClicks: rightClicks.sort(byTime),
  };
}

/** A mark's opacity at `ms`: 0 outside `range`, fading in and out over
 *  `KEY_MARK_FADE_MS` at each end, except an end a pill hands over at. */
export function markAlpha(
  range: OutputRange,
  ms: number,
  handover: { handedIn?: true; handedOut?: true } = {},
): number {
  if (ms < range.startMs || ms >= range.endMs) return 0;
  return Math.min(
    1,
    handover.handedIn ? 1 : (ms - range.startMs) / KEY_MARK_FADE_MS,
    handover.handedOut ? 1 : (range.endMs - ms) / KEY_MARK_FADE_MS,
  );
}
