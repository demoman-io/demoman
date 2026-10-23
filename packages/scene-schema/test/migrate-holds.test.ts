import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SceneDocument } from "../src/index";
import {
  migrateHoldsToGaps,
  migrateToCurrent,
  SceneDocumentSchema,
} from "../src/index";

const fixture = () =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );

// act-1@500, act-2@1200, act-3@2400, act-4@2600 — act-4 is the last action.
// The recorded interval after act-1 is therefore 700ms, which is the number
// every migrated duration below is built from.
const RECORDED_AFTER_ACT_1 = 700;

type Hold = SceneDocument["edits"]["holds"][number];
type Gap = SceneDocument["edits"]["gaps"][number];

function sceneWith(holds: Hold[], gaps: Gap[] = []): SceneDocument {
  const doc = fixture();
  return SceneDocumentSchema.parse({
    ...doc,
    edits: { ...doc.edits, holds, gaps },
  });
}

describe("migrateHoldsToGaps", () => {
  it("migrates a hold at a marker into a gap that also carries the recorded interval", () => {
    // A hold ADDED its duration to whatever the take already had between the
    // two steps; a gap REPLACES that interval outright. So the faithful
    // conversion is recorded + authored, not authored alone — dropping the
    // 700ms would silently speed the demo up at exactly the beat the author
    // asked to slow down.
    const migrated = migrateHoldsToGaps(
      sceneWith([
        {
          id: "h1",
          marker: { actionId: "act-1", offsetMs: 0 },
          durationMs: 800,
        },
      ]),
    );

    expect(migrated.edits.gaps).toEqual([
      {
        id: "h1",
        afterActionId: "act-1",
        durationMs: RECORDED_AFTER_ACT_1 + 800,
      },
    ]);
    expect(migrated.edits.holds).toEqual([]);
  });

  it("leaves a mid-clip hold alone rather than relocating it", () => {
    // A non-zero offset has no gap equivalent. Moving it would move a pause
    // the author placed.
    const migrated = migrateHoldsToGaps(
      sceneWith([
        {
          id: "h1",
          marker: { actionId: "act-1", offsetMs: 350 },
          durationMs: 800,
        },
      ]),
    );

    expect(migrated.edits.gaps).toEqual([]);
    expect(migrated.edits.holds).toHaveLength(1);
  });

  it("leaves a hold on the last action alone, because no gap could carry it", () => {
    // `planScene` pairs each action with the NEXT one, so it emits no pace
    // for a terminal action. A gap there would never be read and the pause
    // would vanish with nothing said.
    const migrated = migrateHoldsToGaps(
      sceneWith([
        {
          id: "h1",
          marker: { actionId: "act-4", offsetMs: 0 },
          durationMs: 800,
        },
      ]),
    );

    expect(migrated.edits.gaps).toEqual([]);
    expect(migrated.edits.holds).toEqual([
      {
        id: "h1",
        marker: { actionId: "act-4", offsetMs: 0 },
        durationMs: 800,
      },
    ]);
  });

  it("leaves a hold alone when its action already carries a gap", () => {
    // One gap per action is a schema rule. The gap is the newer authored
    // value, so it wins; the hold stays a hold and keeps rendering through
    // `plan.holds` rather than being dropped on the floor.
    const migrated = migrateHoldsToGaps(
      sceneWith(
        [
          {
            id: "h1",
            marker: { actionId: "act-1", offsetMs: 0 },
            durationMs: 800,
          },
        ],
        [{ id: "g1", afterActionId: "act-1", durationMs: 250 }],
      ),
    );

    expect(migrated.edits.gaps).toEqual([
      { id: "g1", afterActionId: "act-1", durationMs: 250 },
    ]);
    expect(migrated.edits.holds).toHaveLength(1);
  });

  it("leaves a hold alone when its id is already a gap id", () => {
    // `migrateToCurrent` parses BEFORE this runs and never re-parses after,
    // so a duplicate gap id would not be caught here — it would surface as a
    // failed parse somewhere downstream, with nothing at this seam having
    // said anything. The hold stays a hold and keeps rendering through
    // `plan.holds`.
    const migrated = migrateHoldsToGaps(
      sceneWith(
        [
          {
            id: "shared-id",
            marker: { actionId: "act-1", offsetMs: 0 },
            durationMs: 800,
          },
        ],
        [{ id: "shared-id", afterActionId: "act-2", durationMs: 250 }],
      ),
    );

    expect(migrated.edits.gaps).toEqual([
      { id: "shared-id", afterActionId: "act-2", durationMs: 250 },
    ]);
    expect(migrated.edits.holds).toHaveLength(1);
    expect(() => SceneDocumentSchema.parse(migrated)).not.toThrow();
  });

  it("converts only the first of two offset-0 holds on one action", () => {
    // Two gaps on one action will not parse. The schema does not forbid two
    // holds there, so the second stays a hold rather than producing a
    // document that fails its next parse.
    const migrated = migrateHoldsToGaps(
      sceneWith([
        {
          id: "h1",
          marker: { actionId: "act-1", offsetMs: 0 },
          durationMs: 800,
        },
        {
          id: "h2",
          marker: { actionId: "act-1", offsetMs: 0 },
          durationMs: 100,
        },
      ]),
    );

    expect(migrated.edits.gaps).toEqual([
      {
        id: "h1",
        afterActionId: "act-1",
        durationMs: RECORDED_AFTER_ACT_1 + 800,
      },
    ]);
    expect(migrated.edits.holds.map((h) => h.id)).toEqual(["h2"]);
    expect(() => SceneDocumentSchema.parse(migrated)).not.toThrow();
  });

  it("keeps the migrated document valid", () => {
    const migrated = migrateHoldsToGaps(
      sceneWith([
        {
          id: "h1",
          marker: { actionId: "act-1", offsetMs: 0 },
          durationMs: 800,
        },
        {
          id: "h2",
          marker: { actionId: "act-2", offsetMs: 0 },
          durationMs: 100,
        },
      ]),
    );
    expect(() => SceneDocumentSchema.parse(migrated)).not.toThrow();
  });

  it("tolerates a document whose gaps field never parsed", () => {
    // The frame store casts raw IDB rows without parsing, so Zod's
    // `.default([])` never runs on that path. Absent is not empty.
    const doc = fixture();
    const raw = {
      ...doc,
      edits: { masks: [], holds: [] },
    };
    expect(() => migrateHoldsToGaps(raw as SceneDocument)).not.toThrow();
    expect(migrateHoldsToGaps(raw as SceneDocument).edits.gaps).toEqual([]);
  });

  it("runs on the way out of migrateToCurrent, the seam every reader shares", () => {
    const doc = fixture();
    const migrated = migrateToCurrent({
      ...doc,
      edits: {
        ...doc.edits,
        holds: [
          {
            id: "h1",
            marker: { actionId: "act-1", offsetMs: 0 },
            durationMs: 800,
          },
        ],
      },
    });
    expect(migrated.edits.gaps).toEqual([
      {
        id: "h1",
        afterActionId: "act-1",
        durationMs: RECORDED_AFTER_ACT_1 + 800,
      },
    ]);
    expect(migrated.edits.holds).toEqual([]);
  });
});
