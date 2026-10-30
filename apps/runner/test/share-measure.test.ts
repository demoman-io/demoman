import { LANDSCAPE_1080P, VERTICAL_1080 } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import {
  densestRect,
  encoderCheck,
  bppGridFor,
  expectedEncoder,
  gridFor,
  pickInstants,
  qualityGridFor,
  scaleRect,
  strongEdgeShare,
  TEXT_EDGE_FLOOR,
} from "../src/compare/share-measure";
import { bitsPerPixel, pageHtml, sortedBySize } from "../src/compare/share-page";

const SOFT_Q = '{"quality":0.5,"hardwareAcceleration":"prefer-software"}';

describe("share-measure's pure parts", () => {
  it("text clears the edge floor; a border, a ramp and a flat patch do not", () => {
    const w = 120;
    const h = 40;
    const mk = (f: (x: number, y: number) => number) =>
      Uint8Array.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w)));
    // Glyph-like: 2px strokes, a gap, rows of them.
    const text = mk((x, y) =>
      (x % 5 < 2 && y % 8 < 5) || y % 8 === 7 ? 30 : 235,
    );
    // One dark border line down a light patch.
    const border = mk((x) => (x === 60 ? 20 : 235));
    // A smooth ramp, 0..235 across the width: no step reaches the floor.
    const ramp = mk((x) => Math.round((x / w) * 235));
    const flat = mk(() => 200);
    // The fixtures' claims: text and border are two-level, the ramp spans,
    // the flat patch is one level.
    expect(new Set(text).size).toBe(2);
    expect(new Set(border).size).toBe(2);
    expect(Math.max(...ramp) - Math.min(...ramp)).toBeGreaterThan(200);
    expect(new Set(flat).size).toBe(1);
    expect(strongEdgeShare(text, w)).toBeGreaterThan(TEXT_EDGE_FLOOR);
    expect(strongEdgeShare(border, w)).toBeLessThan(TEXT_EDGE_FLOOR);
    expect(strongEdgeShare(ramp, w)).toBeLessThan(TEXT_EDGE_FLOOR);
    expect(strongEdgeShare(flat, w)).toBeLessThan(TEXT_EDGE_FLOOR);
  });

  it("reports the encoder the sink should say it used", () => {
    // A spec that names no encoder gets render-entry's software pin.
    expect(expectedEncoder(undefined, 5_000_000)).toEqual({
      bitrate: 5_000_000,
      hardwareAcceleration: "prefer-software",
    });
    expect(
      expectedEncoder(
        { quality: 0.5, hardwareAcceleration: "prefer-software" },
        1,
      ),
    ).toEqual({ quality: 0.5, hardwareAcceleration: "prefer-software" });
  });

  // Red if a quality that fell back to a bitrate reads as a quantizer, or
  // the sink's record is taken as "as asked" with the rate control in it.
  it("says what rate control the encoder ran, apart from what was asked", () => {
    const want = expectedEncoder({ quality: 0.5 }, 1);
    expect(
      encoderCheck(
        {
          quality: 0.5,
          hardwareAcceleration: "prefer-software",
          rateControl: "quantizer",
        },
        want,
      ),
    ).toEqual({ text: SOFT_Q, ok: true, rateControl: "quantizer" });
    expect(
      encoderCheck(
        {
          quality: 0.5,
          hardwareAcceleration: "prefer-software",
          rateControl: "bitrate 3225600",
        },
        want,
      ),
    ).toEqual({
      text: SOFT_Q,
      ok: true,
      rateControl: "bitrate 3225600",
    });
    expect(
      encoderCheck(
        { quality: 0.5, hardwareAcceleration: "prefer-software" },
        want,
      ),
    ).toMatchObject({
      ok: false,
      rateControl: "NOT REPORTED",
    });
    expect(encoderCheck({ bitrate: 9 }, want).ok).toBe(false);
    expect(encoderCheck(undefined, want)).toMatchObject({ ok: false });
  });

  it("finds the busy window, not the flat ground, and scales it", () => {
    // A 200x120 grey frame, flat 128 except a striped 40x12 patch at (130,90).
    const width = 200;
    const height = 120;
    const data = new Uint8Array(width * height).fill(128);
    for (let y = 90; y < 102; y++)
      for (let x = 130; x < 170; x++)
        data[y * width + x] = x % 2 === 0 ? 20 : 240;
    // The fixture claims a striped patch on a flat ground.
    expect(new Set(data).size).toBe(3);
    const r = densestRect({ width, height, data });
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    expect(cx).toBeGreaterThan(110);
    expect(cx).toBeLessThan(190);
    expect(cy).toBeGreaterThan(80);
    expect(cy).toBeLessThan(110);
    const big = scaleRect(
      { x: 100, y: 60, width: 20, height: 10 },
      { width: 200, height: 120 },
      { width: 400, height: 240 },
    );
    expect(big).toEqual({ x: 200, y: 120, width: 40, height: 20 });
  });

  it("picks the quietest frame after the first half second and the loudest move", () => {
    const frame = (v: number) => new Uint8Array(16).fill(v);
    // 14 frames: 0-2 flat 10 (quiet, but inside the first half second);
    // 3-4 noisy; 5-9 flat 90 (the quiet hold); 10 jumps to 250; 11-13 drift.
    const levels = [10, 10, 10, 60, 20, 90, 90, 90, 90, 90, 250, 240, 230, 220];
    const frames = levels.map(frame);
    const got = pickInstants(frames);
    // The first quietest frame at or after index 5 is the 6th (5/10 s);
    // frames 1 and 2 are quieter than frame 3 but before the cut-off.
    expect(got.stillSec).toBe(0.6);
    expect(got.moveSec).toBe(1);
  });

  it("the grid has the bottom of the ladder, and no render twice", () => {
    const today = {
      name: "today",
      target: { ...LANDSCAPE_1080P, width: 3840, height: 2160 },
    };
    const mid = {
      name: "1440p",
      target: { ...LANDSCAPE_1080P, width: 2560, height: 1440 },
    };
    const small = { name: "1080p", target: LANDSCAPE_1080P };
    const key = (s: ReturnType<typeof gridFor>[number]) =>
      `${s.target.width}|${s.fps}|${s.mult}|${s.encoderLabel}`;
    const three = gridFor([today, mid, small]);
    expect(new Set(three.map(key)).size).toBe(three.length);
    const has = (w: number, fps: number, mult: number | null, enc: string) =>
      three.some((s) => key(s) === `${w}|${fps}|${mult}|${enc}`);
    expect(has(1920, 30, 0.25, "default")).toBe(true);
    expect(has(1920, 60, 0.5, "default")).toBe(true);
    expect(has(1920, 60, 0.35, "default")).toBe(true);
    expect(has(2560, 30, 0.5, "software")).toBe(true);
    expect(has(2560, 30, null, "q0.5")).toBe(true);
    expect(three.some((s) => s.encoder?.quality === 0.35)).toBe(true);
    // Two frames: mid collides with small, and every such row appears once.
    const two = gridFor([today, small]);
    expect(new Set(two.map(key)).size).toBe(two.length);
    expect(two.filter((s) => key(s) === "1920|30|0.5|default")).toHaveLength(1);
    expect(two.length).toBeLessThan(three.length);
    expect(VERTICAL_1080.width).toBe(1080);
  });

  it("--qualities renders the share frame at 30 fps, once per quality", () => {
    const today = {
      name: "today",
      target: { ...LANDSCAPE_1080P, width: 3840, height: 2160 },
    };
    const small = { name: "1080p", target: LANDSCAPE_1080P };
    const got = qualityGridFor([today, small], [0.5, 0.6]);
    expect(
      got.map((s) => [s.target.width, s.fps, s.mult, s.encoder?.quality]),
    ).toEqual([
      [1920, 30, null, 0.5],
      [1920, 30, null, 0.6],
    ]);
  });

  it("--qualities renders every frame below today's, never today's", () => {
    const today = {
      name: "today",
      target: { ...LANDSCAPE_1080P, width: 3840, height: 2160 },
    };
    const mid = {
      name: "1440p",
      target: { ...LANDSCAPE_1080P, width: 2560, height: 1440 },
    };
    const small = { name: "1080p", target: LANDSCAPE_1080P };
    const got = qualityGridFor([today, mid, small], [0.5]);
    expect(got.map((s) => [s.target.width, s.encoder?.quality])).toEqual([
      [2560, 0.5],
      [1920, 0.5],
    ]);
  });

  // Red if the bitrate is not bpp × width × height × 30, if a frame over
  // 2560 is rendered, or if a quality hint rides along.
  it("--bpps renders each frame up to 2560 at 30 fps, by bitrate", () => {
    const today = {
      name: "today",
      target: { ...LANDSCAPE_1080P, width: 3840, height: 2160 },
    };
    const mid = {
      name: "1440p",
      target: { ...LANDSCAPE_1080P, width: 2560, height: 1756 },
    };
    const small = { name: "1080p", target: LANDSCAPE_1080P };
    const got = bppGridFor([today, mid, small], [0.05, 0.02]);
    expect(
      got.map((s) => [s.target.width, s.fps, s.target.bitrate, s.encoder]),
    ).toEqual([
      [2560, 30, 6_743_040, undefined],
      [2560, 30, 2_697_216, undefined],
      [1920, 30, 3_110_400, undefined],
      [1920, 30, 1_244_160, undefined],
    ]);
    expect(got.every((s) => s.mult === 1)).toBe(true);
  });

  it("the page states bits per pixel per frame, delivered and asked", () => {
    const crop = { kind: "none", why: "n" } as const;
    const c = {
      kind: "file",
      file: "a.mp4",
      frame: "1080p",
      width: 1920,
      height: 1080,
      fps: 30,
      encoder: "0.05 bpp",
      encoderUsed: { text: "", ok: true },
      rateControl: "bitrate 3110400",
      askedMbps: 3.1104,
      bytes: 1,
      realMbps: 1.5552,
      durationSec: 5,
      still: crop,
      zoom: crop,
    } as const;
    expect(bitsPerPixel(c)).toBe("0.0250 delivered, 0.0500 asked");
    expect(bitsPerPixel({ ...c, askedMbps: null })).toBe("0.0250 delivered");
  });

  it("the page lists a refused combination with its error, after the files", () => {
    const crop = { kind: "none", why: "crop holds no text (test)" } as const;
    const file = (bytes: number) =>
      ({
        kind: "file",
        file: `${bytes}.mp4`,
        frame: "today",
        width: 1920,
        height: 1080,
        fps: 60,
        encoder: "default",
        encoderUsed: { text: '{"bitrate":10000000}', ok: true },
        rateControl: "bitrate 10000000",
        askedMbps: 10,
        bytes,
        realMbps: 9,
        durationSec: 5,
        still: crop,
        zoom: crop,
      }) as const;
    const list = [
      { kind: "refused", label: "4K · 60 fps", error: "EncodingError: nope" },
      file(900),
      file(100),
    ] as const;
    const sorted = sortedBySize(list);
    expect(
      sorted.map((c) => (c.kind === "file" ? c.bytes : "refused")),
    ).toEqual([100, 900, "refused"]);
    const html = pageHtml([
      { takeId: "t", name: "T", cropNote: "n", candidates: [...list] },
    ]);
    expect(html).toContain("Refused: EncodingError: nope");
    expect(html).toContain("crop holds no text (test)");
    expect(html).toContain("<video controls loop muted");
    expect(html).toContain("sink used");
    expect(html).toContain("rate control</dt><dd>bitrate 10000000");
    expect(html).toContain("bitrate");
  });
});
