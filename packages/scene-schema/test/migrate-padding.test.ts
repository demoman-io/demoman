import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRANDING_DEFAULTS,
  BrandingSchema,
  CURRENT_SCHEMA_VERSION,
} from "../src/document";
import { migrateToCurrent } from "../src/migrations";

/** The fixture as a v7 document: no `branding.padding`. */
function v7Document(): Record<string, unknown> {
  const current = JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const { padding: _padding, ...branding } = current.branding as Record<
    string,
    unknown
  >;
  return { ...current, branding, schemaVersion: 7 };
}

describe("v7 -> v8: padding", () => {
  it("gives a v7 document the 8% default and leaves the rest of its branding alone", () => {
    const v7 = v7Document();
    // Premise: the builder really removed it, or the value below would be
    // read straight off the fixture and prove nothing.
    expect(v7.branding).not.toHaveProperty("padding");
    const migrated = migrateToCurrent(v7);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.branding.padding).toBe(0.08);
    const { padding: _p, ...rest } = migrated.branding;
    expect(rest).toEqual(v7.branding);
  });

  // A v7 document never carries a padding, but a hand-edited one may: the
  // step fills an absent key and must not overwrite a present one. Red if
  // the step writes the default over the branding instead of under it.
  it("keeps a padding a v7 document already carries", () => {
    const doc: Record<string, unknown> = {
      ...v7Document(),
      branding: { ...(v7Document().branding as object), padding: 0.15 },
    };
    // Premise: this really is a v7 document, so the v7 -> v8 step runs.
    expect(doc.schemaVersion).toBe(7);
    expect(migrateToCurrent(doc).branding.padding).toBe(0.15);
  });

  it("new takes default to 12%, while a v7 document still migrates to 8%", () => {
    expect(BRANDING_DEFAULTS.padding).toBe(0.12);
    // What old documents migrate to is not the new default: unchanged.
    expect(migrateToCurrent(v7Document()).branding.padding).toBe(0.08);
  });
});

describe("BrandingSchema padding", () => {
  const base = { ...BRANDING_DEFAULTS };
  it.each([0, 0.08, 0.2])("accepts %s", (padding) => {
    expect(BrandingSchema.safeParse({ ...base, padding }).success).toBe(true);
  });
  it.each([-0.01, 0.21])("refuses %s, on padding", (padding) => {
    const parsed = BrandingSchema.safeParse({ ...base, padding });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["padding"]);
  });
  it("refuses a branding with no padding", () => {
    const { padding: _p, ...missing } = base;
    const parsed = BrandingSchema.safeParse(missing);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["padding"]);
  });
});
