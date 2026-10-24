import {
  derivePresentation,
  LANDSCAPE_1080P,
  planScene,
  type Rect,
  resolvePlan,
} from "@demoman/compositor";
import { describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { applyCommand } from "../../../pages/src/editor/commands";
import { buildLaneModel } from "../../../pages/src/editor/lanes";
import {
  cssRectToCanvas,
  zoomFocusRect,
} from "../../../pages/src/editor/masks";
import { previewTarget } from "../../../pages/src/editor/preview";
import {
  drawnBox,
  renderStageOverlay,
} from "../../../pages/src/editor/stage-overlay";
import { buildTimelineView } from "../../../pages/src/editor/timeline";

const ids = () => {
  let n = 0;
  return () => `gen-${++n}`;
};

function mount() {
  // One shared id source across both commands, or each `applyCommand` call
  // gets its own counter starting back at "gen-1" — which is what a first
  // draft of this fixture did, and it left the mask and the zoom sharing an
  // id while the mask selection below ("gen-2") matched nothing at all.
  const newId = ids();
  let scene = applyCommand(
    readonlyScene(),
    {
      kind: "addZoom",
      marker: { actionId: "act-2", offsetMs: 0 },
      target: { kind: "element", anchorId: "a-row" },
      scale: 2,
    },
    newId,
  );
  scene = applyCommand(
    scene,
    {
      kind: "addMask",
      rect: { x: 300, y: 320, width: 200, height: 30 },
      start: { actionId: "act-1", sourceOffsetMs: 0 },
      end: { actionId: "act-3", sourceOffsetMs: 0 },
    },
    newId,
  );
  const bundle = proceduralBundle();
  const target = previewTarget(LANDSCAPE_1080P);
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const presentation = derivePresentation(
    scene.branding,
    target,
    scene.meta.capture.viewport,
    null,
  );
  const model = buildLaneModel({
    scene,
    view: buildTimelineView({ scene, bundle, resolved }),
    bundle,
    resolved,
    hoverReport: null,
  });
  const stage = document.createElement("div");
  stage.style.cssText =
    "position:relative;width:800px;height:500px;margin:40px";
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  canvas.style.cssText =
    "width:100%;height:100%;object-fit:contain;display:block";
  const root = document.createElement("div");
  root.style.cssText = "position:absolute;inset:0";
  stage.append(canvas, root);
  document.body.append(stage);
  return { scene, model, resolved, presentation, target, canvas, root };
}

describe("the stage overlay", () => {
  it("resizes the mask box and dispatches a rect that round-trips through the zoomed camera", () => {
    const s = mount();
    const at = (s.model.zooms[0]?.startMs ?? 0) + 200; // while the zoom is in
    const rects: Rect[] = [];
    renderStageOverlay(
      s.root,
      {
        canvas: s.canvas,
        selection: { kind: "mask", id: "gen-2" },
        model: s.model,
        resolved: s.resolved,
        presentation: s.presentation,
        target: s.target,
        outputTimeMs: at,
      },
      { onMaskRect: (_id, rect) => rects.push(rect), onZoomPoint: vi.fn() },
    );
    const box = drawnBox(s.canvas);
    expect(box.scale).toBeGreaterThan(0); // fixture guard: the canvas has layout
    const grip = s.root.querySelector<HTMLElement>(
      '[data-handle="se"]',
    ) as HTMLElement;
    const r = grip.getBoundingClientRect();
    const dxPx = 40;
    grip.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: r.left,
        clientY: r.top,
        pointerId: 1,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: r.left + dxPx,
        clientY: r.top,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: r.left + dxPx,
        clientY: r.top,
      }),
    );
    expect(rects).toHaveLength(1);
    const before = cssRectToCanvas({
      rect: { x: 300, y: 320, width: 200, height: 30 },
      resolved: s.resolved,
      target: s.target,
      presentation: s.presentation,
      outputTimeMs: at,
    });
    const after = cssRectToCanvas({
      rect: rects[0] as Rect,
      resolved: s.resolved,
      target: s.target,
      presentation: s.presentation,
      outputTimeMs: at,
    });
    // Width grew by exactly the drag, in canvas px; x, y, height unchanged.
    expect(after.width - before.width).toBeCloseTo(dxPx / box.scale, 0);
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.height).toBeCloseTo(before.height, 0);
  });

  /**
   * `place()`'s own offset arithmetic — `node.style.left = box.left +
   * rect.x * box.scale`, and the same for top — asserted directly against
   * the inline style `place()` writes, in canvas px. Read off `node.style`
   * rather than `getBoundingClientRect()`: this file never loads the shell
   * stylesheet that gives `.overlay` `position: absolute` (the drag tests
   * above don't need it — they only compare pointer deltas), so a rect
   * read here would report wherever a `position: static` node happens to
   * flow, not what `place()` computed.
   *
   * Nothing else in the repo covers this arithmetic directly:
   * `editor-shell-layout.test.ts`'s mask-overlay cases mount the real
   * `#stage-frame`, which is sized to the bitmap's own ratio, so
   * `drawnBox`'s offsets are ~0 there by construction (see `drawnBox`'s
   * docblock) and a ±0.5px tolerance cannot tell "offset added" from
   * "offset dropped". This file's `mount()` fixture is independent of that
   * CSS — its 800x500 stage div does not share `LANDSCAPE_1080P`'s preview
   * ratio — so `drawnBox` reports a real, non-trivial margin here, and
   * dropping `box.left +` / `box.top +` from `place()` moves this test's
   * expectation by that margin, not by half a pixel. Verified: reverting
   * `place()` to `node.style.left = \`${rect.x * box.scale}px\`` (dropping
   * the offset) turns this red.
   */
  it("places the mask box at the drawn box's offset, not the canvas element's own corner", () => {
    const s = mount();
    const at = (s.model.masks[0]?.startMs ?? 0) + 200;
    renderStageOverlay(
      s.root,
      {
        canvas: s.canvas,
        selection: { kind: "mask", id: "gen-2" },
        model: s.model,
        resolved: s.resolved,
        presentation: s.presentation,
        target: s.target,
        outputTimeMs: at,
      },
      { onMaskRect: vi.fn(), onZoomPoint: vi.fn() },
    );
    const box = drawnBox(s.canvas);
    // Fixture guard: this test says nothing about the offset unless the
    // fixture's canvas element box and its drawn box actually differ.
    expect(
      box.left > 0.5 || box.top > 0.5,
      `drawnBox reports no letterboxing (left ${box.left}, top ${box.top}) — this fixture cannot distinguish "offset added" from "offset dropped"`,
    ).toBe(true);
    const mask = s.model.masks.find((m) => m.id === "gen-2");
    if (!mask) throw new Error("fixture has no mask to select");
    const rect = cssRectToCanvas({
      rect: mask.rect,
      resolved: s.resolved,
      target: s.target,
      presentation: s.presentation,
      outputTimeMs: at,
    });
    const node = s.root.querySelector<HTMLElement>(
      '[data-overlay="mask"]',
    ) as HTMLElement;
    expect(Number.parseFloat(node.style.left)).toBeCloseTo(
      box.left + rect.x * box.scale,
      0,
    );
    expect(Number.parseFloat(node.style.top)).toBeCloseTo(
      box.top + rect.y * box.scale,
      0,
    );
  });

  // F2: a plain click used to dispatch the focus's own (unmoved) centre —
  // indistinguishable from an author who actually meant to re-aim the zoom
  // at that exact point. `onUp` now requires the pointer to have travelled
  // past `DRAG_THRESHOLD_PX` before it dispatches anything.
  it("dispatches nothing for a press that never moved", () => {
    const s = mount();
    const points: { x: number; y: number }[] = [];
    renderStageOverlay(
      s.root,
      {
        canvas: s.canvas,
        selection: { kind: "zoom", id: "gen-1" },
        model: s.model,
        resolved: s.resolved,
        presentation: s.presentation,
        target: s.target,
        outputTimeMs: 0,
      },
      { onMaskRect: vi.fn(), onZoomPoint: (_id, p) => points.push(p) },
    );
    const node = s.root.querySelector<HTMLElement>(
      '[data-overlay="zoom"]',
    ) as HTMLElement;
    const r = node.getBoundingClientRect();
    node.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: r.left + 10,
        clientY: r.top + 10,
        pointerId: 1,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: r.left + 10,
        clientY: r.top + 10,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: r.left + 10,
        clientY: r.top + 10,
      }),
    );
    expect(points).toEqual([]);
  });

  it("draws the zoom focus and dispatches a point moved by 30 / box.scale in canvas x", () => {
    const s = mount();
    const points: { x: number; y: number }[] = [];
    renderStageOverlay(
      s.root,
      {
        canvas: s.canvas,
        selection: { kind: "zoom", id: "gen-1" },
        model: s.model,
        resolved: s.resolved,
        presentation: s.presentation,
        target: s.target,
        outputTimeMs: 0,
      },
      { onMaskRect: vi.fn(), onZoomPoint: (_id, p) => points.push(p) },
    );
    const box = drawnBox(s.canvas);
    const node = s.root.querySelector<HTMLElement>(
      '[data-overlay="zoom"]',
    ) as HTMLElement;
    const r = node.getBoundingClientRect();
    const dxPx = 30;
    node.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: r.left + 10,
        clientY: r.top + 10,
        pointerId: 1,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: r.left + 10 + dxPx,
        clientY: r.top + 10,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: r.left + 10 + dxPx,
        clientY: r.top + 10,
      }),
    );
    expect(points).toHaveLength(1);
    const convert = {
      resolved: s.resolved,
      target: s.target,
      presentation: s.presentation,
      outputTimeMs: 0,
    };
    const zoom = s.model.zooms.find((z) => z.id === "gen-1");
    if (!zoom) throw new Error("fixture");
    // The focus's own centre before any drag — computed independently
    // rather than read off an unmoved dispatch, which now sends nothing.
    const focus = zoomFocusRect({
      zoom,
      resolved: s.resolved,
      viewport: s.resolved.plan.viewport,
      presentation: s.presentation,
      target: s.target,
    });
    const centre = {
      x: focus.x + focus.width / 2,
      y: focus.y + focus.height / 2,
    };
    const before = cssRectToCanvas({
      rect: { ...centre, width: 0, height: 0 },
      ...convert,
    });
    const point = points[0] as { x: number; y: number };
    const after = cssRectToCanvas({
      rect: { x: point.x, y: point.y, width: 0, height: 0 },
      ...convert,
    });
    expect(after.x - before.x).toBeCloseTo(dxPx / box.scale, 0);
  });
});
