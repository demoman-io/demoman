import {
  CAMERA_DEFAULTS,
  motionTimings,
  returnsBetween,
} from "@demoman/compositor";
import {
  SETTLE_MS,
  TAKE_TAIL_MS,
  TYPE_KEY_MS,
  TYPE_LEAD_MS,
  TYPE_MAX_MS,
} from "@demoman/replay-engine";
import { MOTION_DEFAULTS, type SceneAction } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  ARRIVE_MS,
  actMs,
  BASE_REST_MS,
  OPENING_REST_MS,
  restBefore,
  tailMs,
} from "../../src/beats.js";
import { createRoomPolicy, PAN_MARGIN_MS } from "../../src/room.js";

const typed = (text: string | null) =>
  ({ kind: "type", text }) as unknown as SceneAction;

describe("restBefore", () => {
  const plain = { first: false, pauseMs: 0, roomMs: 0, journeyMs: 400 };

  // Red if BASE_REST_MS is dropped from the max, or the first-step branch inverted.
  it("is the base rest for a plain step and the opening rest for the first", () => {
    expect(restBefore(plain)).toBe(BASE_REST_MS);
    expect(restBefore({ ...plain, first: true })).toBe(OPENING_REST_MS);
    expect(OPENING_REST_MS).not.toBe(BASE_REST_MS); // premise: the branches differ
  });

  // Red if `+ i.pauseMs` is removed from the rest.
  it("adds the author's pause", () => {
    expect(restBefore({ ...plain, pauseMs: 1500 })).toBe(BASE_REST_MS + 1500);
  });

  // Red if `i.roomMs - i.journeyMs - ARRIVE_MS` loses the journey or arrive term.
  it("grows to the room the camera needs, less what the journey and arrival already give", () => {
    const roomMs = 3000;
    const i = { ...plain, roomMs };
    expect(roomMs - i.journeyMs - ARRIVE_MS).toBeGreaterThan(BASE_REST_MS); // premise
    expect(restBefore(i)).toBe(roomMs - i.journeyMs - ARRIVE_MS);
    expect(ARRIVE_MS).toBe(SETTLE_MS);
  });

  // Red if the max becomes a sum.
  it("is not the sum of base and room", () => {
    const i = { ...plain, roomMs: 100 };
    expect(100 - i.journeyMs - ARRIVE_MS).toBeLessThan(BASE_REST_MS); // premise
    expect(restBefore(i)).toBe(BASE_REST_MS);
  });
});

describe("actMs", () => {
  // Red if the non-type branch returns anything but 0.
  it("is 0 for every act but typing", () => {
    for (const kind of ["click", "wait", "press", "drag"])
      expect(actMs({ kind } as unknown as SceneAction)).toBe(0);
  });

  // Red if the lead or the (n - 1) gap count changes from the verb's schedule.
  it("is the lead plus a gap between keys for short text", () => {
    expect(actMs(typed("abc"))).toBe(TYPE_LEAD_MS + 2 * TYPE_KEY_MS);
    expect(actMs(typed("a"))).toBe(TYPE_LEAD_MS);
    expect(actMs(typed(null))).toBe(TYPE_LEAD_MS);
  });

  // Red if the cap is dropped: the long string would run (n-1)*TYPE_KEY_MS.
  it("holds to the verb's cap for text too long to type at the key gap", () => {
    const long = "x".repeat(200);
    expect((long.length - 1) * TYPE_KEY_MS).toBeGreaterThan(TYPE_MAX_MS); // premise
    expect(actMs(typed(long))).toBeLessThanOrEqual(TYPE_LEAD_MS + TYPE_MAX_MS);
    expect(actMs(typed(long))).toBeGreaterThan(
      TYPE_LEAD_MS + TYPE_MAX_MS - 200,
    );
  });

  // Red if keys are counted as code units rather than graphemes.
  it("counts a grapheme as one key", () => {
    const emoji = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"; // one family emoji
    expect(emoji.length).toBeGreaterThan(1); // premise: many code units
    expect(actMs(typed(emoji))).toBe(TYPE_LEAD_MS);
  });
});

describe("tailMs", () => {
  // Red if TAKE_TAIL_MS leaves the max.
  it("is the take tail when nothing zooms", () => {
    expect(tailMs({ zoomSettleMs: null, trimEndMs: null })).toBe(TAKE_TAIL_MS);
  });

  // Red if the zoom settle is not in the max.
  it("waits for the zoom to settle when that is later", () => {
    const zoomSettleMs = TAKE_TAIL_MS + 500;
    expect(tailMs({ zoomSettleMs, trimEndMs: null })).toBe(zoomSettleMs);
  });

  // Red if the trim is not added after the settle.
  it("adds the trimmed end after the settle", () => {
    expect(tailMs({ zoomSettleMs: 400, trimEndMs: 900 })).toBe(
      Math.max(TAKE_TAIL_MS, 1300),
    );
    expect(tailMs({ zoomSettleMs: 2000, trimEndMs: 900 })).toBe(2900);
  });
});

describe("room policy arrives", () => {
  const policy = createRoomPolicy(
    { width: 1280, height: 800 },
    MOTION_DEFAULTS,
  );
  const timings = motionTimings(MOTION_DEFAULTS.smoothness);
  const returns = (heldUntilMs: number, clickMs: number) =>
    returnsBetween(
      heldUntilMs,
      clickMs + CAMERA_DEFAULTS.leadInMs + PAN_MARGIN_MS,
      timings,
    );

  // Red if `arrives` returns the wrong side of returnsBetween, or neededMs
  // stops being derived from it.
  it("pans a near gap and returns across a far one, and neededMs agrees", () => {
    const near = { heldUntilMs: 650, clickMs: 650 + 350 + 500 };
    const far = { heldUntilMs: 650, clickMs: 650 + 350 + 6000 };
    expect(returns(near.heldUntilMs, near.clickMs)).toBe(false); // premise
    expect(returns(far.heldUntilMs, far.clickMs)).toBe(true); // premise
    expect(policy.arrives(near)).toBe("pan");
    expect(policy.neededMs(near)).toBe(0);
    expect(policy.arrives(far)).toBe("return");
    expect(policy.neededMs(far)).toBeGreaterThan(0);
  });

  // Red if a null hold is treated as a pan.
  it("returns when no zoom is held yet", () => {
    const first = { heldUntilMs: null, clickMs: 5000 };
    expect(policy.arrives(first)).toBe("return");
    expect(policy.neededMs(first)).toBeGreaterThan(0);
  });
});
