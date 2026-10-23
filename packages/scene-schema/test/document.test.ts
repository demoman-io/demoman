import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CURRENT_SCHEMA_VERSION,
  migrateToCurrent,
  SceneDocumentSchema,
  SchemaVersionError,
  sceneJsonSchema,
} from "../src/index";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8"));

// The file's valid-document builder: a fresh, independent parse of the
// read-only fixture on every call, so two callers can mutate their own
// copy without disturbing each other's.
const validDocument = () => fixture("readonly-scene.json");

const readonlyFixture = fixture("readonly-scene.json");

// A v1-shaped document: no anchor resolution.failureReason / .candidates.
// Derived from the (v2+) readonly fixture rather than hand-written, so it
// stays in lockstep with whatever else that fixture carries.
const v1Fixture = (() => {
  const v1 = structuredClone(readonlyFixture);
  v1.schemaVersion = 1;
  for (const anchor of v1.anchors) {
    delete anchor.resolution.failureReason;
    delete anchor.resolution.candidates;
  }
  return v1;
})();

describe("scene document v1", () => {
  it("parses the read-only fixture", () => {
    const doc = SceneDocumentSchema.parse(fixture("readonly-scene.json"));
    expect(doc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(doc.flags.mutating).toBe(false);
    expect(doc.meta.capture.mode).toBe("record");
    expect(doc.anchors.length).toBeGreaterThan(0);
    expect(doc.actions.length).toBeGreaterThan(0);
  });

  it("parses the mutating fixture and carries the mutation evidence", () => {
    const doc = SceneDocumentSchema.parse(fixture("mutating-scene.json"));
    expect(doc.flags.mutating).toBe(true);
    expect(
      doc.sideChannels.network.some((r) => r.classification === "mutation"),
    ).toBe(true);
  });

  it("parses the retro fixture", () => {
    const doc = SceneDocumentSchema.parse(fixture("retro-scene.json"));
    expect(doc.meta.capture.mode).toBe("retro");
    // retro-keep never captures frames, and never captures credentials
    const typed = doc.actions.filter((a) => a.kind === "type");
    expect(typed.some((a) => a.kind === "type" && a.redacted)).toBe(true);
  });

  // Downstream keys Maps by these ids — the compositor's `holdInstants` and
  // `resolvePlan` among them — and a Map keeps the last writer, so a
  // duplicate id silently lands a hold on the wrong beat. Refused here, by
  // name and position, rather than collapsed there.
  describe("id uniqueness", () => {
    const issue = (doc: unknown) => {
      const result = SceneDocumentSchema.safeParse(doc);
      expect(result.success).toBe(false);
      return result.success ? [] : result.error.issues;
    };

    it("rejects two anchors with one id", () => {
      const doc = fixture("readonly-scene.json");
      doc.anchors.push(structuredClone(doc.anchors[0]));
      const issues = issue(doc);
      expect(issues).toContainEqual(
        expect.objectContaining({
          path: ["anchors", doc.anchors.length - 1, "id"],
          message: `duplicate anchor id "${doc.anchors[0].id}"`,
        }),
      );
    });

    it("rejects two actions with one id", () => {
      const doc = fixture("readonly-scene.json");
      doc.actions.push(structuredClone(doc.actions[0]));
      expect(issue(doc)).toContainEqual(
        expect.objectContaining({
          path: ["actions", doc.actions.length - 1, "id"],
          message: `duplicate action id "${doc.actions[0].id}"`,
        }),
      );
    });

    it("rejects two camera events with one id", () => {
      const doc = fixture("readonly-scene.json");
      const event = {
        id: "cam-1",
        kind: "zoom",
        anchorId: doc.anchors[0].id,
        marker: { actionId: doc.actions[0].id, offsetMs: 0 },
        scale: 1.5,
      };
      doc.camera.push(event, structuredClone(event));
      expect(issue(doc)).toContainEqual(
        expect.objectContaining({
          path: ["camera", 1, "id"],
          message: 'duplicate camera event id "cam-1"',
        }),
      );
    });

    it("rejects two holds with one id", () => {
      const doc = fixture("readonly-scene.json");
      const hold = {
        id: "hold-1",
        marker: { actionId: doc.actions[0].id, offsetMs: 100 },
        durationMs: 800,
      };
      doc.edits.holds.push(hold, structuredClone(hold));
      expect(issue(doc)).toContainEqual(
        expect.objectContaining({
          path: ["edits", "holds", 1, "id"],
          message: 'duplicate hold id "hold-1"',
        }),
      );
    });

    it("still accepts distinct ids", () => {
      const doc = fixture("readonly-scene.json");
      doc.edits.holds.push(
        {
          id: "h-1",
          marker: { actionId: doc.actions[0].id, offsetMs: 0 },
          durationMs: 1,
        },
        {
          id: "h-2",
          marker: { actionId: doc.actions[0].id, offsetMs: 0 },
          durationMs: 1,
        },
      );
      expect(SceneDocumentSchema.safeParse(doc).success).toBe(true);
    });
  });

  it("rejects a redacted type action that still carries text", () => {
    const doc = fixture("readonly-scene.json");
    doc.actions.push({
      id: "act-bad",
      kind: "type",
      anchorId: doc.anchors[0].id,
      timestamp: 9999,
      marker: "m-bad",
      text: "hunter2",
      redacted: true,
    });
    expect(() => SceneDocumentSchema.parse(doc)).toThrow(/redacted/i);
  });

  it("rejects an action referencing an unknown anchor", () => {
    const doc = fixture("readonly-scene.json");
    doc.actions[0].anchorId = "anchor-does-not-exist";
    expect(() => SceneDocumentSchema.parse(doc)).toThrow(/unknown anchor/i);
  });

  it("every anchor fingerprint has at least one usable strategy", () => {
    const doc = fixture("readonly-scene.json");
    const a = doc.anchors[0];
    a.fingerprint = {
      stableId: null,
      role: null,
      accessibleName: null,
      textContent: null,
      treePath: null,
      boundingRect: null,
      imagePatchRef: null,
      dataKey: null,
    };
    expect(() => SceneDocumentSchema.parse(doc)).toThrow(/fingerprint/i);
  });
});

describe("the current schema version", () => {
  // The canary a version bump has to trip over: raising
  // CURRENT_SCHEMA_VERSION without adding the matching step to `migrations`
  // and a fixture to open with it fails here first. It lived under
  // "schema v4 — uncovered origins" until 2026-09-20, where its name said
  // nothing about what it guards and the next bump would have read it as
  // part of that block's subject.
  it("is 12", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(12);
  });
});

describe("schema v11 — drag", () => {
  it("validates a drag action and migrates a v10 document to v11", () => {
    const doc = validDocument();
    const start = doc.actions[0];
    doc.actions.push({
      id: "act-drag",
      kind: "drag",
      anchorId: start.anchorId,
      timestamp: start.timestamp + 1,
      marker: "m-drag",
      rect: { x: 10, y: 10, width: 40, height: 20 },
      toAnchorId: null,
      toRect: { x: 300, y: 10, width: 40, height: 20 },
      fromAt: { x: 0.5, y: 0.5 },
      to: { by: { x: 240, y: 0 } },
    });
    expect(SceneDocumentSchema.safeParse(doc).success).toBe(true);
    const v10 = { ...validDocument(), schemaVersion: 10 };
    expect(migrateToCurrent(v10).schemaVersion).toBe(12);
  });
});

describe("migrations", () => {
  it("v1 documents migrate to themselves", () => {
    const raw = fixture("readonly-scene.json");
    const doc = migrateToCurrent(raw);
    expect(doc).toEqual(SceneDocumentSchema.parse(raw));
  });

  it("refuses documents from a newer schema version", () => {
    const raw = fixture("readonly-scene.json");
    raw.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    expect(() => migrateToCurrent(raw)).toThrow(SchemaVersionError);
  });

  it("refuses documents with no schema version", () => {
    expect(() => migrateToCurrent({})).toThrow(SchemaVersionError);
  });

  // Launch B: the one refusal whose fix is updating Demoman, told apart
  // from a document that is merely broken.
  it("marks a document from a newer schema as tooNew, and a malformed one not", () => {
    const thrown = (raw: unknown): unknown => {
      try {
        migrateToCurrent(raw);
      } catch (error) {
        return error;
      }
      throw new Error("migrateToCurrent did not throw");
    };
    const newer = thrown({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
    expect(newer).toBeInstanceOf(SchemaVersionError);
    expect((newer as SchemaVersionError).tooNew).toBe(true);
    const malformed = thrown({});
    expect(malformed).toBeInstanceOf(SchemaVersionError);
    expect((malformed as SchemaVersionError).tooNew).toBe(false);
  });
});

describe("generated JSON Schema", () => {
  it("committed schema.gen.json matches the Zod source of truth", () => {
    const committed = fixture("../schema.gen.json");
    expect(committed).toEqual(sceneJsonSchema());
  });

  /**
   * The shared fixtures must already be in the shape the generated schema
   * describes — not merely in a shape Zod will repair.
   *
   * `z.toJSONSchema` runs in OUTPUT mode, where a field carrying
   * `.default()` is always present and therefore `required`. The Phoenix
   * service validates uploads against exactly that file, while every test
   * on this side validated the same fixtures with `SceneDocumentSchema
   * .parse`, which APPLIES the default and passes. Two validators, one
   * file, opposite verdicts, and nothing holding them against each other
   * — so when `edits.gaps` was added with a `.default([])` in 25c5856 the
   * fixtures silently stopped satisfying the server, and 59 Elixir tests
   * went red with a message that named the schema rather than the cause.
   *
   * Parsing and comparing catches the whole class without a JSON Schema
   * validator here: if the parse ADDS anything, a default filled it in,
   * which means the file on disk was missing something the server
   * requires.
   */
  it.each(["readonly-scene.json", "mutating-scene.json", "retro-scene.json"])(
    "%s carries every field the schema requires, unaided",
    (name) => {
      const raw = fixture(name);
      expect(SceneDocumentSchema.parse(raw)).toEqual(raw);
    },
  );
});

describe("scene document v2", () => {
  it("accepts the ambiguous strategy and a failure reason", () => {
    const doc = fixture("readonly-scene.json");
    doc.anchors[0].resolution.strategy = "ambiguous";
    doc.anchors[0].resolution.failureReason = "ambiguousTie";
    doc.anchors[0].resolution.candidates = 3;
    expect(() => SceneDocumentSchema.parse(doc)).not.toThrow();
  });

  it("rejects an unknown failure reason", () => {
    const doc = fixture("readonly-scene.json");
    doc.anchors[0].resolution.failureReason = "somethingElse";
    expect(() => SceneDocumentSchema.parse(doc)).toThrow();
  });

  it("rejects a negative candidate count", () => {
    const doc = fixture("readonly-scene.json");
    doc.anchors[0].resolution.candidates = -1;
    expect(() => SceneDocumentSchema.parse(doc)).toThrow();
  });

  it("migrates a v1 document forward, defaulting the new fields", () => {
    const v1 = fixture("readonly-scene.json");
    v1.schemaVersion = 1;
    for (const anchor of v1.anchors) {
      delete anchor.resolution.failureReason;
      delete anchor.resolution.candidates;
    }
    const migrated = migrateToCurrent(v1);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.anchors[0]?.resolution.failureReason).toBeNull();
    expect(migrated.anchors[0]?.resolution.candidates).toBe(1);
  });

  it("still refuses a document from the future", () => {
    const doc = fixture("readonly-scene.json");
    doc.schemaVersion = 99;
    expect(() => migrateToCurrent(doc)).toThrow(SchemaVersionError);
  });

  it("throws — not returns a zero-anchor v2 document — when a v1 document's anchors is not an array", () => {
    const v1 = fixture("readonly-scene.json");
    v1.schemaVersion = 1;
    v1.anchors = null;
    let caught: unknown;
    try {
      migrateToCurrent(v1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(z.ZodError);
    const issues = (caught as z.ZodError).issues;
    expect(issues.some((i) => i.path[0] === "anchors")).toBe(true);
  });

  it("throws a clean validation error, not a TypeError, when a v1 document's anchors array contains a null element", () => {
    const v1 = fixture("readonly-scene.json");
    v1.schemaVersion = 1;
    v1.anchors = [null, ...v1.anchors];
    let caught: unknown;
    try {
      migrateToCurrent(v1);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught).toBeInstanceOf(z.ZodError);
    const issues = (caught as z.ZodError).issues;
    expect(issues.some((i) => i.path[0] === "anchors" && i.path[1] === 0)).toBe(
      true,
    );
  });
});

describe("schema v3", () => {
  it("accepts a waitFor with no anchor, for a navigation wait", () => {
    const doc = structuredClone(readonlyFixture);
    doc.actions.push({
      id: "act-wait",
      anchorId: null,
      timestamp: 10,
      marker: "waitFor:document",
      kind: "waitFor",
      condition: "loaded",
    });
    expect(() => SceneDocumentSchema.parse(doc)).not.toThrow();
  });

  it("still rejects a non-waitFor action with a null anchor", () => {
    const doc = structuredClone(readonlyFixture);
    doc.actions.push({
      id: "act-bad",
      anchorId: null,
      timestamp: 10,
      marker: "click:nothing",
      kind: "click",
    });
    expect(() => SceneDocumentSchema.parse(doc)).toThrow();
  });

  it("still enforces referential integrity for non-null anchor ids", () => {
    const doc = structuredClone(readonlyFixture);
    doc.actions.push({
      id: "act-ghost",
      anchorId: "no-such-anchor",
      timestamp: 10,
      marker: "click:ghost",
      kind: "click",
    });
    expect(() => SceneDocumentSchema.parse(doc)).toThrow(/unknown anchor/);
  });

  it("migrates a v2 document forward, backfilling every new field", () => {
    const v2 = {
      ...structuredClone(readonlyFixture),
      schemaVersion: 2,
      sideChannels: {
        network: [
          {
            method: "POST",
            url: "https://app.example.com/api/orders",
            classification: "mutation",
          },
        ],
        consoleExcerpt: ["boot ok"],
        urlTrace: ["https://app.example.com/orders"],
      },
    };
    delete v2.meta.capture.buildShaSource;
    delete v2.meta.toolchain.captureVersion;

    const migrated = migrateToCurrent(v2);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.sideChannels.uncoveredOrigins).toEqual([]);
    expect(migrated.sideChannels.network[0]).toMatchObject({
      id: "net-1",
      timestamp: 0,
      reclassified: false,
    });
    expect(migrated.sideChannels.consoleExcerpt[0]).toEqual({
      level: "log",
      text: "boot ok",
      timestamp: 0,
    });
    expect(migrated.sideChannels.urlTrace[0]).toEqual({
      url: "https://app.example.com/orders",
      timestamp: 0,
    });
    expect(migrated.meta.capture.buildShaSource).toBeNull();
    expect(migrated.meta.toolchain.captureVersion).toBeNull();
  });

  it("migrates a v1 document all the way to the current version", () => {
    // The chain matters more than either step: a v1 document must still open.
    const v1 = structuredClone(v1Fixture);
    expect(migrateToCurrent(v1).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("schema v4 — uncovered origins", () => {
  it("requires uncoveredOrigins on sideChannels", () => {
    const doc = fixture("readonly-scene.json");
    const { uncoveredOrigins: _dropped, ...withoutIt } = doc.sideChannels;
    const result = SceneDocumentSchema.safeParse({
      ...doc,
      sideChannels: withoutIt,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a scene naming the origins the network log could not see", () => {
    const doc = fixture("mutating-scene.json");
    const result = SceneDocumentSchema.safeParse({
      ...doc,
      sideChannels: {
        ...doc.sideChannels,
        uncoveredOrigins: ["https://api.example.com"],
      },
    });
    expect(result.success).toBe(true);
  });

  // The honest backfill: a v3 document was written by a build that could not
  // record the gap, so it proves no gap — not an empty one it verified.
  it("migrates a v3 document by backfilling an empty list", () => {
    const v3 = fixture("readonly-scene.json");
    const migrated = migrateToCurrent({
      ...v3,
      schemaVersion: 3,
      sideChannels: {
        network: v3.sideChannels.network,
        consoleExcerpt: v3.sideChannels.consoleExcerpt,
        urlTrace: v3.sideChannels.urlTrace,
      },
    });
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.sideChannels.uncoveredOrigins).toEqual([]);
  });
});

describe("schema v4 — authored holds", () => {
  it("requires holds on edits", () => {
    const doc = fixture("readonly-scene.json");
    const { holds: _dropped, ...withoutIt } = doc.edits;
    const result = SceneDocumentSchema.safeParse({
      ...doc,
      edits: withoutIt,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a hold anchored to an action", () => {
    const doc = fixture("readonly-scene.json");
    const actionId = doc.actions[0].id;
    const result = SceneDocumentSchema.safeParse({
      ...doc,
      edits: {
        ...doc.edits,
        holds: [
          { id: "hold-1", marker: { actionId, offsetMs: 0 }, durationMs: 800 },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  // The same referential integrity camera events already get: an edit that
  // names an action nobody recorded is a corrupt document, not a warning.
  it("rejects a hold naming an action that does not exist", () => {
    const doc = fixture("readonly-scene.json");
    const result = SceneDocumentSchema.safeParse({
      ...doc,
      edits: {
        ...doc.edits,
        holds: [
          {
            id: "hold-1",
            marker: { actionId: "act-nope", offsetMs: 0 },
            durationMs: 800,
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  // A zero-length hold is a deletion, and deletion is removing the entry.
  it("rejects a non-positive duration", () => {
    const doc = fixture("readonly-scene.json");
    const actionId = doc.actions[0].id;
    for (const durationMs of [0, -100]) {
      const result = SceneDocumentSchema.safeParse({
        ...doc,
        edits: {
          ...doc.edits,
          holds: [
            { id: "hold-1", marker: { actionId, offsetMs: 0 }, durationMs },
          ],
        },
      });
      expect(result.success).toBe(false);
    }
  });

  it("migrates a v3 document by backfilling an empty list", () => {
    const v3 = fixture("readonly-scene.json");
    const { holds: _h, ...editsWithout } = v3.edits;
    const { uncoveredOrigins: _u, ...sideWithout } = v3.sideChannels;
    const migrated = migrateToCurrent({
      ...v3,
      schemaVersion: 3,
      edits: editsWithout,
      sideChannels: sideWithout,
    });
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.edits.holds).toEqual([]);
  });
});

describe("pacing gaps", () => {
  it("accepts a zero-length gap, which a hold may not be", () => {
    const doc = fixture("readonly-scene.json");
    doc.edits.gaps = [
      { id: "g1", afterActionId: doc.actions[0].id, durationMs: 0 },
    ];
    expect(() => SceneDocumentSchema.parse(doc)).not.toThrow();
  });

  it("refuses a gap after an action that does not exist", () => {
    const doc = fixture("readonly-scene.json");
    doc.edits.gaps = [
      { id: "g1", afterActionId: "no-such-action", durationMs: 500 },
    ];
    const result = SceneDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("afterActionId");
  });

  it("refuses two gaps after the same action", () => {
    const doc = fixture("readonly-scene.json");
    const id = doc.actions[0].id;
    doc.edits.gaps = [
      { id: "g1", afterActionId: id, durationMs: 500 },
      { id: "g2", afterActionId: id, durationMs: 900 },
    ];
    expect(SceneDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it("refuses two gaps sharing one id", () => {
    // Distinct from the check above, which is about two gaps on one ACTION.
    // This one guards the id namespace, and `migrateHoldsToGaps` rests on
    // it: its `claimedIds` guard cites this schema rule as the reason it
    // refuses to reuse a hold's id when a gap already has it. Untested
    // until 2026-09-08, so deleting the `unique(doc.edits.gaps, …)` call
    // would have gone unnoticed and taken that justification with it.
    const doc = fixture("readonly-scene.json");
    doc.edits.gaps = [
      { id: "g1", afterActionId: doc.actions[0].id, durationMs: 500 },
      { id: "g1", afterActionId: doc.actions[1].id, durationMs: 900 },
    ];
    const result = SceneDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("duplicate");
  });

  it("refuses a negative gap", () => {
    const doc = fixture("readonly-scene.json");
    doc.edits.gaps = [
      { id: "g1", afterActionId: doc.actions[0].id, durationMs: -1 },
    ];
    expect(SceneDocumentSchema.safeParse(doc).success).toBe(false);
  });
});

describe("schema v4 — hover signal", () => {
  it("accepts a moveTo carrying how the hover was caught", () => {
    const doc = fixture("readonly-scene.json");
    const moveTo = doc.actions.find(
      (a: { kind: string }) => a.kind === "moveTo",
    );
    moveTo.signal = "style";
    const result = SceneDocumentSchema.safeParse(doc);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Zod strips unknown keys by default, so asserting only `success` passes
    // whether or not MoveTo declares `signal` at all — deleting the field
    // from the schema would leave the input's `signal` silently stripped and
    // this test would not notice. Assert on the PARSED DATA: the field must
    // actually survive parsing, carrying the value that was on the input.
    const parsedMoveTo = result.data.actions.find((a) => a.kind === "moveTo");
    expect(parsedMoveTo).toBeDefined();
    expect(parsedMoveTo?.kind === "moveTo" && parsedMoveTo.signal).toBe(
      "style",
    );
  });

  // Backward compatibility with v4 documents written before this field
  // existed: no migration is owed, so an absent `signal` must still parse.
  it("still accepts a moveTo with no signal", () => {
    const doc = fixture("readonly-scene.json");
    const moveTo = doc.actions.find(
      (a: { kind: string }) => a.kind === "moveTo",
    );
    expect(moveTo.signal).toBeUndefined();
    const result = SceneDocumentSchema.safeParse(doc);
    expect(result.success).toBe(true);
  });
});

describe("schema v7 — authored capture mode", () => {
  it("accepts an authored capture mode, and still accepts the two older ones", () => {
    // Premise: this fixture is a complete, otherwise-valid v7 document — so a
    // refusal below is about `mode` and nothing else.
    expect(SceneDocumentSchema.safeParse(validDocument()).success).toBe(true);

    for (const mode of ["record", "retro", "authored"] as const) {
      const doc = validDocument();
      doc.meta.capture.mode = mode;
      expect(SceneDocumentSchema.safeParse(doc).success).toBe(true);
    }
  });

  it("still refuses a mode nobody defined, and stays at the current schema version", () => {
    const doc = validDocument();
    (doc.meta.capture as { mode: string }).mode = "synthesised";
    expect(SceneDocumentSchema.safeParse(doc).success).toBe(false);
    expect(CURRENT_SCHEMA_VERSION).toBe(12);
  });
});
