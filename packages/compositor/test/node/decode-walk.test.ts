import { describe, expect, it } from "vitest";
import { shouldReseek } from "../../src/ports/decode-walk";

describe("shouldReseek", () => {
  it("re-seeks when nothing has been served yet", () => {
    expect(shouldReseek(null, 1.0)).toBe(true);
  });

  it("walks forward for the next frame of a playing span", () => {
    // The whole point: playback asks for one instant after another, and a
    // decoder asked that way pre-decodes ahead instead of seeking. Measured
    // on a 2560x1600 span, 15.09ms per frame seeking against 4.43ms walking.
    expect(shouldReseek({ servedSeconds: 1.0 }, 1.0167)).toBe(false);
  });

  it("walks forward when the same instant is asked for twice", () => {
    // A 30fps span drawn at 60fps output asks for the same frame twice.
    expect(shouldReseek({ servedSeconds: 1.0 }, 1.0)).toBe(false);
  });

  it("re-seeks when the playhead has gone backwards", () => {
    // An iterator cannot rewind, so a scrub back has to start again.
    expect(shouldReseek({ servedSeconds: 1.0 }, 0.9)).toBe(true);
  });

  it("re-seeks on a jump too far forward to walk to", () => {
    // Walking to a distant instant would decode every frame in between,
    // which is slower than seeking to it. A scrub across the span is this.
    expect(shouldReseek({ servedSeconds: 1.0 }, 4.0)).toBe(true);
  });

  it("walks a gap small enough that decoding through it is cheaper", () => {
    // Playback that drops a few frames still lands inside this, so a
    // stuttering preview does not fall back to seeking on every frame and
    // make itself slower still.
    expect(shouldReseek({ servedSeconds: 1.0 }, 1.2)).toBe(false);
  });
});
