import { planScene, resolvePlan } from "@demoman/compositor";
import { zoomsForClicks } from "@demoman/run-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import {
  authoredScene,
  everyVerbScene,
  hoverScene,
  readonlyScene,
} from "../../../../../packages/replay-engine/test/helpers/scenes";
import {
  MIN_CLIP_FRACTION,
  renderTimeline,
  renderTimelineTools,
  type TimelineState,
} from "../../../pages/entrypoints/editor/timeline-view";
import { applyCommand } from "../../../pages/src/editor/commands";
import { buildLaneModel } from "../../../pages/src/editor/lanes";
import { ZOOM_STEP } from "../../../pages/src/editor/shortcuts";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import {
  fitAll,
  MIN_SPAN_MS,
  pan,
  toFraction,
  type Viewport,
  zoomAt,
  zoomToSpan,
} from "../../../pages/src/editor/viewport";

const ids = () => {
  let n = 0;
  return () => `gen-${++n}`;
};
let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
});

const handlers = () => ({
  onSelect: vi.fn(),
  onSeek: vi.fn(),
  onSeekStart: vi.fn(),
  onGesture: vi.fn(),
  onViewport: vi.fn(),
  onSnapping: vi.fn(),
  onSplit: vi.fn(),
  onRestorePiece: vi.fn(),
  onOpenJoin: vi.fn(),
});

/** `renderTimelineTools`'s narrower handler set — `+ Mask`, `Snap` and
 *  `Fit` no longer take `onSelect`/`onSeek`/`onSeekStart`. */
const toolsHandlers = () => ({
  onGesture: vi.fn(),
  onViewport: vi.fn(),
  onSnapping: vi.fn(),
  onSplit: vi.fn(),
  onRestorePiece: vi.fn(),
  onOpenJoin: vi.fn(),
});

function modelOf(scene = readonlyScene(), bundle = proceduralBundle()) {
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const view = buildTimelineView({ scene, bundle, resolved });
  return buildLaneModel({ scene, view, bundle, resolved, hoverReport: null });
}
const stateFor = (
  model: ReturnType<typeof modelOf>,
  over: Partial<TimelineState> = {},
): TimelineState => ({
  viewport: fitAll(model.durationMs),
  selection: null,
  positionMs: 0,
  refusal: null,
  snapping: true,
  ...over,
});
const pct = (fraction: number) => `${(fraction * 100).toFixed(4)}%`;

describe("the clip bar", () => {
  it("draws one tick per step at its fraction of the window, with timing and flag", () => {
    const model = modelOf(hoverScene());
    const state = stateFor(model);
    renderTimeline(root, model, state, handlers());
    const ticks = [...root.querySelectorAll<HTMLElement>("[data-tick]")];
    expect(ticks.map((t) => t.getAttribute("data-tick"))).toEqual([
      "act-1",
      "act-2",
      "act-h",
      "act-3",
    ]);
    const act2 = model.clip.ticks[1];
    expect(ticks[1]?.style.left).toBe(
      pct(toFraction(state.viewport, act2?.atMs ?? 0)),
    );
    expect(ticks[2]?.getAttribute("data-timing")).toBe("estimated");
    // Verb and anchor, so a lane of otherwise-identical marks still says
    // which step is which — carried over from the old per-beat clip's
    // `textContent`, now on the tick's title/aria-label instead (a tick has
    // no visible text of its own).
    expect(ticks[3]?.title).toContain("a-checkout");
    expect(ticks[3]?.title).toContain("click");
  });

  it("marks a step the frames have no marker for as not in the video", () => {
    const model = modelOf(hoverScene());
    renderTimeline(root, model, stateFor(model), handlers());
    const ticks = [...root.querySelectorAll<HTMLElement>("[data-tick]")];
    // Premise: act-h is estimated and act-1 is rendered.
    expect(ticks[2]?.getAttribute("data-timing")).toBe("estimated");
    expect(ticks[0]?.getAttribute("data-timing")).toBe("rendered");
    expect(ticks[2]?.hasAttribute("data-not-in-video")).toBe(true);
    expect(ticks[2]?.title).toContain("not in the video");
    // It keeps what the tick already said, and appends.
    expect(ticks[2]?.title).toContain("moveTo a-checkout");
    expect(ticks[0]?.hasAttribute("data-not-in-video")).toBe(false);
    expect(ticks[0]?.title).not.toMatch(/not in the video/i);
  });

  it("draws the beats on the Clip track, with no lane of their own", () => {
    const model = modelOf(hoverScene());
    renderTimeline(root, model, stateFor(model), handlers());
    const inClip = root.querySelectorAll('[data-track="clip"] [data-tick]');
    // Fixture guard: the take has beats to place at all.
    expect(model.clip.ticks.length).toBeGreaterThan(0);
    expect(inClip.length).toBe(model.clip.ticks.length);
    expect(
      [...root.querySelectorAll("[data-lane]")].map((row) =>
        row.getAttribute("data-lane"),
      ),
    ).toEqual(["clip", "zoom", "mask"]);
  });

  it("stamps each beat with its verb, which picks its shape", () => {
    const model = modelOf(everyVerbScene());
    renderTimeline(root, model, stateFor(model), handlers());
    expect(
      [...root.querySelectorAll<HTMLElement>("[data-tick]")].map((t) => [
        t.dataset.tick,
        t.dataset.verb,
      ]),
    ).toEqual(model.clip.ticks.map((t) => [t.actionId, t.verb]));
    // Fixture guard: every verb is in the take, once each.
    expect(new Set(model.clip.ticks.map((t) => t.verb))).toEqual(
      new Set(["type", "scrollTo", "moveTo", "waitFor", "click", "drag"]),
    );
  });

  it("places a tick at its share of the viewport, not its naive share of the take", () => {
    // `fitAll`'s own [0, durationMs] window makes the naive fraction
    // (`atMs / durationMs`) and the true viewport-relative one
    // (`(atMs - start) / (end - start)`) numerically identical, so a window
    // starting at 0 cannot tell a viewport-aware placement from one that
    // silently ignored the viewport's start. This one starts away from zero
    // specifically so the two disagree.
    const model = modelOf(readonlyScene());
    const startMs = 2000;
    const state = stateFor(model, {
      viewport: { startMs, endMs: startMs + model.durationMs },
    });
    renderTimeline(root, model, state, handlers());
    const tick = root.querySelector<HTMLElement>('[data-tick="act-3"]');
    const atMs = model.clip.ticks[2]?.atMs ?? 0;
    const naiveFraction = atMs / model.durationMs;
    const viewportFraction = (atMs - startMs) / model.durationMs;
    // Fixture guard: the two really do disagree for this fixture and
    // viewport, or the assertion below could not tell them apart either.
    expect(viewportFraction).not.toBeCloseTo(naiveFraction, 2);
    expect(tick && Number.parseFloat(tick.style.left)).toBeCloseTo(
      viewportFraction * 100,
      4,
    );
  });

  it("selects a tick on click", () => {
    const model = modelOf();
    const h = handlers();
    renderTimeline(root, model, stateFor(model), h);
    root.querySelector<HTMLElement>('[data-tick="act-2"]')?.click();
    expect(h.onSelect).toHaveBeenCalledWith({
      kind: "tick",
      actionId: "act-2",
    });
  });

  it("draws the trim handles at the trim, and the block between them", () => {
    const scene = applyCommand(
      readonlyScene(),
      { kind: "setTrim", head: { actionId: "act-2", offsetMs: 100 } },
      ids(),
    );
    const model = modelOf(scene);
    const state = stateFor(model);
    renderTimeline(root, model, state, handlers());
    const headFraction = toFraction(state.viewport, model.clip.trim.headMs);
    // Fixture guard: the head really is cut, so the block below starts
    // somewhere other than 0 and "spans the trim" is distinguishable from
    // "spans the track".
    expect(headFraction).toBeGreaterThan(0.01);
    const head = root.querySelector<HTMLElement>('[data-trim="head"]');
    expect(head?.style.left).toBe(pct(headFraction));
    // The block IS the kept range: it starts at the head and ends at the
    // tail, and the cut is the bare track before it. The `[data-cut]`
    // overlays that used to shade that region were retired on 2026-09-21.
    const block = root.querySelector<HTMLElement>("[data-clip-block]");
    expect(block?.style.left).toBe(pct(headFraction));
    expect(block?.style.width).toBe(
      pct(toFraction(state.viewport, model.clip.trim.tailMs) - headFraction),
    );
    expect(root.querySelector("[data-cut]")).toBeNull();
  });

  it("leaves the clip block unlabelled", () => {
    // One clip per take, named already by the header's name field: a label
    // here would be that name a second time. Asserted rather than simply
    // not written — a label creeping back would look like a feature and
    // read as noise.
    const model = modelOf();
    renderTimeline(root, model, stateFor(model), handlers());
    const block = root.querySelector("[data-clip-block]");
    // Fixture guard: the block itself is drawn, so "no text" is a fact
    // about the block rather than about its absence.
    expect(block).not.toBeNull();
    expect(block?.textContent).toBe("");
  });

  it("hatches a trim handle with estimated timing", () => {
    const scene = applyCommand(
      readonlyScene(),
      { kind: "setTrim", tail: { actionId: "act-3", offsetMs: -100 } },
      ids(),
    );
    const bundle = proceduralBundle({
      markers: proceduralBundle().markers.filter((m) => m.actionId !== "act-3"),
    });
    renderTimeline(
      root,
      modelOf(scene, bundle),
      stateFor(modelOf(scene, bundle)),
      handlers(),
    );
    expect(
      root.querySelector('[data-trim="tail"]')?.getAttribute("data-timing"),
    ).toBe("estimated");
  });

  it("marks the Clip lane unchecked when the hover pass crashed", () => {
    // The design's failure table: "the Cursor lane is marked unchecked,
    // never clean" — there is no separate Cursor lane any more, and the
    // flag rides the Clip header's glyph, beside the beats the pass covers
    // (a line of text on an Actions strip's label while the beats had one,
    // 2026-09-21 to 2026-09-22). A crashed pass that drew as an ordinary
    // lane would tell an author every hover had been examined.
    const base = modelOf();
    const model = { ...base, hoverCheck: { failed: true, unchecked: 0 } };
    renderTimeline(root, model, stateFor(model), handlers());
    const flag = root.querySelector<HTMLElement>(
      '[data-lane="clip"] .lane-glyph [data-hover-check]',
    );
    expect(flag?.getAttribute("data-hover-check")).toBe("failed");
    // A dot says nothing on its own: the sentence is its name and tooltip.
    expect(flag?.getAttribute("aria-label")).toMatch(
      /hover check could not run/i,
    );
    expect(flag?.title).toBe(flag?.getAttribute("aria-label"));
  });

  it("says how many hovers went unchecked, and says nothing when none did", () => {
    const base = modelOf();
    const partial = { ...base, hoverCheck: { failed: false, unchecked: 3 } };
    renderTimeline(root, partial, stateFor(partial), handlers());
    const flag = root.querySelector<HTMLElement>(
      '[data-lane="clip"] [data-hover-check]',
    );
    expect(flag?.getAttribute("data-hover-check")).toBe("unchecked");
    expect(flag?.title).toBe("3 hovers could not be checked.");

    // A clean pass has nothing to report, and a flag that appeared anyway
    // would fire whether or not anything was wrong.
    const clean = modelOf();
    renderTimeline(root, clean, stateFor(clean), handlers());
    expect(root.querySelector("[data-hover-check]")).toBeNull();
  });

  it("keeps a clock on the ruler at a window narrower than a second", () => {
    const model = modelOf();
    // `MIN_SPAN_MS` is 250, so this is a window an author can actually reach
    // by zooming, and it straddles no whole second: a tick step floored at
    // 1000ms puts the first tick at 1000 > 550 and the ruler renders nothing
    // at all.
    const state = stateFor(model, { viewport: { startMs: 300, endMs: 550 } });
    renderTimeline(root, model, state, handlers());
    const ticks = [...root.querySelectorAll("[data-ruler] .tick")];
    expect(ticks.length).toBeGreaterThan(1);
    // Labelled apart, too: ticks 100ms apart that all read "0:00" are a
    // ruler with no information on it.
    expect(new Set(ticks.map((t) => t.textContent)).size).toBe(ticks.length);
  });

  it("hatches the degraded stretches, and says why in the model's notices", () => {
    const bundle = proceduralBundle({
      degradations: [
        { startMs: 3200, endMs: 3600, kind: "keyframeOnly", note: "busy" },
      ],
    });
    const model = modelOf(readonlyScene(), bundle);
    renderTimeline(root, model, stateFor(model), handlers());
    expect(root.querySelectorAll("[data-degraded]")).toHaveLength(1);
    // The SENTENCE is the status row's since 2026-09-22 — `renderTakeNotes`
    // draws `model.notices`, and `editor-view.test.ts` holds that half.
    // What is asserted here is the pairing the hatch depends on: a texture
    // with no sentence anywhere is a warning nobody can read, so the model
    // this lane hatched from has to be carrying the reason too.
    expect(model.notices).toContain("keyframeOnly: busy");
    expect(root.querySelector("[data-notices]")).toBeNull();
  });
});

describe("the axis's own timing", () => {
  it("says when the axis is provisional rather than drawing it as measured", () => {
    const scene = readonlyScene();
    const view = buildTimelineView({ scene, bundle: null, resolved: null });
    const model = buildLaneModel({
      scene,
      view,
      bundle: null,
      resolved: null,
      hoverReport: null,
    });
    renderTimeline(root, model, stateFor(model), handlers());
    expect(
      root.querySelector("[data-ruler]")?.getAttribute("data-source"),
    ).toBe("captured");
    expect(root.textContent).toContain("re-shoot it in Runs to see the timing");
    expect(root.textContent).not.toMatch(/rebuild/i);
  });

  // The provisional-axis line names the way to a measured timing; an
  // authored take's is its script. Goes red if the timeline stops reading
  // the model's `authored`.
  it("tells an authored take to run its script again to see the timing", () => {
    const scene = authoredScene(readonlyScene());
    const view = buildTimelineView({ scene, bundle: null, resolved: null });
    const model = buildLaneModel({
      scene,
      view,
      bundle: null,
      resolved: null,
      hoverReport: null,
    });
    // Premise: the model is the provisional one this line belongs to, and it
    // knows whose take it is.
    expect(model.timeSource).toBe("captured");
    expect(model.authored).toBe(true);
    renderTimeline(root, model, stateFor(model), handlers());
    expect(root.textContent).toContain(
      "run its script again in Runs to see the timing",
    );
    expect(root.textContent).not.toMatch(/re-shoot/i);
  });

  // Where each label goes is decided in pixels after layout — see
  // `placeRulerLabels` and `editor-timeline-geometry.test.ts`. What the
  // node lane can pin is the input that needs: every tick carries its
  // fraction of the window.
  it("gives every ruler label its fraction of the window", () => {
    const model = modelOf();
    renderTimeline(root, model, stateFor(model), handlers());
    const ticks = [...root.querySelectorAll<HTMLElement>(".ruler .tick")];
    expect(ticks.length).toBeGreaterThan(2);
    for (const tick of ticks) {
      expect(Number.parseFloat(tick.style.left)).toBeCloseTo(
        Number(tick.dataset.fraction) * 100,
        3,
      );
    }
  });
});

describe("the zoom lane", () => {
  const zoomed = () =>
    applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      ids(),
    );

  it("draws a segment with its caps and an automatic end", () => {
    const model = modelOf(zoomed());
    const state = stateFor(model);
    renderTimeline(root, model, state, handlers());
    const seg = root.querySelector<HTMLElement>('[data-segment="gen-1"]');
    expect(seg?.getAttribute("data-kind")).toBe("zoom");
    expect(seg?.getAttribute("data-authored-end")).toBe("false");
    // Drawn from the push-in's departure, where the preview starts moving,
    // not from its landing.
    const zoom = model.zooms[0];
    expect(zoom && zoom.startMs - zoom.departMs).toBeGreaterThan(0);
    expect(seg?.style.left).toBe(
      pct(toFraction(state.viewport, zoom?.departMs ?? 0)),
    );
    expect(seg?.querySelectorAll("[data-cap]")).toHaveLength(2);
  });

  it("emits addZoom at the clicked instant on the empty track, and selects on the segment", () => {
    const model = modelOf(zoomed());
    const h = handlers();
    renderTimeline(root, model, stateFor(model), h);
    const track = root.querySelector<HTMLElement>('[data-track="zoom"]');
    if (!track) throw new Error("no zoom track");
    // jsdom has no layout: the view converts clientX through the track's
    // rect, which is 0 wide here, so the ms it computes is the window start.
    // What this asserts is the WIRING; the px-to-ms conversion is the
    // browser lane's (Task 10).
    track.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(h.onGesture).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "addZoom" }),
    );
    root.querySelector<HTMLElement>('[data-segment="gen-1"]')?.click();
    expect(h.onSelect).toHaveBeenCalledWith({ kind: "zoom", id: "gen-1" });
  });

  it("marks a segment outside the trim", () => {
    let scene = zoomed();
    scene = applyCommand(
      scene,
      { kind: "setTrim", head: { actionId: "act-3", offsetMs: -100 } },
      ids(),
    );
    const model = modelOf(scene);
    renderTimeline(root, model, stateFor(model), handlers());
    expect(
      root
        .querySelector('[data-segment="gen-1"]')
        ?.hasAttribute("data-outside-trim"),
    ).toBe(true);
  });

  it("marks data-to-scale=false when the window widens the segment past its own span, and true at a normal zoom level", () => {
    const model = modelOf(zoomed());
    const seg = model.zooms[0];
    if (!seg) throw new Error("no zoom");
    // The compositor clamps a zoom's own length to a floor well above
    // MIN_CLIP_FRACTION of any window `fitAll` produces (verified: even an
    // authored end 5ms after the start comes back clamped to hundreds of
    // ms), so a short WINDOW rather than a short zoom is what actually
    // exercises `boxOf`'s widening — which is a statement about the zoom
    // LEVEL in the first place ("a widened clip is marked ... at exactly
    // the zoom levels where an author is least able to check").
    const span = seg.endMs - seg.departMs;
    const wide = { startMs: 0, endMs: span / MIN_CLIP_FRACTION + 1000 };
    renderTimeline(
      root,
      model,
      stateFor(model, { viewport: wide }),
      handlers(),
    );
    expect(
      root
        .querySelector('[data-segment="gen-1"]')
        ?.getAttribute("data-to-scale"),
    ).toBe("false");

    const normalRoot = document.createElement("div");
    renderTimeline(normalRoot, model, stateFor(model), handlers()); // fitAll
    expect(
      normalRoot
        .querySelector('[data-segment="gen-1"]')
        ?.getAttribute("data-to-scale"),
    ).toBe("true");
  });
});

describe("zooms generated at save", () => {
  it("draw as ordinary segments, with both caps to drag", () => {
    // What makes save-time zooms different from the auto-zoom removed on
    // 2026-08-30: they are events on the lane like any other, so the
    // author can delete one, move it, or extend its end. A generated zoom
    // that rendered without caps would be back to a rule that can only be
    // argued with.
    const base = readonlyScene();
    const scene = {
      ...base,
      camera: zoomsForClicks(base.actions, base.meta.capture.viewport).camera,
    };
    expect(scene.camera.length).toBeGreaterThan(0); // fixture guard: clicks
    const model = modelOf(scene);
    renderTimeline(root, model, stateFor(model), handlers());
    const seg = root.querySelector('[data-segment="zoom-1"]');
    if (seg === null) throw new Error("generated zoom not on the lane");
    expect(seg.getAttribute("data-kind")).toBe("zoom");
    expect(seg.querySelectorAll("[data-cap]")).toHaveLength(2);
    expect(seg.getAttribute("data-authored-end")).toBe("false");
  });
});

describe("the mask lane", () => {
  it("is always drawn, so there is empty track to click a mask onto", () => {
    // Until 2026-09-14 the lane appeared only once a mask existed or the
    // header button had been pressed.
    const model = modelOf();
    expect(model.masks).toEqual([]); // fixture guard
    renderTimeline(root, model, stateFor(model), handlers());
    expect(root.querySelector('[data-lane="mask"]')).not.toBeNull();
  });

  it("emits addMask at the playhead from the Mask lane's header button", () => {
    // The button lives on the Mask lane's own header, drawn by
    // `renderTimeline` beside the clip track it measures `perPx` from.
    const model = modelOf();
    const h = handlers();
    renderTimeline(root, model, stateFor(model, { positionMs: 4000 }), h);
    const button = root.querySelector<HTMLElement>(
      '[data-lane="mask"] [data-add-mask]',
    );
    expect(button, "no + on the Mask lane").not.toBeNull();
    button?.click();
    expect(h.onGesture).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "addMask", atMs: 4000 }),
    );
  });

  it("reads perPx from the clip track drawn in the same render", () => {
    // The click handler measures the clip track of its own render. Proving
    // it needs a width a detached root never has, so this gives clip tracks
    // one — and fails if the handler stops measuring (`perPx` falls to 0 and
    // `snapMs` with it) or measures some other track.
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        const width = this.getAttribute("data-track") === "clip" ? 1000 : 0;
        return { width, left: 0, right: width } as DOMRect;
      });
    try {
      const model = modelOf();
      const h = handlers();
      const viewport = { startMs: 0, endMs: 8000 };
      renderTimeline(root, model, stateFor(model, { viewport }), h);
      const track = root.querySelector<HTMLElement>('[data-track="clip"]');
      expect(track?.getBoundingClientRect().width, "fixture: clip width").toBe(
        1000,
      );
      root
        .querySelector<HTMLElement>('[data-lane="mask"] [data-add-mask]')
        ?.click();
      // perPx = 8000ms / 1000px = 8ms/px; snapMs = SNAP_PX(8) * 8 = 64.
      expect(h.onGesture).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "addMask", snapMs: 64 }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("reads the playhead when the Mask lane's + is pressed, not when it was drawn", () => {
    const model = modelOf();
    const onGesture = vi.fn();
    let position = 1_000;
    const state: TimelineState = {
      ...stateFor(model),
      get positionMs() {
        return position;
      },
    };
    renderTimeline(root, model, state, { ...handlers(), onGesture });
    const button = root.querySelector<HTMLButtonElement>(
      '[data-lane="mask"] [data-add-mask]',
    );
    expect(button?.getAttribute("aria-label")).toBe(
      "Add a mask at the playhead",
    );
    position = 4_000;
    button?.click();
    expect(onGesture).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "addMask", atMs: 4_000 }),
    );
  });

  it("draws no Add mask among the transport's tools", () => {
    const model = modelOf();
    renderTimelineTools(root, model, stateFor(model), toolsHandlers());
    expect(root.querySelector("[data-add-mask]")).toBeNull();
    expect(root.querySelector('[data-timeline-tools="author"]')).toBeNull();
    expect(root.querySelector('[data-timeline-tools="view"]')).not.toBeNull();
  });

  it("draws a whole-take mask without caps and a ranged one with them", () => {
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addMask",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        start: { actionId: "act-1", offsetMs: 0 },
        end: { actionId: "act-2", offsetMs: 0 },
      },
      ids(),
    );
    scene = {
      ...scene,
      edits: {
        ...scene.edits,
        masks: [
          ...scene.edits.masks,
          { id: "old", rect: { x: 0, y: 0, width: 9, height: 9 } },
        ],
      },
    };
    const model = modelOf(scene);
    renderTimeline(root, model, stateFor(model), handlers());
    expect(
      root
        .querySelector('[data-segment="old"]')
        ?.hasAttribute("data-whole-take"),
    ).toBe(true);
    expect(root.querySelector('[data-segment="old"] [data-cap]')).toBeNull();
    expect(
      root.querySelectorAll('[data-segment="gen-1"] [data-cap]'),
    ).toHaveLength(2);
  });
});

describe("what is unchanged", () => {
  it("still draws the ruler, the playhead and the refusal line", () => {
    const model = modelOf();
    renderTimeline(root, model, stateFor(model, { refusal: "no" }), handlers());
    for (const sel of [
      "[data-ruler]",
      "[data-playhead]",
      "[data-playhead-grab]",
      "[data-axis]",
    ]) {
      expect(root.querySelector(sel)).not.toBeNull();
    }
    expect(root.querySelector("[data-refusal]")?.textContent).toBe("no");
  });

  it("keeps the refusal line out of the way when there is nothing to refuse", () => {
    // The other half of the line's two states, and the reason it is always
    // in the DOM: an element that appeared and vanished would be a toast. It
    // has to be present AND invisible, not present and empty — an empty
    // paragraph still takes a line's worth of space under the lanes.
    const model = modelOf();
    renderTimeline(root, model, stateFor(model), handlers());
    const line = root.querySelector<HTMLElement>("[data-refusal]");
    expect(line).not.toBeNull();
    expect(line?.hidden).toBe(true);
    expect(line?.textContent).toBe("");
  });

  it("zooms about the pointer on a ⌘/ctrl wheel, and not on a plain one", () => {
    const model = modelOf();
    const state = stateFor(model, { viewport: { startMs: 0, endMs: 8000 } });
    const h = handlers();
    renderTimeline(root, model, state, h);
    const box = root.querySelector<HTMLElement>(".timeline") as HTMLElement;
    // The AXIS, not the whole box: the zoom's anchor fraction has to be a
    // fraction of the column the clips are in, or the instant under the
    // pointer lands somewhere else once the new window is drawn.
    const axis = root.querySelector<HTMLElement>("[data-axis]") as HTMLElement;
    axis.getBoundingClientRect = () =>
      ({ left: 0, width: 1000, right: 1000 }) as DOMRect;

    // A wheel with no modifier is the page's, not the timeline's: an editor
    // that zoomed on every scroll would be unusable.
    box.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, clientX: 500, deltaY: -100 }),
    );
    expect(h.onViewport).not.toHaveBeenCalled();

    box.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        clientX: 500,
        deltaY: -100,
        ctrlKey: true,
      }),
    );
    expect(h.onViewport).toHaveBeenCalledWith(
      zoomAt(state.viewport, model.durationMs, 1.2, 0.5),
    );
  });

  it("pans on a horizontal scroll, which is the only way a zoomed take moves", () => {
    // The lanes are drawn in percentages of the pane, so there is nothing
    // for the browser's own scrollbar to move: without this, an author
    // zoomed into the middle of a take can only leave it by zooming out.
    const model = modelOf();
    const state = stateFor(model, { viewport: { startMs: 0, endMs: 4000 } });
    const h = handlers();
    renderTimeline(root, model, state, h);
    const box = root.querySelector<HTMLElement>(".timeline") as HTMLElement;
    const axis = root.querySelector<HTMLElement>("[data-axis]") as HTMLElement;
    axis.getBoundingClientRect = () =>
      ({ left: 0, width: 1000, right: 1000 }) as DOMRect;
    box.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, deltaX: 250, clientX: 0 }),
    );
    expect(h.onViewport).toHaveBeenCalledWith(
      pan(state.viewport, model.durationMs, 1000),
    );
  });

  it("scrubs from a press and drag on the ruler, not only a click, and holds the ends", () => {
    // Two old assertions in one fixture: a drag that moves after the initial
    // press keeps seeking (not only the pointerdown instant), and a drag
    // pushed past either end of the take clamps to it rather than seeking
    // into frames that do not exist.
    const model = modelOf();
    const state = stateFor(model);
    const h = handlers();
    renderTimeline(root, model, state, h);
    const ruler = root.querySelector<HTMLElement>(
      "[data-ruler]",
    ) as HTMLElement;
    ruler.getBoundingClientRect = () =>
      ({ left: 0, width: 1000, right: 1000 }) as DOMRect;

    ruler.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: 250 }),
    );
    expect(h.onSeekStart).toHaveBeenCalledTimes(1);
    expect(h.onSeek).toHaveBeenLastCalledWith(
      state.viewport.startMs +
        0.25 * (state.viewport.endMs - state.viewport.startMs),
    );

    // Follows a move, not only the press.
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 750 }),
    );
    expect(h.onSeek).toHaveBeenLastCalledWith(
      state.viewport.startMs +
        0.75 * (state.viewport.endMs - state.viewport.startMs),
    );

    // Past the right end of the take: held at durationMs, not run past it.
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 5000 }),
    );
    expect(h.onSeek).toHaveBeenLastCalledWith(model.durationMs);

    // Past the left end: held at 0, not driven negative.
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: -5000 }),
    );
    expect(h.onSeek).toHaveBeenLastCalledWith(0);
  });
});

/** The tool row speaks in glyphs, since 2026-09-22: no control on it
 *  carries a word, and every one carries its name — shortcut included where
 *  it has one — as both its accessible name and its tooltip. */
describe("the timeline tools", () => {
  it("keeps its nodes across renders, acting on the latest state once", () => {
    // Built once and updated in place, so a drag on the zoom slider
    // survives the render its own input causes (see
    // `editor-timeline-zoom-drag.test.ts`). Handlers are reassigned per
    // render: one that stacked would fire twice, one that went stale would
    // toggle from the first render's state.
    const model = modelOf();
    const h = toolsHandlers();
    renderTimelineTools(root, model, { ...stateFor(model), snapping: true }, h);
    const snap = root.querySelector<HTMLElement>("[data-snap]");
    const slider = root.querySelector("[data-zoom-slider]");
    renderTimelineTools(
      root,
      model,
      { ...stateFor(model), snapping: false },
      h,
    );
    expect(root.querySelector("[data-snap]"), "Snap was rebuilt").toBe(snap);
    expect(
      root.querySelector("[data-zoom-slider]"),
      "the slider was rebuilt",
    ).toBe(slider);
    expect(snap?.getAttribute("aria-pressed")).toBe("false");
    snap?.click();
    expect(h.onSnapping).toHaveBeenCalledTimes(1);
    expect(h.onSnapping).toHaveBeenCalledWith(true);
  });

  it("carry no words, and name every control", () => {
    const model = modelOf();
    // Zoomed in part-way, so neither Fit nor a magnifier is at an end —
    // the names below are the live ones.
    renderTimelineTools(
      root,
      model,
      {
        ...stateFor(model),
        viewport: { startMs: 1000, endMs: 1000 + model.durationMs / 2 },
      },
      toolsHandlers(),
    );
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
    // Fixture guard: the row's five buttons — Split, Snap, Fit and the two
    // magnifiers. `+ Mask` is checked on the Mask lane below.
    expect(buttons.length).toBe(5);
    const expected: Record<string, RegExp> = {
      "[data-split-tool]": /^Split at playhead$/,
      "[data-snap]": /^Snapping o(n|ff) — /,
      "[data-fit]": /whole take/,
      '[data-zoom-step="out"]': /^Zoom out$/,
      '[data-zoom-step="in"]': /^Zoom in$/,
    };
    for (const [selector, name] of Object.entries(expected)) {
      const b = root.querySelector<HTMLButtonElement>(selector);
      if (!b) throw new Error(`no ${selector}`);
      expect(
        b.querySelector("svg"),
        `${selector} draws no glyph`,
      ).not.toBeNull();
      const words = [...b.childNodes]
        .filter((n) => !(n instanceof Element && n.getAttribute("aria-hidden")))
        .map((n) => n.textContent ?? "")
        .join("")
        .trim();
      expect(words, `${selector} still carries a word`).toBe("");
      expect(b.getAttribute("aria-label"), selector).toMatch(name);
      // The pointer's name: the tooltip, or a disabled control's title.
      expect(b.dataset.tip ?? b.title, selector).toBe(
        b.getAttribute("aria-label"),
      );
    }
    // The Mask lane's + is a glyph, with a name and no word.
    const lane = document.createElement("div");
    renderTimeline(lane, model, stateFor(model), handlers());
    const add = lane.querySelector<HTMLButtonElement>(
      '[data-lane="mask"] [data-add-mask]',
    );
    expect(add?.querySelector("svg"), "+ draws no glyph").not.toBeNull();
    expect(add?.textContent?.trim(), "+ carries a word").toBe("");
    expect(add?.getAttribute("aria-label")).toMatch(/add a mask/i);
    expect(add?.title).toBe(add?.getAttribute("aria-label"));
  });
});

/** Fit, moved to `#transport` (`renderTimelineTools`) alongside Snap. */
describe("the fit button", () => {
  const button = () =>
    root.querySelector("[data-fit]") as HTMLButtonElement | null;

  it("sits between Snap and the zoom slider", () => {
    // Order matters here and nothing else asserts it: these three are the
    // row's view controls and they read left to right as "how drags land,
    // show me all of it, show me this much".
    const model = modelOf();
    renderTimelineTools(root, model, stateFor(model), toolsHandlers());
    const order = [
      ...root.querySelectorAll("[data-snap], [data-fit], [data-zoom-control]"),
    ].map((n) =>
      n.hasAttribute("data-snap")
        ? "snap"
        : n.hasAttribute("data-fit")
          ? "fit"
          : "zoom",
    );
    expect(order).toEqual(["snap", "fit", "zoom"]);
  });

  it("offers a way back to the whole take", () => {
    const model = modelOf();
    const h = toolsHandlers();
    renderTimelineTools(
      root,
      model,
      { ...stateFor(model), viewport: { startMs: 3000, endMs: 4000 } },
      h,
    );
    (button() as HTMLButtonElement).click();
    expect(h.onViewport).toHaveBeenCalledWith(fitAll(model.durationMs));
  });

  it("says whether Fit has anything to do", () => {
    // Both states, because either alone passes on a button whose `disabled`
    // never changes: always-on satisfies the zoomed case, always-off the
    // fitted one.
    const model = modelOf();

    renderTimelineTools(
      root,
      model,
      { ...stateFor(model), viewport: { startMs: 3000, endMs: 4000 } },
      toolsHandlers(),
    );
    expect(button()?.disabled, "Fit is dead while zoomed in").toBe(false);

    renderTimelineTools(
      root,
      model,
      { ...stateFor(model), viewport: fitAll(model.durationMs) },
      toolsHandlers(),
    );
    expect(
      button()?.disabled,
      "Fit still offers to do something with the whole take already in view",
    ).toBe(true);
    expect(button()?.title).toMatch(/already in view/i);
  });

  it("calls a take shorter than the zoom floor fitted", () => {
    // `fitAll` clamps to `MIN_SPAN_MS`, so a 100ms take fits to 0..250 and
    // never to 0..100. Compared against the raw duration this button would
    // stay live forever on exactly the takes with least to do.
    //
    // The duration is overridden on a real model rather than a scene built
    // to be 100ms long: what is under test is which number the button
    // compares against, and that is the only field it reads.
    const model = { ...modelOf(), durationMs: 100 };
    expect(model.durationMs).toBeLessThan(MIN_SPAN_MS);
    renderTimelineTools(
      root,
      model,
      { ...stateFor(model), viewport: fitAll(model.durationMs) },
      toolsHandlers(),
    );
    expect(button()?.disabled).toBe(true);
  });
});

describe("the zoom slider", () => {
  const slider = () =>
    root.querySelector("[data-zoom-slider]") as HTMLInputElement | null;

  it("draws the knob where the current window puts it", () => {
    const model = modelOf();
    // Fitted: all the way out.
    renderTimelineTools(
      root,
      model,
      { ...stateFor(model), viewport: fitAll(model.durationMs) },
      toolsHandlers(),
    );
    expect(Number(slider()?.value)).toBeCloseTo(0, 3);

    // Zoomed in: somewhere along. Both states, because either alone passes
    // against a slider whose value never moves.
    const narrow = { startMs: 3000, endMs: 3000 + MIN_SPAN_MS };
    renderTimelineTools(
      root,
      model,
      { ...stateFor(model), viewport: narrow },
      toolsHandlers(),
    );
    expect(Number(slider()?.value)).toBeCloseTo(1, 3);
  });

  it("asks for the window its position means, about the playhead", () => {
    const model = modelOf();
    const h = toolsHandlers();
    const positionMs = model.durationMs * 0.25;
    renderTimelineTools(
      root,
      model,
      { ...stateFor(model), viewport: fitAll(model.durationMs), positionMs },
      h,
    );
    const input = slider();
    if (!input) throw new Error("no zoom slider");
    input.value = "0.5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(h.onViewport).toHaveBeenCalledTimes(1);
    const next = h.onViewport.mock.calls[0]?.[0] as Viewport;
    // The span the knob asked for...
    expect(next.endMs - next.startMs).toBeCloseTo(
      zoomToSpan(model.durationMs, 0.5),
      3,
    );
    // ...and the playhead still in it, at the same fraction it was at —
    // which is the whole reason this anchors rather than centring. The
    // fixture guard is the 0.25 above: at 0.5 an anchored zoom and a
    // centred one land in the same place and this could not tell them
    // apart.
    expect(toFraction(next, positionMs)).toBeCloseTo(0.25, 3);
  });

  it("falls back to the middle when the playhead is outside the window", () => {
    const model = modelOf();
    const h = toolsHandlers();
    const viewport = { startMs: 0, endMs: model.durationMs / 2 };
    const positionMs = model.durationMs;
    // Fixture guard: the playhead really is outside this window.
    expect(toFraction(viewport, positionMs)).toBeGreaterThan(1);
    renderTimelineTools(
      root,
      model,
      { ...stateFor(model), viewport, positionMs },
      h,
    );
    const input = slider();
    if (!input) throw new Error("no zoom slider");
    input.value = "0.75";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const next = h.onViewport.mock.calls[0]?.[0] as Viewport;
    // Centred on what the old window was centred on, rather than dragged
    // off to wherever the playhead happens to be parked.
    expect(
      toFraction(next, (viewport.startMs + viewport.endMs) / 2),
    ).toBeCloseTo(0.5, 3);
  });

  it("refuses, and says why, on a take shorter than the zoom floor", () => {
    // `fitAll` clamps to `MIN_SPAN_MS`, so a 100ms take has no travel at
    // all — every position of the knob means the same window. A live
    // control there would move under the pointer and change nothing.
    //
    // The duration is overridden on a real model rather than a scene built
    // to be 100ms long: what is under test is which number the control
    // compares against, and that is the only field it reads.
    const short = { ...modelOf(), durationMs: 100 };
    expect(short.durationMs).toBeLessThan(MIN_SPAN_MS);
    renderTimelineTools(
      root,
      short,
      { ...stateFor(short), viewport: fitAll(short.durationMs) },
      toolsHandlers(),
    );
    expect(slider()?.disabled).toBe(true);
    expect(slider()?.title).toMatch(/too short/i);

    // Both states, because a control that is always disabled satisfies the
    // case above without being a refusal at all.
    const model = modelOf();
    expect(model.durationMs).toBeGreaterThan(MIN_SPAN_MS);
    renderTimelineTools(root, model, stateFor(model), toolsHandlers());
    expect(slider()?.disabled).toBe(false);
  });

  it("says what it does with magnifiers, not the word", () => {
    // The word "Zoom" stood beside the slider until 2026-09-22. The
    // magnifiers at its ends carry that now, and the slider keeps its name
    // for a screen reader.
    const model = modelOf();
    renderTimelineTools(root, model, stateFor(model), toolsHandlers());
    const control = root.querySelector("[data-zoom-control]");
    expect(control?.textContent?.trim()).toBe("");
    expect(slider()?.getAttribute("aria-label")).toMatch(/zoom/i);
    expect(
      [...(control?.querySelectorAll("[data-zoom-step]") ?? [])].map((b) =>
        b.getAttribute("data-zoom-step"),
      ),
      "the magnifiers are not zoom-out, then zoom-in, either side of it",
    ).toEqual(["out", "in"]);
  });

  it("steps like the − and + keys: one ZOOM_STEP about the playhead", () => {
    const model = modelOf();
    const viewport = { startMs: 1000, endMs: 1000 + model.durationMs / 2 };
    const positionMs =
      viewport.startMs + (viewport.endMs - viewport.startMs) * 0.3;
    for (const [dir, factor] of [
      ["in", ZOOM_STEP],
      ["out", 1 / ZOOM_STEP],
    ] as const) {
      const h = toolsHandlers();
      renderTimelineTools(
        root,
        model,
        { ...stateFor(model), viewport, positionMs },
        h,
      );
      root.querySelector<HTMLElement>(`[data-zoom-step="${dir}"]`)?.click();
      // The same call main.ts makes for the key, so the two can never land
      // on different windows. The playhead at 0.3 rather than 0.5 is the
      // fixture guard: at the middle an anchored zoom and a centred one
      // agree.
      expect(h.onViewport).toHaveBeenCalledWith(
        zoomAt(viewport, model.durationMs, factor, 0.3),
      );
    }
  });

  it("disables each magnifier at its own end of the travel", () => {
    const model = modelOf();
    const step = (dir: string) =>
      root.querySelector<HTMLButtonElement>(`[data-zoom-step="${dir}"]`);
    renderTimelineTools(
      root,
      model,
      { ...stateFor(model), viewport: fitAll(model.durationMs) },
      toolsHandlers(),
    );
    expect([step("out")?.disabled, step("in")?.disabled]).toEqual([
      true,
      false,
    ]);
    renderTimelineTools(
      root,
      model,
      {
        ...stateFor(model),
        viewport: { startMs: 3000, endMs: 3000 + MIN_SPAN_MS },
      },
      toolsHandlers(),
    );
    expect([step("out")?.disabled, step("in")?.disabled]).toEqual([
      false,
      true,
    ]);
    // And both on a take with no travel at all, beside the refused slider.
    const short = { ...model, durationMs: 100 };
    renderTimelineTools(
      root,
      short,
      { ...stateFor(short), viewport: fitAll(short.durationMs) },
      toolsHandlers(),
    );
    expect([step("out")?.disabled, step("in")?.disabled]).toEqual([true, true]);
  });
});

describe("clicking past everything", () => {
  const selectedTick = (model: ReturnType<typeof modelOf>) =>
    stateFor(model, { selection: { kind: "tick", actionId: "act-1" } });
  const click = (node: Element | null) =>
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  it("clears the selection", () => {
    // The inspector shows the demo panel — export, branding, render mode,
    // the replacements list — only when the selection resolves to nothing,
    // and no view called `onSelect(null)`. The first tick click of a
    // session took all of it off screen for the rest of the session.
    const model = modelOf();
    const h = handlers();
    renderTimeline(root, model, selectedTick(model), h);
    click(root.querySelector(".lanes"));
    expect(h.onSelect).toHaveBeenCalledWith(null);
  });

  it("leaves the selection alone on the drag surfaces and the zoom lane", () => {
    // Each of these already means something else where it is: the ruler and
    // the playhead's grab are scrub surfaces, and empty space on the Zoom
    // lane adds a zoom. A deselect riding along would send the author back
    // to the demo panel every time they moved the playhead.
    //
    // The Mask lane's + is in it too: `box`'s click handler excludes
    // `button` generally, and pressing + must not also drop the selection.
    const model = modelOf();
    for (const selector of [
      "[data-ruler]",
      "[data-playhead-grab]",
      '[data-track="zoom"]',
      "[data-add-mask]",
    ]) {
      const h = handlers();
      renderTimeline(root, model, selectedTick(model), h);
      const node = root.querySelector(selector);
      expect(node, selector).not.toBeNull();
      click(node);
      expect(h.onSelect, selector).not.toHaveBeenCalled();
    }
  });
});

/* `describe("the bar carries the take's hover report")` lived here until
 * 2026-09-22, when the report left the dock for the status row. Its four
 * cases moved to `editor-view.test.ts`'s `renderTakeNotes` block — all but
 * one, which was retired rather than ported: "reports loudly instead of
 * doing nothing when the Remove button has no handler wired" existed
 * because `TimelineHandlers.onRemoveStillHovers` was OPTIONAL and an
 * unwired button would have clicked into nothing. `renderTakeNotes` takes
 * its handler as required, so the case it guarded is now a compile error
 * and the runtime guard it asserted no longer exists to assert. */

/**
 * The Snap control, beside Fit.
 *
 * S toggles snapping from the keyboard, and a keystroke that silently
 * changes how every later drag behaves with nothing on screen saying so is
 * the shape this repo's first rule is about. The button is that sign — and
 * it is what the browser lane and a person looking at the editor can both
 * read back.
 */
describe("the snapping toggle", () => {
  it("shows snapping on, and says so where a reader can see it", () => {
    const model = modelOf();
    const root2 = document.createElement("div");
    renderTimelineTools(root2, model, stateFor(model), toolsHandlers());
    const snap = root2.querySelector<HTMLElement>("[data-snap]");
    expect(snap).not.toBeNull();
    expect(snap?.getAttribute("data-snap")).toBe("on");
    expect(snap?.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows snapping off when it is off", () => {
    const model = modelOf();
    const root2 = document.createElement("div");
    renderTimelineTools(
      root2,
      model,
      { ...stateFor(model), snapping: false },
      toolsHandlers(),
    );
    const snap = root2.querySelector<HTMLElement>("[data-snap]");
    expect(snap?.getAttribute("data-snap")).toBe("off");
    expect(snap?.getAttribute("aria-pressed")).toBe("false");
  });

  it("asks for the opposite of what it currently is when clicked", () => {
    const model = modelOf();
    const root2 = document.createElement("div");
    const h = toolsHandlers();
    renderTimelineTools(
      root2,
      model,
      { ...stateFor(model), snapping: true },
      h,
    );
    root2.querySelector<HTMLElement>("[data-snap]")?.click();
    expect(h.onSnapping).toHaveBeenCalledWith(false);
  });

  it("names the keystroke that does the same thing", () => {
    // A control the author can reach two ways has to say so on the one they
    // found first, or the shortcut stays undiscovered.
    const model = modelOf();
    const root2 = document.createElement("div");
    // Zoomed in, so Fit and both magnifiers have something to do.
    renderTimelineTools(
      root2,
      model,
      { ...stateFor(model), viewport: { startMs: 3000, endMs: 4000 } },
      toolsHandlers(),
    );
    const keys = Object.fromEntries(
      [
        "[data-snap]",
        "[data-fit]",
        '[data-zoom-step="out"]',
        '[data-zoom-step="in"]',
      ].map((selector) => {
        const button = root2.querySelector<HTMLButtonElement>(selector);
        // Fixture guard: a disabled control speaks through `title` instead,
        // and this would read its absence as a missing key.
        expect(button?.disabled, selector).toBe(false);
        return [selector, button?.dataset.tipKeys];
      }),
    );
    expect(keys).toEqual({
      "[data-snap]": "S",
      "[data-fit]": "Shift Z",
      '[data-zoom-step="out"]': "\u2212",
      '[data-zoom-step="in"]': "+",
    });
    expect(
      root2
        .querySelector('[data-zoom-step="out"]')
        ?.getAttribute("aria-keyshortcuts"),
    ).toBe("-");
  });
});

// The mockup the author approved on 2026-10-22 (split pieces, version 4).
describe("split pieces", () => {
  const point = (actionId: string, sourceOffsetMs: number) => ({
    actionId,
    sourceOffsetMs,
  });
  const withPieces = (edits: object) =>
    modelOf({
      ...readonlyScene(),
      edits: { ...readonlyScene().edits, ...edits },
    });
  const cutAtEnd = () =>
    withPieces({
      splits: [{ id: "s1", at: point("act-2", 0) }],
      removed: [{ id: "r1", start: point("act-2", 0), end: null }],
    });

  it("gives each inner edge a handle and leaves the clip's own ends to the trim", () => {
    const model = withPieces({ splits: [{ id: "s1", at: point("act-2", 0) }] });
    renderTimeline(root, model, stateFor(model), handlers());
    const wraps = [...root.querySelectorAll(".piece-wrap")];
    // Premise: one split, two pieces.
    expect(wraps).toHaveLength(2);
    const edges = (wrap: Element | undefined) =>
      [...(wrap?.querySelectorAll("[data-edge]") ?? [])].map((e) =>
        e.getAttribute("data-edge"),
      );
    expect(edges(wraps[0])).toEqual(["end"]);
    expect(edges(wraps[1])).toEqual(["start"]);
    expect(root.querySelector('[data-trim="head"]')).not.toBeNull();
    expect(root.querySelector('[data-trim="tail"]')).not.toBeNull();
    // Split, the clip block hands its fill to the pieces.
    expect(root.querySelector("[data-clip-block][data-pieces]")).not.toBeNull();
  });

  it("swaps the tail trim for the piece's edge where frames were removed at the end", () => {
    const model = cutAtEnd();
    renderTimeline(root, model, stateFor(model), handlers());
    const wraps = [...root.querySelectorAll(".piece-wrap")];
    expect(wraps).toHaveLength(1);
    expect(
      [...(wraps[0]?.querySelectorAll("[data-edge]") ?? [])].map((e) =>
        e.getAttribute("data-edge"),
      ),
    ).toEqual(["end"]);
    expect(root.querySelector('[data-trim="tail"]')).toBeNull();
    expect(root.querySelector('[data-trim="head"]')).not.toBeNull();
    // One piece: the block keeps its own fill, as an unsplit clip's.
    expect(root.querySelector("[data-clip-block][data-pieces]")).toBeNull();
  });

  it("opens a join's card on a click instead of restoring", () => {
    const model = cutAtEnd();
    const h = handlers();
    renderTimeline(root, model, stateFor(model), h);
    root.querySelector<HTMLElement>('[data-join="r1"]')?.click();
    expect(h.onOpenJoin).toHaveBeenCalledWith("r1");
    expect(h.onRestorePiece).not.toHaveBeenCalled();
  });

  it("opens nothing for a press on the dot that turned into a drag", () => {
    const model = cutAtEnd();
    const h = handlers();
    renderTimeline(root, model, stateFor(model), h);
    const dot = root.querySelector<HTMLElement>('[data-join="r1"]');
    dot?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: 100 }),
    );
    dot?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 120, detail: 1 }),
    );
    expect(h.onOpenJoin).not.toHaveBeenCalled();
  });

  it("draws the open card with what was removed, and restores from it", () => {
    const model = cutAtEnd();
    const h = handlers();
    renderTimeline(root, model, stateFor(model, { openJoin: "r1" }), h);
    const card = root.querySelector<HTMLElement>('[data-join-card="r1"]');
    // act-2 is at 3200 and the take's frames end at 9000 or later.
    expect(card?.textContent).toMatch(
      /^\d+\.\ds removed0:03\.2 to 0:\d\d\.\dRestore$/,
    );
    expect(card?.getAttribute("data-align")).toBe("end");
    root.querySelector<HTMLElement>('[data-restore="r1"]')?.click();
    expect(h.onRestorePiece).toHaveBeenCalledWith("r1");
    expect(
      root.querySelector('[data-join="r1"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("puts a dot and its line at one position, at the lane's end too", () => {
    const model = cutAtEnd();
    renderTimeline(root, model, stateFor(model), handlers());
    const dot = root.querySelector<HTMLElement>('[data-join="r1"]');
    const seam = root.querySelector<HTMLElement>('[data-seam="r1"]');
    // Premise: this join sits at the end of the lane.
    expect(model.clip.joins[0]?.atMs).toBe(model.durationMs);
    expect(dot?.style.left).toBe("calc(100% - 1px)");
    expect(seam?.style.left).toBe(dot?.style.left);
  });

  it("reports a dragged edge as a pieceEdge gesture by how far it moved", () => {
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        const width = this.getAttribute("data-track") === "clip" ? 1000 : 0;
        return { width, left: 0, right: width } as DOMRect;
      });
    try {
      const model = cutAtEnd();
      const h = handlers();
      const viewport = { startMs: 0, endMs: 10_000 };
      renderTimeline(root, model, stateFor(model, { viewport }), h);
      const edge = root.querySelector<HTMLElement>('[data-edge="end"]');
      edge?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientX: 300 }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 350 }),
      );
      expect(edge?.getAttribute("data-readout")).toBe("+0.5s");
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 350 }),
      );
      // 10 000 ms over 1000 px: 50 px is 500 ms.
      expect(h.onGesture).toHaveBeenCalledWith({
        kind: "pieceEdge",
        start: null,
        side: "end",
        deltaMs: 500,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a join for a piece that removed no frames", () => {
  it("says why in its card, and discards the piece from it", () => {
    const full = proceduralBundle();
    const bundle = {
      ...full,
      markers: full.markers.filter((m) => m.actionId !== "act-3"),
    };
    const scene = {
      ...readonlyScene(),
      edits: {
        ...readonlyScene().edits,
        removed: [
          {
            id: "r1",
            start: { actionId: "act-2", sourceOffsetMs: 0 },
            end: { actionId: "act-3", sourceOffsetMs: 0 },
          },
        ],
      },
    };
    const model = modelOf(scene, bundle);
    const h = handlers();
    renderTimeline(root, model, stateFor(model, { openJoin: "r1" }), h);
    const card = root.querySelector<HTMLElement>('[data-join-card="r1"]');
    expect(card?.querySelector("b")?.textContent).toBe("Removes no frames");
    expect(card?.querySelector("span")?.textContent).toMatch(
      /^These frames carry no marker for "act-3"/,
    );
    const button = root.querySelector<HTMLElement>('[data-restore="r1"]');
    expect(button?.textContent).toBe("Discard");
    button?.click();
    expect(h.onRestorePiece).toHaveBeenCalledWith("r1");
  });
});
