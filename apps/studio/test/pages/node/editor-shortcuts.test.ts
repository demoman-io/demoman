import { describe, expect, it } from "vitest";
import {
  comboSpoken,
  describeShortcut,
  isMacPlatform,
  keyLabel,
  NUDGE_COARSE_MS,
  NUDGE_FINE_MS,
  resolveShortcut,
  SHORTCUT_LEGEND,
  type ShortcutAction,
  type ShortcutContext,
} from "../../../pages/src/editor/shortcuts";

/**
 * The editor's key map, as a table.
 *
 * It lives apart from `entrypoints/editor/main.ts` so the decisions — which
 * key means what, and when a key is deliberately left to the browser — can
 * be read and tested without a DOM, a session or a player. `main.ts` keeps
 * only the guards about where a press landed and the dispatch.
 */

const press = (
  key: string,
  modifiers: Partial<{ shift: boolean; meta: boolean; ctrl: boolean }> = {},
) => ({
  key,
  shiftKey: modifiers.shift === true,
  metaKey: modifiers.meta === true,
  ctrlKey: modifiers.ctrl === true,
});

const ctx = (overrides: Partial<ShortcutContext> = {}): ShortcutContext => ({
  hasSelection: false,
  selectionIsBeat: false,
  canUndo: false,
  canRedo: false,
  panelOpen: false,
  hasTimeline: true,
  ...overrides,
});

describe("editor shortcuts — playback", () => {
  it("plays and pauses on the space bar", () => {
    expect(resolveShortcut(press(" "), ctx())).toEqual({ kind: "playPause" });
  });

  it("shuttles forward on L and back on J", () => {
    expect(resolveShortcut(press("l"), ctx())).toEqual({
      kind: "shuttle",
      direction: 1,
    });
    expect(resolveShortcut(press("j"), ctx())).toEqual({
      kind: "shuttle",
      direction: -1,
    });
  });

  it("stops on K rather than toggling, so K after K stays stopped", () => {
    expect(resolveShortcut(press("k"), ctx())).toEqual({ kind: "stop" });
  });

  it("shuttles on the shifted letters too, for a capitals-locked keyboard", () => {
    expect(resolveShortcut(press("L"), ctx())).toEqual({
      kind: "shuttle",
      direction: 1,
    });
  });
});

describe("editor shortcuts — the playhead moves on the plain arrows", () => {
  // The NLE layout, adopted 2026-09-19: every one of Premiere, Resolve and
  // Final Cut steps the PLAYHEAD on a bare arrow. Before that this editor
  // stepped the selection there and put the playhead on the shifted pair,
  // which is the same two keys reading the opposite way round.
  it("nudges the playhead a tenth of a second on a bare arrow", () => {
    expect(resolveShortcut(press("ArrowRight"), ctx())).toEqual({
      kind: "nudge",
      deltaMs: NUDGE_FINE_MS,
    });
    expect(resolveShortcut(press("ArrowLeft"), ctx())).toEqual({
      kind: "nudge",
      deltaMs: -NUDGE_FINE_MS,
    });
  });

  it("nudges further on a shifted arrow", () => {
    expect(
      resolveShortcut(press("ArrowRight", { shift: true }), ctx()),
    ).toEqual({ kind: "nudge", deltaMs: NUDGE_COARSE_MS });
  });

  it("steps the selection between beats on the vertical arrows", () => {
    expect(resolveShortcut(press("ArrowDown"), ctx())).toEqual({
      kind: "stepBeat",
      delta: 1,
    });
    expect(resolveShortcut(press("ArrowUp"), ctx())).toEqual({
      kind: "stepBeat",
      delta: -1,
    });
  });

  it("jumps to the trimmed ends on the command key and an arrow", () => {
    // The third rung of the arrow ladder — bare is a tenth of a second,
    // shifted is half a second, the command key goes all the way — and the
    // pair a Mac keyboard already uses for "start / end of line". It earns
    // taking Chrome's Back and Forward because a MacBook has no Home or End
    // key printed on it: fn plus an arrow sends one, which is a reach for
    // the most ordinary move on the timeline.
    for (const modifier of ["meta", "ctrl"] as const) {
      expect(
        resolveShortcut(press("ArrowLeft", { [modifier]: true }), ctx()),
      ).toEqual({ kind: "seekEdge", edge: "head" });
      expect(
        resolveShortcut(press("ArrowRight", { [modifier]: true }), ctx()),
      ).toEqual({ kind: "seekEdge", edge: "tail" });
    }
  });

  it("leaves a shifted command arrow to the browser", () => {
    // ⇧⌘← selects to the start of a line on a Mac. Nothing here wants it,
    // and the table claims a command-key press only when it means one of
    // its own — so this stays unbound rather than jumping the playhead on
    // a modifier the author was holding for something else.
    expect(
      resolveShortcut(press("ArrowLeft", { meta: true, shift: true }), ctx()),
    ).toBeNull();
  });

  it("jumps to the trimmed ends on Home and End", () => {
    expect(resolveShortcut(press("Home"), ctx())).toEqual({
      kind: "seekEdge",
      edge: "head",
    });
    expect(resolveShortcut(press("End"), ctx())).toEqual({
      kind: "seekEdge",
      edge: "tail",
    });
  });

  it("takes the coarse nudge before the beat step, so a shifted arrow is never both", () => {
    expect(resolveShortcut(press("ArrowLeft", { shift: true }), ctx())).toEqual(
      {
        kind: "nudge",
        deltaMs: -NUDGE_COARSE_MS,
      },
    );
  });
});

describe("editor shortcuts — marking and cutting", () => {
  it("sets the trim's head on I and its tail on O", () => {
    expect(resolveShortcut(press("i"), ctx())).toEqual({
      kind: "setTrim",
      edge: "head",
    });
    expect(resolveShortcut(press("o"), ctx())).toEqual({
      kind: "setTrim",
      edge: "tail",
    });
  });

  it("leaves the razor keys alone, because nothing here splits", () => {
    // C and Cmd+B are unbound by decision, not by omission: this editor's
    // timeline is beat-indexed and has no clip to razor. Binding either to
    // `trimFrom` would fire a one-way amputation off a key that means
    // "split" everywhere else.
    expect(resolveShortcut(press("c"), ctx())).toBeNull();
    // ⌘B and Ctrl+B are the split since 2026-10-22; see "splits".
  });

  it("deletes the selection on either delete key", () => {
    // A Mac keyboard's "delete" sends Backspace; only Fn+Delete sends Delete.
    for (const key of ["Delete", "Backspace"]) {
      expect(resolveShortcut(press(key), ctx({ hasSelection: true }))).toEqual({
        kind: "deleteSelection",
      });
    }
  });

  // Step editing left the Studio (spec 2026-10-22 split-tool): a step is a
  // label, but Delete on one still reaches the editor, which says why it
  // removes nothing (review 2026-10-22) rather than doing nothing silently.
  it("reaches the editor on a selected step, shifted or not", () => {
    const step = ctx({ hasSelection: true, selectionIsBeat: true });
    for (const p of [
      press("Delete"),
      press("Backspace"),
      press("Delete", { shift: true }),
    ]) {
      expect(resolveShortcut(p, step)).toEqual({ kind: "deleteSelection" });
    }
  });

  it("ignores the shift on a zoom or a mask", () => {
    expect(
      resolveShortcut(
        press("Delete", { shift: true }),
        ctx({ hasSelection: true, selectionIsBeat: false }),
      ),
    ).toEqual({ kind: "deleteSelection" });
  });

  // Spec 2026-10-22 split-tool: ⌘B is Final Cut's and Resolve's blade.
  it("splits on ⌘B, and on Ctrl+B off macOS", () => {
    expect(resolveShortcut(press("b", { meta: true }), ctx())).toEqual({
      kind: "split",
    });
    expect(resolveShortcut(press("b", { ctrl: true }), ctx())).toEqual({
      kind: "split",
    });
    // Shifted is not the split: ⇧⌘B is the browser's bookmarks bar.
    expect(
      resolveShortcut(press("b", { meta: true, shift: true }), ctx()),
    ).toBeNull();
  });

  it("deletes a selected piece", () => {
    expect(
      resolveShortcut(
        press("Delete"),
        ctx({ hasSelection: true, selectionIsBeat: false }),
      ),
    ).toEqual({ kind: "deleteSelection" });
  });

  it("leaves both delete keys to the browser with nothing selected", () => {
    expect(resolveShortcut(press("Delete"), ctx())).toBeNull();
    expect(resolveShortcut(press("Backspace"), ctx())).toBeNull();
  });
});

describe("editor shortcuts — history", () => {
  it("undoes on the OS's own command key", () => {
    for (const modifier of ["meta", "ctrl"] as const) {
      expect(
        resolveShortcut(
          press("z", { [modifier]: true }),
          ctx({ canUndo: true }),
        ),
      ).toEqual({ kind: "undo" });
    }
  });

  it("redoes on a shifted Z, and on Ctrl+Y for the Windows convention", () => {
    expect(
      resolveShortcut(
        press("z", { meta: true, shift: true }),
        ctx({ canRedo: true }),
      ),
    ).toEqual({ kind: "redo" });
    expect(
      resolveShortcut(press("y", { ctrl: true }), ctx({ canRedo: true })),
    ).toEqual({ kind: "redo" });
  });

  it("leaves Cmd+Y to the browser, where it opens the history window", () => {
    expect(
      resolveShortcut(press("y", { meta: true }), ctx({ canRedo: true })),
    ).toBeNull();
  });

  it("leaves the key to the browser rather than claiming a no-op", () => {
    // An empty history must not swallow the press: a shortcut that does
    // nothing still reads to the author as a shortcut that did something.
    expect(resolveShortcut(press("z", { meta: true }), ctx())).toBeNull();
    expect(
      resolveShortcut(press("z", { meta: true, shift: true }), ctx()),
    ).toBeNull();
  });
});

describe("editor shortcuts — the timeline window", () => {
  it("zooms in on plus and out on minus", () => {
    const zoomIn = resolveShortcut(press("+"), ctx());
    const zoomOut = resolveShortcut(press("-"), ctx());
    expect(zoomIn).toMatchObject({ kind: "zoomTimeline" });
    expect(zoomOut).toMatchObject({ kind: "zoomTimeline" });
    // In multiplies the span down, out multiplies it back up; the two have
    // to be reciprocals or a zoom in followed by a zoom out lands somewhere
    // new every time.
    const factorIn = (zoomIn as { factor: number }).factor;
    const factorOut = (zoomOut as { factor: number }).factor;
    expect(factorIn).toBeGreaterThan(1);
    expect(factorIn * factorOut).toBeCloseTo(1, 10);
  });

  it("zooms on the unshifted equals key, which is where plus is printed", () => {
    // A US keyboard sends "=" unless shift is held, so binding "+" alone
    // leaves the author pressing the key under the + and getting nothing.
    expect(resolveShortcut(press("="), ctx())).toEqual(
      resolveShortcut(press("+"), ctx()),
    );
  });

  it("fits the whole take on a shifted Z", () => {
    expect(resolveShortcut(press("z", { shift: true }), ctx())).toEqual({
      kind: "zoomFit",
    });
  });

  it("keeps the command key's shifted Z on redo, not on fit", () => {
    expect(
      resolveShortcut(
        press("z", { meta: true, shift: true }),
        ctx({ canRedo: true }),
      ),
    ).toEqual({ kind: "redo" });
  });

  it("leaves the zoom keys to the browser before a take has been rendered", () => {
    // Claimed and then dropped is worse than not claimed: `main.ts` has
    // already called `preventDefault` by the time it finds no viewport, so
    // the press is eaten and nothing says why.
    const blank = ctx({ hasTimeline: false });
    expect(resolveShortcut(press("+"), blank)).toBeNull();
    expect(resolveShortcut(press("="), blank)).toBeNull();
    expect(resolveShortcut(press("-"), blank)).toBeNull();
    expect(resolveShortcut(press("z", { shift: true }), blank)).toBeNull();
  });

  it("toggles snapping on S", () => {
    expect(resolveShortcut(press("s"), ctx())).toEqual({
      kind: "toggleSnapping",
    });
  });

  it("leaves Cmd+S to the browser rather than toggling snapping", () => {
    expect(resolveShortcut(press("s", { meta: true }), ctx())).toBeNull();
  });
});

describe("editor shortcuts — the selection and the legend", () => {
  it("clears the selection on Escape, and only when there is one", () => {
    expect(
      resolveShortcut(press("Escape"), ctx({ hasSelection: true })),
    ).toEqual({ kind: "clearSelection" });
    expect(resolveShortcut(press("Escape"), ctx())).toBeNull();
  });

  // The author, 2026-10-19: the list is an inspector panel, the editor in
  // view beside it, so every key works while a panel is open (Linear's way).
  // It was a modal over a scrim until then and refused every key but its
  // own two. Red: make an open panel refuse keys.
  it("lets every key work while a panel is open, beside the editor", () => {
    // A zoom or a mask selected: Delete is bound on those, not on a step.
    const state = {
      hasSelection: true,
      selectionIsBeat: false,
      canUndo: true,
      canRedo: true,
    };
    const open = ctx({ ...state, panelOpen: true });
    const closed = ctx({ ...state, panelOpen: false });
    const keys = [
      press(" "),
      press("j"),
      press("k"),
      press("l"),
      press("ArrowLeft"),
      press("ArrowRight"),
      press("ArrowUp"),
      press("ArrowDown"),
      press("Home"),
      press("End"),
      press("i"),
      press("o"),
      press("Delete"),
      press("Delete", { shift: true }),
      press("z", { meta: true }),
      press("z", { meta: true, shift: true }),
      press("y", { ctrl: true }),
      press("+"),
      press("-"),
      press("s"),
      press("z", { shift: true }),
    ];
    for (const key of keys) {
      const action = resolveShortcut(key, open);
      // Premise: each of these is bound, so "the same" is not two nulls.
      expect(action, key.key).not.toBeNull();
      expect({ key: key.key, action }).toEqual({
        key: key.key,
        action: resolveShortcut(key, closed),
      });
    }
  });
  // The author, 2026-10-19: Escape undoes the innermost thing, one press
  // each — a selection, then the open panel (a popover and a text field
  // are the page's, before this table). Red: let Escape skip the selection,
  // or leave a panel open with nothing selected.
  it("clears a selection on Escape, then closes the open panel", () => {
    const both = ctx({ panelOpen: true, hasSelection: true });
    expect(resolveShortcut(press("Escape"), both)).toEqual({
      kind: "clearSelection",
    });
    const panelOnly = ctx({ panelOpen: true });
    expect(resolveShortcut(press("Escape"), panelOnly)).toEqual({
      kind: "closePanel",
    });
    // Nothing selected and nothing open: Escape is the browser's.
    expect(resolveShortcut(press("Escape"), ctx())).toBeNull();
    // ? still toggles the list, whatever is open.
    expect(resolveShortcut(press("?"), both)).toEqual({ kind: "toggleHelp" });
  });
  it("opens the legend on ?", () => {
    expect(resolveShortcut(press("?"), ctx())).toEqual({ kind: "toggleHelp" });
  });

  it("closes the open panel on Escape with nothing selected", () => {
    expect(resolveShortcut(press("Escape"), ctx({ panelOpen: true }))).toEqual({
      kind: "closePanel",
    });
  });

  it("lists every bindable key in the legend", () => {
    // The overlay is rendered from this table, so a binding cannot ship
    // without a line explaining it. Revert any entry and this goes red.
    const bound = new Set<ShortcutAction["kind"]>();
    const keys = [
      " ",
      "j",
      "k",
      "l",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "i",
      "o",
      "Delete",
      "z",
      "y",
      "+",
      "-",
      "s",
      "Escape",
      "?",
    ];
    const full = ctx({
      hasSelection: true,
      selectionIsBeat: true,
      canUndo: true,
      canRedo: true,
    });
    for (const key of keys) {
      for (const mods of [
        {},
        { shift: true },
        { meta: true },
        { ctrl: true },
        { meta: true, shift: true },
      ]) {
        const action = resolveShortcut(press(key, mods), full);
        if (action !== null) bound.add(action.kind);
      }
    }
    const documented = new Set(SHORTCUT_LEGEND.map((entry) => entry.action));
    expect([...bound].filter((kind) => !documented.has(kind))).toEqual([]);
    expect(bound.size).toBeGreaterThan(0);
  });

  it("gives every legend line keys and a description to show", () => {
    for (const entry of SHORTCUT_LEGEND) {
      expect(entry.combos.length).toBeGreaterThan(0);
      for (const combo of entry.combos) expect(combo.length).toBeGreaterThan(0);
      // The description may be one line or a pair; `describeShortcut` is
      // what resolves it, and the pair is covered on both keyboards below.
      expect(describeShortcut(entry, true).length).toBeGreaterThan(0);
      expect(entry.group.length).toBeGreaterThan(0);
    }
  });
});

/**
 * What the overlay prints on a key, and what a screen reader says for it.
 *
 * Kept apart from the bindings so the legend can be drawn as a row of keycaps
 * rather than a pre-joined string — a cap is per KEY, so the data has to be
 * per key too. The alternative, splitting "⇧← / ⇧→" back apart in the view,
 * would put the map's meaning in a regex.
 */
describe("key labels", () => {
  // The author, 2026-10-19: a Mac's own symbols, as Linear draws them. They
  // were words from 2026-09-19, when bold 12px caps made them smudges.
  it("prints a Mac's modifiers as its symbols, and words elsewhere", () => {
    expect(keyLabel("Shift", true)).toBe("\u21e7");
    expect(keyLabel("Shift", false)).toBe("Shift");
    expect(keyLabel("Delete", true)).toBe("\u232b");
    expect(keyLabel("Delete", false)).toBe("Delete");
    // Esc and Space read as words on every keyboard.
    expect(keyLabel("Esc", true)).toBe("Esc");
    expect(keyLabel("Space", true)).toBe("Space");
  });
  it("names the command key after the keyboard it is being read on", () => {
    // ⌘ means nothing on a Windows keyboard, and the binding really is Ctrl
    // there — `resolveShortcut` claims either.
    expect(keyLabel("Mod", true)).toBe("\u2318");
    expect(keyLabel("Mod", false)).toBe("Ctrl");
  });
  it("keeps the arrows as arrows, which every keyboard prints", () => {
    expect(keyLabel("Left", true)).toBe("←");
    expect(keyLabel("Right", true)).toBe("→");
    expect(keyLabel("Up", true)).toBe("↑");
    expect(keyLabel("Down", true)).toBe("↓");
  });

  it("prints a plain character key as itself", () => {
    expect(keyLabel("J", true)).toBe("J");
    expect(keyLabel("?", true)).toBe("?");
  });

  it("leaves no token unprinted", () => {
    // A token with no spelling would reach a cap as its own identifier —
    // the `REASON_TEXT[reason] ?? reason` shape CLAUDE.md names. "Space"
    // and "Esc" print as themselves on purpose, so the guard is the list of
    // spelled tokens, each pinned above: a new multi-character token has to
    // join it, and be given a spelling, to pass.
    const spelled = new Set([
      "Mod",
      "Shift",
      "Space",
      "Esc",
      "Delete",
      "Left",
      "Right",
      "Up",
      "Down",
    ]);
    for (const entry of SHORTCUT_LEGEND) {
      for (const combo of entry.combos) {
        for (const token of combo) {
          if (token.length > 1) expect(spelled, token).toContain(token);
          for (const mac of [true, false]) {
            expect(keyLabel(token, mac).length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
  it("says a combo out loud for a screen reader", () => {
    // A cap reading "⇧" aloud is nothing, and "SHIFT DELETE" read as two
    // caps does not say they are pressed together.
    expect(comboSpoken(["Shift", "Delete"], true)).toBe("Shift plus Delete");
    expect(comboSpoken(["Mod", "Z"], true)).toBe("Command plus Z");
    expect(comboSpoken(["Mod", "Z"], false)).toBe("Control plus Z");
    expect(comboSpoken(["Left"], true)).toBe("Left arrow");
  });

  it("writes the line for the keyboard it will be read on", () => {
    // "Redo — Ctrl+Y as well on Windows" is noise on a Mac. A legend that
    // hedges for both at once is a legend nobody's platform reads cleanly.
    const redo = SHORTCUT_LEGEND.find((e) => e.action === "redo");
    if (redo === undefined) throw new Error("fixture: no redo line");
    expect(describeShortcut(redo, false)).toMatch(/ctrl\+y/i);
    expect(describeShortcut(redo, true)).not.toMatch(/ctrl/i);
    expect(describeShortcut(redo, true)).toMatch(/redo/i);
  });

  it("lists no Home or End, which a Mac does not print, though both still work", () => {
    // The row explaining fn ← went with the side panel (2026-10-19): one
    // line, "Jump to start / end", on ⌘← and ⌘→. The keys still resolve.
    const tokens = SHORTCUT_LEGEND.flatMap((e) => e.combos.flat());
    expect(tokens).not.toContain("Home");
    expect(tokens).not.toContain("End");
    expect(resolveShortcut(press("Home"), ctx())).not.toBeNull();
  });
  it("never mentions the other keyboard's keys", () => {
    // The invariant behind both of the above, over every line: a Mac reader
    // is never told about Ctrl, and everyone else is never told about fn or
    // what a Mac does.
    for (const entry of SHORTCUT_LEGEND) {
      expect(describeShortcut(entry, true)).not.toMatch(/\bctrl\b|windows/i);
      expect(describeShortcut(entry, false)).not.toMatch(/\bfn\b|\bmac\b/i);
    }
  });

  it("gives every line a description on both keyboards", () => {
    for (const entry of SHORTCUT_LEGEND) {
      for (const mac of [true, false]) {
        expect(describeShortcut(entry, mac).length).toBeGreaterThan(0);
      }
    }
  });

  it("reads a Mac keyboard from its user agent", () => {
    expect(
      isMacPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      ),
    ).toBe(true);
    expect(
      isMacPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit"),
    ).toBe(false);
    // Unknown is not Mac: CTRL is the safer thing to print, since it is what
    // the binding does everywhere that is not a Mac.
    expect(isMacPlatform("")).toBe(false);
  });
});
