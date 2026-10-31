// apps/studio/test/pages/node/library-list-keys.test.ts
//
// The list's type-ahead search (spec 2026-10-31-library-list-view §4.3).
import { describe, expect, it } from "vitest";
import { typeAheadMatch } from "../../../pages/src/library/list-keys";

// A heading or a video row is "": never a match, as the grid passes it.
const NAMES = ["", "Create an invoice", "Edit profile", "", "Export a report"];

describe("typeAheadMatch", () => {
  it("finds the next name after from", () => {
    expect(typeAheadMatch(NAMES, 0, "e")).toBe(2);
    expect(typeAheadMatch(NAMES, 0, "ex")).toBe(4);
    // After `from`, not at it: from Edit, "e" goes on to Export.
    expect(typeAheadMatch(NAMES, 2, "e")).toBe(4);
  });

  it("wraps to the top", () => {
    expect(typeAheadMatch(NAMES, 4, "c")).toBe(1);
    // The row it started on comes last.
    expect(typeAheadMatch(NAMES, 4, "exp")).toBe(4);
  });

  it("ignores case", () => {
    expect(typeAheadMatch(NAMES, 0, "EX")).toBe(4);
  });

  it("returns null for no match", () => {
    expect(typeAheadMatch(NAMES, 0, "exc")).toBeNull();
    expect(typeAheadMatch([], -1, "a")).toBeNull();
  });
});
