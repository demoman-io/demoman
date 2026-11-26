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
  type Doc = ReturnType<typeof v12>;
  const timeOf = (doc: Doc, id: string) =>
    (doc.actions as { id: string; timestamp: number }[]).find(
      (a) => a.id === id,
    )?.timestamp as number;
  /** The stretch between the ranged mask's end step and its end. */
  const endStretch = (doc: Doc) => {
    const step = timeOf(doc, "act-3");
    return [step, step + 400] as const;
  };
  const removedAt = (actionId: string, from: number, to: number) => ({
    id: "rm-1",
    start: { actionId, sourceOffsetMs: from },
    end: { actionId, sourceOffsetMs: to },
  });
  // Red: the 12 -> 13 step pushes no note — the mask is read on the source
  // axis, an edit between its step and its edge moves it, and nothing says.
  it.each([
    [
      "a removed piece",
      (d: Doc) => {
        d.edits.removed = [removedAt("act-3", 100, 300)];
        return timeOf(d, "act-3") + 100;
      },
    ],
    [
      "a shortened gap",
      (d: Doc) => {
        d.edits.gaps = [{ id: "gap-1", afterActionId: "act-3", durationMs: 0 }];
        return timeOf(d, "act-3");
      },
    ],
    [
      "a hold",
      (d: Doc) => {
        d.edits.holds = [
          {
            id: "hold-1",
            marker: { actionId: "act-3", offsetMs: 100 },
            durationMs: 500,
          },
        ];
        return timeOf(d, "act-3") + 100;
      },
    ],
  ])("says so with %s between the mask's step and its edge", (_, edit) => {
    const before = v12();
    const at = edit(before);
    // Premise: the edit lies inside the end's stretch (act-3 to +400 ms).
    const [lo, hi] = endStretch(before);
    expect(at, `${at} in [${lo}, ${hi}]`).toBeGreaterThanOrEqual(lo);
    expect(at).toBeLessThan(hi);
    const notes: string[] = [];
    migrateToCurrent(before, notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(
      /1 mask on this take was drawn before Demoman 0\.7\.3/,
    );
  });

  // Red: note on any edit anywhere (review of DEM-115) — the removed piece
  // below lies outside both of the mask's stretches.
  it("says nothing when no edit lies between a step and its edge, or no mask is ranged", () => {
    const notes: string[] = [];
    migrateToCurrent(v12(), notes);
    const outside = v12();
    outside.edits.removed = [removedAt("act-2", 50, 300)];
    // Premise: the piece (act-2 +50..+300) misses the start's stretch
    // (act-2 -120..0) and the end's (act-3 ..+400).
    const piece = [
      timeOf(outside, "act-2") + 50,
      timeOf(outside, "act-2") + 300,
    ];
    expect(piece[0]).toBeGreaterThan(timeOf(outside, "act-2"));
    expect(piece[1]).toBeLessThan(endStretch(outside)[0]);
    migrateToCurrent(outside, notes);
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

  // Review of DEM-115. Red: count a stretch that only meets the step or the
  // edge (closed intervals) — every v12 take whose cut ends at the mask's
  // step, as `cutsToRemoved` always ends one, gets a note.
  it("says nothing for a cut or gap that only meets a mask's step or edge", () => {
    const notes: string[] = [];
    const cut = v12();
    // A cut from act-2 that ends where act-3 begins, as cutsToRemoved writes.
    cut.edits.removed = [
      {
        id: "rm-1",
        start: { actionId: "act-2", sourceOffsetMs: 0 },
        end: { actionId: "act-3", sourceOffsetMs: 0 },
      },
    ];
    const gap = v12();
    gap.edits.gaps = [{ id: "gap-1", afterActionId: "act-2", durationMs: 0 }];
    // Premise: each spans act-2 to act-3, which meets the start's stretch
    // (act-2 -120..0) at act-2 and the end's (act-3 ..+400) at act-3, and
    // enters neither.
    expect(endStretch(gap)[0]).toBe(timeOf(gap, "act-3"));
    expect(timeOf(gap, "act-3")).toBeGreaterThan(timeOf(gap, "act-2"));
    migrateToCurrent(cut, notes);
    migrateToCurrent(gap, notes);
    expect(notes).toEqual([]);
    // Positive control: a hold, a point, at the end's step still counts.
    const hold = v12();
    hold.edits.holds = [
      {
        id: "hold-1",
        marker: { actionId: "act-3", offsetMs: 0 },
        durationMs: 500,
      },
    ];
    migrateToCurrent(hold, notes);
    expect(notes).toHaveLength(1);
  });
});

describe("schema 14: click at a spot, and press", () => {
  it("migrates a v13 scene to v14 unchanged but its version", () => {
    const before = readonly();
    before.schemaVersion = 13;
    const doc = migrateToCurrent(before);
    expect(doc.schemaVersion).toBe(17);
    expect({ ...doc, schemaVersion: 0 }).toEqual({
      ...before,
      schemaVersion: 0,
    });
  });
});
