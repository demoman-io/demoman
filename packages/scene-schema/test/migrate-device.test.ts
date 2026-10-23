import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/document";
import { migrateToCurrent, SchemaVersionError } from "../src/migrations";

interface Fixture {
  schemaVersion: number;
  meta: { capture: Record<string, unknown> & { viewport: unknown } };
}

const readonly = (): Fixture =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );

describe("schema 10: capture.device", () => {
  // v11 (drag, 2026-10-21) is past it.
  it("is version 10 or later", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
  });

  it("migrates a v9 take unchanged but for its version", () => {
    const current = readonly();
    // The fixture premise: the stored fixture is a current document and names
    // no device, so the v9 copy below is a desktop take.
    expect(current.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(current.meta.capture.device).toBeUndefined();
    const doc = migrateToCurrent({ ...current, schemaVersion: 9 });
    expect(doc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(doc.meta.capture.device).toBeUndefined();
    expect(doc.meta.capture.viewport).toEqual(current.meta.capture.viewport);
  });

  it("keeps a device a v10 take carries", () => {
    const device = {
      preset: "phone",
      width: 393,
      height: 852,
      mobile: true,
      touch: true,
      userAgent: "Mozilla/5.0 (iPhone; test)",
    };
    const v10 = readonly();
    v10.meta.capture.device = device;
    expect(migrateToCurrent(v10).meta.capture.device).toEqual(device);
  });

  // Red if the bump is dropped: an older build would otherwise parse a phone
  // take and rebuild it on the desktop.
  it("refuses a document from a newer build", () => {
    expect(() =>
      migrateToCurrent({
        ...readonly(),
        schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      }),
    ).toThrow(SchemaVersionError);
  });
});
