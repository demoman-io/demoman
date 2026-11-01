import { describe, expect, it } from "vitest";
import { parseFilmedCode } from "../../src/index.js";

describe("parseFilmedCode", () => {
  it("reads a commit, a first-commit null, and a reason", () => {
    const code = { commit: "a".repeat(40), tree: "b".repeat(40), dirty: true };
    expect(parseFilmedCode(code)).toEqual(code);
    expect(parseFilmedCode({ commit: null, tree: "t", dirty: false })).toEqual({
      commit: null,
      tree: "t",
      dirty: false,
    });
    expect(parseFilmedCode({ none: "not a checkout" })).toEqual({
      none: "not a checkout",
    });
  });

  it("copies only the fields it checked", () => {
    expect(
      parseFilmedCode({ commit: "c", tree: "t", dirty: false, extra: 1 }),
    ).toEqual({ commit: "c", tree: "t", dirty: false });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string", "abc"],
    ["an array", []],
    ["an empty reason", { none: "" }],
    ["a numeric commit", { commit: 42, tree: "t", dirty: false }],
    ["no tree", { commit: "c", dirty: false }],
    ["a string dirty", { commit: "c", tree: "t", dirty: "no" }],
    ["no commit key", { tree: "t", dirty: false }],
  ])("is null for %s", (_, raw) => {
    expect(parseFilmedCode(raw)).toBeNull();
  });
});
