import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { MIN_SCREEN_MS, screenMoments } from "../../src/index";
import { CAMERA_DEFAULTS } from "../../src/plan/camera";
import { FOLLOW_STEP_MS } from "../../src/plan/camera-follow";
import { busySpans } from "../../src/plan/moments";
import { planScene } from "../../src/plan/plan";
import {
  cursorMotionSpans,
  type ResolvedPlan,
  resolvePlan,
} from "../../src/plan/resolve";
import { type TimeSpan, toOutputMs } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

// Three clicks, each reached by a 300 ms glide that ends 200 ms before it:
// act-1 at 1500, act-2 at 3500, act-3 at 5500, the take ending at 7000.
const P0 = { x: 120, y: 640 };
const P1 = { x: 200, y: 42 };
const P2 = { x: 640, y: 328 };
const P3 = { x: 1060, y: 642 };
const CLICKS = [1500, 3500, 5500];
const END_MS = 7000;

function clicksScene(
  timestamps: number[] = CLICKS,
  camera: SceneDocument["camera"] = [],
): SceneDocument {
  const base = readonlyScene();
  const anchors = ["a-search", "a-row", "a-checkout"];
  return {
    ...base,
    actions: timestamps.map((timestamp, i) => ({
      id: `act-${i + 1}`,
      anchorId: anchors[i] as string,
      timestamp,
      marker: `click:${anchors[i]}`,
      kind: "click",
      button: "left",
    })),
    camera,
  };
}

function bundleOf(over: Partial<FrameBundle> = {}): FrameBundle {
  return proceduralBundle({
    timing: "real",
    keyframes: [0, ...CLICKS, END_MS].map((sourceTimeMs, i) => ({
      sourceTimeMs,
      ref: `k-${i}`,
      width: 1280,
      height: 800,
      actionId: null,
      byteLength: 0,
    })),
    motionSpans: [],
    cursorSamples: [
      { sourceTimeMs: 0, ...P0 },
      { sourceTimeMs: 1000, ...P0 },
      { sourceTimeMs: 1300, ...P1 },
      { sourceTimeMs: 3000, ...P1 },
      { sourceTimeMs: 3300, ...P2 },
      { sourceTimeMs: 5000, ...P2 },
      { sourceTimeMs: 5300, ...P3 },
      { sourceTimeMs: END_MS, ...P3 },
    ],
    markers: CLICKS.map((sourceTimeMs, i) => ({
      actionId: `act-${i + 1}`,
      sourceTimeMs,
    })),
    ...over,
  });
}

function resolved(scene: SceneDocument, bundle: FrameBundle): ResolvedPlan {
  return resolvePlan(planScene(scene), bundle, scene);
}

/** The still stretches, for the premises: the complement of what moves. */
function stills(r: ResolvedPlan): TimeSpan[] {
  const out: TimeSpan[] = [];
  let start = 0;
  for (const b of busySpans(r).busy) {
    if (b.startMs > start) out.push({ startMs: start, endMs: b.startMs });
    start = Math.max(start, b.endMs);
  }
  if (r.timeline.outputDurationMs > start) {
    out.push({ startMs: start, endMs: r.timeline.outputDurationMs });
  }
  return out;
}

const lengths = (spans: TimeSpan[]) =>
  spans.map((s) => Math.round(s.endMs - s.startMs));

describe("screenMoments", () => {
  it("puts one moment before each step and one on the final screen", () => {
    const scene = clicksScene();
    const bundle = bundleOf();
    const r = resolved(scene, bundle);
    // Premise: four still stretches of about a second — before each glide
    // (each after the previous click's 560 ms press and pulse) and the end.
    expect(lengths(stills(r))).toEqual([1000, 1050, 1050, 1050]);

    const { steps, moments } = screenMoments(r, scene, bundle);
    expect(steps).toBe(3);
    expect(moments.map((m) => m.step)).toEqual([0, 1, 2, null]);
    expect(moments.map((m) => m.ms)).toEqual([500, 2475, 4475, 6475]);
  });

  it("puts the moment before the camera's lead-in, not in it", () => {
    // act-2 at 4500 with a zoom: the pointer is on the row by 2300, the
    // push-in sets off at 2850 and lands on it at 4150, and the pointer
    // nudges 6px at 4300. The 150 ms of zoomed-in dwell before the nudge is
    // still, and is "the last still stretch" if the lead-in is not counted.
    const clicks = [1500, 4500, 5500];
    const scene = clicksScene(clicks, [
      {
        id: "zoom-2",
        kind: "zoom",
        anchorId: "a-row",
        marker: { actionId: "act-2", offsetMs: CAMERA_DEFAULTS.leadInMs },
        scale: CAMERA_DEFAULTS.defaultZoomScale,
      },
    ]);
    const bundle = bundleOf({
      cursorSamples: [
        { sourceTimeMs: 0, ...P0 },
        { sourceTimeMs: 1000, ...P0 },
        { sourceTimeMs: 1300, ...P1 },
        { sourceTimeMs: 2000, ...P1 },
        { sourceTimeMs: 2300, ...P2 },
        { sourceTimeMs: 4300, ...P2 },
        { sourceTimeMs: 4400, x: P2.x + 6, y: P2.y },
        { sourceTimeMs: END_MS, x: P2.x + 6, y: P2.y },
      ],
      markers: clicks.map((sourceTimeMs, i) => ({
        actionId: `act-${i + 1}`,
        sourceTimeMs,
      })),
    });
    const r = resolved(scene, bundle);
    const zoom = r.cameraSegments.find((s) => s.id === "zoom-2");
    expect(zoom?.departMs).toBe(2850);
    expect(zoom?.startMs).toBe(4150);
    // Premise: the dwell between the landing and the nudge is still, and
    // so is a stretch before the push-in sets off.
    const still = stills(r);
    const dwell = still.find((s) => s.startMs >= 4100 && s.endMs <= 4300);
    expect(dwell && dwell.endMs - dwell.startMs).toBeGreaterThanOrEqual(
      MIN_SCREEN_MS,
    );
    expect(
      still.some((s) => s.startMs > 1500 && s.endMs <= 2850 + FOLLOW_STEP_MS),
    ).toBe(true);

    const before = screenMoments(r, scene, bundle).moments.find(
      (m) => m.step === 1,
    );
    expect(before?.ms).toBeGreaterThan(1500);
    expect(before?.ms).toBeLessThan(2850);
  });

  it("puts the moment before the cursor's glide toward the step", () => {
    // act-2's glide is long (2200 to 3300): read without the glide, the
    // still stretch after act-1's pulse would run on to the press and its
    // midpoint would land in the middle of it.
    const scene = clicksScene();
    const bundle = bundleOf({
      cursorSamples: [
        { sourceTimeMs: 0, ...P0 },
        { sourceTimeMs: 1000, ...P0 },
        { sourceTimeMs: 1300, ...P1 },
        { sourceTimeMs: 2200, ...P1 },
        { sourceTimeMs: 3300, ...P2 },
        { sourceTimeMs: 5000, ...P2 },
        { sourceTimeMs: 5300, ...P3 },
        { sourceTimeMs: END_MS, ...P3 },
      ],
    });
    const r = resolved(scene, bundle);
    const glides = cursorMotionSpans(r.cursor).map((s) => ({
      startMs: toOutputMs(r.timeline, s.startMs),
      endMs: toOutputMs(r.timeline, s.endMs),
    }));
    // Premise: the glide, and 250 ms still before it.
    expect(glides).toContainEqual({ startMs: 2200, endMs: 3300 });
    expect(lengths(stills(r))[1]).toBe(250);

    const { moments } = screenMoments(r, scene, bundle);
    expect(moments.map((m) => m.step)).toEqual([0, 1, 2, null]);
    for (const m of moments) {
      for (const g of glides) {
        expect(m.ms < g.startMs || m.ms > g.endMs).toBe(true);
      }
    }
  });

  it("skips a step whose page never settles before it", () => {
    const scene = clicksScene();
    // The page animates from act-1's click until act-2's glide sets off.
    const bundle = bundleOf({
      motionSpans: [
        {
          startMs: 1500,
          endMs: 3000,
          ref: "m-0",
          width: 1280,
          height: 800,
          fps: 60,
          byteLength: 0,
        },
      ],
    });
    const r = resolved(scene, bundle);
    // Premise: nothing still between act-1 and act-2's glide.
    expect(stills(r).filter((s) => s.endMs > 1500 && s.startMs < 3000)).toEqual(
      [],
    );

    const { steps, moments } = screenMoments(r, scene, bundle);
    expect(steps).toBe(3);
    expect(moments.map((m) => m.step)).toEqual([0, 2, null]);
  });

  it("skips a step whose last still stretch is short, not falling back", () => {
    const scene = clicksScene();
    // act-1's result paints from 2300 to 2920: the page is still for 350 ms
    // before it and only 80 ms after it, before act-2's glide at 3000. One
    // more settled film would show the result; falling back to the
    // pre-result page would make the two films' screens differ.
    const bundle = bundleOf({
      motionSpans: [
        {
          startMs: 2300,
          endMs: 2920,
          ref: "m-0",
          width: 1280,
          height: 800,
          fps: 60,
          byteLength: 0,
        },
      ],
    });
    const r = resolved(scene, bundle);
    // Premise: the two stretches between act-1's pulse and act-2's glide.
    expect(
      lengths(stills(r).filter((s) => s.startMs >= 1500 && s.endMs <= 3000)),
    ).toEqual([350, 80]);

    const { steps, moments } = screenMoments(r, scene, bundle);
    expect(steps).toBe(3);
    expect(moments.map((m) => m.step)).toEqual([0, 2, null]);
  });

  it("has no final screen when the video ends moving", () => {
    const scene = clicksScene();
    // The page moves from 6200 to the take's end at 7000: still for 250 ms
    // after act-3's pulse, then never again.
    const bundle = bundleOf({
      motionSpans: [
        {
          startMs: 6200,
          endMs: END_MS,
          ref: "m-0",
          width: 1280,
          height: 800,
          fps: 60,
          byteLength: 0,
        },
      ],
    });
    const r = resolved(scene, bundle);
    // Premise: the last still stretch is the 250 ms one, and it stops short
    // of the end.
    const last = stills(r).at(-1);
    expect(last && Math.round(last.endMs - last.startMs)).toBe(250);
    expect(last?.endMs).toBeLessThan(r.timeline.outputDurationMs);

    const { moments } = screenMoments(r, scene, bundle);
    expect(moments.map((m) => m.step)).toEqual([0, 1, 2]);
  });

  it("skips a moment inside a click's pulse", () => {
    // act-2 is a wait 300 ms after act-1's click; nothing moves on the page
    // or the pointer between them, but the click's pulse is playing.
    const base = clicksScene();
    const scene: SceneDocument = {
      ...base,
      actions: base.actions.map((a) =>
        a.id === "act-2"
          ? {
              id: "act-2",
              anchorId: null,
              timestamp: 1800,
              marker: "waitFor:act-2",
              kind: "waitFor",
              condition: "loaded",
            }
          : a,
      ),
    };
    const bundle = bundleOf({
      cursorSamples: [
        { sourceTimeMs: 0, ...P0 },
        { sourceTimeMs: 1000, ...P0 },
        { sourceTimeMs: 1300, ...P1 },
        { sourceTimeMs: 5000, ...P1 },
        { sourceTimeMs: 5300, ...P3 },
        { sourceTimeMs: END_MS, ...P3 },
      ],
      markers: [
        { actionId: "act-1", sourceTimeMs: 1500 },
        { actionId: "act-2", sourceTimeMs: 1800 },
        { actionId: "act-3", sourceTimeMs: 5500 },
      ],
    });
    const r = resolved(scene, bundle);
    // Premise: no page motion and no pointer travel between the two.
    expect(
      r.timeline.segments.filter(
        (s) => s.kind === "motion" && s.outEndMs > 1500 && s.outStartMs < 1800,
      ),
    ).toEqual([]);
    expect(
      cursorMotionSpans(r.cursor).filter(
        (s) => s.endMs > 1500 && s.startMs < 1800,
      ),
    ).toEqual([]);

    const { moments } = screenMoments(r, scene, bundle);
    expect(moments.map((m) => m.step)).toEqual([0, 2, null]);
  });

  it("places the final screen inside the ending", () => {
    const scene = clicksScene();
    const bundle = bundleOf();
    const r = resolved(scene, bundle);
    const final = screenMoments(r, scene, bundle).moments.find(
      (m) => m.step === null,
    );
    expect(final?.ms).toBeGreaterThan(5500);
    expect(final?.ms).toBeLessThan(r.timeline.outputDurationMs);
  });

  it("moves with the timeline, not the source clock", () => {
    // A sampled replay: the recorded pause before act-3 is replayed as a
    // pace. Recorded 500 ms longer than the frames hold, then 1000 ms.
    const sampled = bundleOf({ timing: undefined });
    const film = (extraMs: number) => {
      const scene = clicksScene([1500, 3500, 5500 + extraMs]);
      const r = resolved(scene, sampled);
      return { r, screens: screenMoments(r, scene, sampled) };
    };
    const once = film(500);
    const twice = film(1000);
    // Premise: the pace is real, and doubling it adds 500 ms of output.
    const pace = (r: ResolvedPlan) =>
      r.timeline.segments
        .filter((s) => s.kind === "pace")
        .map((s) => Math.round(s.outEndMs - s.outStartMs));
    expect(pace(once.r)).toEqual([500]);
    expect(pace(twice.r)).toEqual([1000]);
    const added =
      twice.r.timeline.outputDurationMs - once.r.timeline.outputDurationMs;
    expect(added).toBe(500);

    // The pace stands before act-3's click: the screens before act-3's
    // glide are where they were, and everything after the pace moves on.
    const a = once.screens.moments;
    const b = twice.screens.moments;
    expect(b.map((m) => m.step)).toEqual(a.map((m) => m.step));
    expect(a.map((m) => m.step)).toEqual([0, 1, 2, null]);
    expect(b.map((m, i) => m.ms - (a[i] as { ms: number }).ms)).toEqual([
      0,
      0,
      0,
      added,
    ]);
  });
});
