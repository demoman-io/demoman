// apps/studio/test/pages/node/library-selection.test.ts
import { describe, expect, it } from "vitest";
import {
  clickSelect,
  emptySelection,
  pruneSelection,
} from "../../../pages/src/library/selection";

const ORDER = ["a", "b", "c", "d"] as const;
const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort();

describe("library selection", () => {
  it("plain click ticks then unticks", () => {
    const once = clickSelect(emptySelection(), "b", false, ORDER);
    expect(ids(once)).toEqual(["b"]);
    expect(once.anchor).toBe("b");
    expect(ids(clickSelect(once, "b", false, ORDER))).toEqual([]);
  });

  it("shift-click ticks the range between anchor and target in visible order", () => {
    const s = clickSelect(emptySelection(), "b", false, ORDER);
    expect(ids(clickSelect(s, "d", true, ORDER))).toEqual(["b", "c", "d"]);
  });

  it("shift-click upward ticks the same range", () => {
    const s = clickSelect(emptySelection(), "d", false, ORDER);
    expect(ids(clickSelect(s, "b", true, ORDER))).toEqual(["b", "c", "d"]);
  });

  it("range with a missing anchor ticks only the target", () => {
    const s = { ids: new Set(["x"]), anchor: "x" };
    expect(ids(clickSelect(s, "c", true, ORDER))).toEqual(["c", "x"]);
    expect(ids(clickSelect(emptySelection(), "c", true, ORDER))).toEqual(["c"]);
  });

  it("prune drops vanished ids and an anchor that vanished", () => {
    const s = clickSelect(
      clickSelect(emptySelection(), "a", false, ORDER),
      "c",
      false,
      ORDER,
    );
    const pruned = pruneSelection(s, new Set(["a", "b"]));
    expect(ids(pruned)).toEqual(["a"]);
    expect(pruned.anchor).toBeNull();
    expect(pruneSelection(s, new Set(["a", "c"])).anchor).toBe("c");
  });
});
