import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANVAS_DEFAULTS,
  CURRENT_SCHEMA_VERSION,
  SCENE_ASPECTS,
  SceneDocumentSchema,
} from "../src/document";
import { migrateToCurrent } from "../src/migrations";

/** The fixture as a v8 document with the given aspect. */
function v8Document(aspect: string): Record<string, unknown> {
  const current = JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  return { ...current, schemaVersion: 8, canvas: { aspect } };
}

describe("v8 -> v9: auto", () => {
  // Red if the step rewrites existing demos to the new default: every
  // demo already exported would change shape on its next export.
  it.each(["16:9", "9:16"])("keeps a v8 document's %s", (aspect) => {
    const migrated = migrateToCurrent(v8Document(aspect));
    // v10 (devices), v11 (drag), v12 (removed pieces) and v13 (mask ends in
    // source time) are past this step; the aspect survives them.
    expect(CURRENT_SCHEMA_VERSION).toBe(14);
    expect(migrated.schemaVersion).toBe(14);
    expect(migrated.canvas.aspect).toBe(aspect);
  });

  it("offers auto first, and starts new takes on it", () => {
    expect(SCENE_ASPECTS).toEqual(["auto", "16:9", "9:16"]);
    expect(CANVAS_DEFAULTS).toEqual({ aspect: "auto" });
  });

  it("accepts an auto document and refuses a shape nobody offers", () => {
    const doc = {
      ...v8Document("auto"),
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };
    expect(SceneDocumentSchema.safeParse(doc).success).toBe(true);
    const odd = {
      ...v8Document("4:3"),
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };
    expect(SceneDocumentSchema.safeParse(odd).success).toBe(false);
  });
});
