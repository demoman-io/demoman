import {
  composeForTarget,
  derivePresentation,
  GIF_800,
  LANDSCAPE_4K,
  LANDSCAPE_1080P,
  LANDSCAPE_1440P,
  planScene,
  type RenderTarget,
  VERTICAL_1080,
} from "@demoman/compositor";
import {
  BRANDING_DEFAULTS,
  CURSOR_DEFAULTS,
  MOTION_DEFAULTS,
  type SceneDocument,
  type SceneMotion,
} from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { targetFor } from "../../../pages/src/editor/jobs";
import {
  COST_MIN_SAMPLES,
  COST_PERCENTILE,
  COST_WINDOW,
  composeCostEstimate,
  createFrameSourceCache,
  createPlayer,
  createScrubber,
  cursorRedrawNeeded,
  formatClock,
  motionRedrawNeeded,
  PLAYBACK_BUDGET_MS,
  PLAYBACK_HEIGHT_STEP,
  PREVIEW_HEIGHT,
  presentationRedrawNeeded,
  previewHeightFor,
  previewScene,
  previewTarget,
} from "../../../pages/src/editor/preview";

/** Let queued microtasks and the scrubber's own continuation run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("previewTarget", () => {
  it("keeps the deliverable's aspect", () => {
    const preview = previewTarget(LANDSCAPE_4K);
    expect(preview.height).toBe(PREVIEW_HEIGHT);
    expect(preview.width / preview.height).toBeCloseTo(
      LANDSCAPE_4K.width / LANDSCAPE_4K.height,
      6,
    );
  });

  it("keeps fit, so the framing scrubbed is the framing shipped", () => {
    // Most load-bearing on the vertical cut: `cover` is what makes the crop
    // a magnification, and a `contain` preview would show a letterbox the
    // deliverable does not have.
    const preview = previewTarget(VERTICAL_1080);
    expect(preview.fit).toBe("cover");
  });

  it("scales the corner radius with the frame instead of leaving it huge", () => {
    expect(previewTarget(LANDSCAPE_4K).cornerRadius).toBeLessThan(
      LANDSCAPE_4K.cornerRadius,
    );
    expect(previewTarget(LANDSCAPE_4K).cornerRadius).toBeGreaterThanOrEqual(4);
  });

  // Review 2026-10-06: derivePresentation snapped any fit within 1.5 px of
  // its box to the box, a pixel measured at the TARGET's size — so on a fixed
  // preset a near fit came out edge to edge in the preview and with bars in
  // the 4K file, and the author scrubbed a clean edge and exported
  // hairlines. Red if the snap reaches a frame that is not Auto's. The Auto
  // half is the positive control: red if the fix stops the preview of an
  // Auto frame snapping, which is what the snap is for.
  it("frames a near fit in the preview as the file frames it", () => {
    const viewport = { width: 1280, height: 721 };
    const bundle = proceduralBundle({
      viewport,
      keyframes: [
        {
          sourceTimeMs: 0,
          ref: "k-0",
          width: 3840,
          height: 2163,
          actionId: null,
          byteLength: 0,
        },
      ],
    });
    const branding = { ...BRANDING_DEFAULTS, padding: 0 };
    const frame = { padding: 0, viewport };
    const edgeToEdge = (t: RenderTarget) => {
      const f = derivePresentation(branding, t, viewport).frameRect;
      return (
        f.x === 0 && f.y === 0 && f.width === t.width && f.height === t.height
      );
    };
    const sizes = (deliverable: RenderTarget) => [
      deliverable,
      ...[450, 720, 1080, 1440].map((h) => previewTarget(deliverable, h)),
    ];

    const fixed = targetFor("mp4", "16:9", bundle, frame);
    expect(fixed).toBe(LANDSCAPE_4K);
    // Premise: a plain contain fit leaves under a pixel of background each
    // side in the 720 preview and more than two in the file — the spread
    // the old tolerance answered differently.
    const gap = (t: RenderTarget) =>
      t.width - (t.height * viewport.width) / viewport.height;
    expect(gap(previewTarget(fixed, 720))).toBeLessThan(2);
    expect(gap(fixed)).toBeGreaterThan(4);
    expect(sizes(fixed).map(edgeToEdge)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);

    const auto = targetFor("mp4", "auto", bundle, frame);
    expect(sizes(auto).map(edgeToEdge)).toEqual([true, true, true, true, true]);
  });
});

describe("createScrubber", () => {
  it("draws the requested time", async () => {
    const draw = vi.fn().mockResolvedValue(undefined);
    const scrubber = createScrubber({ draw, schedule: (fn) => fn() });
    scrubber.seek(120);
    await scrubber.idle();
    expect(draw).toHaveBeenCalledWith(120);
  });

  it("keeps one draw in flight and renders only the latest request", async () => {
    // A pointer-move storm must not queue fifty 4K composites. Latest-wins
    // is what makes a scrub feel like a scrub.
    //
    // Every draw is held open and its resolver collected, because the
    // scrubber starts a SECOND draw as soon as the first settles. A single
    // `release` variable would be overwritten by that second draw and the
    // test would hang in `idle()` waiting on a promise nothing can resolve.
    const releases: Array<() => void> = [];
    const draw = vi
      .fn()
      .mockImplementation(
        () => new Promise<void>((resolve) => releases.push(resolve)),
      );
    const scrubber = createScrubber({ draw, schedule: (fn) => fn() });

    scrubber.seek(10);
    scrubber.seek(20);
    scrubber.seek(30);
    // Three seeks, one draw: the later two collapse into a single pending
    // request rather than queueing behind each other.
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenLastCalledWith(10);

    // Finish the in-flight draw. The collapsed request then runs — and it is
    // the LAST seek that gets drawn, never the intermediate one.
    releases[0]?.();
    await flush();
    expect(draw).toHaveBeenCalledTimes(2);
    expect(draw).toHaveBeenLastCalledWith(30);

    // Drain, so `idle()` settles instead of waiting on the second draw.
    releases[1]?.();
    await scrubber.idle();
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it("survives a failing draw without wedging the scrubber", async () => {
    const draw = vi
      .fn()
      .mockRejectedValueOnce(new Error("frame missing"))
      .mockResolvedValue(undefined);
    const scrubber = createScrubber({ draw, schedule: (fn) => fn() });
    scrubber.seek(10);
    await scrubber.idle();
    scrubber.seek(20);
    await scrubber.idle();
    expect(draw).toHaveBeenLastCalledWith(20);
  });

  it("does nothing more after dispose", async () => {
    const draw = vi.fn().mockResolvedValue(undefined);
    const scrubber = createScrubber({ draw, schedule: (fn) => fn() });
    scrubber.dispose();
    scrubber.seek(10);
    await scrubber.idle();
    expect(draw).not.toHaveBeenCalled();
  });
});

/**
 * A hand-cranked wall clock and frame pump.
 *
 * The player is driven by real elapsed time, so a test that used real time
 * could only assert "roughly". `advance` moves the clock and runs whatever
 * the player scheduled, which makes every assertion here exact.
 */
function harness(durationMs = 1000, startMs = 0) {
  let nowMs = 0;
  let queued: Array<() => void> = [];
  let looping = false;
  const drawn: number[] = [];
  const player = createPlayer({
    seek: (outputMs) => drawn.push(outputMs),
    durationMs: () => durationMs,
    startMs: () => startMs,
    looping: () => looping,
    now: () => nowMs,
    schedule: (fn) => queued.push(fn),
  });
  return {
    player,
    drawn,
    /** The repeat button, as the page would flip it. */
    setLooping(on: boolean): void {
      looping = on;
    },
    /** Move the clock forward and run one round of scheduled work. */
    advance(ms: number): void {
      nowMs += ms;
      const due = queued;
      queued = [];
      for (const fn of due) fn();
    },
  };
}

describe("createPlayer", () => {
  it("advances the playhead by elapsed wall-clock time", () => {
    // Wall clock, not a frame count: a composite slow enough to miss ticks
    // must cost frames, never stretch the demo. The preview's one promise is
    // that the timing you watch is the timing you ship.
    const { player, advance } = harness();
    player.play();
    advance(250);
    expect(player.positionMs).toBe(250);
    advance(100);
    expect(player.positionMs).toBe(350);
  });

  it("draws each position it advances through", () => {
    const { player, drawn, advance } = harness();
    player.play();
    advance(16);
    advance(16);
    expect(drawn).toEqual([0, 16, 32]);
  });

  it("keeps real time across a tick that took longer than one frame", () => {
    // The dropped-frame case. One slow composite skips the frames it missed
    // rather than replaying them late.
    const { player, drawn, advance } = harness();
    player.play();
    advance(500);
    expect(player.positionMs).toBe(500);
    expect(drawn).toEqual([0, 500]);
  });

  it("stops at the end instead of running past the last frame", () => {
    const { player, advance } = harness(1000);
    player.play();
    advance(1500);
    expect(player.positionMs).toBe(1000);
    expect(player.playing).toBe(false);
  });

  it("restarts from the beginning when played from the end", () => {
    const { player, advance } = harness(1000);
    player.play();
    advance(1000);
    expect(player.playing).toBe(false);

    player.play();
    expect(player.positionMs).toBe(0);
    advance(100);
    expect(player.positionMs).toBe(100);
  });

  it("freezes the playhead while paused", () => {
    const { player, advance } = harness();
    player.play();
    advance(200);
    player.pause();
    advance(500);
    expect(player.positionMs).toBe(200);
    expect(player.playing).toBe(false);
  });

  it("resumes from where it was paused, not from where the clock is", () => {
    // The bug an absolute clock would have: pausing for five seconds and
    // pressing play would jump five seconds into the demo.
    const { player, advance } = harness(10_000);
    player.play();
    advance(200);
    player.pause();
    advance(5000);
    player.play();
    advance(100);
    expect(player.positionMs).toBe(300);
  });

  it("re-anchors the clock when scrubbed mid-playback", () => {
    const { player, advance } = harness(10_000);
    player.play();
    advance(200);
    player.seek(5000);
    advance(100);
    expect(player.positionMs).toBe(5100);
    expect(player.playing).toBe(true);
  });

  it("draws a scrub while paused without starting playback", () => {
    const { player, drawn, advance } = harness();
    player.seek(400);
    expect(drawn).toEqual([400]);
    expect(player.playing).toBe(false);
    advance(100);
    expect(player.positionMs).toBe(400);
  });

  it("clamps a scrub to the demo it has", () => {
    const { player } = harness(1000);
    player.seek(4000);
    expect(player.positionMs).toBe(1000);
    player.seek(-40);
    expect(player.positionMs).toBe(0);
  });

  it("toggles between playing and paused", () => {
    const { player } = harness();
    player.toggle();
    expect(player.playing).toBe(true);
    player.toggle();
    expect(player.playing).toBe(false);
  });

  it("refuses to play a demo with no duration", () => {
    // The no-bundle case. Playing here would run a clock over nothing and
    // report a Pause button for a demo that is not playing.
    const { player, advance } = harness(0);
    player.play();
    expect(player.playing).toBe(false);
    advance(100);
    expect(player.positionMs).toBe(0);
  });

  it("reports every change so the transport can redraw", () => {
    const changes = vi.fn();
    let nowMs = 0;
    const queued: Array<() => void> = [];
    const player = createPlayer({
      seek: () => {},
      durationMs: () => 1000,
      now: () => nowMs,
      schedule: (fn) => queued.push(fn),
      onChange: changes,
    });
    player.play();
    expect(changes).toHaveBeenCalledTimes(1);
    nowMs += 100;
    for (const fn of queued.splice(0)) fn();
    expect(changes).toHaveBeenCalledTimes(2);
    player.pause();
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("does nothing more after dispose", () => {
    const { player, advance } = harness();
    player.play();
    player.dispose();
    advance(100);
    expect(player.positionMs).toBe(0);
    expect(player.playing).toBe(false);
  });

  it("plays from the trim's head and stops at its tail", () => {
    const seeks: number[] = [];
    let now = 0;
    const queue: (() => void)[] = [];
    const player = createPlayer({
      seek: (ms) => seeks.push(ms),
      durationMs: () => 5000,
      startMs: () => 1000,
      now: () => now,
      schedule: (fn) => queue.push(fn),
    });
    player.play();
    expect(seeks.at(-1)).toBe(1000);
    now = 10_000;
    queue.shift()?.();
    expect(player.positionMs).toBe(5000);
    expect(player.playing).toBe(false);
    player.seek(200);
    expect(player.positionMs).toBe(1000); // clamped to the head
  });
});

/**
 * J / K / L, the one NLE habit this editor can afford exactly.
 *
 * Playback here is already a wall-clock derivation over composites that cost
 * tens of milliseconds, so a rate is a multiplier on that derivation rather
 * than new machinery — and a faster rate asks for FEWER composites per second
 * of take, not more. Reverse is the same arithmetic with a negative sign.
 */
function shuttleHarness(args: { durationMs?: number; startMs?: number } = {}) {
  const durationMs = args.durationMs ?? 10_000;
  const startMs = args.startMs ?? 0;
  let nowMs = 0;
  let queued: Array<() => void> = [];
  const drawn: number[] = [];
  let changes = 0;
  const player = createPlayer({
    seek: (outputMs) => drawn.push(outputMs),
    durationMs: () => durationMs,
    startMs: () => startMs,
    now: () => nowMs,
    schedule: (fn) => queued.push(fn),
    onChange: () => {
      changes += 1;
    },
  });
  return {
    player,
    drawn,
    changeCount: () => changes,
    advance(ms: number): void {
      nowMs += ms;
      const due = queued;
      queued = [];
      for (const fn of due) fn();
    },
  };
}

describe("createPlayer — shuttle", () => {
  it("plays forward at normal speed on the first shuttle", () => {
    const { player, advance } = shuttleHarness();
    player.shuttle(1);
    expect(player.playing).toBe(true);
    expect(player.rate).toBe(1);
    advance(500);
    expect(player.positionMs).toBe(500);
  });

  it("doubles the rate on each further tap in the same direction", () => {
    const { player, advance } = shuttleHarness();
    player.shuttle(1);
    player.shuttle(1);
    expect(player.rate).toBe(2);
    advance(500);
    expect(player.positionMs).toBe(1000);

    player.shuttle(1);
    expect(player.rate).toBe(4);
    advance(500);
    expect(player.positionMs).toBe(3000);
  });

  it("stops doubling at 4x", () => {
    const { player } = shuttleHarness();
    for (let i = 0; i < 6; i += 1) player.shuttle(1);
    expect(player.rate).toBe(4);
  });

  it("runs the playhead backwards on the reverse shuttle", () => {
    const { player, advance } = shuttleHarness();
    player.seek(5000);
    player.shuttle(-1);
    expect(player.rate).toBe(-1);
    advance(1000);
    expect(player.positionMs).toBe(4000);
  });

  it("returns to normal speed when the opposite key is pressed", () => {
    // Pressing J at 4x forward means "now go the other way", not "go
    // backwards four times as fast". Anything else makes the pair of keys
    // impossible to aim.
    const { player } = shuttleHarness();
    player.seek(5000);
    player.shuttle(1);
    player.shuttle(1);
    player.shuttle(1);
    expect(player.rate).toBe(4);
    player.shuttle(-1);
    expect(player.rate).toBe(-1);
  });

  it("holds at the trim's head rather than running past it in reverse", () => {
    const { player, advance } = shuttleHarness({ startMs: 1000 });
    player.seek(2000);
    player.shuttle(-1);
    advance(5000);
    expect(player.positionMs).toBe(1000);
    expect(player.playing).toBe(false);
    expect(player.rate).toBe(1);
  });

  it("stops at the tail in fast forward, without overshooting it", () => {
    const { player, advance } = shuttleHarness({ durationMs: 4000 });
    player.shuttle(1);
    player.shuttle(1);
    player.shuttle(1);
    advance(5000);
    expect(player.positionMs).toBe(4000);
    expect(player.playing).toBe(false);
  });

  it("does not treat the start as an end when playing forward", () => {
    // The reverse guard lives in the shared tick. Playing forward from
    // exactly `start()` with no elapsed time puts `next` ON the start, and
    // a `<=` there ends the take before it began — reporting through the
    // same path a finished one does. rAF and a real clock make this
    // unreachable in a browser; an injected clock reaches it, and a guard
    // that fires on a run it was not written for is the defect either way.
    const { player, advance } = shuttleHarness({ startMs: 1000 });
    player.seek(1000);
    player.play();
    advance(0);
    expect(player.playing).toBe(true);
    advance(500);
    expect(player.positionMs).toBe(1500);
  });

  it("stops and forgets the rate on stop", () => {
    const { player, advance } = shuttleHarness();
    player.shuttle(1);
    player.shuttle(1);
    advance(100);
    player.stop();
    expect(player.playing).toBe(false);
    expect(player.rate).toBe(1);
    const held = player.positionMs;
    advance(1000);
    expect(player.positionMs).toBe(held);
  });

  it("plays at normal speed after a shuttle was stopped", () => {
    const { player, advance } = shuttleHarness();
    player.shuttle(1);
    player.shuttle(1);
    player.stop();
    player.play();
    advance(500);
    expect(player.positionMs).toBe(500);
  });

  it("forgets the rate on pause as well, so the button never resumes at 4x", () => {
    const { player } = shuttleHarness();
    player.shuttle(-1);
    player.pause();
    expect(player.rate).toBe(1);
  });

  it("reports the rate change so the transport can show it", () => {
    const { player, changeCount } = shuttleHarness();
    const before = changeCount();
    player.shuttle(1);
    player.shuttle(1);
    expect(changeCount()).toBeGreaterThan(before + 1);
  });

  it("keeps a mid-shuttle scrub honest by re-anchoring the clock", () => {
    const { player, advance } = shuttleHarness();
    player.shuttle(1);
    player.shuttle(1);
    advance(100);
    player.seek(6000);
    advance(100);
    expect(player.positionMs).toBe(6200);
  });

  it("does nothing on a shuttle after dispose", () => {
    const { player, advance } = shuttleHarness();
    player.dispose();
    player.shuttle(1);
    expect(player.playing).toBe(false);
    advance(500);
    expect(player.positionMs).toBe(0);
  });

  it("refuses to shuttle a take with no duration", () => {
    const { player } = shuttleHarness({ durationMs: 0 });
    player.shuttle(1);
    expect(player.playing).toBe(false);
  });
});

describe("createScrubber failure reporting", () => {
  it("reports a failed draw rather than only swallowing it", async () => {
    // The swallow itself is right — a missing frame mid-regeneration must not
    // wedge the scrubber. What was missing is anywhere for it to speak: under
    // playback a frozen canvas with a clock still running is indistinguishable
    // from a demo that holds still.
    const onDrawFailed = vi.fn();
    const draw = vi.fn().mockRejectedValue(new Error("frame missing"));
    const scrubber = createScrubber({
      draw,
      schedule: (fn) => fn(),
      onDrawFailed,
    });
    scrubber.seek(10);
    await scrubber.idle();
    expect(onDrawFailed).toHaveBeenCalledTimes(1);
    expect(onDrawFailed.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("says the draw recovered, so a stale failure can be taken down", () => {
    // The mirror of the rule that put `onDrawFailed` here. A page that only
    // ever hears about failures keeps showing "the preview stopped" over a
    // preview that is drawing again — a report that has outlived what it
    // reports.
    const onDrawRecovered = vi.fn();
    const scrubber = createScrubber({
      draw: vi.fn().mockResolvedValue(undefined),
      schedule: (fn) => fn(),
      onDrawFailed: vi.fn(),
      onDrawRecovered,
    });
    scrubber.seek(10);
    return scrubber.idle().then(() => {
      expect(onDrawRecovered).toHaveBeenCalledTimes(1);
    });
  });

  it("does not call the draw recovered when the draw failed", async () => {
    const onDrawRecovered = vi.fn();
    const scrubber = createScrubber({
      draw: vi.fn().mockRejectedValue(new Error("frame missing")),
      schedule: (fn) => fn(),
      onDrawFailed: vi.fn(),
      onDrawRecovered,
    });
    scrubber.seek(10);
    await scrubber.idle();
    expect(onDrawRecovered).not.toHaveBeenCalled();
  });

  it("says nothing when the draw succeeded", async () => {
    const onDrawFailed = vi.fn();
    const scrubber = createScrubber({
      draw: vi.fn().mockResolvedValue(undefined),
      schedule: (fn) => fn(),
      onDrawFailed,
    });
    scrubber.seek(10);
    await scrubber.idle();
    expect(onDrawFailed).not.toHaveBeenCalled();
  });
});

describe("formatClock", () => {
  it("reads as minutes and seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(3400)).toBe("0:03");
    expect(formatClock(72_000)).toBe("1:12");
    expect(formatClock(605_000)).toBe("10:05");
  });

  it("never shows a negative or fractional time", () => {
    expect(formatClock(-1)).toBe("0:00");
    expect(formatClock(999)).toBe("0:00");
  });
});

describe("createFrameSourceCache", () => {
  const bundle = proceduralBundle();
  const other = proceduralBundle({ sceneId: "scene-other" });
  const source = { at: async () => null, describe: () => null } as never;

  it("builds one source per bundle, however many frames are drawn", async () => {
    // The reason playback is affordable at all. Building per draw stands up
    // an H.264 decoder for every motion span sixty times a second.
    const build = vi.fn().mockResolvedValue(source);
    const framesFor = createFrameSourceCache(build);
    await framesFor(bundle);
    await framesFor(bundle);
    await framesFor(bundle);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when a regeneration lands a different bundle", async () => {
    const build = vi.fn().mockResolvedValue(source);
    const framesFor = createFrameSourceCache(build);
    await framesFor(bundle);
    await framesFor(other);
    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenLastCalledWith(other);
  });

  it("reports a failed build rather than resolving to nothing", async () => {
    const build = vi.fn().mockRejectedValue(new Error("frames are gone"));
    const framesFor = createFrameSourceCache(build);
    await expect(framesFor(bundle)).rejects.toThrow("frames are gone");
  });

  it("does not cache a failed build, so the next draw tries again", async () => {
    // A cached rejection would outlive the transient read that caused it and
    // fail every later draw against frames that are perfectly fine.
    const build = vi
      .fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue(source);
    const framesFor = createFrameSourceCache(build);
    await expect(framesFor(bundle)).rejects.toThrow("read failed");
    await expect(framesFor(bundle)).resolves.toBe(source);
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe("cursorRedrawNeeded", () => {
  it("asks for the first draw", () => {
    expect(cursorRedrawNeeded(null, CURSOR_DEFAULTS)).toBe(true);
  });

  it("asks for a redraw when any field moves", () => {
    for (const patch of [
      { hidden: true },
      { style: "dark" as const },
      { scale: 1.5 },
      { motionBlur: 0 },
      { hideWhenIdle: true },
      { tilt: 0.9 },
      { clickBounce: 2 },
    ]) {
      expect(
        cursorRedrawNeeded(CURSOR_DEFAULTS, { ...CURSOR_DEFAULTS, ...patch }),
      ).toBe(true);
    }
  });

  it("asks for nothing when the look is unchanged", () => {
    // `render()` runs on every edit, every session emit and every
    // render-progress message. An unconditional re-seek here would redraw
    // the canvas on all of them.
    expect(cursorRedrawNeeded(CURSOR_DEFAULTS, { ...CURSOR_DEFAULTS })).toBe(
      false,
    );
  });

  it("asks for a redraw when an optional field is taken away", () => {
    // An undo past the first Tilt edit hands back a block without `tilt`
    // while the canvas was drawn with one. Premise: the live block really
    // lacks the key, so this is the case that walking `live`'s keys alone
    // could never visit.
    const live = { ...CURSOR_DEFAULTS };
    expect("tilt" in live).toBe(false);
    expect(cursorRedrawNeeded({ ...CURSOR_DEFAULTS, tilt: 0.9 }, live)).toBe(
      true,
    );
  });
});

describe("motionRedrawNeeded", () => {
  it("asks for the first draw", () => {
    expect(motionRedrawNeeded(null, MOTION_DEFAULTS)).toBe(true);
  });

  it("asks for a redraw when any field moves", () => {
    for (const patch of [{ smoothness: 0.9 }, { blur: 0 }, { follow: false }]) {
      expect(
        motionRedrawNeeded(MOTION_DEFAULTS, { ...MOTION_DEFAULTS, ...patch }),
        JSON.stringify(patch),
      ).toBe(true);
    }
  });

  it("asks for nothing when the motion is unchanged", () => {
    expect(motionRedrawNeeded(MOTION_DEFAULTS, { ...MOTION_DEFAULTS })).toBe(
      false,
    );
  });
});

describe("previewScene", () => {
  /** One zoom on the first step with no authored end, so its segment ends
   *  where the smoothness-set pull-out lands. */
  const zoomed = (): SceneDocument => ({
    ...readonlyScene(),
    camera: [
      {
        id: "cam-1",
        kind: "zoom" as const,
        anchorId: "a-search",
        marker: { actionId: "act-1", offsetMs: 0 },
        scale: 1.6,
      },
    ],
  });
  const compose = (scene: SceneDocument) =>
    composeForTarget({
      plan: planScene(scene),
      bundle: proceduralBundle({ motionSpans: [] }),
      scene,
      target: LANDSCAPE_1080P,
    }).resolved;
  const layered = (stored: SceneDocument, motion: SceneMotion | undefined) =>
    previewScene(stored, {
      cursor: stored.cursor,
      branding: stored.branding,
      motion,
    });

  it("hands back the stored document itself when nothing is layered", () => {
    const stored = zoomed();
    expect(layered(stored, stored.motion)).toBe(stored);
    // And writes no `motion` key for a document that has none.
    const withCursor = previewScene(stored, {
      cursor: { ...stored.cursor, scale: 1.5 },
      branding: stored.branding,
      motion: undefined,
    });
    expect("motion" in withCursor).toBe(false);
  });

  // The camera preview re-solves the camera: a smoothness drag layered here
  // lengthens the zoom's pull-out in the keys the canvas is composed from.
  it("re-solves the camera from a dragged smoothness", () => {
    const stored = zoomed();
    const at = compose(stored).cameraSegments.find((s) => s.id === "cam-1");
    const smoother = compose(
      layered(stored, { ...MOTION_DEFAULTS, smoothness: 1 }),
    ).cameraSegments.find((s) => s.id === "cam-1");
    if (!at || !smoother) throw new Error("the zoom produced no segment");
    // Premise: the stored segment is not pinned to the end of the take,
    // so a longer pull-out has room to show.
    expect(at.endMs).toBeLessThan(
      compose(stored).timeline.outputDurationMs - 500,
    );
    expect(smoother.endMs).toBeGreaterThan(at.endMs);
  });
});

describe("presentationRedrawNeeded", () => {
  const viewport = { width: 1280, height: 800 };
  const drawn = derivePresentation(
    {
      background: { kind: "solid", color: "#3b5bdb" },
      logo: null,
      padding: 0.08,
    },
    LANDSCAPE_1080P,
    viewport,
  );

  it("asks for the first draw", () => {
    expect(presentationRedrawNeeded(null, drawn)).toBe(true);
  });

  it("asks for a redraw when the primary colour moves", () => {
    const live = derivePresentation(
      {
        background: { kind: "solid", color: "#e03131" },
        logo: null,
        padding: 0.08,
      },
      LANDSCAPE_1080P,
      viewport,
    );
    // The premise: the two presentations carry different backgrounds. Were
    // `derivePresentation` to stop reading the colour, this would be the
    // assertion to fail rather than the one below passing for free.
    expect(live.background).not.toEqual(drawn.background);
    expect(presentationRedrawNeeded(drawn, live)).toBe(true);
  });

  it("asks for a redraw when the colour returns to the default", () => {
    const live = derivePresentation(
      BRANDING_DEFAULTS,
      LANDSCAPE_1080P,
      viewport,
    );
    expect(presentationRedrawNeeded(drawn, live)).toBe(true);
  });

  const image = {
    image: {},
    width: 200,
    height: 100,
    sourceTimeMs: 0,
  } as never;

  it("asks for a redraw when the wallpaper's image lands", () => {
    // The background names the wallpaper before its image is decoded: the
    // frame drawn then is the neutral, and the same background with the
    // image is a different picture. Red if the image is not compared.
    const onWallpaper = {
      background: { kind: "wallpaper" as const, id: "vivid-1" },
      logo: null,
      padding: 0.08,
    };
    const before = derivePresentation(onWallpaper, LANDSCAPE_1080P, viewport);
    const after = derivePresentation(
      onWallpaper,
      LANDSCAPE_1080P,
      viewport,
      null,
      image,
    );
    expect(before.wallpaper).toBeNull();
    expect(after.wallpaper).not.toBeNull();
    expect(presentationRedrawNeeded(before, after)).toBe(true);
    expect(presentationRedrawNeeded(after, after)).toBe(false);
  });

  const logo = (patch: object = {}) => ({
    ref: "logo:a",
    corner: "bottom-right" as const,
    size: 0.06,
    opacity: 0.9,
    ...patch,
  });
  const withLogo = (patch: object = {}) =>
    derivePresentation(
      {
        background: { kind: "solid", color: "#3b5bdb" },
        logo: logo(patch),
        padding: 0.08,
      },
      LANDSCAPE_1080P,
      viewport,
      image,
    );

  it("asks for a redraw when the gradient angle moves", () => {
    const at = (angle: number) =>
      derivePresentation(
        {
          background: {
            kind: "gradient",
            from: "#000000",
            to: "#ffffff",
            angle,
          },
          logo: null,
          padding: 0.08,
        },
        LANDSCAPE_1080P,
        viewport,
      );
    expect(presentationRedrawNeeded(at(90), at(135))).toBe(true);
  });

  it("asks for a redraw when a solid becomes a gradient of the same colour", () => {
    const gradient = derivePresentation(
      {
        background: {
          kind: "gradient",
          from: "#3b5bdb",
          to: "#3b5bdb",
          angle: 0,
        },
        logo: null,
        padding: 0.08,
      },
      LANDSCAPE_1080P,
      viewport,
    );
    expect(presentationRedrawNeeded(drawn, gradient)).toBe(true);
  });

  it("asks for a redraw when the logo moves corner", () => {
    const a = withLogo();
    const b = withLogo({ corner: "top-left" });
    // Premise: the two differ in where the mark lands, and only there.
    expect(a.logo?.rect).not.toEqual(b.logo?.rect);
    expect(a.logo?.opacity).toBe(b.logo?.opacity);
    expect(presentationRedrawNeeded(a, b)).toBe(true);
  });

  it("asks for a redraw when the logo's opacity moves", () => {
    const a = withLogo();
    const b = withLogo({ opacity: 0.5 });
    expect(a.logo?.rect).toEqual(b.logo?.rect);
    expect(presentationRedrawNeeded(a, b)).toBe(true);
  });

  it("asks for nothing when a logo'd backdrop is re-derived unchanged", () => {
    // `derivePresentation` builds a fresh placed-logo object every time, so
    // an identity comparison would redraw on every render.
    const a = withLogo();
    const b = withLogo();
    expect(a.logo).not.toBe(b.logo);
    expect(presentationRedrawNeeded(a, b)).toBe(false);
  });

  it("asks for a redraw when a logo lands", () => {
    expect(presentationRedrawNeeded(drawn, withLogo())).toBe(true);
  });

  it("asks for nothing when the backdrop is unchanged", () => {
    // Re-derived, not the same object: `render()` derives a fresh
    // presentation on every edit, emit and render-progress message.
    const live = derivePresentation(
      {
        background: { kind: "solid", color: "#3b5bdb" },
        logo: null,
        padding: 0.08,
      },
      LANDSCAPE_1080P,
      viewport,
    );
    expect(live).not.toBe(drawn);
    expect(presentationRedrawNeeded(drawn, live)).toBe(false);
  });
});

/**
 * How tall the preview bitmap should be, added 2026-09-21.
 *
 * `PREVIEW_HEIGHT` was the only answer, and a fixed 720 means the preview is
 * upscaled to whatever the stage paints it at — measured at 1.82x on a DPR-2
 * laptop. Raising landscape's padding to 0.15 made that visibly worse
 * without changing the ratio at all: the inset takes its share of a fixed
 * bitmap, so the app inside it fell from 1184px to 921px and the author saw
 * a preview that had genuinely lost a fifth of its resolution.
 *
 * Composing at the painted size costs what the pixels cost — measured in the
 * compositor's browser lane, 11.8ms/frame at 1280x720 against 40.3ms at
 * 2336x1314, i.e. 3.40x for 3.33x the pixels. A 25fps compose ceiling is the
 * wrong trade for playback and the right one for a still, which is the split
 * every NLE already makes.
 */
describe("previewHeightFor", () => {
  const painted = { paintedCssWidth: 1168, devicePixelRatio: 2 };

  it("drops to the playback height while playing", () => {
    expect(
      previewHeightFor({ ...painted, target: LANDSCAPE_1440P, playing: true }),
    ).toBe(PREVIEW_HEIGHT);
  });

  it("matches the painted device pixels when parked", () => {
    // 1168 CSS x 2 = 2336 device px wide; at 16:9 that is 1314 tall.
    expect(
      previewHeightFor({ ...painted, target: LANDSCAPE_1440P, playing: false }),
    ).toBe(1314);
  });

  // The cap. Past the deliverable's own resolution there is nothing to show:
  // the extra pixels are invented, and they are the most expensive pixels in
  // the loop.
  it("never exceeds the deliverable's own height", () => {
    const height = previewHeightFor({
      paintedCssWidth: 4000,
      devicePixelRatio: 3,
      target: LANDSCAPE_1440P,
      playing: false,
    });
    expect(height).toBe(LANDSCAPE_1440P.height);
  });

  // The floor. A tiny window must not make the preview WORSE than playback.
  it("never goes below the playback height", () => {
    expect(
      previewHeightFor({
        paintedCssWidth: 200,
        devicePixelRatio: 1,
        target: LANDSCAPE_1440P,
        playing: false,
      }),
    ).toBe(PREVIEW_HEIGHT);
  });

  // Before the first layout there is no rect to read. Answering 0 would hand
  // `previewTarget` a zero-height bitmap and blank the stage — a measurement
  // that never arrived, drawn exactly like a demo with nothing in it.
  it("falls back to the playback height when nothing has been painted yet", () => {
    for (const paintedCssWidth of [0, Number.NaN]) {
      expect(
        previewHeightFor({
          paintedCssWidth,
          devicePixelRatio: 2,
          target: LANDSCAPE_1440P,
          playing: false,
        }),
      ).toBe(PREVIEW_HEIGHT);
    }
  });

  // The cap binds the fallbacks too. GIF is 450 tall, under the floor: its
  // parked answer is 450, and a fallback of a flat 720 composed playback
  // (and an unpainted stage) at a bitmap larger than the export itself —
  // so the height flipped on every play and pause, and the zoom clamp with
  // it. Verified failable: returning `PREVIEW_HEIGHT` bare from either
  // fallback fails the matching line.
  it("caps its fallbacks at a deliverable shorter than the floor", () => {
    // Premise: the deliverable really is under the floor.
    expect(GIF_800.height).toBeLessThan(PREVIEW_HEIGHT);
    const parked = previewHeightFor({
      ...painted,
      target: GIF_800,
      playing: false,
    });
    expect(parked).toBe(GIF_800.height);
    expect(
      previewHeightFor({ ...painted, target: GIF_800, playing: true }),
      "playing, uncalibrated",
    ).toBe(parked);
    expect(
      previewHeightFor({
        paintedCssWidth: 0,
        devicePixelRatio: 2,
        target: GIF_800,
        playing: false,
      }),
      "nothing painted yet",
    ).toBe(parked);
  });

  it("follows the target's aspect rather than assuming 16:9", () => {
    // VERTICAL_1080 is 1080x1920. 600 CSS x 2 = 1200 device px wide, so the
    // height that keeps its aspect is 2133 — over the cap, which wins.
    expect(
      previewHeightFor({
        paintedCssWidth: 600,
        devicePixelRatio: 2,
        target: VERTICAL_1080,
        playing: false,
      }),
    ).toBe(VERTICAL_1080.height);
    // Half that width leaves it under the cap and the aspect shows.
    expect(
      previewHeightFor({
        paintedCssWidth: 250,
        devicePixelRatio: 2,
        target: VERTICAL_1080,
        playing: false,
      }),
    ).toBe(Math.round((500 * VERTICAL_1080.height) / VERTICAL_1080.width));
  });
});

describe("previewTarget at an explicit height", () => {
  it("takes the height it is given and keeps the aspect", () => {
    const preview = previewTarget(LANDSCAPE_1440P, 1314);
    expect(preview.height).toBe(1314);
    expect(preview.width).toBe(
      Math.round((1314 * LANDSCAPE_1440P.width) / LANDSCAPE_1440P.height),
    );
  });

  it("still defaults to the playback height", () => {
    expect(previewTarget(LANDSCAPE_1440P).height).toBe(PREVIEW_HEIGHT);
  });

  // The radius is in output pixels, so it has to follow the bitmap or a
  // full-resolution still draws the deliverable's corners at a third of
  // their size.
  it("scales the corner radius with the height it was given", () => {
    const small = previewTarget(LANDSCAPE_1440P, PREVIEW_HEIGHT).cornerRadius;
    const big = previewTarget(LANDSCAPE_1440P, 1314).cornerRadius;
    expect(big).toBeGreaterThan(small);
    expect(big).toBe(
      Math.round(
        (LANDSCAPE_1440P.cornerRadius * 1314) / LANDSCAPE_1440P.height,
      ),
    );
  });
});

/**
 * Sizing playback to the machine, added 2026-09-21.
 *
 * Playback took a flat `PREVIEW_HEIGHT` because a browser-lane measurement
 * put a full-resolution composite at ~25fps. That measurement was made in
 * HEADLESS chromium, which rasterises through SwiftShader; the same work on
 * the author's real GPU runs 6.6x faster (1280x720: 40.9ms headless against
 * 6.2ms headed; 2336x1314: 149.0ms against 15.2ms). A constant picked from
 * either number is wrong on the other machine, and the spread is too wide
 * to split the difference.
 *
 * So the height is solved for, from a cost the preview measures itself.
 * Compose cost is proportional to destination area to within a percent —
 * measured 11.8, 11.7, 11.8 and 11.9 ms per unit area across four
 * resolutions — so one `msPerMegapixel` sample predicts every other size.
 */
describe("previewHeightFor, sizing playback to the measured machine", () => {
  const painted = { paintedCssWidth: 1168, devicePixelRatio: 2 };
  const parked = previewHeightFor({
    ...painted,
    target: LANDSCAPE_1440P,
    playing: false,
  });

  // The premise. Every case below is about playback landing somewhere
  // BETWEEN the floor and this, so a parked height equal to the floor would
  // make them all vacuous.
  it("has room between the floor and the parked height to choose from", () => {
    expect(parked).toBe(1314);
    expect(parked).toBeGreaterThan(PREVIEW_HEIGHT);
  });

  it("takes the parked height when the machine composes well inside budget", () => {
    // 2336x1314 is 3.07 megapixels; at 2ms each that is 6.1ms, inside the
    // budget, so there is nothing to give up.
    expect(
      previewHeightFor({
        ...painted,
        target: LANDSCAPE_1440P,
        playing: true,
        msPerMegapixel: 2,
      }),
    ).toBe(parked);
  });

  it("steps down when the machine cannot afford the parked height", () => {
    const height = previewHeightFor({
      ...painted,
      target: LANDSCAPE_1440P,
      playing: true,
      msPerMegapixel: 12,
    });
    expect(height).toBeLessThan(parked);
    expect(height).toBeGreaterThanOrEqual(PREVIEW_HEIGHT);
  });

  it("keeps what it picks inside the budget", () => {
    for (const msPerMegapixel of [4, 8, 12, 20]) {
      const height = previewHeightFor({
        ...painted,
        target: LANDSCAPE_1440P,
        playing: true,
        msPerMegapixel,
      });
      // Only meaningful above the floor: the floor wins outright below it,
      // which the next case is about.
      if (height > PREVIEW_HEIGHT) {
        const megapixels = ((height * 16) / 9) * height * 1e-6;
        expect(megapixels * msPerMegapixel).toBeLessThanOrEqual(
          PLAYBACK_BUDGET_MS,
        );
      }
    }
  });

  // The floor beats the budget. A machine too slow for 720p gets 720p and
  // drops frames — dropping resolution further would make the preview
  // useless to judge framing by, which is the one thing it is for.
  it("never goes below the floor however slow the machine is", () => {
    expect(
      previewHeightFor({
        ...painted,
        target: LANDSCAPE_1440P,
        playing: true,
        msPerMegapixel: 500,
      }),
    ).toBe(PREVIEW_HEIGHT);
  });

  // Nothing measured yet, or every draw so far has failed: take the floor
  // rather than guessing high and dropping frames on the first playback.
  it("takes the floor until something has actually been measured", () => {
    for (const msPerMegapixel of [null, undefined, Number.NaN, -1]) {
      expect(
        previewHeightFor({
          ...painted,
          target: LANDSCAPE_1440P,
          playing: true,
          msPerMegapixel,
        }),
      ).toBe(PREVIEW_HEIGHT);
    }
  });

  // A machine fast enough to measure zero is not an uncalibrated one.
  it("reads a measured zero as free, not as unmeasured", () => {
    expect(
      previewHeightFor({
        ...painted,
        target: LANDSCAPE_1440P,
        playing: true,
        msPerMegapixel: 0,
      }),
    ).toBe(parked);
  });

  /**
   * Hysteresis. The estimate moves a little on every draw, and the height is
   * re-chosen on every play — without a step, two consecutive plays on an
   * unchanged machine could compose at different sizes, which is a visible
   * flicker with no cause the author can see.
   */
  it("snaps to a step, so measurement noise does not move it", () => {
    const heights = [11.5, 11.7, 11.9, 12.1, 12.3].map((msPerMegapixel) =>
      previewHeightFor({
        ...painted,
        target: LANDSCAPE_1440P,
        playing: true,
        msPerMegapixel,
      }),
    );
    expect(new Set(heights).size).toBe(1);
    const [only] = heights;
    expect((only as number) % PLAYBACK_HEIGHT_STEP).toBe(0);
  });

  it("never exceeds the parked height even on an idle machine", () => {
    expect(
      previewHeightFor({
        ...painted,
        target: LANDSCAPE_1440P,
        playing: true,
        msPerMegapixel: 0.001,
      }),
    ).toBe(parked);
  });
});

/**
 * The cost estimate, rewritten 2026-09-21 the same day it landed.
 *
 * It was a decaying maximum — `max(sample, previous * 0.98)` — on the
 * reasoning that a budget is a ceiling and so wants the expensive frames
 * rather than the typical one. That reasoning is right and the estimator
 * was wrong, in two ways that compound:
 *
 * - It is SEEDED BY THE WORST DRAW OF THE SESSION. The first composite
 *   pays decoder warmup and allocation and runs several times typical, so
 *   the estimate opens ~4x too high and 2%/draw takes ~35 draws to work it
 *   off.
 * - ONE STALL RE-PINS IT. A GC pause puts it straight back to the top.
 *
 * Simulated against a realistic draw sequence, the chosen height sat at the
 * 720p floor for the first ~30 draws, touched 810p, and fell back to 720p
 * on the next stall — never reaching the 1080p the machine could afford.
 * The author reported it as "a bit sharper at times", which is exactly the
 * shape of that wander.
 *
 * A high percentile over a recent window keeps the intent — describe the
 * expensive end, not the mean — while ageing the cold draw out and
 * absorbing isolated stalls.
 */
describe("composeCostEstimate", () => {
  const flat = (n: number, ms: number): number[] => Array(n).fill(ms);

  it("says nothing until it has seen enough draws", () => {
    expect(composeCostEstimate([])).toBeNull();
    expect(composeCostEstimate(flat(COST_MIN_SAMPLES - 1, 5))).toBeNull();
    expect(composeCostEstimate(flat(COST_MIN_SAMPLES, 5))).not.toBeNull();
  });

  it("reports the steady cost of a steady machine", () => {
    expect(composeCostEstimate(flat(20, 5))).toBe(5);
  });

  // The whole point of a percentile rather than a mean: the budget is a
  // ceiling, so the estimate has to sit above the middle of the spread.
  it("sits at the expensive end of the spread, not the middle", () => {
    const spread = Array.from({ length: 20 }, (_, i) => 4 + i * 0.1);
    const mean = spread.reduce((a, b) => a + b, 0) / spread.length;
    const estimate = composeCostEstimate(spread) as number;
    expect(estimate).toBeGreaterThan(mean);
    expect(estimate).toBeLessThan(Math.max(...spread));
  });

  // The defect this replaced. One 4x warmup draw must not set the estimate.
  it("is not seeded by a single cold first draw", () => {
    const withWarmup = [20, ...flat(19, 5)];
    expect(composeCostEstimate(withWarmup)).toBe(5);
  });

  // The other half: an isolated stall mid-session.
  it("absorbs an isolated stall", () => {
    const withStall = [...flat(10, 5), 30, ...flat(9, 5)];
    expect(composeCostEstimate(withStall)).toBe(5);
  });

  // But a machine that is REALLY slower has to be believed, or the preview
  // would keep asking for a resolution it cannot hold.
  it("follows a machine that genuinely got slower", () => {
    const before = composeCostEstimate(flat(20, 5)) as number;
    const after = composeCostEstimate(flat(20, 15)) as number;
    expect(after).toBeGreaterThan(before * 2);
  });

  /**
   * The window is what lets it recover. Without one the cold draw and every
   * stall stay in the sample for the life of the session, and the estimate
   * only ever ratchets toward the worst thing that ever happened.
   */
  it("forgets draws that have fallen out of the window", () => {
    const old = flat(COST_WINDOW, 40);
    const recent = flat(COST_WINDOW, 5);
    expect(composeCostEstimate([...old, ...recent])).toBe(5);
  });

  it("takes the percentile it documents", () => {
    // 0..99 inclusive: the p-th value of a uniform ramp is p*99, and the
    // index rule is ceil(p*n)-1, so this pins the convention rather than
    // just asserting it is somewhere plausible.
    const ramp = Array.from({ length: 100 }, (_, i) => i).slice(
      100 - COST_WINDOW,
    );
    const sorted = [...ramp].sort((a, b) => a - b);
    const index = Math.ceil(COST_PERCENTILE * sorted.length) - 1;
    expect(composeCostEstimate(ramp)).toBe(sorted[index]);
  });
});

describe("repeat", () => {
  it("stops at the end with repeat off", () => {
    // The control the rest of this block is measured against: same harness,
    // same crossing of the end, repeat never switched on.
    const { player, advance } = harness(1000);
    player.play();
    advance(1200);
    expect(player.playing).toBe(false);
    expect(player.positionMs).toBe(1000);
  });

  it("wraps to the trim's head and keeps playing", () => {
    const { player, advance, setLooping } = harness(1000, 200);
    setLooping(true);
    player.play();
    expect(player.positionMs).toBe(200);
    advance(700);
    expect(player.positionMs).toBe(900);
    // Crossing the end.
    advance(200);
    expect(player.playing).toBe(true);
    // The HEAD, not zero — the trimmed-out lead-in is not replayed.
    expect(player.positionMs).toBe(200);
    // And it is still running afterwards, rather than parked on the head.
    advance(300);
    expect(player.positionMs).toBe(500);
  });

  it("keeps the shuttle rate across a wrap", () => {
    const { player, advance, setLooping } = harness(1000);
    setLooping(true);
    player.shuttle(1);
    player.shuttle(1);
    expect(player.rate).toBe(2);
    advance(600);
    expect(player.playing).toBe(true);
    expect(player.rate).toBe(2);
  });

  it("wraps a reverse shuttle to the tail", () => {
    const { player, advance, setLooping } = harness(1000, 200);
    setLooping(true);
    player.seek(400);
    player.shuttle(-1);
    advance(300);
    expect(player.playing).toBe(true);
    expect(player.positionMs).toBe(1000);
    expect(player.rate).toBe(-1);
  });

  it("stops rather than spinning on a take trimmed to nothing", () => {
    // Head and tail at the same instant: there is no range to wrap around,
    // and a wrap here would re-enter on every frame forever with the
    // playhead never moving. `advance` runs one round of scheduled work, so
    // a spin would show up as work still queued after the take ended.
    const { player, advance, setLooping } = harness(1000, 1000);
    setLooping(true);
    player.play();
    advance(50);
    expect(player.playing).toBe(false);
    expect(player.positionMs).toBe(1000);
  });
});

/**
 * Reported 2026-10-06: at padding 0 in Auto, a hairline of background down
 * both sides of the PREVIEW as well as the file. The preview draws at its
 * own target — the deliverable rescaled to a bitmap height, width rounded —
 * so its shape is a second rounding off the recording's. Every Auto preview
 * must still hand the recording its whole box. Red if derivePresentation
 * stops snapping, or `previewTarget` rounds the shape outside the snap.
 */
describe("the Auto preview frame", () => {
  it("gives the recording its whole box at every preview height", () => {
    let checked = 0;
    for (let w = 600; w <= 3000; w += 53) {
      for (let h = 400; h <= 2000; h += 47) {
        const viewport = { width: w, height: h };
        for (const padding of [0, 0.08]) {
          for (const fileType of ["mp4", "gif", "stills"] as const) {
            const deliverable = targetFor(fileType, "auto", null, {
              padding,
              viewport,
            });
            for (const height of [240, 361, 480, 720, 1000]) {
              if (height > deliverable.height) continue;
              const t = previewTarget(deliverable, height);
              const pad = Math.min(t.width, t.height) * padding;
              const { frameRect: f } = derivePresentation(
                { ...BRANDING_DEFAULTS, padding },
                t,
                viewport,
              );
              if (
                f.x !== pad ||
                f.y !== pad ||
                f.width !== t.width - 2 * pad ||
                f.height !== t.height - 2 * pad
              ) {
                throw new Error(
                  `${w}x${h} ${fileType} at ${padding}, preview ${t.width}x${t.height}: frame ${JSON.stringify(f)}`,
                );
              }
              checked++;
            }
          }
        }
      }
    }
    // Premise: the sweep really ran over thousands of frames.
    expect(checked).toBeGreaterThan(5_000);
  });
});
