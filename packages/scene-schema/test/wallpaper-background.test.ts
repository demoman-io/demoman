import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BackgroundSchema,
  BRANDING_DEFAULTS,
  NEUTRAL_BACKGROUND,
} from "../src/document";
import { migrateToCurrent } from "../src/migrations";
import { DemoScriptSchema } from "../src/script";
import { WALLPAPERS, wallpaperInfo } from "../src/wallpapers";

describe("wallpaper and image backgrounds", () => {
  it("parses a wallpaper and an image background", () => {
    for (const bg of [
      { kind: "wallpaper", id: "vivid-3" },
      { kind: "image", ref: "assets/x.webp" },
    ]) {
      expect(BackgroundSchema.parse(bg)).toEqual(bg);
    }
  });

  it("refuses a wallpaper id with a path in it", () => {
    expect(
      BackgroundSchema.safeParse({ kind: "wallpaper", id: "../x" }).success,
    ).toBe(false);
  });

  it("new takes default to the vivid wallpaper", () => {
    expect(BRANDING_DEFAULTS.background).toEqual({
      kind: "wallpaper",
      id: "vivid-1",
    });
    expect(wallpaperInfo("vivid-1")?.family).toBe("vivid");
  });

  it("the set is six vivid, two light, two dark with unique ids", () => {
    const counts = { vivid: 0, light: 0, dark: 0 };
    for (const w of WALLPAPERS) counts[w.family]++;
    expect(counts).toEqual({ vivid: 6, light: 2, dark: 2 });
    expect(new Set(WALLPAPERS.map((w) => w.id)).size).toBe(10);
  });

  it("a script naming an unknown wallpaper is refused, naming the ids", () => {
    const result = DemoScriptSchema.safeParse({
      scriptVersion: 1,
      name: "demo",
      target: "https://app.example.com/",
      steps: [{ do: "click", on: { stableId: "go" } }],
      look: {
        branding: {
          background: { kind: "wallpaper", id: "vivid-99" },
          logo: null,
        },
      },
    });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((i) => i.message).join("\n");
    expect(messages).toContain("vivid-99");
    expect(messages).toContain("vivid-1");
  });

  it("a v5 document with no colour still migrates to the neutral gradient", () => {
    const current = JSON.parse(
      readFileSync(
        join(__dirname, "..", "fixtures", "readonly-scene.json"),
        "utf8",
      ),
    );
    const migrated = migrateToCurrent({
      ...current,
      schemaVersion: 5,
      branding: { logoRef: null, primaryColor: null },
    });
    expect(migrated.branding.background).toEqual(NEUTRAL_BACKGROUND);
    expect(NEUTRAL_BACKGROUND.kind).toBe("gradient");
  });
});
