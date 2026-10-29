import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRANDING_DEFAULTS,
  BrandingSchema,
  CURRENT_SCHEMA_VERSION,
  NEUTRAL_BACKGROUND,
  SceneDocumentSchema,
} from "../src/document";
import { migrateToCurrent } from "../src/migrations";

/** The v5 fixture as it stood before this feature: the old branding pair. */
function v5Document(branding: {
  logoRef: string | null;
  primaryColor: string | null;
}) {
  const current = JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  return { ...current, schemaVersion: 5, branding };
}

describe("v5 -> v6: branding becomes a background and a placed logo", () => {
  it("turns a set colour into the gradient today's tint derives", () => {
    const doc = v5Document({ logoRef: null, primaryColor: "#3B5BDB" });
    // Premise: the fixture carries a colour, or the case below tests the
    // neutral path twice.
    expect(doc.branding.primaryColor).toBe("#3B5BDB");
    const migrated = migrateToCurrent(doc);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    // v5's lighter stop, oklch(0.94 0.06 268), is outside sRGB. Chrome's
    // canvas clipped it channel by channel and painted 218,235,255 — measured
    // in the compositor's browser lane on 2026-09-22. The migration keeps what
    // was painted, so it clips the same way rather than reducing chroma.
    expect(migrated.branding).toEqual({
      background: {
        kind: "gradient",
        from: "#daebff",
        to: "#a8c2ff",
        angle: 150,
      },
      logo: null,
      padding: 0.08,
    });
  });

  it("turns no colour into today's neutral, which is BRANDING_DEFAULTS", () => {
    const migrated = migrateToCurrent(
      v5Document({ logoRef: null, primaryColor: null }),
    );
    expect(migrated.branding).toEqual({
      background: {
        kind: "gradient",
        from: "#eceff2",
        to: "#ced1d6",
        angle: 150,
      },
      logo: null,
      padding: 0.08,
    });
    // Today's defaults but the padding: v7 -> v8 wrote 8%, and what old
    // documents migrate to stays put when the default moves (12%, 2026-10-28).
    expect(migrated.branding).toEqual({
      ...BRANDING_DEFAULTS,
      background: NEUTRAL_BACKGROUND,
      padding: 0.08,
    });
  });

  it("keeps a logo where and how today's watermark draws it", () => {
    const doc = v5Document({ logoRef: "logo:abc", primaryColor: null });
    expect(doc.branding.logoRef).toBe("logo:abc");
    expect(migrateToCurrent(doc).branding.logo).toEqual({
      ref: "logo:abc",
      corner: "bottom-right",
      size: 0.03,
      opacity: 0.9,
    });
  });

  it("migrates an unparseable v5 colour to the neutral rather than refusing the take", () => {
    // v5 accepted any non-empty string, and `rgb(...)` painted the neutral.
    // The migration keeps that picture; refusing would lose a take over a
    // value the old build already ignored.
    const migrated = migrateToCurrent(
      v5Document({ logoRef: null, primaryColor: "rgb(1,2,3)" }),
    );
    expect(migrated.branding.background).toEqual(NEUTRAL_BACKGROUND);
  });

  it("migrates both at once", () => {
    const migrated = migrateToCurrent(
      v5Document({ logoRef: "logo:x", primaryColor: "#3b5bdb" }),
    );
    expect(migrated.branding.background).toMatchObject({
      kind: "gradient",
      from: "#daebff",
    });
    expect(migrated.branding.logo?.ref).toBe("logo:x");
  });
});

describe("BrandingSchema", () => {
  const ok = {
    background: { kind: "solid", color: "#1b2a4a" },
    logo: null,
    padding: 0.08,
  };

  it("accepts a solid and a gradient", () => {
    expect(BrandingSchema.safeParse(ok).success).toBe(true);
    expect(
      BrandingSchema.safeParse({
        background: {
          kind: "gradient",
          from: "#000000",
          to: "#ffffff",
          angle: 0,
        },
        logo: null,
        padding: 0.08,
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      "uppercase hex",
      { ...ok, background: { kind: "solid", color: "#1B2A4A" } },
    ],
    [
      "a css function",
      { ...ok, background: { kind: "solid", color: "rgb(1,2,3)" } },
    ],
    [
      "angle 360",
      {
        ...ok,
        background: {
          kind: "gradient",
          from: "#000000",
          to: "#ffffff",
          angle: 360,
        },
      },
    ],
    [
      "fractional angle",
      {
        ...ok,
        background: {
          kind: "gradient",
          from: "#000000",
          to: "#ffffff",
          angle: 1.5,
        },
      },
    ],
    [
      "logo too large",
      {
        ...ok,
        logo: { ref: "logo:a", corner: "top-left", size: 0.3, opacity: 1 },
      },
    ],
    [
      "logo too faint",
      {
        ...ok,
        logo: { ref: "logo:a", corner: "top-left", size: 0.05, opacity: 0.1 },
      },
    ],
    [
      "unknown corner",
      {
        ...ok,
        logo: { ref: "logo:a", corner: "middle", size: 0.05, opacity: 1 },
      },
    ],
  ])("refuses %s", (_label, value) => {
    expect(BrandingSchema.safeParse(value).success).toBe(false);
  });

  it("is the schema the document validates branding with", () => {
    // The kit (Task 8) and a demo must be checked by the same object, or
    // they drift. `SceneDocumentSchema.shape.branding` is that object.
    expect(SceneDocumentSchema.shape.branding).toBe(BrandingSchema);
  });
});
