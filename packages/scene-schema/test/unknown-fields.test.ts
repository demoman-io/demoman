import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/document";
import { migrateToCurrent, unknownFields } from "../src/migrations";

type Doc = Record<string, unknown> & {
  schemaVersion: number;
  actions: Record<string, unknown>[];
};

const readonly = (): Doc =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );

describe("fields a newer Demoman wrote", () => {
  it("a current take's unknown keys are named by path, and its read says so", () => {
    const doc = readonly();
    // Premise: the fixture reads as current, with no unknown keys of its own.
    expect(doc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(unknownFields(doc)).toEqual([]);
    const second = doc.actions[1];
    if (second === undefined) throw new Error("the fixture has one step");
    second.newer = 1;
    doc.later = true;

    expect(unknownFields(doc)).toEqual(["actions[1].newer", "later"]);
    const notes: string[] = [];
    const read = migrateToCurrent(doc, notes);
    expect(read).not.toHaveProperty("later");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("actions[1].newer, later");
    expect(notes[0]).toContain("newer Demoman");
  });

  // Red: drop the `readAsCurrent` gate — an older take's leftover key, which
  // its migration means to drop, would read as written by a newer Demoman.
  it("an older take's leftovers are the migration's to drop, not a newer Demoman's", () => {
    const doc = readonly();
    doc.schemaVersion = CURRENT_SCHEMA_VERSION - 1;
    doc.later = true;
    const notes: string[] = [];
    expect(migrateToCurrent(doc, notes)).not.toHaveProperty("later");
    expect(notes).toEqual([]);
    expect(unknownFields(doc)).toEqual([]);
  });

  it("names five and counts the rest", () => {
    const doc = readonly();
    for (let i = 0; i < 7; i++) doc[`later${i}`] = i;
    const notes: string[] = [];
    migrateToCurrent(doc, notes);
    expect(notes[0]).toContain(
      "later0, later1, later2, later3, later4 and 2 more",
    );
  });
});
