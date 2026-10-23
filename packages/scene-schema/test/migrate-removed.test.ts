import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/document";
import { migrateToCurrent } from "../src/migrations";

interface Fixture {
  schemaVersion: number;
  actions: { id: string }[];
  edits: Record<string, unknown>;
}

const readonly = (): Fixture =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );

/** The fixture as a v11 take carrying `cuts` on the given steps and the
 *  given replacements. */
function v11(cutOn: string[], replacements: unknown[] = []): Fixture {
  const doc = readonly();
  doc.schemaVersion = 11;
  doc.edits = {
    ...doc.edits,
    replacements,
    cuts: cutOn.map((actionId, i) => ({ id: `cut-${i}`, actionId })),
  };
  return doc;
}

const REPLACEMENT = {
  id: "rep",
  targetAnchorId: "a-search",
  find: null,
  replace: "x",
};

describe("schema 12: removed ranges", () => {
  it("is version 12", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(12);
  });

  it("the fixture is the four-step take these cases cut", () => {
    expect(readonly().actions.map((a) => a.id)).toEqual([
      "act-1",
      "act-2",
      "act-3",
      "act-4",
    ]);
  });

  it("converts a run of cut steps to one removed range from the first cut step to the next kept step", () => {
    const raw = v11(["act-2", "act-3"]);
    expect((raw.edits.cuts as unknown[]).length).toBe(2);
    const doc = migrateToCurrent(raw);
    expect(doc.edits.removed).toEqual([
      {
        id: expect.any(String),
        start: { actionId: "act-2", sourceOffsetMs: 0 },
        end: { actionId: "act-4", sourceOffsetMs: 0 },
      },
    ]);
    // The two fields left with schema 12: not emptied, gone.
    expect("cuts" in doc.edits).toBe(false);
    expect("replacements" in doc.edits).toBe(false);
  });

  it("a cut run reaching the last step ends at the take's end", () => {
    const doc = migrateToCurrent(v11(["act-3", "act-4"]));
    expect(doc.edits.removed).toEqual([
      {
        id: expect.any(String),
        start: { actionId: "act-3", sourceOffsetMs: 0 },
        end: null,
      },
    ]);
  });

  it("two separate runs stay two ranges", () => {
    const doc = migrateToCurrent(v11(["act-1", "act-3"]));
    expect(doc.edits.removed.map((r) => [r.start, r.end])).toEqual([
      [
        { actionId: "act-1", sourceOffsetMs: 0 },
        { actionId: "act-2", sourceOffsetMs: 0 },
      ],
      [
        { actionId: "act-3", sourceOffsetMs: 0 },
        { actionId: "act-4", sourceOffsetMs: 0 },
      ],
    ]);
  });

  it("drops replacements and says so", () => {
    const notes: string[] = [];
    const doc = migrateToCurrent(
      v11([], [REPLACEMENT, { ...REPLACEMENT, id: "rep-2" }]),
      notes,
    );
    expect("replacements" in doc.edits).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("2");
  });

  // Review 2026-10-22: a replacement on a blocked (redacted) field was the
  // value a rebuild typed there, not an overlay, and the note has to say what
  // losing it costs.
  it("names a dropped value for a blocked field apart from an overlay", () => {
    const raw = v11(
      [],
      [
        { ...REPLACEMENT, id: "secret", targetAnchorId: "a-search" },
        { ...REPLACEMENT, id: "overlay", targetAnchorId: "a-checkout" },
      ],
    ) as Fixture & { actions: Record<string, unknown>[] };
    // act-3 types into a-search: make it a blocked field.
    raw.actions = raw.actions.map((a) =>
      a.id === "act-3" ? { ...a, redacted: true, text: null } : a,
    );
    const notes: string[] = [];
    migrateToCurrent(raw, notes);
    expect(notes).toEqual([
      "1 text overlay was removed from this take: the video shows the text that was recorded.",
      "1 typed value for a blocked field was removed from this take: rebuilding the take stops at that step. Put the value in the script and record it again.",
    ]);
  });

  it("a doc with neither writes no note", () => {
    const notes: string[] = [];
    const doc = migrateToCurrent(v11([]), notes);
    expect(notes).toEqual([]);
    expect(doc.edits.removed).toEqual([]);
    expect(doc.edits.splits).toEqual([]);
  });
});
