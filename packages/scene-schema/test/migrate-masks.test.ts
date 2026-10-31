import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateToCurrent } from "../src/migrations";

const readonly = (): Record<string, unknown> & {
  edits: Record<string, unknown>;
} =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );

/** The fixture as a v12 take: its whole-take mask, and one ranged mask
 *  written on the output axis, as v12 stored it. */
function v12() {
  const doc = readonly();
  doc.schemaVersion = 12;
  doc.edits.masks = [
    ...(doc.edits.masks as unknown[]),
    {
      id: "mask-ranged",
      rect: { x: 1, y: 2, width: 30, height: 40 },
      start: { actionId: "act-2", offsetMs: -120 },
      end: { actionId: "act-3", offsetMs: 400 },
    },
  ];
  return doc;
}

describe("schema 13: masks in the frames' own time (audit run 1)", () => {
  // Red: no 12 -> 13 step, or one that leaves `offsetMs` in place.
  it("moves a ranged mask's offsets to the source axis, and leaves a whole-take mask alone", () => {
    const before = v12();
    // Premise: the fixture holds a whole-take mask beside the ranged one.
    expect(
      (before.edits.masks as { start?: unknown }[]).filter(
        (m) => m.start === undefined,
      ),
    ).toHaveLength(1);
    const doc = migrateToCurrent(before);
    expect(doc.edits.masks).toEqual([
      {
        id: "mask-1",
        rect: { x: 40, y: 200, width: 600, height: 300 },
        note: "customer table",
      },
      {
        id: "mask-ranged",
        rect: { x: 1, y: 2, width: 30, height: 40 },
        start: { actionId: "act-2", sourceOffsetMs: -120 },
        end: { actionId: "act-3", sourceOffsetMs: 400 },
      },
    ]);
  });
});

describe("schema 14: click at a spot, and press", () => {
  it("migrates a v13 scene to v14 unchanged but its version", () => {
    const before = readonly();
    before.schemaVersion = 13;
    const doc = migrateToCurrent(before);
    expect(doc.schemaVersion).toBe(14);
    expect({ ...doc, schemaVersion: 0 }).toEqual({
      ...before,
      schemaVersion: 0,
    });
  });
});
