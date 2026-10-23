/**
 * Colour conversion and parsing for branding. Here, at the bottom of the
 * package graph, because the v5 -> v6 migration needs OKLCh -> hex and runs
 * inside this package; the editor's colour field uses the same parser, so
 * what the author pastes and what a migrated document holds are converted
 * by one implementation.
 */

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

type Rgb = [number, number, number];

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function expandHex(body: string): string {
  return body.length <= 4
    ? body
        .split("")
        .map((ch) => ch + ch)
        .join("")
    : body;
}

const toLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const toGamma = (v: number): number =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * sRGB -> OKLab -> OKLCh. Hue in degrees, [0, 360).
 */
export function hexToOklch(hex: string): Oklch | null {
  const match = HEX.exec(hex.trim());
  if (!match) return null;
  const full = expandHex(match[1] as string);
  if (full.length !== 6) return null;
  const [r, g, b] = [0, 2, 4].map((i) =>
    toLinear(Number.parseInt(full.slice(i, i + 2), 16) / 255),
  ) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const labL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const labA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    l: labL,
    c: Math.hypot(labA, labB),
    h: ((Math.atan2(labB, labA) * 180) / Math.PI + 360) % 360,
  };
}

function oklchToLinear({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: Rgb): boolean =>
  rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

/**
 * OKLCh -> sRGB hex, in one of two gamut modes for a colour sRGB cannot hold:
 *
 * - `"chroma"` (the default) reduces chroma at the same lightness and hue
 *   until the colour fits — the CSS Color 4 direction, and what "nearest
 *   sRGB" means in the colour field's note.
 * - `"clip"` clamps each linear channel to [0, 1], which is what Chrome's
 *   canvas does with an out-of-gamut `oklch()` fill. The v5 -> v6 migration
 *   uses it, because what it must preserve is what v5 actually painted.
 */
export function oklchToHex(
  color: Oklch,
  gamut: "chroma" | "clip" = "chroma",
): { hex: string; clipped: boolean } {
  let linear = oklchToLinear(color);
  const clipped = !inGamut(linear);
  if (clipped && gamut === "chroma") {
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...color, c: mid }))) lo = mid;
      else hi = mid;
    }
    linear = oklchToLinear({ ...color, c: lo });
  }
  return {
    hex: rgbToHex(
      linear.map((v) => toGamma(Math.min(1, Math.max(0, v)))) as Rgb,
    ),
    clipped,
  };
}

export type ParsedColor =
  | { ok: true; hex: string; note: string | null }
  | { ok: false; reason: string };

const OPAQUE_ONLY: ParsedColor = {
  ok: false,
  reason: "Backgrounds are opaque — drop the alpha",
};

/** A number, or a percentage of `full`. */
function channel(token: string, full: number): number | null {
  const pct = /^(-?\d*\.?\d+)%$/.exec(token);
  if (pct) return (Number(pct[1]) / 100) * full;
  return /^-?\d*\.?\d+$/.test(token) ? Number(token) : null;
}

/** `name(a b c / alpha)` or `name(a, b, c, alpha)` -> its parts, or null. */
function functional(
  input: string,
): { name: string; parts: string[]; alpha: string | null } | null {
  const match = /^([a-z]+)\(\s*(.*)\s*\)$/i.exec(input);
  if (!match) return null;
  const name = (match[1] as string).toLowerCase();
  const body = match[2] as string;
  const [main, slashAlpha] = body.split("/").map((s) => s.trim());
  const parts = (main as string).split(/[\s,]+/).filter(Boolean);
  if (slashAlpha !== undefined) {
    return parts.length === 3 ? { name, parts, alpha: slashAlpha } : null;
  }
  if (parts.length === 4)
    return { name, parts: parts.slice(0, 3), alpha: parts[3] as string };
  return parts.length === 3 ? { name, parts, alpha: null } : null;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/**
 * What the author typed, as a stored brand colour, or the reason it is not
 * one. Accepts hex (3, 4, 6, 8 digits, `#` optional), rgb()/rgba(),
 * hsl()/hsla() and oklch(), in comma and space syntax. Any alpha other
 * than 1 is refused: a background is opaque, and storing an alpha the
 * painter ignores would be a value that silently does nothing.
 */
export function parseColor(input: string): ParsedColor {
  const text = input.trim();
  const notAColour: ParsedColor = {
    ok: false,
    reason: `"${text}" is not a colour`,
  };

  const hexMatch = HEX.exec(text);
  if (hexMatch) {
    const full = expandHex(hexMatch[1] as string).toLowerCase();
    if (full.length === 8) {
      if (full.slice(6) !== "ff") return OPAQUE_ONLY;
      return { ok: true, hex: `#${full.slice(0, 6)}`, note: null };
    }
    return { ok: true, hex: `#${full}`, note: null };
  }

  const fn = functional(text);
  if (!fn) return notAColour;
  if (fn.alpha !== null) {
    const alpha = channel(fn.alpha, 1);
    if (alpha === null) return notAColour;
    if (alpha !== 1) return OPAQUE_ONLY;
  }

  if (fn.name === "rgb" || fn.name === "rgba") {
    const rgb = fn.parts.map((p) => channel(p, 255));
    if (rgb.some((v) => v === null)) return notAColour;
    return {
      ok: true,
      hex: rgbToHex(rgb.map((v) => (v as number) / 255) as Rgb),
      note: null,
    };
  }
  if (fn.name === "hsl" || fn.name === "hsla") {
    const h = channel((fn.parts[0] as string).replace(/deg$/, ""), 360);
    // Saturation and lightness are percentages whether or not they carry
    // the `%`: CSS Color 4 allows `hsl(220 50 40)`, and read as fractions
    // that painted yellow.
    const pct = (token: string): number | null =>
      token.endsWith("%")
        ? channel(token, 1)
        : ((v) => (v === null ? null : v / 100))(channel(token, 1));
    const s = pct(fn.parts[1] as string);
    const l = pct(fn.parts[2] as string);
    if (h === null || s === null || l === null) return notAColour;
    return {
      ok: true,
      hex: rgbToHex(hslToRgb(((h % 360) + 360) % 360, s, l)),
      note: null,
    };
  }
  if (fn.name === "oklch") {
    const l = channel(fn.parts[0] as string, 1);
    const c = channel(fn.parts[1] as string, 0.4);
    const h = channel((fn.parts[2] as string).replace(/deg$/, ""), 360);
    if (l === null || c === null || h === null) return notAColour;
    const out = oklchToHex({ l, c, h });
    return {
      ok: true,
      hex: out.hex,
      note: out.clipped ? `Nearest sRGB is ${out.hex}` : null,
    };
  }
  return notAColour;
}
