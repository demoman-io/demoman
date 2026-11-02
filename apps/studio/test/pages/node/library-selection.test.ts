// apps/studio/test/pages/node/library-selection.test.ts
import { describe, expect, it } from "vitest";
import {
  clickSelect,
  emptySelection,
  pruneSelection,
  type Selection,
  selectAll,
  toggleGroup,
} from "../../../pages/src/library/selection";

const ORDER = ["a", "b", "c", "d", "e"] as const;
const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort();
const toggle = (s: Selection, id: string) =>
  clickSelect(s, id, "toggle", ORDER);
const range = (s: Selection, id: string) => clickSelect(s, id, "range", ORDER);

describe("library selection", () => {
  it("emptySelection has an empty range", () => {
    expect(emptySelection().range).toEqual([]);
  });

  it("a toggle ticks then unticks", () => {
    const once = toggle(emptySelection(), "b");
    expect(ids(once)).toEqual(["b"]);
    expect(once.anchor).toBe("b");
    expect(ids(toggle(once, "b"))).toEqual([]);
  });

  it("a range ticks anchor..target in visible order, either direction", () => {
    expect(ids(range(toggle(emptySelection(), "b"), "d"))).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(ids(range(toggle(emptySelection(), "d"), "b"))).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("a range replaces the last range", () => {
    const first = range(toggle(emptySelection(), "b"), "d");
    expect(ids(first)).toEqual(["b", "c", "d"]); // premise
    expect(first.range).toEqual(["c", "d"]);
    expect(ids(range(first, "c"))).toEqual(["b", "c"]);
  });

  it("Shift+down then Shift+up shrinks back to the anchor", () => {
    const down = range(range(toggle(emptySelection(), "b"), "c"), "d");
    expect(ids(down)).toEqual(["b", "c", "d"]); // premise
    const up = range(range(down, "c"), "b");
    expect(ids(up)).toEqual(["b"]);
  });

  // Red: the new range deleting every id of the last one, seen or not.
  it("a range keeps the last range's ids a fold has since hidden", () => {
    // a..c under Today, d..e under Yesterday, f under a past month.
    const all = ["a", "b", "c", "d", "e", "f"];
    const first = clickSelect(toggle(emptySelection(), "a"), "e", "range", all);
    expect(ids(first)).toEqual(["a", "b", "c", "d", "e"]); // premise
    // Yesterday folded: d and e are off screen.
    const folded = ["a", "b", "c", "f"];
    const next = clickSelect(first, "f", "range", folded);
    expect(ids(next)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(next.range).toEqual(["b", "c", "f"]);
    // A shrink on screen still takes back what it can see.
    expect(ids(clickSelect(next, "b", "range", folded))).toEqual([
      "a",
      "b",
      "d",
      "e",
    ]);
  });

  it("a toggle outside the range survives the next range", () => {
    const s = toggle(toggle(emptySelection(), "a"), "c");
    expect(s.anchor).toBe("c"); // premise
    const wide = range(s, "e");
    expect(ids(wide)).toEqual(["a", "c", "d", "e"]);
    expect(ids(range(wide, "d"))).toEqual(["a", "c", "d"]);
  });

  it("a toggle moves the anchor and clears the range", () => {
    const ranged = range(toggle(emptySelection(), "a"), "c");
    expect(ranged.range.length).toBeGreaterThan(0); // premise
    const t = toggle(ranged, "e");
    expect(t.anchor).toBe("e");
    expect(t.range).toEqual([]);
    expect(ids(t)).toEqual(["a", "b", "c", "e"]);
  });

  it("a range with no anchor on screen is a toggle", () => {
    const s: Selection = { ids: new Set(["x"]), anchor: "x", range: [] };
    expect(ids(range(s, "c"))).toEqual(["c", "x"]);
    expect(range(s, "c").anchor).toBe("c");
    expect(ids(range(emptySelection(), "c"))).toEqual(["c"]);
  });

  // Red: `from` ignored, so Shift+↓ from a with nothing ticked ticks b
  // alone and leaves out the row it started from (Finder ticks both).
  it("a range with no anchor on screen grows from `from`, the row the move started at", () => {
    const down = clickSelect(emptySelection(), "b", "range", ORDER, "a");
    expect(ids(down)).toEqual(["a", "b"]);
    expect(down.anchor).toBe("a");
    const up = clickSelect(down, "a", "range", ORDER, "b");
    expect(ids(up)).toEqual(["a"]);
    // An anchor on screen wins over `from`.
    const anchored = toggle(emptySelection(), "c");
    expect(ids(clickSelect(anchored, "e", "range", ORDER, "d"))).toEqual([
      "c",
      "d",
      "e",
    ]);
  });

  it("selectAll ticks every visible id and keeps the anchor", () => {
    const s = toggle(emptySelection(), "b");
    const all = selectAll(s, ["a", "b", "c"]);
    expect(ids(all)).toEqual(["a", "b", "c"]);
    expect(all.anchor).toBe("b");
    expect(all.range).toEqual([]);
  });

  it("prune drops vanished ids, range ids and an anchor that vanished", () => {
    const s = range(toggle(emptySelection(), "a"), "c");
    expect(s.range).toEqual(["b", "c"]); // premise
    const pruned = pruneSelection(s, new Set(["b"]));
    expect(ids(pruned)).toEqual(["b"]);
    expect(pruned.range).toEqual(["b"]);
    expect(pruned.anchor).toBeNull();
    expect(pruneSelection(s, new Set(["a", "c"])).anchor).toBe("a");
  });
});

describe("toggleGroup", () => {
  const sel = (...picked: string[]): Selection => ({
    ids: new Set(picked),
    anchor: picked[0] ?? null,
    range: [],
  });
  const day = ["a", "b", "c"];

  it("none ticked: all of the day", () => {
    expect(ids(toggleGroup(emptySelection(), day))).toEqual(day);
  });

  it("some ticked: all of the day, others kept", () => {
    const some = sel("b", "z");
    expect(ids(some)).toEqual(["b", "z"]); // premise: partly ticked
    expect(ids(toggleGroup(some, day))).toEqual(["a", "b", "c", "z"]);
  });

  it("all ticked: none of the day, others untouched, anchor kept", () => {
    const all = sel("a", "b", "c", "z");
    expect(day.every((d) => all.ids.has(d))).toBe(true); // premise
    const next = toggleGroup(all, day);
    expect(ids(next)).toEqual(["z"]);
    expect(next.anchor).toBe("a");
  });

  it("an empty day changes nothing", () => {
    expect(ids(toggleGroup(sel("z"), []))).toEqual(["z"]);
  });
});
