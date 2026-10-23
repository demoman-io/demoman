import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/document";
import { migrateToCurrent } from "../src/migrations";

/** The fixture as a v6 document: no `canvas`, no `edits.cuts`. */
function v6Document(): Record<string, unknown> {
  const current = JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const { canvas: _canvas, ...rest } = current;
  const { cuts: _cuts, ...edits } = current.edits as Record<string, unknown>;
  return { ...rest, edits, schemaVersion: 6 };
}

describe("v6 -> v7: canvas and cuts", () => {
  it("backfills a 16:9 canvas and no removed pieces", () => {
    // Premise: the v6 builder really removed both, or the backfill below
    // would be read straight off the fixture and prove nothing.
    const v6 = v6Document();
    expect(v6).not.toHaveProperty("canvas");
    expect(v6.edits).not.toHaveProperty("cuts");

    const migrated = migrateToCurrent(v6);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.canvas).toEqual({ aspect: "16:9" });
    expect(migrated.edits.removed).toEqual([]);
  });

  it("keeps an authored aspect", () => {
    const doc = {
      ...v6Document(),
      schemaVersion: 7,
      canvas: { aspect: "9:16" },
      edits: { ...(v6Document().edits as object), cuts: [] },
    };
    expect(migrateToCurrent(doc).canvas.aspect).toBe("9:16");
  });

  it("refuses an aspect the product does not offer", () => {
    const doc = {
      ...v6Document(),
      schemaVersion: 7,
      canvas: { aspect: "1:1" },
      edits: { ...(v6Document().edits as object), cuts: [] },
    };
    // On the aspect, by path: a bare toThrow() is also satisfied by the
    // version refusal a v6 build gives any v7 document.
    expect(() => migrateToCurrent(doc)).toThrow(/"aspect"/);
  });
});

describe("a v7 cut", () => {
  function v7With(cuts: unknown[]): Record<string, unknown> {
    return {
      ...v6Document(),
      schemaVersion: 7,
      canvas: { aspect: "16:9" },
      edits: { ...(v6Document().edits as object), cuts },
    };
  }
  const firstAction = () =>
    (v6Document().actions as { id: string }[])[0]?.id as string;

  // Step cuts became removed pieces at v12 (spec split-tool); a v7 cut
  // reaches the current schema as one.
  it("on an action the scene has arrives as a removed piece", () => {
    // Premise: the fixture has an action to cut.
    expect(firstAction()).toBeTruthy();
    const doc = migrateToCurrent(
      v7With([{ id: "cut-1", actionId: firstAction() }]),
    );
    expect("cuts" in doc.edits).toBe(false);
    expect(doc.edits.removed[0]?.start).toEqual({
      actionId: firstAction(),
      sourceOffsetMs: 0,
    });
  });
});
