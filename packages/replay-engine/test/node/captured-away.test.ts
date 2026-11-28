import { describe, expect, it } from "vitest";
import {
  type CaptureWindow,
  capturedAway,
  ECHO_WINDOW_MS,
  STILL_ECHO_WINDOW_MS,
  STRAY_WINDOW_MS,
  type StillWindow,
  stillEcho,
} from "../../src/step-settle.js";

/** Which screencast frames a page capture keeps out of the film, judged by
 *  when each was painted (close review 3). */
describe("capturedAway", () => {
  const HI = "2560x1600";
  const LO = "1280x800";
  const held: CaptureWindow = {
    fromMs: 1000,
    toMs: 1100,
    inputMs: null,
    size: HI,
  };
  const sized = (size: string | null) => () => size;

  it("keeps everything when no capture was taken, or before it began", () => {
    expect(capturedAway(1050, sized(LO), null)).toBe(false);
    expect(capturedAway(999, sized(LO), held)).toBe(false);
  });

  // Red when frames are judged by arrival: one painted with the caret
  // hidden that arrives after the release was kept.
  it("drops a frame painted during the hold, at any size", () => {
    expect(capturedAway(1000, sized(HI), held)).toBe(true);
    expect(capturedAway(1100, sized(HI), held)).toBe(true);
    expect(capturedAway(1050, sized(LO), held)).toBe(true);
    // Still holding: everything painted since it began.
    expect(capturedAway(5000, sized(HI), { ...held, toMs: null })).toBe(true);
  });

  // Red without the echo window: on CI the release's two repaints, kept,
  // made a span that owed a settled still, and the next step's still stood
  // in at 1280 (PR #67, 2026-11-12).
  it("drops the release's echo at the page's own size, and keeps what comes after it", () => {
    expect(capturedAway(1101, sized(HI), held)).toBe(true);
    expect(capturedAway(1100 + ECHO_WINDOW_MS, sized(HI), held)).toBe(true);
    expect(capturedAway(1101 + ECHO_WINDOW_MS, sized(HI), held)).toBe(false);
  });

  // Red when the echo outlasts the walk's next input: the hover a pointer
  // path painted right after a capture was dropped and never seen.
  it("ends the echo at the walk's next input", () => {
    const acted = { ...held, inputMs: 1120 };
    expect(capturedAway(1120, sized(HI), acted)).toBe(true);
    expect(capturedAway(1121, sized(HI), acted)).toBe(false);
  });

  // Red when a normal-size frame ends the stray check: Chrome's 1x frame
  // arriving second was kept.
  it("drops a frame of another size painted just after, whatever came between", () => {
    expect(capturedAway(1101 + ECHO_WINDOW_MS, sized(HI), held)).toBe(false);
    expect(capturedAway(1110 + ECHO_WINDOW_MS, sized(LO), held)).toBe(true);
    expect(capturedAway(1100 + STRAY_WINDOW_MS, sized(null), held)).toBe(true);
  });

  it("keeps a frame of another size once the window has passed, or with no size to go back to", () => {
    expect(capturedAway(1101 + STRAY_WINDOW_MS, sized(LO), held)).toBe(false);
    expect(
      capturedAway(1110 + ECHO_WINDOW_MS, sized(LO), { ...held, size: null }),
    ).toBe(false);
  });

  it("reads a frame's size only inside the window", () => {
    let reads = 0;
    const counted = () => {
      reads++;
      return LO;
    };
    capturedAway(1050, counted, held);
    capturedAway(2000, counted, held);
    expect(reads).toBe(0);
    capturedAway(1150, counted, held);
    expect(reads).toBe(0);
    capturedAway(1110 + ECHO_WINDOW_MS, counted, held);
    expect(reads).toBe(1);
  });
});

/** Which screencast frames a full still keeps out of the film: its echo, at
 *  the still's scale, painted once the still was asked for. */
describe("stillEcho", () => {
  const OWN = "2560x1600";
  const STILL = "3840x2400";
  const still: StillWindow = {
    fromMs: 1000,
    toMs: 1400,
    own: OWN,
    still: STILL,
  };
  const sized = (size: string | null) => () => size;

  // Red without the rule: under load a frame painted during the still, one
  // painted 120 ms after it and one of the page made a kept span at 3840.
  it("drops a frame at the still's size painted during the still or just after, arriving in any order", () => {
    expect(stillEcho(1050, sized(STILL), still)).toBe("echo");
    expect(stillEcho(1400 + 120, sized(STILL), still)).toBe("echo");
    expect(stillEcho(1400 + STILL_ECHO_WINDOW_MS, sized(STILL), still)).toBe(
      "echo",
    );
    // Still being taken: everything at its size since it was asked for.
    expect(stillEcho(9000, sized(STILL), { ...still, toMs: null })).toBe(
      "echo",
    );
  });

  it("keeps the screencast's own frames, and frames painted before the still", () => {
    expect(stillEcho(1050, sized(OWN), still)).toBeNull();
    expect(stillEcho(1500, sized(OWN), still)).toBeNull();
    expect(stillEcho(999, sized(STILL), still)).toBeNull();
    // Another size altogether is the recorder's to judge (`coversViewport`).
    expect(stillEcho(1050, sized("1800x1104"), still)).toBeNull();
  });

  // Red when the rule forgives a late one silently: it is refused, and the
  // walk says it, because that long after a still it may be the page.
  it("calls one at the still's size painted past the window late", () => {
    expect(stillEcho(1401 + STILL_ECHO_WINDOW_MS, sized(STILL), still)).toBe(
      "late",
    );
  });

  it("judges nothing when the screencast already runs at the still's size, or a size is not known", () => {
    expect(stillEcho(1050, sized(STILL), { ...still, own: STILL })).toBeNull();
    expect(stillEcho(1050, sized(STILL), { ...still, own: null })).toBeNull();
    expect(stillEcho(1050, sized(STILL), { ...still, still: null })).toBeNull();
    expect(stillEcho(1050, sized(STILL), null)).toBeNull();
  });

  it("reads a frame's size only once a still was asked for", () => {
    let reads = 0;
    const counted = () => {
      reads++;
      return STILL;
    };
    stillEcho(999, counted, still);
    stillEcho(1050, counted, null);
    expect(reads).toBe(0);
    stillEcho(1050, counted, still);
    expect(reads).toBe(1);
  });
});
