import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BackgroundSchema,
  BRANDING_DEFAULTS,
  DEFAULT_WALLPAPER_BLUR,
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

  it("a wallpaper or image takes an optional blur from 0 to 1", () => {
    for (const bg of [
      { kind: "wallpaper", id: "vivid-3", blur: 0 },
      { kind: "wallpaper", id: "vivid-3", blur: 1 },
      { kind: "image", ref: "assets/x.webp", blur: 0.25 },
    ]) {
      expect(BackgroundSchema.parse(bg)).toEqual(bg);
    }
    for (const blur of [1.2, -0.1]) {
      expect(
        BackgroundSchema.safeParse({ kind: "wallpaper", id: "vivid-3", blur })
          .success,
        `blur ${blur}`,
      ).toBe(false);
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
      blur: DEFAULT_WALLPAPER_BLUR,
    });
    expect(DEFAULT_WALLPAPER_BLUR).toBe(0);
    expect(wallpaperInfo("vivid-1")?.family).toBe("vivid");
  });

  it("the set is six vivid, two light, two dark, four muted with unique ids", () => {
    const counts = { vivid: 0, light: 0, dark: 0, muted: 0 };
    for (const w of WALLPAPERS) counts[w.family]++;
    expect(counts).toEqual({ vivid: 6, light: 2, dark: 2, muted: 4 });
    expect(new Set(WALLPAPERS.map((w) => w.id)).size).toBe(14);
  });

  const scriptOn = (id: string, blur?: number) => ({
    scriptVersion: 1,
    name: "demo",
    target: "https://app.example.com/",
    steps: [{ do: "click", on: { stableId: "go" } }],
    look: {
      branding: {
        background: {
          kind: "wallpaper",
          id,
          ...(blur === undefined ? {} : { blur }),
        },
        logo: null,
      },
    },
  });

  // The positive control for the refusal below: the same script on a known
  // id parses, so that refusal is the id's and not the script's.
  it("a script naming a known wallpaper parses, keeping it", () => {
    const result = DemoScriptSchema.safeParse(scriptOn("vivid-1"));
    expect(result.error?.issues).toBeUndefined();
    expect(result.data?.look?.branding?.background).toEqual({
      kind: "wallpaper",
      id: "vivid-1",
    });
  });

  it("a script's wallpaper keeps its blur", () => {
    const result = DemoScriptSchema.safeParse(scriptOn("vivid-2", 0.3));
    expect(result.error?.issues).toBeUndefined();
    expect(result.data?.look?.branding?.background).toEqual({
      kind: "wallpaper",
      id: "vivid-2",
      blur: 0.3,
    });
  });

  it("a script naming an unknown wallpaper is refused, naming the ids", () => {
    const result = DemoScriptSchema.safeParse(scriptOn("vivid-99"));
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
