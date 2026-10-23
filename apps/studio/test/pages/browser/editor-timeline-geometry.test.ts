import { planScene, resolvePlan } from "@demoman/compositor";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
// The editor's OWN stylesheet, read from the shell it ships in. Every
// assertion in this file is about geometry the CSS produces, so a hand-copied
// approximation of it here would prove something about the copy.
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import {
  MIN_CLIP_FRACTION,
  renderTimeline,
} from "../../../pages/entrypoints/editor/timeline-view";
import { buildLaneModel } from "../../../pages/src/editor/lanes";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import {
  fitAll,
  toFraction,
  type Viewport,
} from "../../../pages/src/editor/viewport";
import { mountShell } from "../helpers/shell-css";

/**
 * The lanes as they are actually laid out, which is the only place the two
 * coordinate systems in `renderTimeline` can be told apart.
 *
 * `.lane` is a two-column grid — a 76px label column, then the track — so a
 * ruler or a playhead positioned as a fraction of the whole `.timeline` box
 * has both a different origin and a different scale from the clips it is
 * drawn above. jsdom never lays out and cannot see that; the node lane pins
 * the structure, and this pins the pixels the structure is there to produce.
 */
beforeAll(() => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(shell)?.[1];
  // Not decoration: a shell that stopped carrying its styles inline would
  // leave every rect below equal to every other one and pass this whole file
  // vacuously.
  if (!css?.includes(".lane")) {
    throw new Error("index.html no longer carries the editor's stylesheet");
  }
  // The shell the page links comes too: `box-sizing` and the base font
  // live there since 2026-09-14, and a lane laid out without them is not
  // the lane the editor draws.
  mountShell("light", css);
});

function zoomedScene() {
  const scene = readonlyScene();
  return {
    ...scene,
    camera: [
      {
        id: "cam-1",
        kind: "zoom" as const,
        anchorId: "a-checkout",
        marker: { actionId: "act-3", offsetMs: -350 },
        scale: 1.6,
      },
    ],
  };
}

function mount(
  options: {
    scene?: ReturnType<typeof readonlyScene>;
    positionMs?: number;
    viewport?: Viewport;
    onSeek?: (outputMs: number) => void;
  } = {},
) {
  const scene = options.scene ?? readonlyScene();
  const bundle = proceduralBundle();
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const model = buildLaneModel({
    scene,
    view: buildTimelineView({ scene, bundle, resolved }),
    bundle,
    resolved,
    hoverReport: null,
  });
  // `id="timeline"`, because the rule that grows the scrollbar this file
  // checks for — `#timeline { overflow-x: auto }` — is addressed by id.
  const root = document.createElement("div");
  root.id = "timeline";
  root.style.width = "1000px";
  // Offset from the body's left edge, so a rect whose `left` was dropped
  // rather than measured does not happen to come out right.
  root.style.marginLeft = "120px";
  document.body.replaceChildren(root);
  renderTimeline(
    root,
    model,
    {
      viewport: options.viewport ?? fitAll(model.durationMs),
      selection: null,
      positionMs: options.positionMs ?? 0,
      refusal: null,
      snapping: true,
    },
    {
      onSelect: vi.fn(),
      onSeek: options.onSeek ?? vi.fn(),
      onSeekStart: vi.fn(),
      onGesture: vi.fn(),
      onViewport: vi.fn(),
      onSnapping: vi.fn(),
      onSplit: vi.fn(),
      onRestorePiece: vi.fn(),
      onOpenJoin: vi.fn(),
    },
  );
  return { root, model };
}

const rectOf = (root: HTMLElement, selector: string): DOMRect => {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node.getBoundingClientRect();
};

describe("the timeline's one axis", () => {
  it("gives the ruler the clips' own origin and scale", () => {
    const { root } = mount();
    const ruler = rectOf(root, "[data-ruler]");
    const track = rectOf(root, '[data-track="clip"]');
    // The fixture guard the rest of the file rests on: the track really is
    // inset behind a label column, so "the whole box" and "the track" are
    // genuinely different rects here.
    expect(track.left).toBeGreaterThan(rectOf(root, ".timeline").left + 50);
    expect(ruler.left).toBeCloseTo(track.left, 1);
    expect(ruler.width).toBeCloseTo(track.width, 1);
  });

  it("puts the playhead on the instant it is given, at both ends", () => {
    const head = mount({ positionMs: 0 });
    expect(rectOf(head.root, "[data-playhead]").left).toBeCloseTo(
      rectOf(head.root, '[data-track="clip"]').left,
      0,
    );

    const tail = mount({ positionMs: 9_999_999 });
    const track = rectOf(tail.root, '[data-track="clip"]');
    // Its own left edge lands on the track's right edge; the 2px of width is
    // the playhead itself.
    expect(rectOf(tail.root, "[data-playhead]").left).toBeCloseTo(
      track.right,
      0,
    );
  });

  // Task 9 replaced the per-action clip (with its own `[data-clip]` /
  // `[data-edge-clip]` lead-in handle) with one clip bar plus a `.seg` per
  // zoom. The two tests that used to live here retargeted the old lead-in/
  // hold-handle assertions onto the zoom segment's `.cap[data-cap="start"|
  // "end"]` elements, but a cap's side is `.cap[data-cap="start"]{left:0}` /
  // `.cap[data-cap="end"]{right:0}` in the stylesheet — an unconditional CSS
  // rule, not a computed placement `boxOf` or `toFraction` could get wrong.
  // Those two cases passed by construction and could never go red, so they
  // were retired rather than kept as a weaker stand-in. What replaces them
  // is a test on the one thing here that IS computed: the segment's own box
  // against the axis it is drawn on. Full retarget of every remaining
  // `[data-clip]`-shaped assumption in this file to `[data-tick]`/
  // `[data-segment]` is Task 15's job; this much is needed here just to keep
  // the file running against Task 9's DOM.
  it("draws the zoom segment's box at its own start and end, not a clamped stand-in", () => {
    const scene = zoomedScene();
    const { root, model } = mount({ scene });
    const zoom = model.zooms[0];
    if (!zoom) throw new Error("fixture drift: zoomedScene() produced no zoom");
    const track = rectOf(root, '[data-track="zoom"]');
    const seg = rectOf(root, `[data-segment="${zoom.id}"]`);
    // Fixture guard: `boxOf` widens anything drawn narrower than
    // `MIN_CLIP_FRACTION` of the track, and a widened box's right edge is no
    // longer `endMs` — this is what a regression in that widening (or in the
    // track losing its label-column inset) would show up as first.
    expect(seg.width / track.width).toBeGreaterThanOrEqual(MIN_CLIP_FRACTION);
    const viewport = fitAll(model.durationMs);
    // From where the push-in sets off, not where it lands: the preview is
    // already moving between the two.
    expect(zoom.startMs - zoom.departMs).toBeGreaterThan(0); // guard
    const expectedLeft =
      track.left + track.width * toFraction(viewport, zoom.departMs);
    const expectedRight =
      track.left + track.width * toFraction(viewport, zoom.endMs);
    // Goes red if `boxOf` clamps `left`/`width` wrongly, or if the zoom
    // track stops sharing the ruler/axis's origin and scale.
    expect(Math.abs(seg.left - expectedLeft)).toBeLessThan(1);
    expect(Math.abs(seg.right - expectedRight)).toBeLessThan(1);
  });

  it("does not grow a scrollbar when the window is zoomed in", () => {
    // Clips outside the window used to be drawn at `left` values in the
    // thousands of percent. Absolutely positioned children still count as
    // scrollable overflow, so `#timeline` grew a horizontal scrollbar
    // proportional to the zoom level and the window stopped matching the
    // lanes.
    const { root } = mount({ viewport: { startMs: 0, endMs: 250 } });
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
  });
});

/**
 * The scrub gesture against real layout.
 *
 * The node lane pins the arithmetic with a stubbed rect; this pins the rect
 * itself. The handle measures the AXIS, and the axis is inset from
 * `.timeline` by the 76px label column — so a scrub that measured the whole
 * box, or the handle's own 15px square, would seek to an instant the author
 * did not point at, and only a laid-out browser can tell the difference.
 */
describe("dragging the playhead", () => {
  it("seeks to the instant under the pointer, not to one a label column off", () => {
    const seeks: number[] = [];
    const { root, model } = mount({ onSeek: (ms) => seeks.push(ms) });
    const axis = root.querySelector<HTMLElement>("[data-axis]") as HTMLElement;
    const grab = root.querySelector<HTMLElement>(
      "[data-playhead-grab]",
    ) as HTMLElement;
    const rect = axis.getBoundingClientRect();
    // Guard the fixture: the inset is the whole point, and a `.timeline` that
    // had stopped insetting its axis would make every assertion below pass
    // against the wrong box.
    expect(rect.left).toBeGreaterThan(root.getBoundingClientRect().left + 50);

    const quarter = rect.left + rect.width / 4;
    grab.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: quarter }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: quarter }),
    );

    expect(seeks[0]).toBeCloseTo(model.durationMs / 4, 0);
  });

  it("puts the handle on the playhead it drags", () => {
    const { root } = mount({ positionMs: 0 });
    const head = root
      .querySelector<HTMLElement>("[data-playhead]")
      ?.getBoundingClientRect() as DOMRect;
    const grab = root
      .querySelector<HTMLElement>("[data-playhead-grab]")
      ?.getBoundingClientRect() as DOMRect;
    // Centred on the line, or the author grabs beside the thing they aimed at.
    expect(
      Math.abs((grab.left + grab.right) / 2 - (head.left + head.right) / 2),
    ).toBeLessThan(1.5);
    // And big enough to hit: the playhead itself is 2px.
    expect(grab.width).toBeGreaterThanOrEqual(12);
  });

  it("draws the knob as a small circle on the line, inside a larger hit area", () => {
    // Since 2026-09-22 the mark you see (`::before`) and the box you grab
    // (`.grab`) are different sizes on purpose: an 11px circle in a 20px
    // target. The box alone is what the case above measures, so the circle
    // is asked about here, or a knob that painted as a square — or not at
    // all — would pass it.
    const { root } = mount({ positionMs: 0 });
    const grabEl = root.querySelector<HTMLElement>(
      "[data-playhead-grab]",
    ) as HTMLElement;
    const head = root
      .querySelector<HTMLElement>("[data-playhead]")
      ?.getBoundingClientRect() as DOMRect;
    const box = grabEl.getBoundingClientRect();
    const knob = getComputedStyle(grabEl, "::before");
    const size = [knob.width, knob.height];
    expect(size, "the knob is not an 11px square box").toEqual([
      "11px",
      "11px",
    ]);
    expect(knob.borderRadius, "the knob is not a circle").toBe("50%");
    expect(knob.backgroundColor, "the knob paints nothing").not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    // Centred in its hit area, and so on the line.
    const cx =
      box.left +
      Number.parseFloat(knob.left) +
      Number.parseFloat(knob.width) / 2;
    expect(Math.abs(cx - (head.left + head.right) / 2)).toBeLessThan(1.5);
    expect(
      box.width,
      "the hit area is no larger than the knob",
    ).toBeGreaterThan(Number.parseFloat(knob.width));
  });

  it("draws the divider over the ruler edge to edge, and hangs the knob on it", () => {
    // The divider under the transport (2026-10-08) is `.lanes::before`,
    // and the playhead's knob is centred on it. A pseudo-element has no
    // rect of its own, so its box is read from its computed offsets
    // against `.lanes`. Every half is asked: a line that stopped painting
    // would leave the knob centred on nothing, one that stopped at the
    // axis would leave the label column bare, and a knob that drifted
    // would sit beside the line.
    const { root } = mount({ positionMs: 0 });
    const lanesEl = root.querySelector<HTMLElement>(".lanes") as HTMLElement;
    const lanes = lanesEl.getBoundingClientRect();
    const divider = getComputedStyle(lanesEl, "::before");
    expect(divider.content, "the divider is not drawn").not.toBe("none");
    expect(divider.height, "the divider is not a 1px hairline").toBe("1px");
    expect(divider.backgroundColor, "the divider paints nothing").not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    const line = {
      top: lanes.top + Number.parseFloat(divider.top),
      left: lanes.left + Number.parseFloat(divider.left),
      width: Number.parseFloat(divider.width),
    };
    // Edge to edge: from the lane headers' left edge to the tracks' right
    // edge, not only over the axis.
    const row = rectOf(root, '.lane[data-lane="clip"]');
    const track = rectOf(root, '[data-track="clip"]');
    const said = `line ${line.left}+${line.width}, headers ${row.left}, track end ${track.right}`;
    expect(Math.abs(line.left - row.left), said).toBeLessThan(0.5);
    expect(Math.abs(line.left + line.width - track.right), said).toBeLessThan(
      0.5,
    );
    // Fixture guard: the label column really is to the left of the axis,
    // or "edge to edge" and "over the axis" are the same span.
    expect(rectOf(root, "[data-axis]").left - row.left).toBeGreaterThan(50);
    // On the ruler's top edge, the seam between it and the transport.
    expect(Math.abs(line.top - rectOf(root, "[data-ruler]").top)).toBeLessThan(
      0.5,
    );

    const grabEl = root.querySelector<HTMLElement>(
      "[data-playhead-grab]",
    ) as HTMLElement;
    const box = grabEl.getBoundingClientRect();
    const knob = getComputedStyle(grabEl, "::before");
    const knobTop = box.top + Number.parseFloat(knob.top);
    const cy = knobTop + Number.parseFloat(knob.height) / 2;
    const lineMiddle = line.top + 0.5;
    expect(
      Math.abs(cy - lineMiddle),
      `knob centre ${cy}, divider middle ${lineMiddle}`,
    ).toBeLessThan(0.5);
    // Raised onto the line, the knob reaches above the axis; `#timeline`
    // scrolls, so it clips there. Its 2px of shadow must clear that edge.
    const clip = root.getBoundingClientRect();
    expect(
      knobTop - 2,
      `knob top ${knobTop}, #timeline top ${clip.top}`,
    ).toBeGreaterThanOrEqual(clip.top);
  });
});

describe("the ruler's labels", () => {
  const labels = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>(".ruler .tick")].map((tick) => ({
      tick,
      rect: tick.getBoundingClientRect(),
      shown: getComputedStyle(tick).visibility !== "hidden",
    }));

  // Red under the fraction rule this replaced (turn the last 5% inward):
  // with a tick at 0.9 and one at 1.0 the two labels overlapped at this
  // width. Red, too, if nothing is turned inward: the end label runs out.
  for (const width of [870, 1400]) {
    it(`keeps every label inside the ruler and clear of its neighbour at ${width}px`, async () => {
      const { root } = mount({ viewport: { startMs: 0, endMs: 5000 } });
      root.style.width = `${width}px`;
      const ruler = rectOf(root, "[data-ruler]");
      await vi.waitFor(() => {
        const all = labels(root);
        // Premise: the window ends on a tick, which is the label that has
        // to go somewhere, and there is one a step before it.
        const fractions = all.map(({ tick }) => Number(tick.dataset.fraction));
        expect(fractions.at(-1)).toBe(1);
        expect(fractions.at(-2)).toBeCloseTo(0.9, 5);
        const shown = all.filter((label) => label.shown);
        for (const { rect, tick } of shown) {
          expect(
            rect.right,
            `"${tick.textContent}" ends at ${rect.right}, past the ruler's ${ruler.right}`,
          ).toBeLessThanOrEqual(ruler.right + 0.5);
        }
        shown.slice(1).forEach((label, i) => {
          const before = shown[i] as (typeof shown)[number];
          expect(
            label.rect.left,
            `"${label.tick.textContent}" overlaps "${before.tick.textContent}"`,
          ).toBeGreaterThanOrEqual(before.rect.right - 0.5);
        });
      });
    });
  }

  // The other half: a ruler with room for every label hides none, so the
  // rule above cannot be passing by hiding everything near the end.
  it("hides nothing on a ruler with room for every label", async () => {
    const { root } = mount({ viewport: { startMs: 0, endMs: 5000 } });
    root.style.width = "1400px";
    await vi.waitFor(() => {
      const all = labels(root);
      expect(all.at(-1)?.tick.dataset.edge).toBe("end");
      expect(all.every((label) => label.shown)).toBe(true);
    });
  });

  // And a narrow one does hide one, so the overlap the fraction rule left
  // is really on the table here and not merely survived. 520px is the
  // stacked layouts' narrowest dock.
  it("hides the end label where it would overlap the one before it", async () => {
    const { root } = mount({ viewport: { startMs: 0, endMs: 5000 } });
    root.style.width = "520px";
    const ruler = rectOf(root, "[data-ruler]");
    await vi.waitFor(() => {
      const all = labels(root);
      // Premise: the last two labels cannot both fit in one step.
      const step = ruler.width * 0.1;
      const [before, last] = all.slice(-2) as [
        (typeof all)[number],
        (typeof all)[number],
      ];
      expect(
        before.rect.width + last.rect.width,
        `two labels ${before.rect.width}px + ${last.rect.width}px fit in a ${step}px step`,
      ).toBeGreaterThan(step);
      expect(last.shown).toBe(false);
      expect(before.shown).toBe(true);
    });
  });
});
