import { CAMERA_DEFAULTS, planScene, resolvePlan } from "@demoman/compositor";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
// The editor's own stylesheet, as `editor-timeline-geometry.test.ts` loads
// it: the ghost is asserted on by rect, and without `.seg` absolutely
// positioned nothing here could move.
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import { renderTimeline } from "../../../pages/entrypoints/editor/timeline-view";
import { applyCommand } from "../../../pages/src/editor/commands";
import {
  type Gesture,
  MASK_DEFAULT_MS,
  MIN_ZOOM_GAP_MS,
  placeZoom,
  ZOOM_DEFAULT_MS,
} from "../../../pages/src/editor/gestures";
import { buildLaneModel } from "../../../pages/src/editor/lanes";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import { fitAll } from "../../../pages/src/editor/viewport";
import { mountShell } from "../helpers/shell-css";

/**
 * The hover ghost on the Zoom and Mask lanes: a translucent segment where a
 * click would put the new zoom or mask, drawn from the same placement the
 * resolver uses, so a zoom moved past a collision is visible before the
 * click and not only in the note after it.
 */
beforeAll(() => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(shell)?.[1];
  if (!css?.includes(".seg")) {
    throw new Error("index.html no longer carries the editor's stylesheet");
  }
  // The shell the page links comes too: `box-sizing` and the base font
  // live there since 2026-09-14, and a lane laid out without them is not
  // the lane the editor draws.
  mountShell("light", css);
});

const ids = () => {
  let n = 0;
  return () => `gen-${++n}`;
};

function mount(scene = readonlyScene()) {
  const bundle = proceduralBundle();
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const model = buildLaneModel({
    scene,
    view: buildTimelineView({ scene, bundle, resolved }),
    bundle,
    resolved,
    hoverReport: null,
  });
  const root = document.createElement("div");
  root.style.width = "1000px";
  root.style.marginLeft = "120px";
  document.body.append(root);
  const gestures: Gesture[] = [];
  renderTimeline(
    root,
    model,
    {
      viewport: fitAll(model.durationMs),
      selection: null,
      positionMs: 0,
      refusal: null,
      snapping: true,
    },
    {
      onSelect: vi.fn(),
      onSeek: vi.fn(),
      onSeekStart: vi.fn(),
      onGesture: (g) => gestures.push(g),
      onViewport: vi.fn(),
      onSnapping: vi.fn(),
      onSplit: vi.fn(),
      onRestorePiece: vi.fn(),
      onOpenJoin: vi.fn(),
    },
  );
  const track = (kind: "zoom" | "mask"): HTMLElement =>
    root.querySelector(`[data-track="${kind}"]`) as HTMLElement;
  return { root, model, gestures, track };
}

const at = (node: Element, fraction: number): number => {
  const rect = node.getBoundingClientRect();
  return rect.left + rect.width * fraction;
};

const hover = (node: HTMLElement, clientX: number): void => {
  node.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, clientX }),
  );
};

/** The ghost's span as fractions of its track. */
function ghostBox(
  track: HTMLElement,
  kind: "zoom" | "mask",
): { left: number; width: number } | null {
  const ghost = track.querySelector<HTMLElement>(`[data-ghost="${kind}"]`);
  if (ghost === null) return null;
  const t = track.getBoundingClientRect();
  const g = ghost.getBoundingClientRect();
  return { left: (g.left - t.left) / t.width, width: g.width / t.width };
}

describe("the hover ghost", () => {
  it("draws a fresh zoom's length centred under the pointer, and the click adds that", () => {
    const { model, track, gestures } = mount();
    const zoom = track("zoom");
    expect(zoom.getBoundingClientRect().width).toBeGreaterThan(0); // guard
    hover(zoom, at(zoom, 0.5));
    const box = ghostBox(zoom, "zoom");
    if (box === null) throw new Error("no ghost on hover");
    // Drawn from the push-in setting off to the automatic return, as a
    // placed zoom is drawn.
    expect(model.zoomInMs).toBeGreaterThan(0); // guard
    const length = (model.zoomInMs + ZOOM_DEFAULT_MS) / model.durationMs;
    expect(box.width).toBeCloseTo(length, 2);
    // Centred, not started, at the pointer: a segment that hung off the
    // pointer's right read as placed at its end.
    expect(box.left + box.width / 2).toBeCloseTo(0.5, 2);
    expect(zoom.querySelectorAll("[data-ghost]")).toHaveLength(1);
    // And the click adds what the ghost drew: a zoom landing its push-in's
    // length after the ghost's left edge.
    zoom.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: at(zoom, 0.5) }),
    );
    const g = gestures[0];
    if (g?.kind !== "addZoom")
      throw new Error(`expected addZoom, got ${g?.kind}`);
    expect(g.atMs).toBeCloseTo(
      box.left * model.durationMs + model.zoomInMs,
      -1,
    );
  });

  it("follows the pointer, stays on the take at its start, and leaves with it", () => {
    const { model, track } = mount();
    const zoom = track("zoom");
    const half = (model.zoomInMs + ZOOM_DEFAULT_MS) / 2 / model.durationMs;
    expect(0.2 - half).toBeGreaterThan(0); // guard: not clamped at 0.2
    hover(zoom, at(zoom, 0.2));
    expect(ghostBox(zoom, "zoom")?.left).toBeCloseTo(0.2 - half, 2);
    hover(zoom, at(zoom, 0.4));
    // Moved, not duplicated.
    expect(zoom.querySelectorAll("[data-ghost]")).toHaveLength(1);
    expect(ghostBox(zoom, "zoom")?.left).toBeCloseTo(0.4 - half, 2);
    // Within half a length of the start, the span clamps to the take's
    // start rather than running before it.
    hover(zoom, at(zoom, half / 2));
    expect(ghostBox(zoom, "zoom")?.left).toBeCloseTo(0, 2);
    zoom.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
    expect(ghostBox(zoom, "zoom")).toBeNull();
  });

  it("shows a zoom moved past a collision where it will actually go", () => {
    // On act-1, so the slot after it has the rest of this 9s take to land in.
    // Ended as early as the camera allows, so that just past its end is
    // still within `MIN_ZOOM_GAP_MS` of its start.
    const scene = applyCommand(
      applyCommand(
        readonlyScene(),
        {
          kind: "addZoom",
          marker: { actionId: "act-1", offsetMs: 0 },
          target: { kind: "element", anchorId: "a-row" },
          scale: 1.8,
        },
        ids(),
      ),
      {
        kind: "setZoomRange",
        id: "gen-1",
        start: { actionId: "act-1", offsetMs: CAMERA_DEFAULTS.leadInMs },
        end: { actionId: "act-1", offsetMs: 0 },
      },
      ids(),
    );
    const { model, track } = mount(scene);
    const zoom = track("zoom");
    const z = model.zooms[0];
    if (!z) throw new Error("fixture");
    const mid = (z.startMs + z.endMs) / 2 / model.durationMs;
    // Over the existing segment the pointer is on the segment, not the
    // track, and there is no ghost; just past its end there is, and it is
    // drawn where the placement moved it rather than under the pointer.
    const seg = zoom.querySelector(`[data-segment="${z.id}"]`) as HTMLElement;
    hover(seg, at(zoom, mid));
    expect(ghostBox(zoom, "zoom")).toBeNull();
    // Just past the segment's end: centred there, the candidate — taking an
    // element zoom's lead-in, the widest it can be — would start within
    // `MIN_ZOOM_GAP_MS` of the zoom's start.
    const justPast = (z.endMs + 1) / model.durationMs;
    expect(
      z.endMs +
        1 -
        (ZOOM_DEFAULT_MS - model.zoomInMs) / 2 +
        CAMERA_DEFAULTS.leadInMs -
        z.startMs,
    ).toBeLessThan(MIN_ZOOM_GAP_MS); // fixture guard
    hover(zoom, at(zoom, justPast));
    const box = ghostBox(zoom, "zoom");
    if (box === null) throw new Error("no ghost past the zoom");
    const asked = z.endMs + 1 - (ZOOM_DEFAULT_MS - model.zoomInMs) / 2; // `centredAt`
    const placement = placeZoom(model, asked);
    if (placement.kind !== "placed") throw new Error("refused");
    expect(placement.movedPast?.zoom.id).toBe(z.id); // guard: it moved
    expect(placement.atMs).toBeGreaterThan(asked + 100);
    // Its push-in would set off inside the zoom before, which the camera
    // does not leave until it is back at full frame: drawn from there, not
    // over that zoom's block.
    expect(placement.atMs - model.zoomInMs).toBeLessThan(z.drawnEndMs); // guard
    expect(box.left).toBeCloseTo(z.drawnEndMs / model.durationMs, 2);
  });

  it("draws a mask to the next tick or its default length, and adds one on click", () => {
    const { model, track, gestures } = mount();
    const mask = track("mask");
    expect(mask.getBoundingClientRect().width).toBeGreaterThan(0); // guard
    hover(mask, at(mask, 0.5));
    const box = ghostBox(mask, "mask");
    if (box === null) throw new Error("no ghost on the mask lane");
    // Fixture guard: no tick within half a default length either side of
    // the midpoint, so the default length is what is drawn, centred.
    const pointerMs = model.durationMs * 0.5;
    const atMs = pointerMs - MASK_DEFAULT_MS / 2;
    expect(
      model.clip.ticks.some(
        (t) => t.atMs > atMs && t.atMs < atMs + MASK_DEFAULT_MS,
      ),
    ).toBe(false);
    expect(box.width).toBeCloseTo(MASK_DEFAULT_MS / model.durationMs, 2);
    expect(box.left + box.width / 2).toBeCloseTo(0.5, 2);

    mask.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: at(mask, 0.5) }),
    );
    const g = gestures[0];
    if (g?.kind !== "addMask")
      throw new Error(`expected addMask, got ${g?.kind}`);
    expect(g.atMs).toBeCloseTo(atMs, -1);
  });

  it("draws nothing where the click would be refused", () => {
    // A zoom whose authored end covers the take leaves no slot on either
    // side of it, so `placeZoom` refuses everywhere and the ghost has nothing
    // to promise.
    const newId = ids();
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-1", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      newId,
    );
    scene = applyCommand(
      scene,
      {
        kind: "setZoomRange",
        id: "gen-1",
        start: { actionId: "act-1", offsetMs: 0 },
        end: { actionId: "act-3", offsetMs: 0 },
      },
      newId,
    );
    const { model, track } = mount(scene);
    const zoom = track("zoom");
    const z = model.zooms[0];
    if (!z) throw new Error("fixture");
    // Fixture guards: every later start is inside the authored span, and
    // there is too little take before it for a start `MIN_ZOOM_GAP_MS`
    // earlier, with an element zoom's lead-in.
    expect(z.endAuthored).toBe(true);
    expect(z.endMs).toBe(model.durationMs);
    expect(z.startMs - MIN_ZOOM_GAP_MS + CAMERA_DEFAULTS.leadInMs).toBeLessThan(
      0,
    );
    // The sliver of track before the segment is the only empty track left.
    hover(zoom, at(zoom, z.startMs / 2 / model.durationMs));
    expect(ghostBox(zoom, "zoom")).toBeNull();
  });
});
