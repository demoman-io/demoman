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

describe("a pre-0.7.3 mask the author's edits may have moved (DEM-115)", () => {
  const mask = (doc: ReturnType<typeof v12>) =>
    (doc.edits.masks as { id: string; start?: { actionId: string } }[]).find(
      (m) => m.id === "mask-ranged",
    );
  // Red: the 12 -> 13 step pushes no note — the mask is read on the source
  // axis, an edit between its step and its edge moves it, and nothing says.
  it.each([
    [
      "a removed piece",
      (d: ReturnType<typeof v12>) => {
        d.edits.removed = [
          {
            id: "rm-1",
            start: { actionId: "act-2", sourceOffsetMs: 50 },
            end: { actionId: "act-2", sourceOffsetMs: 300 },
          },
        ];
      },
    ],
    [
      "a shortened gap",
      (d: ReturnType<typeof v12>) => {
        d.edits.gaps = [{ id: "gap-1", afterActionId: "act-2", durationMs: 0 }];
      },
    ],
    [
      "a hold",
      (d: ReturnType<typeof v12>) => {
        d.edits.holds = [
          {
            id: "hold-1",
            marker: { actionId: "act-2", offsetMs: 100 },
            durationMs: 500,
          },
        ];
      },
    ],
  ])("says so with %s after the mask's step", (_, edit) => {
    const before = v12();
    edit(before);
    // Premise: the mask starts at act-2, and the edit is at act-2, between
    // its step and its end at act-3.
    expect(mask(before)?.start?.actionId).toBe("act-2");
    expect(JSON.stringify(before.edits)).toMatch(
      /"(afterActionId|actionId)":"act-2"/,
    );
    const notes: string[] = [];
    migrateToCurrent(before, notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(
      /1 mask on this take was drawn before Demoman 0\.7\.3/,
    );
  });

  it("says nothing when no edit can have moved it, or no mask is ranged", () => {
    const notes: string[] = [];
    migrateToCurrent(v12(), notes);
    const whole = v12();
    whole.edits.masks = (whole.edits.masks as unknown[]).slice(0, 1);
    whole.edits.gaps = [{ id: "gap-1", afterActionId: "act-2", durationMs: 0 }];
    // Premise: the one mask left covers the whole take.
    expect(whole.edits.masks).toEqual([
      expect.not.objectContaining({ start: expect.anything() }),
    ]);
    migrateToCurrent(whole, notes);
    expect(notes).toEqual([]);
  });
});

describe("schema 14: click at a spot, and press", () => {
  it("migrates a v13 scene to v14 unchanged but its version", () => {
    const before = readonly();
    before.schemaVersion = 13;
    const doc = migrateToCurrent(before);
    expect(doc.schemaVersion).toBe(15);
    expect({ ...doc, schemaVersion: 0 }).toEqual({
      ...before,
      schemaVersion: 0,
    });
  });
});
