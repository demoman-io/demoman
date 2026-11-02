import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/document";
import { migrateToCurrent } from "../src/migrations";

function fixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );
}

type Doc = {
  camera: Record<string, unknown>[];
  zoomsSkipped?: unknown;
  [key: string]: unknown;
};

/** The fixture as a v14 document. */
function v14(): Doc {
  return { ...(fixture() as Doc), schemaVersion: 14 };
}

/** A v15 document: one author zoom, one off skip, one asked-scale skip. */
function v15(): Doc {
  const doc = v14();
  const first = doc.camera[0];
  return {
    ...doc,
    schemaVersion: 15,
    camera: [{ ...first, source: "author", scaleSetBy: "script", scale: 2 }],
    zoomsSkipped: [
      { actionId: "act-1", reason: "off" },
      {
        actionId: "act-3",
        reason: "tooClose",
        afterActionId: "act-2",
        gapMs: 100,
        askedScale: 2,
      },
    ],
  };
}

describe("v14 -> v15: where a zoom came from", () => {
  it("migrates a v14 document untouched, guessing no source", () => {
    const old = v14();
    // Premise: there is a camera event to gain a source it must not gain.
    expect(old.camera.length).toBeGreaterThan(0);
    const migrated = migrateToCurrent(old);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(15);
    expect(migrated).toEqual({ ...old, schemaVersion: 15 });
    for (const c of migrated.camera) expect(c).not.toHaveProperty("source");
  });

  it("keeps source, scaleSetBy, an off skip and askedScale", () => {
    const doc = v15();
    // Premise: the fixture really carries what is asserted back.
    expect(doc.camera[0]?.source).toBe("author");
    const migrated = migrateToCurrent(doc);
    expect(migrated.camera[0]?.source).toBe("author");
    expect(migrated.camera[0]?.scaleSetBy).toBe("script");
    expect(migrated.zoomsSkipped).toEqual(doc.zoomsSkipped);
  });

  it("refuses an unknown source value", () => {
    const doc = v15();
    doc.camera[0] = { ...doc.camera[0], source: "robot" };
    expect(() => migrateToCurrent(doc)).toThrow();
  });

  it("refuses an off skip naming no action", () => {
    const doc = v15();
    doc.zoomsSkipped = [{ actionId: "act-nope", reason: "off" }];
    expect(() => migrateToCurrent(doc)).toThrow(/unknown action.*act-nope/);
  });
});
