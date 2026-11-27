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

  // The Sublime board's card drop (2026-11-08): the drag's zoom frames both
  // ends, so the hand resting where it let go is already in frame. Chasing
  // it from the release lurched the camera at the drop.
  it("keeps a drag's aim after the release until the hand moves on", () => {
    const drop = { x: 520, y: 420 };
    const keys = [
      cameraKey({
        outputTimeMs: 0,
        center: { x: 640, y: 400 },
        scale: 1,
        transitionMs: 0,
      }),
      cameraKey({ outputTimeMs: 1000, center: A, scale: 2 }),
      cameraKey({ outputTimeMs: 7000, center: A, scale: 1 }),
    ];
    // Pressed on A at 1500, dropped at 2200, let go at 2500, still until
    // 4000, then away.
    const hand = pointerThrough([
      [0, A],
      [1500, A],
      [2200, drop],
      [4000, drop],
      [4400, { x: 900, y: 600 }],
    ]);
    const t = track({
      keys,
      cursorAt: hand,
      holds: [{ startMs: 1500, endMs: 2500 }],
    });
    // Premise: the hand rests at the drop, well away from the aim, from
    // before the release until 4000.
    expect(dist(hand(2500), A)).toBeGreaterThan(200);
    expect(hand(3900)).toEqual(hand(2500));
    expect(dist(sampleTrack(t, 2490).center, A)).toBeLessThan(3);
    expect(dist(sampleTrack(t, 3900).center, A)).toBeLessThan(3);
    // Once the hand moves on, the camera follows it again.
    expect(dist(sampleTrack(t, 4600).center, A)).toBeGreaterThan(100);
  });

  // the Sublime board, 2026-11-22: the drag's zoom lands between
  // the card and the drop, 350 ms before the press. The follow chased the
  // hand to the card, then the press held the drag's aim and the camera
  // swung back: a bounce before the drag had begun.
  describe("before a drag's press, with the drag's own aim in force", () => {
    const grab = { x: 300, y: 400 };
    const drop = { x: 1000, y: 400 };
    const middle = { x: 650, y: 400 };
    const keys = [
      cameraKey({
        outputTimeMs: 0,
        center: { x: 640, y: 400 },
        scale: 1,
        transitionMs: 0,
      }),
      cameraKey({ outputTimeMs: 1000, center: middle, scale: 1.8 }),
      cameraKey({ outputTimeMs: 7000, center: middle, scale: 1 }),
    ];
    const pressed = [{ startMs: 2000, endMs: 3000 }];
    /** The largest move toward the grab (−x), px per 60 fps frame. */
    const mostTowardGrab = (t: ReturnType<typeof track>) => {
      let worst = 0;
      let previous = sampleTrack(t, 1000).center;
      for (let at = 1000 + 1000 / 60; at <= 2000; at += 1000 / 60) {
        const now = sampleTrack(t, at).center;
        worst = Math.max(worst, previous.x - now.x);
        previous = now;
      }
      return worst;
    };

    it("does not chase a hand resting on the card", () => {
      const hand = pointerThrough([
        [0, grab],
        [2000, grab],
        [2700, drop],
        [7000, drop],
      ]);
      const t = track({ keys, cursorAt: hand, holds: pressed });
      // Premise: the hand rests on the card, far from the aim, until the press.
      expect(hand(1999)).toEqual(grab);
      expect(dist(grab, middle)).toBeGreaterThan(300);
      expect(mostTowardGrab(t)).toBeLessThan(0.5);
      expect(dist(sampleTrack(t, 1990).center, middle)).toBeLessThan(3);
    });

    it("does not chase a hand still on its way to the card", () => {
      const from = { x: 500, y: 700 };
      const hand = pointerThrough([
        [0, from],
        [1200, from],
        [1900, grab],
        [2000, grab],
        [2700, drop],
        [7000, drop],
      ]);
      const t = track({ keys, cursorAt: hand, holds: pressed });
      // Premise: the hand travels toward the grab after the zoom lands.
      expect(dist(hand(1200), hand(1600))).toBeGreaterThan(100);
      expect(hand(1900)).toEqual(grab);
      expect(mostTowardGrab(t)).toBeLessThan(0.5);
      expect(dist(sampleTrack(t, 1990).center, middle)).toBeLessThan(3);
    });

    // Review of fix/drag-camera (2026-11-23): the hand was already on its way
    // to the grab when the drag's aim set off mid-stretch. Aimed at the keys'
    // eased camera, the target stepped back to the previous key's centre at
    // the set-off and the camera turned back before panning on.
    describe("when the drag's aim sets off mid-stretch", () => {
      const start = { x: 100, y: 400 };
      const midKeys = (dragKeyMs: number, transitionMs: number) => [
        cameraKey({
          outputTimeMs: 0,
          center: { x: 640, y: 400 },
          scale: 1,
          transitionMs: 0,
        }),
        cameraKey({ outputTimeMs: 1000, center: start, scale: 1.8 }),
        cameraKey({
          outputTimeMs: dragKeyMs,
          center: middle,
          scale: 1.8,
          transitionMs,
        }),
        cameraKey({ outputTimeMs: 7000, center: middle, scale: 1 }),
      ];
      const frame = 1000 / 60;
      /** The largest step back (−x), px per 60 fps frame, over [from, to]. */
      const mostBack = (
        t: ReturnType<typeof track>,
        from: number,
        to: number,
      ) => {
        let worst = 0;
        let previous = sampleTrack(t, from).center;
        for (let at = from + frame; at <= to; at += frame) {
          const now = sampleTrack(t, at).center;
          worst = Math.max(worst, previous.x - now.x);
          previous = now;
        }
        return worst;
      };

      it("never turns back as it sets off while the hand is on its way to the grab", () => {
        // The drag's key sets off at 2400 − 600 = 1800; pressed at 3000.
        const keys = midKeys(2400, 600);
        const hand = pointerThrough([
          [0, start],
          [1100, start],
          [1500, grab],
          [3000, grab],
          [3600, drop],
          [7000, drop],
        ]);
        const t = track({
          keys,
          cursorAt: hand,
          holds: [{ startMs: 3000, endMs: 3600 }],
        });
        // Premise: the camera has followed the hand well toward the grab, and
        // well short of the drag's aim, when the drag's aim sets off.
        expect(sampleTrack(t, 1800).center.x).toBeGreaterThan(start.x + 100);
        expect(sampleTrack(t, 1800).center.x).toBeLessThan(middle.x - 200);
        expect(mostBack(t, 1000, 3000)).toBeLessThan(0.5);
        expect(dist(sampleTrack(t, 2990).center, middle)).toBeLessThan(3);
      });

      it("does not change its aim when the button goes down mid-pan", () => {
        // The drag's key sets off at 3100 − 740 = 2360 and lands at 3100;
        // pressed at 2500, 140 ms into its pan.
        const keys = midKeys(3100, 740);
        const pressedAt = (press: number) =>
          track({
            keys,
            cursorAt: pointerThrough([
              [0, start],
              [1100, start],
              [1500, grab],
              [press, grab],
              [press + 600, drop],
              [7000, drop],
            ]),
            holds: [{ startMs: press, endMs: press + 600 }],
          });
        // The same take pressed mid-pan, and pressed after the pan landed.
        const early = pressedAt(2500);
        const late = pressedAt(3300);
        // Premise: the keys' pan is still moving at the early press.
        expect(
          dist(
            sampleCamera(keys, 2500).center,
            sampleCamera(keys, 2500 - frame).center,
          ),
        ).toBeGreaterThan(1);
        // The button going down changes nothing while the pan runs.
        let apart = 0;
        for (let at = 2360; at <= 3100; at += frame) {
          apart = Math.max(
            apart,
            dist(sampleTrack(early, at).center, sampleTrack(late, at).center),
          );
        }
        expect(apart).toBeLessThan(0.01);
      });

      // Excalidraw (2026-11-23): handed the key's end at once, the camera
      // outran the keys' own eased pan toward the drag's aim.
      it("moves onto the drag's aim no faster than the keys' own pan to it", () => {
        // The camera rests on `start` when the drag's pan sets off at
        // 2900 − 1100 = 1800: a slow pan, slower than the spring's own peak.
        const keys = midKeys(2900, 1100);
        const hand = pointerThrough([
          [0, start],
          [1900, start],
          [2900, grab],
          [3200, grab],
          [3800, drop],
          [7000, drop],
        ]);
        const t = track({
          keys,
          cursorAt: hand,
          holds: [{ startMs: 3200, endMs: 3800 }],
        });
        let keysFastest = 0;
        let cameraFastest = 0;
        for (let at = 1800; at <= 3200; at += frame) {
          keysFastest = Math.max(
            keysFastest,
            dist(
              sampleCamera(keys, at).center,
              sampleCamera(keys, at - frame).center,
            ),
          );
          cameraFastest = Math.max(
            cameraFastest,
            dist(sampleTrack(t, at).center, sampleTrack(t, at - frame).center),
          );
        }
        // Premise: the camera rests at `start`, and the pan is long.
        expect(dist(sampleTrack(t, 1800).center, start)).toBeLessThan(3);
        expect(keysFastest).toBeGreaterThan(5);
        expect(cameraFastest).toBeLessThanOrEqual(keysFastest * 1.05);
        expect(dist(sampleTrack(t, 3190).center, middle)).toBeLessThan(3);
      });
    });

    it("still follows the hand before the drag's own aim has set off", () => {
      // The same drag with a key before it: the zoom lands on `first` at
      // 1000, and the drag's aim sets off at 2400 − 600 = 1800.
      const first = { x: 400, y: 300 };
      const twoKeys = [
        cameraKey({
          outputTimeMs: 0,
          center: { x: 640, y: 400 },
          scale: 1,
          transitionMs: 0,
        }),
        cameraKey({ outputTimeMs: 1000, center: first, scale: 1.8 }),
        cameraKey({
          outputTimeMs: 2400,
          center: middle,
          scale: 1.8,
          transitionMs: 600,
        }),
        cameraKey({ outputTimeMs: 7000, center: middle, scale: 1 }),
      ];
      const away = { x: 400, y: 600 };
      const hand = pointerThrough([
        [0, first],
        [1100, first],
        [1500, away],
        [2500, away],
        [2700, grab],
        [3000, grab],
      ]);
      const t = track({
        keys: twoKeys,
        cursorAt: hand,
        holds: [{ startMs: 3000, endMs: 3500 }],
      });
      // Premise: the hand moves well away from `first` before 1800.
      expect(dist(hand(1600), first)).toBeGreaterThan(200);
      // Before the drag's aim sets off, the camera trails the hand.
      expect(sampleTrack(t, 1790).center.y).toBeGreaterThan(first.y + 100);
    });
  });

  // Excalidraw, 2026-11-18: a drag dropped below its aim, the next
  // step's key (a toolbar, above) set off while the hand still rested at the
  // drop, and the hand then went up to it. The camera went up to the
  // toolbar, back down to the hand as it set off, then up again with it.
  describe("after a drag, toward a target above the drop", () => {
    const drop = { x: 520, y: 420 };
    const toolbar = { x: 700, y: 40 };
    const keys = [
      cameraKey({
        outputTimeMs: 0,
        center: { x: 640, y: 400 },
        scale: 1,
        transitionMs: 0,
      }),
      cameraKey({ outputTimeMs: 1000, center: A, scale: 2 }),
      // Sets off at 3300, while the hand rests at the drop until 4000.
      cameraKey({
        outputTimeMs: 4800,
        center: toolbar,
        scale: 2,
        transitionMs: 1500,
      }),
      // The pull-out sets off at 5750 and moves the centre itself.
      cameraKey({ outputTimeMs: 7000, center: toolbar, scale: 1 }),
    ];
    const pressed = [{ startMs: 1500, endMs: 2500 }];
    /** The largest step down, px per 60 fps frame, from `from` to `to`. */
    const mostDown = (
      t: ReturnType<typeof track>,
      from: number,
      to: number,
    ) => {
      let worst = 0;
      let previous = sampleTrack(t, from).center;
      for (let at = from + 1000 / 60; at <= to; at += 1000 / 60) {
        const now = sampleTrack(t, at).center;
        worst = Math.max(worst, now.y - previous.y);
        previous = now;
      }
      return worst;
    };

    it("never moves down, from the release to the toolbar", () => {
      const hand = pointerThrough([
        [0, A],
        [1500, A],
        [2200, drop],
        [4000, drop],
        [4600, toolbar],
      ]);
      const t = track({ keys, cursorAt: hand, holds: pressed });
      // Premise: the hand rests at the drop, below the aim, then goes up.
      expect(drop.y).toBeGreaterThan(A.y);
      expect(hand(3900)).toEqual(hand(2500));
      expect(mostDown(t, 2500, 5700)).toBeLessThan(0.5);
      expect(dist(sampleTrack(t, 5700).center, toolbar)).toBeLessThan(3);
    });

    // Review of PR #86: the drag's aim was kept for the whole rest, so a
    // step that does not move the pointer (a key press) was never framed.
    it("frames the next step's key while the hand stays at the drop", () => {
      const hand = pointerThrough([
        [0, A],
        [1500, A],
        [2200, drop],
        [7000, drop],
      ]);
      const t = track({ keys, cursorAt: hand, holds: pressed });
      expect(dist(sampleTrack(t, 5000).center, toolbar)).toBeLessThan(3);
    });

    // Review of PR #86: any pause in the hand's travel dropped what was left
    // of its offset at once, and the camera lurched down toward the paused
    // hand, then went up again with it.
    it("does not lurch toward a hand that pauses on its way", () => {
      const midway = { x: 610, y: 230 };
      const hand = pointerThrough([
        [0, A],
        [1500, A],
        [2200, drop],
        [4000, drop],
        [4300, midway],
        [4500, midway],
        [4800, toolbar],
      ]);
      const t = track({ keys, cursorAt: hand, holds: pressed });
      expect(mostDown(t, 2500, 5700)).toBeLessThan(2);
      expect(dist(sampleTrack(t, 5700).center, toolbar)).toBeLessThan(3);
    });
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
