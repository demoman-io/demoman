import { describe, expect, it } from "vitest";
import { hexToOklch, oklchToHex, parseColor } from "../src/color";

describe("hexToOklch / oklchToHex", () => {
  // Carried from the compositor's color.test.ts, deleted with the module in
  // the v6 move: the conversions live here now.
  it("maps white to full lightness and no chroma", () => {
    const white = hexToOklch("#ffffff");
    expect(white?.l).toBeCloseTo(1, 2);
    expect(white?.c).toBeCloseTo(0, 3);
  });

  it("maps black to zero lightness", () => {
    expect(hexToOklch("#000000")?.l).toBeCloseTo(0, 3);
  });

  it("gives a saturated blue a mid lightness and real chroma", () => {
    const blue = hexToOklch("#3B5BDB");
    expect(blue?.l).toBeGreaterThan(0.3);
    expect(blue?.l).toBeLessThan(0.7);
    expect(blue?.c).toBeGreaterThan(0.1);
  });

  it("accepts shorthand hex and returns null for what it cannot parse", () => {
    expect(hexToOklch("#fff")?.l).toBeCloseTo(1, 2);
    expect(hexToOklch("cornflowerblue")).toBeNull();
    expect(hexToOklch("#12345")).toBeNull();
    expect(hexToOklch("")).toBeNull();
  });

  it("round-trips a brand colour exactly", () => {
    const oklch = hexToOklch("#3b5bdb");
    expect(oklch).not.toBeNull();
    expect(oklchToHex(oklch as NonNullable<typeof oklch>)).toEqual({
      hex: "#3b5bdb",
      clipped: false,
    });
  });

  it("converts today's neutral stops to the reference hexes", () => {
    // Computed independently on 2026-09-22; the migration's defaults are
    // these two values, so a drift here moves every unbranded demo.
    expect(oklchToHex({ l: 0.95, c: 0.005, h: 260 }).hex).toBe("#eceff2");
    expect(oklchToHex({ l: 0.86, c: 0.008, h: 260 }).hex).toBe("#ced1d6");
  });

  it("clips channel by channel on request, as Chrome's canvas does", () => {
    // The v5 -> v6 migration's mode: v5 handed the canvas this oklch() and
    // Chrome painted 218,235,255 (measured 2026-09-22), not the
    // chroma-reduced 227,235,255.
    expect(oklchToHex({ l: 0.94, c: 0.06, h: 268.038 }, "clip")).toEqual({
      hex: "#daebff",
      clipped: true,
    });
  });

  it("maps an out-of-gamut colour into sRGB and says so", () => {
    const out = oklchToHex({ l: 0.7, c: 0.4, h: 150 });
    expect(out.clipped).toBe(true);
    expect(out.hex).toBe("#00be58");
  });
});

describe("parseColor", () => {
  const hex = (input: string) => {
    const parsed = parseColor(input);
    if (!parsed.ok) throw new Error(`refused ${input}: ${parsed.reason}`);
    return parsed.hex;
  };

  it("canonicalises hex the way designers paste it", () => {
    // Review Focus 1: Figma and brand guides hand out uppercase and
    // shorthand; the stored form is one spelling.
    expect(hex("#3B5BDB")).toBe("#3b5bdb");
    expect(hex("3b5bdb")).toBe("#3b5bdb");
    expect(hex("#FFF")).toBe("#ffffff");
    expect(hex("  #0a0  ")).toBe("#00aa00");
  });

  it("reads rgb() in comma and space syntax, and percentages", () => {
    expect(hex("rgb(59, 91, 219)")).toBe("#3b5bdb");
    expect(hex("rgb(59 91 219)")).toBe("#3b5bdb");
    expect(hex("rgb(100% 0% 0%)")).toBe("#ff0000");
  });

  it("reads hsl()", () => {
    expect(hex("hsl(0, 100%, 50%)")).toBe("#ff0000");
    expect(hex("hsl(120 100% 25%)")).toBe("#008000");
  });

  it("reads hsl() saturation and lightness written without %", () => {
    // CSS Color 4 allows bare numbers here, meaning percent; Chrome accepts
    // them. Read as fractions they turned `hsl(220 50 40)` into yellow.
    expect(hex("hsl(220 50 40)")).toBe(hex("hsl(220 50% 40%)"));
    expect(hex("hsl(220, 50, 40)")).toBe(hex("hsl(220, 50%, 40%)"));
    expect(hex("hsl(220 50% 40%)")).toBe("#335599");
  });

  it("reads oklch(), with a note only when it had to clip", () => {
    const inGamut = parseColor("oklch(0.5 0.1 260)");
    expect(inGamut).toMatchObject({ ok: true, note: null });
    const clipped = parseColor("oklch(0.7 0.4 150)");
    expect(clipped).toEqual({
      ok: true,
      hex: "#00be58",
      note: "Nearest sRGB is #00be58",
    });
  });

  it("accepts an explicit alpha of 1", () => {
    expect(hex("rgb(59 91 219 / 1)")).toBe("#3b5bdb");
    expect(hex("#3b5bdbff")).toBe("#3b5bdb");
  });

  it("refuses any transparency, and says why", () => {
    for (const input of [
      "#3b5bdb80",
      "#3b58",
      "rgb(59 91 219 / 0.5)",
      "rgba(59, 91, 219, 0.5)",
    ]) {
      expect(parseColor(input)).toEqual({
        ok: false,
        reason: "Backgrounds are opaque — drop the alpha",
      });
    }
  });

  it("refuses what is not a colour, naming the input", () => {
    // The reason must carry the author's own text. A fallback that printed
    // a generic message would pass a looser assertion with or without the
    // parser — CLAUDE.md's `?? reason` shape.
    for (const input of ["rgb(59 91", "blue-ish", "#12345", ""]) {
      const parsed = parseColor(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok)
        expect(parsed.reason).toBe(`"${input.trim()}" is not a colour`);
    }
  });
});
