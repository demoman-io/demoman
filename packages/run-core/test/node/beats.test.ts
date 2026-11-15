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
  afterScroll,
  BASE_REST_MS,
  JOURNEY_TAIL_MS,
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

  // Red if `roomLeft` loses the journey, arrive or journey-tail term.
  it("grows to the room the camera needs, less what the journey (less its eased-out end) and arrival already give", () => {
    const roomMs = 3000;
    const i = { ...plain, roomMs };
    expect(roomMs - i.journeyMs - ARRIVE_MS).toBeGreaterThan(BASE_REST_MS); // premise
    expect(restBefore(i)).toBe(
      roomMs - i.journeyMs - ARRIVE_MS + JOURNEY_TAIL_MS,
    );
    expect(ARRIVE_MS).toBe(SETTLE_MS);
  });

  // Red if the margin is added without a journey (`journeyMs > 0 ?` in
  // `roomLeft` dropped): a cursor that does not move has no eased-out end.
  it("plans no journey margin when the cursor makes no journey", () => {
    const i = { ...plain, roomMs: 3000, journeyMs: 0 };
    expect(3000 - ARRIVE_MS).toBeGreaterThan(BASE_REST_MS); // premise
    expect(restBefore(i)).toBe(3000 - ARRIVE_MS);
  });

  // Red if the max becomes a sum.
  it("is not the sum of base and room", () => {
    const i = { ...plain, roomMs: 100 };
    expect(100 - i.journeyMs - ARRIVE_MS).toBeLessThan(BASE_REST_MS); // premise
    expect(restBefore(i)).toBe(BASE_REST_MS);
  });

  // Red if `+ (i.returnShortMs ?? 0)` goes: a return the room policy says
  // is short would keep the rest that left it short.
  it("adds what a return still lacks on top of the room it was given", () => {
    const i = { ...plain, roomMs: 3000 };
    expect(restBefore({ ...i, returnShortMs: 525 })).toBe(restBefore(i) + 525);
    expect(restBefore({ ...plain, returnShortMs: 525 })).toBe(
      BASE_REST_MS + 525,
    );
  });
});

describe("afterScroll", () => {
  // Red if the non-zoomed branch plans anything but an arrive's worth.
  it("is an arrive's worth before a step that does not zoom, whatever the room", () => {
    expect(afterScroll({ zooms: false, roomMs: 3000, journeyMs: 400 })).toBe(
      ARRIVE_MS,
    );
  });

  // Red if the zoomed branch loses `roomLeft`'s journey, arrive or
  // journey-tail term.
  it("is the room left after the journey, less its eased-out end, and the arrive before a zoomed click", () => {
    const i = { zooms: true, roomMs: 3000, journeyMs: 400 };
    expect(3000 - 400 - ARRIVE_MS).toBeGreaterThan(ARRIVE_MS); // premise
    expect(afterScroll(i)).toBe(3000 - 400 - ARRIVE_MS + JOURNEY_TAIL_MS);
    expect(afterScroll({ ...i, journeyMs: 0 })).toBe(3000 - ARRIVE_MS);
  });

  // Red if `+ (i.returnShortMs ?? 0)` goes from `afterScroll`.
  it("adds what a return still lacks after the scroll", () => {
    const i = { zooms: true, roomMs: 3000, journeyMs: 400 };
    expect(afterScroll({ ...i, returnShortMs: 525 })).toBe(
      afterScroll(i) + 525,
    );
  });

  // Red if the floor at `ARRIVE_MS` goes: a pan's room is 0.
  it("never plans less than an arrive's worth", () => {
    expect(afterScroll({ zooms: true, roomMs: 0, journeyMs: 400 })).toBe(
      ARRIVE_MS,
    );
  });
});

describe("actMs", () => {
  // Red if the non-type branch returns anything but 0.
  it("is 0 for every act but typing", () => {
    for (const kind of ["click", "wait", "press", "drag"])
      expect(actMs({ kind } as unknown as SceneAction)).toBe(0);
  });

  // Red if the (n - 1) gap count changes from the verb's schedule, or the
  // verb's lead comes back: it is idle inside the act, which a planned take
  // plays for 0, so counting it would widen every camera gap after a typed
  // step by 250 ms the video never plays (final review, Important 1).
  it("is a gap between keys for short text, without the verb's lead", () => {
    expect(TYPE_LEAD_MS).toBeGreaterThan(0); // premise: there is a lead to leave out
    expect(actMs(typed("abc"))).toBe(2 * TYPE_KEY_MS);
    expect(actMs(typed("a"))).toBe(0);
    expect(actMs(typed(null))).toBe(0);
  });

  // Red if the cap is dropped: the long string would run (n-1)*TYPE_KEY_MS.
  it("holds to the verb's cap for text too long to type at the key gap", () => {
    const long = "x".repeat(200);
    expect((long.length - 1) * TYPE_KEY_MS).toBeGreaterThan(TYPE_MAX_MS); // premise
    expect(actMs(typed(long))).toBeLessThanOrEqual(TYPE_MAX_MS);
    expect(actMs(typed(long))).toBeGreaterThan(TYPE_MAX_MS - 200);
  });

  // Red if keys are counted as code units rather than graphemes.
  it("counts a grapheme as one key", () => {
    const emoji = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"; // one family emoji
    expect(emoji.length).toBeGreaterThan(1); // premise: many code units
    expect(actMs(typed(emoji))).toBe(0);
    expect(actMs(typed(`${emoji}${emoji}`))).toBe(TYPE_KEY_MS);
  });
});

describe("tailMs", () => {
  const NONE = { trimAfterAction: false, pauseMs: 0 };
  // Red if TAKE_TAIL_MS leaves the max.
  it("is the take tail when nothing zooms", () => {
    expect(tailMs({ zoomSettleMs: null, trimEndMs: null, ...NONE })).toBe(
      TAKE_TAIL_MS,
    );
  });

  // Red if the zoom settle is not in the max.
  it("waits for the zoom to settle when that is later", () => {
    const zoomSettleMs = TAKE_TAIL_MS + 500;
    expect(tailMs({ zoomSettleMs, trimEndMs: null, ...NONE })).toBe(
      zoomSettleMs,
    );
  });

  // Red if the trim is not added after the settle.
  it("adds the trimmed end after the settle", () => {
    expect(tailMs({ zoomSettleMs: 400, trimEndMs: 900, ...NONE })).toBe(
      Math.max(TAKE_TAIL_MS, 1300),
    );
    expect(tailMs({ zoomSettleMs: 2000, trimEndMs: 900, ...NONE })).toBe(2900);
  });

  // Red if the trim is counted from the settle whatever `after` says
  // (`(i.trimAfterAction ? 0 : z)` back to `z`): 2900 and 2300 instead.
  it("counts a trim after the action from the act, not the settle", () => {
    expect(
      tailMs({
        zoomSettleMs: 2000,
        trimEndMs: 900,
        trimAfterAction: true,
        pauseMs: 0,
      }),
    ).toBe(2000);
    expect(
      tailMs({
        zoomSettleMs: 400,
        trimEndMs: 1900,
        trimAfterAction: true,
        pauseMs: 0,
      }),
    ).toBe(1900);
  });

  // Red if `pauseMs` leaves the take tail's term.
  it("adds a closing pause to the take tail", () => {
    expect(
      tailMs({
        zoomSettleMs: null,
        trimEndMs: null,
        trimAfterAction: false,
        pauseMs: 2000,
      }),
    ).toBe(TAKE_TAIL_MS + 2000);
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

  // Red if `returnShortMs` loses a term of the return (a plateau, the
  // pull-out, the push-in), the margin, or the arrival's lead-in: the click
  // it plans would then not leave a whole return plus the margin.
  it("says what a return lacks for a whole one plus the margin, and nothing once it has it", () => {
    const heldUntilMs = 650;
    // The reviewer's band: a click 2500 ms after the zoomed one before it.
    const click = { heldUntilMs, clickMs: heldUntilMs + 350 + 2500 };
    expect(policy.arrives(click)).toBe("return"); // premise: paced as a return
    expect(returns(heldUntilMs, click.clickMs - PAN_MARGIN_MS)).toBe(false); // premise: none fits
    const short = policy.returnShortMs(click);
    expect(short).toBe(2725 + PAN_MARGIN_MS - 2500);
    const planned = { heldUntilMs, clickMs: click.clickMs + short };
    // With it added, a return fits with the margin to spare, exactly.
    expect(returns(heldUntilMs, planned.clickMs - 2 * PAN_MARGIN_MS)).toBe(
      true,
    );
    expect(returns(heldUntilMs, planned.clickMs - 2 * PAN_MARGIN_MS - 1)).toBe(
      false,
    );
    expect(policy.returnShortMs(planned)).toBe(0);
    expect(policy.returnShortMs({ heldUntilMs: null, clickMs: 0 })).toBe(0);
  });

  // Red if a null hold is treated as a pan.
  it("returns when no zoom is held yet", () => {
    const first = { heldUntilMs: null, clickMs: 5000 };
    expect(policy.arrives(first)).toBe("return");
    expect(policy.neededMs(first)).toBeGreaterThan(0);
  });
});
