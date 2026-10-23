import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/document";
import { migrateToCurrent } from "../src/migrations";

/** The v4 fixture as it stood before this feature: no `cursor` block. */
function v4Document(): Record<string, unknown> {
  const current = JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const { cursor: _dropped, ...rest } = current;
  return { ...rest, schemaVersion: 4 };
}

describe("v4 -> v5: the cursor block", () => {
  it("backfills the product defaults, motion blur at max", () => {
    const migrated = migrateToCurrent(v4Document());
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.cursor).toEqual({
      hidden: false,
      style: "light",
      scale: 1,
      motionBlur: 1,
      hideWhenIdle: false,
    });
  });

  it("leaves a cursor block a v5 document already carries alone", () => {
    const authored = {
      hidden: true,
      style: "touch" as const,
      scale: 1.75,
      motionBlur: 0.25,
      hideWhenIdle: true,
    };
    const doc = { ...v4Document(), schemaVersion: 5, cursor: authored };
    expect(migrateToCurrent(doc).cursor).toEqual(authored);
  });

  it("refuses a scale outside the slider's range", () => {
    const doc = {
      ...v4Document(),
      schemaVersion: 5,
      cursor: {
        ...{
          hidden: false,
          style: "light",
          motionBlur: 1,
          hideWhenIdle: false,
        },
        scale: 4,
      },
    };
    expect(() => migrateToCurrent(doc)).toThrow();
  });
});
