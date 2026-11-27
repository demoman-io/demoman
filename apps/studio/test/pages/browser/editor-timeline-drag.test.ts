import { planScene, resolvePlan } from "@demoman/compositor";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
// The editor's own stylesheet, as `editor-timeline-geometry.test.ts` loads
// it. The live-preview tests below read rects, and without `.handle` and
// `.seg` being absolutely positioned, `style.left` moves nothing and a
// preview that never ran would read exactly like one that did.
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import { renderTimeline } from "../../../pages/entrypoints/editor/timeline-view";
import { applyCommand } from "../../../pages/src/editor/commands";
import {
  type Gesture,
  SNAP_PX,
  ZOOM_DEFAULT_MS,
} from "../../../pages/src/editor/gestures";
import { buildLaneModel } from "../../../pages/src/editor/lanes";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import { fitAll } from "../../../pages/src/editor/viewport";
import { mountShell } from "../helpers/shell-css";

beforeAll(() => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(shell)?.[1];
  if (!css?.includes(".handle")) {
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

function mount(scene = readonlyScene(), snapping = true) {
  const bundle = proceduralBundle();
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const model = buildLaneModel({
    rerunLine: "re-film it",
    scene,
    view: buildTimelineView({ scene, bundle, resolved }),
    bundle,
    resolved,
    hoverReport: null,
  });
  const root = document.createElement("div");
  root.style.width = "1000px";
  // Off the body's left edge, so a dropped `rect.left` cannot pass unnoticed.
  root.style.marginLeft = "120px";
  document.body.append(root);
  const gestures: Gesture[] = []; // recorded, never spied on console
  const draw = () =>
    renderTimeline(
      root,
      model,
      {
        viewport: fitAll(model.durationMs),
        selection: null,
        positionMs: 0,
        refusal: null,
        snapping,
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
  draw();
  /** The same render again, as the folder watch's refresh asks for one. */
  return { root, model, gestures, again: draw };
}

const at = (node: Element, fraction: number): number => {
  const rect = node.getBoundingClientRect();
  return rect.left + rect.width * fraction;
};

function drag(el: HTMLElement, fromX: number, toX: number): void {
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      clientX: fromX,
      pointerId: 1,
    }),
  );
  window.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, clientX: toX }),
  );
  window.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, clientX: toX }),
  );
}

describe("timeline drags", () => {
  it("turns a real pointer drag on the tail handle into a trim gesture at that instant", () => {
    const { root, model, gestures } = mount();
    const handle = root.querySelector<HTMLElement>(
      '[data-trim="tail"]',
    ) as HTMLElement;
    const track = root.querySelector<HTMLElement>(
      '[data-track="clip"]',
    ) as HTMLElement;
    expect(track.getBoundingClientRect().left).toBeGreaterThan(0); // fixture guard
    drag(handle, at(handle, 0.5), at(track, 0.6));
    expect(gestures).toHaveLength(1);
    const g = gestures[0];
    expect(g?.kind).toBe("trim");
    if (g?.kind !== "trim") throw new Error("kind");
    expect(g.edge).toBe("tail");
    expect(g.toMs).toBeCloseTo(model.durationMs * 0.6, -2);
    // The snap band is SNAP_PX worth of the window.
    const perPx = model.durationMs / track.getBoundingClientRect().width;
    expect(g.snapMs).toBeCloseTo(SNAP_PX * perPx, 3);
  });

  // S. The band is what makes a drag land on a beat; with it off the author
  // can put a zoom or a mask edge at an instant no step sits on, which is
  // otherwise unreachable — an 8px band on a 60s take is ~600ms wide.
  it("hands every drag a zero snap band when snapping is off", () => {
    const { root, model, gestures } = mount(readonlyScene(), false);
    const handle = root.querySelector<HTMLElement>(
      '[data-trim="tail"]',
    ) as HTMLElement;
    const track = root.querySelector<HTMLElement>(
      '[data-track="clip"]',
    ) as HTMLElement;
    drag(handle, at(handle, 0.5), at(track, 0.6));
    const g = gestures[0];
    if (g?.kind !== "trim") throw new Error("kind");
    expect(g.snapMs).toBe(0);
    // ...and the instant itself is untouched, so this is the band going
    // away rather than the drag being dropped.
    expect(g.toMs).toBeCloseTo(model.durationMs * 0.6, -2);
    // Fixture guard: the same drag with snapping on has a band to lose.
    const on = mount(readonlyScene(), true);
    drag(
      on.root.querySelector<HTMLElement>('[data-trim="tail"]') as HTMLElement,
      at(on.root.querySelector('[data-trim="tail"]') as Element, 0.5),
      at(on.root.querySelector('[data-track="clip"]') as Element, 0.6),
    );
    expect((on.gestures[0] as { snapMs: number }).snapMs).toBeGreaterThan(0);
  });

  it("reports a body drag as a delta in ms, not an absolute instant", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      ids(),
    );
    const { root, model, gestures } = mount(scene);
    const seg = root.querySelector<HTMLElement>(
      '[data-segment="gen-1"]',
    ) as HTMLElement;
    const track = root.querySelector<HTMLElement>(
      '[data-track="zoom"]',
    ) as HTMLElement;
    const width = track.getBoundingClientRect().width;
    drag(seg, at(seg, 0.5), at(seg, 0.5) + width * 0.1);
    const g = gestures[0];
    if (g?.kind !== "moveZoom")
      throw new Error(`expected moveZoom, got ${g?.kind}`);
    expect(g.deltaMs).toBeCloseTo(model.durationMs * 0.1, -2);
  });

  it("shortens the clip block with the pointer before release, then commits once", () => {
    // The `[data-cut]` overlays this used to measure were retired with the
    // flat dock (2026-09-21). The block IS the kept range now, so what the
    // drag previews is the block's own right edge — a stronger thing to
    // assert than a shade drawn beside it, because it is the picture an
    // author is actually reading the trim off.
    const { root, gestures } = mount();
    const handle = root.querySelector<HTMLElement>(
      '[data-trim="tail"]',
    ) as HTMLElement;
    const track = root.querySelector<HTMLElement>(
      '[data-track="clip"]',
    ) as HTMLElement;
    const block = root.querySelector<HTMLElement>(
      "[data-clip-block]",
    ) as HTMLElement;
    const width = track.getBoundingClientRect().width;
    const left = (node: Element): number =>
      node.getBoundingClientRect().left - track.getBoundingClientRect().left;
    // Fixture guard: the take starts untrimmed, so the block spans the
    // whole track and the drag has to SHORTEN it rather than move an
    // already-short one. Without this, every width below could be
    // satisfied by a block that was already that size.
    expect(block).not.toBeNull();
    expect(left(block)).toBeCloseTo(0, 0);
    expect(block.getBoundingClientRect().width).toBeCloseTo(width, 0);
    const startX = at(handle, 0.5);
    handle.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: startX }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: at(track, 0.6),
      }),
    );
    // Live: the handle and the block's end follow the pointer, and nothing
    // has been committed yet.
    expect(gestures).toEqual([]);
    expect(left(handle) + 4).toBeCloseTo(width * 0.6, 0);
    expect(left(block)).toBeCloseTo(0, 0);
    expect(block.getBoundingClientRect().width).toBeCloseTo(width * 0.6, 0);
    // Back toward the start: the preview tracks the pointer both ways.
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: at(track, 0.3),
      }),
    );
    expect(left(handle) + 4).toBeCloseTo(width * 0.3, 0);
    expect(block.getBoundingClientRect().width).toBeCloseTo(width * 0.3, 0);
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: at(track, 0.3) }),
    );
    // One commit, at the drop; and the preview is put back to the model's
    // own trim, because a drop the resolver turns into nothing never
    // re-renders.
    expect(gestures).toHaveLength(1);
    expect(gestures[0]?.kind).toBe("trim");
    expect(block.getBoundingClientRect().width).toBeCloseTo(width, 0);
    expect(left(handle) + 4).toBeCloseTo(width, 0);
  });

  it("moves a zoom segment with the pointer before release", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      ids(),
    );
    const { root, gestures } = mount(scene);
    const seg = root.querySelector<HTMLElement>(
      '[data-segment="gen-1"]',
    ) as HTMLElement;
    const track = root.querySelector<HTMLElement>(
      '[data-track="zoom"]',
    ) as HTMLElement;
    const width = track.getBoundingClientRect().width;
    const before = seg.getBoundingClientRect();
    seg.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: at(seg, 0.5) }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: at(seg, 0.5) + width * 0.1,
      }),
    );
    expect(gestures).toEqual([]);
    const during = seg.getBoundingClientRect();
    expect(during.left - before.left).toBeCloseTo(width * 0.1, 0);
    expect(during.width).toBeCloseTo(before.width, 0);
  });

  it("emits nothing when the pointer never moved, and selects instead", () => {
    const { root, gestures } = mount();
    const handle = root.querySelector<HTMLElement>(
      '[data-trim="head"]',
    ) as HTMLElement;
    drag(handle, at(handle, 0.5), at(handle, 0.5));
    expect(gestures).toEqual([]);
  });

  // The block starts where the push-in sets off, so its start cap hands
  // over the instant it was dropped at, a departure; `resolveGesture` lands
  // the zoom its push-in's length later (`editor-gestures.test.ts`).
  it("hands a start-cap drag over as the instant it was dropped at", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-3", offsetMs: 0 },
        target: { kind: "point", x: 5, y: 6 },
        scale: 1.8,
      },
      ids(),
    );
    const { root, model, gestures } = mount(scene, false);
    const z = model.zooms[0];
    if (!z) throw new Error("fixture");
    const leadMs = z.startMs - z.departMs;
    expect(leadMs).toBeGreaterThan(500); // guard: a real push-in, not clipped
    const cap = root.querySelector<HTMLElement>(
      `[data-segment="${z.id}"] [data-cap="start"]`,
    ) as HTMLElement;
    const track = root.querySelector<HTMLElement>(
      '[data-track="zoom"]',
    ) as HTMLElement;
    drag(cap, at(cap, 0.5), at(track, 0.5));
    const g = gestures[0];
    if (g?.kind !== "zoomEdge") throw new Error(`got ${g?.kind}`);
    expect(g.edge).toBe("start");
    expect(g.toMs).toBeCloseTo(model.durationMs * 0.5, -2);
  });

  it("ends a zoom's block where the next one sets off when the camera pans between them", () => {
    let scene = readonlyScene();
    const fresh = ids();
    for (const offsetMs of [0, 700])
      scene = applyCommand(
        scene,
        {
          kind: "addZoom",
          marker: { actionId: "act-2", offsetMs },
          target: { kind: "point", x: 5 + offsetMs, y: 6 },
          scale: 1.8,
        },
        fresh,
      );
    const { root, model } = mount(scene);
    const [a, b] = [...model.zooms].sort((x, y) => x.startMs - y.startMs);
    if (!a || !b) throw new Error("fixture");
    // Fixture guard: no room to return, so `a` runs to `b`'s landing and
    // `b`'s pan sets off before it.
    expect(a.endMs).toBe(b.startMs);
    expect(b.departMs).toBeLessThan(a.endMs);
    const box = (id: string) =>
      root.querySelector(`[data-segment="${id}"]`)?.getBoundingClientRect();
    const right = box(a.id)?.right ?? 0;
    const left = box(b.id)?.left ?? 0;
    expect(Math.abs(right - left)).toBeLessThan(1);
  });

  it("adds a zoom centred on the instant clicked on the empty zoom track", () => {
    const { root, model, gestures } = mount();
    const track = root.querySelector<HTMLElement>(
      '[data-track="zoom"]',
    ) as HTMLElement;
    track.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: at(track, 0.25) }),
    );
    const g = gestures[0];
    if (g?.kind !== "addZoom")
      throw new Error(`expected addZoom, got ${g?.kind}`);
    // Landed so the block it draws — `zoomInMs` before the landing to a
    // default zoom after it — sits under the pointer rather than hanging
    // off its right. `editor-timeline-ghost.test.ts` pins the ghost to the
    // same rule.
    expect(g.atMs).toBeCloseTo(
      model.durationMs * 0.25 - (ZOOM_DEFAULT_MS - model.zoomInMs) / 2,
      -2,
    );
  });
});

// A render that lands mid-drag (the folder watch's refresh after an edit)
// replaced the handle in the hand, and the one drawn stopped following
// the pointer: it waits for the release instead.
describe("a render while a drag is held", () => {
  const press = (handle: HTMLElement, track: HTMLElement) => {
    handle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: at(handle, 0.5),
        pointerId: 1,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: at(track, 0.6),
      }),
    );
  };

  it("keeps the handle in the hand and lands on the release", () => {
    const { root, gestures, again } = mount();
    const handle = root.querySelector<HTMLElement>(
      '[data-trim="tail"]',
    ) as HTMLElement;
    const track = root.querySelector<HTMLElement>(
      '[data-track="clip"]',
    ) as HTMLElement;
    press(handle, track);
    expect(handle.hasAttribute("data-dragging"), "premise: held").toBe(true);
    again();
    expect(
      root.querySelector('[data-trim="tail"]'),
      "the handle in the hand",
    ).toBe(handle);
    expect(root.hasAttribute("data-render-held"), "the render waits").toBe(
      true,
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: at(track, 0.6) }),
    );
    expect(gestures.map((g) => g.kind)).toEqual(["trim"]);
    expect(
      root.querySelector('[data-trim="tail"]'),
      "redrawn on release",
    ).not.toBe(handle);
    expect(root.hasAttribute("data-render-held")).toBe(false);
  });

  // A touch the browser takes for a pan ends in pointercancel. The drag
  // ended only on pointerup, so the render it held waited, and the next
  // tap's pointerup dropped the drag where it landed.
  it("ends on a pointercancel with no gesture, and the render lands", () => {
    const { root, gestures, again } = mount();
    const handle = root.querySelector<HTMLElement>(
      '[data-trim="tail"]',
    ) as HTMLElement;
    const track = root.querySelector<HTMLElement>(
      '[data-track="clip"]',
    ) as HTMLElement;
    press(handle, track);
    again();
    expect(root.hasAttribute("data-render-held"), "premise: held").toBe(true);
    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    expect(handle.hasAttribute("data-dragging"), "the drag ended").toBe(false);
    expect(root.querySelector('[data-trim="tail"]'), "redrawn").not.toBe(
      handle,
    );
    expect(root.hasAttribute("data-render-held")).toBe(false);
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: at(track, 0.3) }),
    );
    expect(gestures, "a later tap drops nothing").toEqual([]);
  });
});

// The edges between two pieces sit under the beats: their two grabs cover
// the seam, and a beat on it (a split made at a step) is clicked there.
// The clip's own ends are its trim and go over them.
describe("a beat on a seam between two pieces", () => {
  it("is what a press at its middle lands on", () => {
    const scene = applyCommand(
      readonlyScene(),
      { kind: "split", at: { actionId: "act-2", sourceOffsetMs: 0 } },
      ids(),
    );
    const { root } = mount(scene);
    const wraps = root.querySelectorAll(".piece-wrap");
    expect(wraps.length, "premise: two pieces").toBe(2);
    const beat = root.querySelector<HTMLElement>(
      '[data-track="clip"] [data-tick="act-2"]',
    ) as HTMLElement;
    // Each mount is another root down the page: this one, into the window.
    beat.scrollIntoView({ block: "center", inline: "center" });
    const b = beat.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    // Premise: an interior edge's grab reaches the beat's middle, so this
    // asks which is on top.
    const edges = [
      ...root.querySelectorAll<HTMLElement>(
        '.piece-wrap:first-child > [data-edge="end"], .piece-wrap:last-child > [data-edge="start"]',
      ),
    ].map((e) => e.getBoundingClientRect());
    expect(
      edges.some((r) => r.left - 6 <= x && x <= r.right + 6),
      `premise: an edge's grab at the beat's middle ${x}: ${JSON.stringify(edges)}`,
    ).toBe(true);
    const hit = document.elementFromPoint(x, y);
    expect(
      hit !== null && beat.contains(hit),
      `the beat on the seam is under ${hit?.outerHTML.slice(0, 80)}`,
    ).toBe(true);
  });
});
