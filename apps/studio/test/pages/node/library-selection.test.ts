// apps/studio/test/pages/node/library-selection.test.ts
import { describe, expect, it } from "vitest";
import {
  clickSelect,
  emptySelection,
  pruneSelection,
  type Selection,
  selectAll,
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
