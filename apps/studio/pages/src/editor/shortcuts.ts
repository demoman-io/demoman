/**
 * The editor's keyboard map, as a table rather than a chain of `if`s.
 *
 * Two reasons it is a module of its own and not more branches inside
 * `entrypoints/editor/main.ts`'s handler:
 *
 * - The decisions here — which key means what, which keys are deliberately
 *   left to the browser — are testable without a DOM, a session or a player.
 *   `main.ts` keeps only the guards about *where* a press landed (a text
 *   field, a focused button) and the dispatch to the things that act.
 * - `SHORTCUT_LEGEND` is rendered straight into the `?` overlay, so a
 *   binding cannot ship without a line telling the author it exists. The
 *   test lane asserts that every reachable action has one.
 *
 * The layout follows Premiere, Resolve and Final Cut wherever this editor
 * has something to bind. Where it does not — there is no clip to razor, no
 * frame ruler to step — the key is left unbound rather than pointed at the
 * nearest differently-shaped edit. See `ShortcutAction` for what each one
 * became.
 */

/** A pressed key, narrowed to the four fields this table reads. Taken as a
 *  plain object so the node lane can drive it without a `KeyboardEvent`. */
export interface KeyPress {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/**
 * What the editor can say about itself when a key arrives.
 *
 * Every field here exists to decide whether a key is *claimed* — not what it
 * does once claimed. A shortcut with nothing to act on returns null and lets
 * the browser have the press, because a swallowed key that does nothing
 * still reads to the author as a shortcut that did something.
 */
export interface ShortcutContext {
  hasSelection: boolean;
  /** A step is selected, rather than a zoom or a mask: Delete has nothing
   *  to remove from it. */
  selectionIsBeat: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** An inspector panel is open — Export, Background, Cursor, Selection or
   *  Keyboard shortcuts — so Escape has one to close. */
  panelOpen: boolean;
  /**
   * A take has been rendered, so there is a timeline with a window to move.
   *
   * Without it `+`, `-` and ⇧Z were claimed and then dropped on the floor by
   * `main.ts` — `preventDefault` had already run, so the press was eaten and
   * nothing said why. A shortcut with nothing to act on belongs to the
   * browser, which is the same rule `canUndo` and `hasSelection` follow.
   */
  hasTimeline: boolean;
}

export type ShortcutAction =
  | { kind: "playPause" }
  /** J and L. `direction` is the sign of playback; repeated presses raise
   *  the rate, which is the player's business, not this table's. */
  | { kind: "shuttle"; direction: -1 | 1 }
  /** K. Stops rather than toggling: K after K must stay stopped, which is
   *  the whole reason it is a separate key from the space bar. */
  | { kind: "stop" }
  | { kind: "nudge"; deltaMs: number }
  | { kind: "stepBeat"; delta: -1 | 1 }
  | { kind: "seekEdge"; edge: "head" | "tail" }
  | { kind: "setTrim"; edge: "head" | "tail" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "deleteSelection" }
  /** ⌘B: split the clip at the playhead. */
  | { kind: "split" }
  | { kind: "zoomTimeline"; factor: number }
  | { kind: "zoomFit" }
  | { kind: "toggleSnapping" }
  | { kind: "clearSelection" }
  /** Escape with nothing selected: close the open panel. */
  | { kind: "closePanel" }
  /** ?: open Keyboard shortcuts in the inspector, or close it there. */
  | { kind: "toggleHelp" };

/**
 * A bare arrow.
 *
 * A deliberate fixed increment rather than a frame: the beat is this
 * timeline's unit and there is no frame ruler here for a step to be one of
 * (see `timeline.ts`). A tenth of a second is also the precision
 * `PACE_SNAP_MS` already holds authored timing to — a finer nudge would
 * claim a resolution nothing else in the editor keeps.
 */
export const NUDGE_FINE_MS = 100;

/** A shifted arrow. Five of the fine step, matching every NLE's "step five
 *  frames" in shape if not in unit. */
export const NUDGE_COARSE_MS = 500;

/** One press of + or -. The same factor the trackpad's ⌘-scroll uses in
 *  `timeline-view.ts`, so the two gestures agree about how far one step is. */
export const ZOOM_STEP = 1.2;

export function resolveShortcut(
  press: KeyPress,
  context: ShortcutContext,
): ShortcutAction | null {
  const key = press.key;
  const lower = key.toLowerCase();
  const command = press.metaKey || press.ctrlKey;

  // Undo and redo, on whatever this OS calls its command key, and the
  // split. Handled first and exclusively: every other key in this table is
  // unmodified, so any command-key press that is not one of these belongs
  // to the browser — ⌘S among them.
  if (command) {
    if (lower === "z") {
      if (press.shiftKey) return context.canRedo ? { kind: "redo" } : null;
      return context.canUndo ? { kind: "undo" } : null;
    }
    // Ctrl only, for the Windows convention: ⌘Y on a Mac is the browser's
    // own history window and taking it would be worse than not having a
    // second redo key.
    if (lower === "y" && press.ctrlKey && !press.metaKey) {
      return context.canRedo ? { kind: "redo" } : null;
    }
    // ⌘B, the blade in Final Cut and Resolve. Not shifted: ⇧⌘B is the
    // browser's bookmarks bar.
    if (lower === "b" && !press.shiftKey) return { kind: "split" };
    // The arrow ladder's top rung: bare moves a tenth of a second, shifted
    // half a second, the command key goes all the way to an end. It is also
    // the pair a Mac keyboard already uses for "start / end of line".
    //
    // This one does take something from the browser — ⌘← and ⌘→ are Back and
    // Forward in Chrome — which the rest of this branch exists to avoid. It
    // is worth it here because a MacBook has no Home or End key printed on
    // it: fn plus an arrow sends one, and that is a reach for the most
    // ordinary move there is on a timeline. The editor opens in a tab of its
    // own with no history behind it, so what is taken is a no-op in the
    // place it is taken from.
    //
    // Unshifted only: ⇧⌘← selects to the start of a line on a Mac, and
    // nothing here wants it.
    if (!press.shiftKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      return { kind: "seekEdge", edge: key === "ArrowLeft" ? "head" : "tail" };
    }
    return null;
  }

  if (key === " ") return { kind: "playPause" };
  if (lower === "j") return { kind: "shuttle", direction: -1 };
  if (lower === "k") return { kind: "stop" };
  if (lower === "l") return { kind: "shuttle", direction: 1 };

  // Both horizontal arrows move the PLAYHEAD, shifted or not — the NLE
  // layout, where a bare arrow steps a frame and a shifted one steps five.
  // The beat step is on the vertical pair below, which is what "previous /
  // next cut point" means on a timeline whose unit is the beat.
  if (key === "ArrowRight" || key === "ArrowLeft") {
    const step = press.shiftKey ? NUDGE_COARSE_MS : NUDGE_FINE_MS;
    return { kind: "nudge", deltaMs: key === "ArrowRight" ? step : -step };
  }
  if (key === "ArrowDown") return { kind: "stepBeat", delta: 1 };
  if (key === "ArrowUp") return { kind: "stepBeat", delta: -1 };
  if (key === "Home") return { kind: "seekEdge", edge: "head" };
  if (key === "End") return { kind: "seekEdge", edge: "tail" };

  if (lower === "i") return { kind: "setTrim", edge: "head" };
  if (lower === "o") return { kind: "setTrim", edge: "tail" };

  if (key === "Delete" || key === "Backspace") {
    // On a step too: a step is a label (spec 2026-10-22 split-tool), and the
    // editor says so rather than letting the press do nothing.
    if (!context.hasSelection) return null;
    return { kind: "deleteSelection" };
  }

  // "=" as well as "+": a US keyboard sends "=" unless shift is held, so
  // binding the printed character alone leaves the author pressing the key
  // under the + and getting nothing.
  if (key === "+" || key === "=") {
    if (!context.hasTimeline) return null;
    return { kind: "zoomTimeline", factor: ZOOM_STEP };
  }
  if (key === "-" || key === "_") {
    if (!context.hasTimeline) return null;
    return { kind: "zoomTimeline", factor: 1 / ZOOM_STEP };
  }
  // Unmodified by the time it reaches here — the command-key branch above
  // already returned — so this is the NLE's plain Shift+Z, not redo.
  if (lower === "z" && press.shiftKey) {
    return context.hasTimeline ? { kind: "zoomFit" } : null;
  }
  if (lower === "s") return { kind: "toggleSnapping" };

  // Escape undoes the innermost thing, one press each (the author,
  // 2026-10-19: every panel closes on Esc, as Linear's do). A popover and a
  // text field are the page's to answer before this table is asked; here a
  // selection goes first, then the open panel. Keyboard shortcuts is one of
  // the inspector's panels, and every key works while it is open.
  if (key === "Escape") {
    if (context.hasSelection) return { kind: "clearSelection" };
    return context.panelOpen ? { kind: "closePanel" } : null;
  }
  if (key === "?") return { kind: "toggleHelp" };

  return null;
}

/**
 * A key as the legend names it.
 *
 * Special keys have a token (`"Mod"`, `"Shift"`, `"Left"`); every other key
 * is the character it prints (`"J"`, `"?"`, `"+"`). `keyLabel` turns either
 * into what goes on the cap.
 */
export type KeyToken = string;

/** What a key shows, and what it is called out loud. A pair where the two
 *  differ by keyboard — only the command key does. */
interface KeySpelling {
  label: string | { mac: string; other: string };
  spoken: string | { mac: string; other: string };
}

/**
 * The keys that need spelling out, and how.
 *
 * On a Mac the modifiers are the symbols its menus print — ⌘ ⇧ ⌫ — as Linear,
 * Figma and Final Cut draw them (the author, 2026-10-19). They were words
 * from 2026-09-19, when the caps were 12px of bold beside bold letters and
 * the symbols read as smudges; the caps are a regular weight now, in the
 * side panel's quieter rows. Off a Mac the modifiers stay words: ⌘ means
 * nothing on a Windows keyboard. Esc and Space are words everywhere.
 *
 * The arrows stay arrows: every keyboard prints those, at any size.
 */
const KEYS: Record<string, KeySpelling> = {
  Mod: {
    // Named after the keyboard it is being read on. ⌘ means nothing on a
    // Windows keyboard, and `resolveShortcut` genuinely claims Ctrl there —
    // so a legend saying CMD to a Windows author names a key they do not
    // have, for a binding that works.
    label: { mac: "\u2318", other: "Ctrl" },
    spoken: { mac: "Command", other: "Control" },
  },
  Shift: { label: { mac: "\u21e7", other: "Shift" }, spoken: "Shift" },
  Space: { label: "Space", spoken: "Space" },
  Esc: { label: "Esc", spoken: "Escape" },
  Delete: { label: { mac: "\u232b", other: "Delete" }, spoken: "Delete" },
  Home: { label: "Home", spoken: "Home" },
  End: { label: "End", spoken: "End" },
  Left: { label: "\u2190", spoken: "Left arrow" },
  Right: { label: "\u2192", spoken: "Right arrow" },
  Up: { label: "\u2191", spoken: "Up arrow" },
  Down: { label: "\u2193", spoken: "Down arrow" },
};

const pick = (
  value: string | { mac: string; other: string },
  mac: boolean,
): string =>
  typeof value === "string" ? value : mac ? value.mac : value.other;

/** What goes on the cap. A key with no entry above prints as itself, which
 *  is right for every letter and punctuation key the map binds. */
export function keyLabel(token: KeyToken, mac: boolean): string {
  const spelling = KEYS[token];
  return spelling === undefined ? token : pick(spelling.label, mac);
}

/** The labels that are a symbol rather than a word or a letter: drawn in
 *  the system's own face, larger, wherever a cap shows one (the studio's
 *  mono has none of them, and fell back to specks). */
const KEY_SYMBOLS = new Set([
  "\u2318",
  "\u21e7",
  "\u232b",
  "\u2190",
  "\u2192",
  "\u2191",
  "\u2193",
]);
export function isKeySymbol(label: string): boolean {
  return KEY_SYMBOLS.has(label);
}

/** What a screen reader says for one key. */
export function keySpoken(token: KeyToken, mac: boolean): string {
  const spelling = KEYS[token];
  return spelling === undefined ? token : pick(spelling.spoken, mac);
}

/**
 * What a screen reader says for a whole chord.
 *
 * "plus", spelled out, because the caps carry no separator: adjacency is how
 * the eye reads "pressed together" and it is not something a reader can see.
 * Without this a row announces as two unrelated key names.
 */
export function comboSpoken(combo: readonly KeyToken[], mac: boolean): string {
  return combo.map((token) => keySpoken(token, mac)).join(" plus ");
}

/**
 * Whether to print CMD or CTRL, from the user agent.
 *
 * Unknown is not a Mac: CTRL is what the binding does everywhere else, so it
 * is the safer thing to be wrong about. `navigator.platform` would be the
 * obvious read and is deprecated; the extension platform-info API is
 * authoritative but async, and the legend draws synchronously.
 *
 * Named in prose rather than in code on purpose: this module is under the
 * capture-core boundary, and `test/node/boundary.test.ts` scans these files
 * as text — it caught the API's dotted name in this very comment.
 */
export function isMacPlatform(userAgent: string): boolean {
  return /\bMac/i.test(userAgent);
}

export interface ShortcutEntry {
  group: string;
  /**
   * The alternatives for this line. Each inner array is one chord — keys
   * held together — so the view can draw a cap per key and never split a
   * chord across a line break.
   */
  combos: readonly (readonly KeyToken[])[];
  /**
   * The line beside the keys, in one form or two.
   *
   * A pair where the two keyboards genuinely have different things to say —
   * Ctrl+Y exists only off a Mac, and the fn trick matters only on one. A
   * single line hedging for both ("Redo — Ctrl+Y as well on Windows") reads
   * as noise to everyone, since nobody is on both platforms at once.
   */
  description: string | { mac: string; other: string };
  /** The `ShortcutAction["kind"]` this line documents. The test lane walks
   *  every reachable action and fails on one with no entry here. */
  action: ShortcutAction["kind"];
}

/** The description for the keyboard this page is being read on. */
export function describeShortcut(entry: ShortcutEntry, mac: boolean): string {
  return pick(entry.description, mac);
}

export const SHORTCUT_LEGEND: readonly ShortcutEntry[] = [
  {
    group: "Playback",
    combos: [["Space"]],
    description: "Play / pause",
    action: "playPause",
  },
  {
    group: "Playback",
    combos: [["J"], ["L"]],
    description: "Shuttle back / forward",
    action: "shuttle",
  },
  { group: "Playback", combos: [["K"]], description: "Stop", action: "stop" },
  {
    group: "Playback",
    combos: [["Left"], ["Right"]],
    description: "Nudge playhead",
    action: "nudge",
  },
  {
    group: "Playback",
    combos: [
      ["Shift", "Left"],
      ["Shift", "Right"],
    ],
    description: "Nudge half a second",
    action: "nudge",
  },
  {
    group: "Playback",
    combos: [
      ["Mod", "Left"],
      ["Mod", "Right"],
    ],
    description: "Jump to start / end",
    action: "seekEdge",
  },
  {
    group: "Steps",
    combos: [["Up"], ["Down"]],
    description: "Previous / next step",
    action: "stepBeat",
  },
  {
    group: "Steps",
    combos: [["Esc"]],
    description: "Clear selection",
    action: "clearSelection",
  },
  {
    group: "Trim",
    combos: [["I"], ["O"]],
    description: "Trim start / end to playhead",
    action: "setTrim",
  },
  {
    group: "Editing",
    combos: [["Mod", "B"]],
    description: "Split at playhead",
    action: "split",
  },
  {
    group: "Editing",
    combos: [["Delete"]],
    description: "Delete the selected piece, zoom or mask",
    action: "deleteSelection",
  },
  {
    group: "Editing",
    combos: [["Mod", "Z"]],
    description: "Undo",
    action: "undo",
  },
  {
    group: "Editing",
    combos: [["Shift", "Mod", "Z"]],
    description: { mac: "Redo", other: "Redo \u2014 or Ctrl+Y" },
    action: "redo",
  },
  {
    group: "Timeline",
    combos: [["+"], ["\u2212"]],
    description: "Zoom in / out",
    action: "zoomTimeline",
  },
  {
    group: "Timeline",
    combos: [["Shift", "Z"]],
    description: "Fit the whole take",
    action: "zoomFit",
  },
  {
    group: "Timeline",
    combos: [["S"]],
    description: "Snapping on / off",
    action: "toggleSnapping",
  },
  {
    group: "Panels",
    combos: [["?"]],
    description: "Show shortcuts",
    action: "toggleHelp",
  },
  {
    group: "Panels",
    combos: [["Esc"]],
    description: "Close the panel",
    action: "closePanel",
  },
];
