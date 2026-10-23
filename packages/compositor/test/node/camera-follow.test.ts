import { describe, expect, it } from "vitest";
import type { Vec } from "../../src/geometry";
import {
  frameCamera,
  motionTimings,
  sampleCamera,
} from "../../src/plan/camera";
import {
  type CameraTrack,
  FOLLOW_STEP_MS,
  type FollowStretch,
  sampleTrack,
  solveFollow,
} from "../../src/plan/camera-follow";
import {
  contentScale,
  derivePresentation,
} from "../../src/render/presentation";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { cameraKey } from "../fixtures/camera-key";
import {
  A,
  B,
  C,
  CLICKS,
  LANDING_MS,
  PULL_OUT_MS,
  pointer,
  pointerThrough,
  RUN_WAY,
  runKeys,
} from "../fixtures/run-follow";
import { readonlyScene } from "../fixtures/scene";

// Spec 2026-10-22 (the camera trails the pointer): while zoomed, a spring
// chases the drawn pointer, so a run of clicks reads as one journey rather
// than a park at every button.

const viewport = { width: 1280, height: 800 };
const RATE = 10;

function track(
  overrides: Partial<Parameters<typeof solveFollow>[0]> = {},
): CameraTrack {
  const args = {
    keys: runKeys(),
    cursorAt: pointer,
    holds: [],
    outputDurationMs: 8000,
    rate: RATE,
    ...overrides,
  };
  return { cameraKeys: args.keys, cameraFollow: solveFollow(args) };
}

const dist = (p: Vec, q: Vec) => Math.hypot(p.x - q.x, p.y - q.y);

describe("solveFollow and sampleTrack", () => {
  it("has the fixture it claims: one stretch, a pointer that travels between three clicks", () => {
    const stretches: FollowStretch[] = track().cameraFollow;
    expect(stretches).toHaveLength(1);
    const [only] = stretches as [FollowStretch];
    expect(only.startMs).toBe(LANDING_MS);
    expect(only.pullOutDepartMs).toBe(PULL_OUT_MS - 925);
    expect(only.endMs).toBe(PULL_OUT_MS);
    // The pointer does travel between the clicks, faster than 50 px/s.
    for (const [from, to] of [
      [CLICKS[0], CLICKS[1]],
      [CLICKS[1], CLICKS[2]],
    ] as const) {
      let fastest = 0;
      for (let t = from; t < to; t += 33) {
        fastest = Math.max(fastest, dist(pointer(t + 33), pointer(t)) / 0.033);
      }
      expect(fastest).toBeGreaterThan(50);
    }
    // And is not yet on A when the push-in lands.
    expect(dist(pointer(LANDING_MS), A)).toBeGreaterThan(5);
  });

  it("lands the push-in exactly where the keys do", () => {
    const t = track();
    for (let at = 0; at <= LANDING_MS; at += 10) {
      expect(sampleTrack(t, at), `at ${at}ms`).toEqual(
        sampleCamera(t.cameraKeys, at),
      );
    }
  });

  // A spring sets off from rest, so for the first moments of each journey
  // the camera is still gathering speed: `ONSET_MS` (1.5 time constants at
  // rate 10) is that allowance. A dead zone like the old follow-cam's holds
  // far longer: the hand has to cross a quarter of the window first.
  it("never stops while the pointer travels", () => {
    const t = track();
    const ONSET_MS = 150;
    const setsOff = [2150, 3350];
    // Premise: the journeys start where the allowance assumes.
    for (const at of setsOff) {
      expect(dist(pointer(at), pointer(at - 50))).toBe(0);
      expect(dist(pointer(at + 100), pointer(at))).toBeGreaterThan(1);
    }
    for (let at = CLICKS[0] + 33; at <= CLICKS[2]; at += 33) {
      const hand = dist(pointer(at), pointer(at - 33));
      if (hand <= 1.65) continue;
      if (setsOff.some((s) => at > s && at - s < ONSET_MS)) continue;
      const camera = dist(
        sampleTrack(t, at).center,
        sampleTrack(t, at - 33).center,
      );
      expect(camera, `camera moved at ${at}ms`).toBeGreaterThan(0.33);
    }
  });

  it("trails rather than leads", () => {
    const at = 2500;
    const camera = sampleTrack(track(), at).center;
    const hand = pointer(at);
    // Premise: mid-journey, the hand is well clear of A.
    expect(hand.x - A.x).toBeGreaterThan(50);
    expect(camera.x).toBeGreaterThan(A.x);
    expect(camera.x).toBeLessThan(hand.x);
  });

  it("keeps each clicked target in frame at its click", () => {
    const t = track();
    for (const [i, at] of CLICKS.entries()) {
      const target = [A, B, C][i] as Vec;
      const { center, scale } = sampleTrack(t, at);
      const halfW = viewport.width / scale / 2 - 24;
      const halfH = viewport.height / scale / 2 - 24;
      expect(Math.abs(target.x - center.x), `x at ${at}ms`).toBeLessThan(halfW);
      expect(Math.abs(target.y - center.y), `y at ${at}ms`).toBeLessThan(halfH);
    }
  });

  it("follows the zoom aims, still without stopping, when there is no pointer to follow", () => {
    const t = track({ cursorAt: null });
    for (let at = 2850 - 600 + 33; at <= 2850; at += 33) {
      const now = sampleTrack(t, at).center;
      const before = sampleTrack(t, at - 33).center;
      expect(
        dist(before, B) - dist(now, B),
        `toward B at ${at}ms`,
      ).toBeGreaterThan(0.33);
    }
    // Before C's pan sets off at 4050 − 600, the aim in force is still B.
    expect(dist(sampleTrack(t, 3400).center, B)).toBeLessThan(2);
  });

  it("holds a drag's aim while its button is down", () => {
    // Pressed on B at 2950, dragged away, released at 3400: all before C's
    // pan sets off at 3450, so B is the aim in force throughout.
    const wander = pointerThrough([
      ...RUN_WAY.slice(0, 5),
      [2950, B],
      [3350, { x: 900, y: 600 }],
    ]);
    const t = track({
      cursorAt: wander,
      holds: [{ startMs: 2950, endMs: 3400 }],
    });
    // Premise: the hand does move away inside the hold.
    expect(dist(wander(3350), B)).toBeGreaterThan(200);
    expect(dist(sampleTrack(t, 3390).center, B)).toBeLessThan(3);
  });

  it("leaves the spring for the pull-out without a jump", () => {
    const t = track();
    let previous = sampleTrack(t, 5200);
    for (let at = 5201; at <= PULL_OUT_MS; at += 1) {
      const now = sampleTrack(t, at);
      expect(
        dist(now.center, previous.center),
        `centre at ${at}ms`,
      ).toBeLessThan(2);
      expect(Math.abs(now.scale - previous.scale)).toBeLessThan(0.01);
      previous = now;
    }
    expect(sampleTrack(t, PULL_OUT_MS)).toEqual(
      sampleCamera(t.cameraKeys, PULL_OUT_MS),
    );
  });

  it("changes scale inside a run without a jump in the centre", () => {
    const t = track({ keys: runKeys(2.4) });
    // Premise: the scale does change across the window.
    expect(sampleTrack(t, 4100).scale).toBeGreaterThan(
      sampleTrack(t, 3300).scale + 0.3,
    );
    let previous = sampleTrack(t, 3300).center;
    for (let at = 3301; at <= 4100; at += 1) {
      const now = sampleTrack(t, at).center;
      expect(dist(now, previous), `centre at ${at}ms`).toBeLessThan(2);
      previous = now;
    }
  });

  it("keeps a pointer parked past the edge from jumping the frame", () => {
    const off: Vec = { x: -40, y: 270 };
    const parked = pointerThrough([
      ...RUN_WAY.slice(0, 5),
      [2950, B],
      [3550, off],
      [3950, off],
      [4550, B],
    ]);
    const t = track({ cursorAt: parked });
    const scene = readonlyScene();
    const { frameRect } = derivePresentation(
      scene.branding,
      LANDSCAPE_1080P,
      viewport,
    );
    const base = contentScale(frameRect, viewport);
    const drawn = (at: number) =>
      frameCamera(
        sampleTrack(t, at),
        base,
        frameRect,
        viewport,
        LANDSCAPE_1080P,
      ).center;
    // Premise: the spring does chase the hand past the clamp.
    expect(sampleTrack(t, 3900).center.x).toBeLessThan(drawn(3900).x - 50);
    // No step of the drawn frame is longer than the hand's longest: the
    // camera never outruns the pointer it trails, coming back included.
    let handStep = 0;
    let previous = drawn(2950);
    for (let at = 2958; at <= 5000; at += 8) {
      handStep = Math.max(handStep, dist(parked(at), parked(at - 8)));
    }
    for (let at = 2958; at <= 5000; at += 8) {
      const now = drawn(at);
      expect(dist(now, previous), `drawn centre at ${at}ms`).toBeLessThan(
        handStep,
      );
      previous = now;
    }
  });

  // /code-review 2026-10-22: a take that ends zoomed has no pull-out, and
  // its last instant must not snap from the spring back to the key's aim.
  it("holds the spring through the last instant of a take that ends zoomed", () => {
    // The pull-out removed; the take ends at 6010, a short last step after
    // 6002 (the stretch starts at 1650, so steps fall on 1650 + 8k). The
    // hand ends away from the last key's aim.
    const keys = runKeys().slice(0, -1);
    const away: Vec = { x: 1100, y: 600 };
    const hand = pointerThrough([...RUN_WAY, [4400, C], [5600, away]]);
    const t = track({ keys, cursorAt: hand, outputDurationMs: 6010 });
    const end = sampleTrack(t, 6010).center;
    // Premise: just before the end the spring has followed the hand well
    // off the aim.
    expect(dist(sampleTrack(t, 6009).center, C)).toBeGreaterThan(100);
    expect(dist(end, sampleTrack(t, 6009).center)).toBeLessThan(0.5);
    expect(dist(end, sampleTrack(t, 6005).center)).toBeLessThan(2);
  });

  it("reads the pointer once per step", () => {
    let reads = 0;
    const keys = [
      cameraKey({
        outputTimeMs: 0,
        center: { x: 640, y: 400 },
        scale: 1,
        transitionMs: 0,
      }),
      cameraKey({ outputTimeMs: 1000, center: A, scale: 2 }),
    ];
    const stretches = solveFollow({
      keys,
      cursorAt: (at) => {
        reads++;
        return pointer(at);
      },
      holds: [],
      outputDurationMs: 601_000,
      rate: RATE,
    });
    // Premise: one ten-minute stretch.
    expect(stretches.map((s) => s.endMs - s.startMs)).toEqual([600_000]);
    expect(reads).toBeLessThanOrEqual(Math.ceil(600_000 / FOLLOW_STEP_MS) + 1);
  });

  it("is a pure function of time", () => {
    const first = track();
    const direct = sampleTrack(first, 3000);
    for (let at = 0; at < 3000; at += 7) sampleTrack(first, at);
    expect(sampleTrack(first, 3000)).toEqual(direct);
    expect(sampleTrack(track(), 3000)).toEqual(direct);
  });

  it("takes its rate from the smoothness: 10 at the default, brisker at 0", () => {
    expect(motionTimings(0.5).followRatePerS).toBe(10);
    expect(motionTimings(0).followRatePerS).toBe(13);
    expect(motionTimings(1).followRatePerS).toBe(7);
  });
});
