import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SceneDocumentSchema } from "../src/index";

const fixture = () =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );

// Ids are read off the fixture rather than typed here, so this file follows
// the fixture if it is ever renamed instead of failing on a stale literal.
const base = SceneDocumentSchema.parse(fixture());
const actionId = base.actions[0]?.id ?? "";
const laterActionId = base.actions[base.actions.length - 1]?.id ?? "";
const anchorId = base.anchors[0]?.id ?? "";

const issuesAt = (doc: unknown): string[] => {
  const result = SceneDocumentSchema.safeParse(doc);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};

describe("camera event targets", () => {
  it("accepts a point target with no anchor", () => {
    const doc = {
      ...base,
      camera: [
        {
          id: "cam-p",
          kind: "zoom",
          point: { x: 100, y: 200 },
          marker: { actionId, offsetMs: -350 },
          scale: 1.8,
        },
      ],
    };
    expect(issuesAt(doc)).toEqual([]);
  });

  it("refuses an event with both an anchor and a point, naming anchorId", () => {
    const doc = {
      ...base,
      camera: [
        {
          id: "cam-both",
          kind: "zoom",
          anchorId,
          point: { x: 1, y: 1 },
          marker: { actionId, offsetMs: 0 },
          scale: 1.8,
        },
      ],
    };
    expect(issuesAt(doc)).toContain("camera.0.anchorId");
  });

  it("refuses an event with neither", () => {
    const doc = {
      ...base,
      camera: [
        {
          id: "cam-none",
          kind: "zoom",
          marker: { actionId, offsetMs: 0 },
          scale: 1.8,
        },
      ],
    };
    expect(issuesAt(doc)).toContain("camera.0.anchorId");
  });

  it("refuses an authored end naming an unknown action, at its own path", () => {
    const doc = {
      ...base,
      camera: [
        {
          id: "cam-end",
          kind: "zoom",
          anchorId,
          marker: { actionId, offsetMs: 0 },
          end: { actionId: "nope", offsetMs: 0 },
          scale: 1.8,
        },
      ],
    };
    expect(issuesAt(doc)).toContain("camera.0.end.actionId");
  });
});

describe("mask ranges", () => {
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  it("accepts a mask with no range (whole take) and one with both ends", () => {
    const doc = {
      ...base,
      edits: {
        ...base.edits,
        masks: [
          { id: "m-whole", rect },
          {
            id: "m-range",
            rect,
            start: { actionId, offsetMs: 0 },
            end: { actionId: laterActionId, offsetMs: 500 },
          },
        ],
      },
    };
    expect(issuesAt(doc)).toEqual([]);
  });

  it("refuses a start without an end, naming the missing side", () => {
    const doc = {
      ...base,
      edits: {
        ...base.edits,
        masks: [{ id: "m-half", rect, start: { actionId, offsetMs: 0 } }],
      },
    };
    expect(issuesAt(doc)).toContain("edits.masks.0.end");
  });

  it("refuses a zero-length range on one step", () => {
    const doc = {
      ...base,
      edits: {
        ...base.edits,
        masks: [
          {
            id: "m-zero",
            rect,
            start: { actionId, offsetMs: 100 },
            end: { actionId, offsetMs: 100 },
          },
        ],
      },
    };
    expect(issuesAt(doc)).toContain("edits.masks.0.end");
  });
});

describe("trim", () => {
  it("accepts a head-only trim and refuses one naming an unknown action", () => {
    const ok = {
      ...base,
      edits: { ...base.edits, trim: { head: { actionId, offsetMs: 250 } } },
    };
    expect(issuesAt(ok)).toEqual([]);
    const bad = {
      ...base,
      edits: {
        ...base.edits,
        trim: { tail: { actionId: "nope", offsetMs: 0 } },
      },
    };
    expect(issuesAt(bad)).toContain("edits.trim.tail.actionId");
  });

  // F7: this used to be `expect(SceneDocumentSchema.parse(fixture())).toEqual(base)`
  // — comparing one parse of the fixture to `base`, which line 16 defines as
  // ANOTHER parse of the very same fixture. That can only fail if `.parse`
  // is non-deterministic; a schema change that adds `.default(...)` to
  // `edits.trim`, a mask's `start`/`end`, or a camera event's
  // `point`/`end`/`note` would make the new field appear on BOTH sides
  // identically and this would stay green. Asserting the fixture's own
  // absence of each field is the version that would actually catch that
  // production change: add a default anywhere in that list and exactly one
  // of these lines goes red.
  it("leaves the pre-spec fixture's new fields absent rather than defaulted", () => {
    expect(base.edits.trim).toBeUndefined();
    for (const mask of base.edits.masks) {
      expect(mask).not.toHaveProperty("start");
      expect(mask).not.toHaveProperty("end");
    }
    for (const event of base.camera) {
      expect(event).not.toHaveProperty("point");
      expect(event).not.toHaveProperty("end");
      expect(event).not.toHaveProperty("note");
    }
  });
});

// Review 2026-10-22: splits and removed pieces name steps too, and were the
// only marker-like fields the schema did not check.
describe("splits and removed pieces", () => {
  const at = (id: string) => ({ actionId: id, sourceOffsetMs: 0 });
  it("accepts ones that name the take's own steps", () => {
    const ok = {
      ...base,
      edits: {
        ...base.edits,
        splits: [{ id: "s1", at: at(actionId) }],
        removed: [{ id: "r1", start: at(actionId), end: null }],
      },
    };
    expect(issuesAt(ok)).toEqual([]);
  });
  it("refuses ones naming an unknown action, at their own paths", () => {
    const bad = {
      ...base,
      edits: {
        ...base.edits,
        splits: [{ id: "s1", at: at("nope") }],
        removed: [
          { id: "r1", start: at("nope"), end: at(laterActionId) },
          { id: "r2", start: at(actionId), end: at("nope") },
        ],
      },
    };
    expect(issuesAt(bad)).toEqual([
      "edits.splits.0.at.actionId",
      "edits.removed.0.start.actionId",
      "edits.removed.1.end.actionId",
    ]);
  });
});
