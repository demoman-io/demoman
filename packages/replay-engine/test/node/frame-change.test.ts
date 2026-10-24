import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MOVING_RECENT_MS, MOVING_SHARE } from "../../src/constants.js";
import {
  changedShare,
  lumaBlocks,
  pageMoving,
  type SeenFrame,
  standInFrame,
} from "../../src/frame-change.js";

/**
 * The fixtures are 256x160 baseline 4:2:0 JPEGs at quality 80, the shape
 * Chrome's encoder writes (`frame-change.ts`): `base`, the same picture
 * with one 16x16 square at (64, 32) painted red, and the same with a
 * 160x128 block painted over its top-left.
 */
const frame = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "frames", name)),
  );
const base = frame("base.jpg");
const small = frame("small-change.jpg");
const big = frame("big-change.jpg");

describe("lumaBlocks", () => {
  it("reads one value per 8x8 luma block", () => {
    const blocks = lumaBlocks(base);
    expect(blocks?.width).toBe(32);
    expect(blocks?.height).toBe(20);
  });

  /**
   * The geometry, not only "something changed": the square covers exactly
   * blocks (8..9, 4..5), and a decoder that misplaced blocks or misread
   * a code would change others, or none.
   */
  it("changes exactly the blocks under a change", () => {
    const a = lumaBlocks(base);
    const b = lumaBlocks(small);
    if (!a || !b) throw new Error("a fixture did not decode");
    const changed: string[] = [];
    for (let i = 0; i < a.dc.length; i++) {
      if (a.dc[i] !== b.dc[i]) {
        changed.push(`${i % a.width},${Math.floor(i / a.width)}`);
      }
    }
    expect(changed).toEqual(["8,4", "9,4", "8,5", "9,5"]);
  });

  it("refuses what it does not read rather than throwing", () => {
    expect(lumaBlocks(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(lumaBlocks(base.subarray(0, base.length / 2))).toBeNull();
    // The same frame under a progressive marker.
    const progressive = base.slice();
    const sof = progressive.findIndex(
      (b, i) => b === 0xff && progressive[i + 1] === 0xc0,
    );
    expect(sof, "the fixture has no baseline SOF").toBeGreaterThan(0);
    progressive[sof + 1] = 0xc2;
    expect(lumaBlocks(progressive)).toBeNull();
  });
});

describe("changedShare", () => {
  it("measures how much of the page changed", () => {
    const [a, b, c] = [lumaBlocks(base), lumaBlocks(small), lumaBlocks(big)];
    if (!a || !b || !c) throw new Error("a fixture did not decode");
    expect(changedShare(a, a)).toBe(0);
    expect(changedShare(a, b)).toBeCloseTo(4 / 640, 6);
    // 160x128 of 256x160 is half the page, give or take the blocks the
    // rectangle's edges share with what was there.
    expect(changedShare(a, c)).toBeGreaterThan(0.45);
  });
});

describe("pageMoving", () => {
  const seen = (bytes: Uint8Array, atMs: number): SeenFrame => ({
    data: Buffer.from(bytes).toString("base64"),
    atMs,
  });

  // Premise for the cases below: the fixtures straddle the threshold, or a
  // case could pass on the timing rule alone.
  it("has fixtures either side of the share that counts as moving", () => {
    const [a, b, c] = [lumaBlocks(base), lumaBlocks(small), lumaBlocks(big)];
    if (!a || !b || !c) throw new Error("a fixture did not decode");
    expect(changedShare(a, b)).toBeLessThan(MOVING_SHARE);
    expect(changedShare(a, c)).toBeGreaterThan(MOVING_SHARE);
  });

  it("is moving when two recent frames differ over much of the page", () => {
    expect(pageMoving(seen(big, 1016), seen(base, 1000), 1030)).toBe(true);
  });

  it("is still when only a sliver repaints, however often", () => {
    expect(pageMoving(seen(small, 1016), seen(base, 1000), 1030)).toBe(false);
  });

  it("is still when the newest frame is older than the window", () => {
    const late = 1016 + MOVING_RECENT_MS + 1;
    expect(pageMoving(seen(big, 1016), seen(base, 1000), late)).toBe(false);
  });

  it("is still after one big repaint with nothing just before it", () => {
    const after = 1000 + MOVING_RECENT_MS + 1;
    expect(pageMoving(seen(big, after), seen(base, 1000), after + 5)).toBe(
      false,
    );
  });

  it("is still with fewer than two frames, or one it cannot read", () => {
    expect(pageMoving(null, null, 0)).toBe(false);
    expect(pageMoving(seen(big, 10), null, 20)).toBe(false);
    expect(
      pageMoving({ data: "not base64!", atMs: 16 }, seen(base, 0), 20),
    ).toBe(false);
  });
});

describe("standInFrame", () => {
  const seen = (bytes: Uint8Array, atMs: number): SeenFrame => ({
    data: Buffer.from(bytes).toString("base64"),
    atMs,
  });
  /** The frames the screencast sends next, one per call, then nothing. */
  const upcoming = (...frames: SeenFrame[]) => {
    const asked: number[] = [];
    const next = async (ms: number) => {
      asked.push(ms);
      return frames.shift() ?? null;
    };
    return { next, asked };
  };

  it("takes the next frame when the two newest say the page moves", async () => {
    const after = seen(big, 1040);
    const { next } = upcoming(after);
    const got = await standInFrame(
      {
        newest: seen(big, 1016),
        prior: seen(base, 1000),
        captureEndedMs: 0,
        nowMs: 1030,
      },
      next,
      100,
    );
    expect(got).toBe(after);
  });

  /**
   * A full still had just come back, so the screencast sent nothing while
   * it ran and the newest frame predates it. The 2026-10-24 re-film's sheet
   * slid open through one such still unseen. Verified failable: deciding on
   * the stale pair alone answers null here and takes a full still.
   */
  it("waits for two frames after a full still, and takes the second if they move", async () => {
    const first = seen(base, 2010);
    const second = seen(big, 2026);
    const { next, asked } = upcoming(first, second);
    const got = await standInFrame(
      {
        newest: seen(base, 1800),
        prior: seen(base, 1784),
        captureEndedMs: 2000,
        nowMs: 2005,
      },
      next,
      100,
    );
    expect(asked).toEqual([100, 100]);
    expect(got).toBe(second);
  });

  it("takes the full still after a full still when what follows is a sliver", async () => {
    const { next } = upcoming(seen(base, 2010), seen(small, 2026));
    const got = await standInFrame(
      {
        newest: seen(base, 1800),
        prior: seen(base, 1784),
        captureEndedMs: 2000,
        nowMs: 2005,
      },
      next,
      100,
    );
    expect(got).toBeNull();
  });

  it("waits for nothing on a page that has been still", async () => {
    const { next, asked } = upcoming(seen(big, 5016));
    const got = await standInFrame(
      {
        newest: seen(base, 1000),
        prior: seen(base, 984),
        captureEndedMs: 0,
        nowMs: 5000,
      },
      next,
      100,
    );
    expect(got).toBeNull();
    expect(asked).toEqual([]);
  });
});
