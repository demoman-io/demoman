import { planScene, resolvePlan } from "@demoman/compositor";
import { page, userEvent } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
// The shell itself, markup and stylesheet both: every assertion here is
// about what the page's own rules produce, so a hand-built approximation of
// either would only prove something about the approximation.
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import {
  type InspectorHandlers,
  renderInspector,
} from "../../../pages/entrypoints/editor/inspector";
import { renderTimeline } from "../../../pages/entrypoints/editor/timeline-view";
import {
  renderHeaderIcons,
  renderShortcuts,
} from "../../../pages/entrypoints/editor/view";
import { buildLaneModel } from "../../../pages/src/editor/lanes";
import { createSections } from "../../../pages/src/editor/sections";
import { SHORTCUT_LEGEND } from "../../../pages/src/editor/shortcuts";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import { fitAll } from "../../../pages/src/editor/viewport";
import {
  installTooltips,
  SHOW_DELAY_MS,
} from "../../../pages/src/shell/tooltip";
import { mountShell } from "../helpers/shell-css";

/**
 * Keyboard shortcuts as it is actually painted: one of the inspector's
 * panels since 2026-10-19 (the author: one inspector, one way to close), a
 * panel of its own and a modal before that. Where the inspector sits, and
 * how it separates from the page, is `editor-shell-layout.test.ts`'s; this
 * file is the list inside it, and the tooltip that teaches its keys.
 */

const css = /<style>([\s\S]*?)<\/style>/.exec(shell)?.[1];
const bodyHtml = /<body>([\s\S]*?)<\/body>/.exec(shell)?.[1];

/** Every inspector handler, as a spy: this file drives none of them. */
const handlers = (): InspectorHandlers =>
  new Proxy({} as InspectorHandlers, { get: () => vi.fn() });

/** The real shell with the inspector on Keyboard shortcuts, filled. */
function mountPanel(scheme: "light" | "dark"): HTMLElement {
  if (!css?.includes(".shortcuts-row")) {
    throw new Error("index.html no longer carries the list's stylesheet");
  }
  mountShell(scheme, css);
  document.body.innerHTML = bodyHtml ?? "";
  document.body.dataset.panel = "open";
  const scene = readonlyScene();
  const bundle = proceduralBundle();
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const view = buildTimelineView({ scene, bundle, resolved });
  const model = buildLaneModel({
    scene,
    view,
    bundle,
    resolved,
    hoverReport: null,
  });
  renderInspector(
    document.querySelector("#inspector") as HTMLElement,
    {
      selection: null,
      view,
      model,
      scene,
      hoverReport: null,
      viewport: scene.meta.capture.viewport,
      rail: "shortcuts",
      sections: createSections(),
      attachedToCuts: [],
    },
    handlers(),
  );
  const box = document.querySelector("[data-panel-shortcuts]") as HTMLElement;
  renderShortcuts(
    box,
    { mac: true, query: "", focus: false },
    { onClose: vi.fn(), onQuery: vi.fn() },
  );
  return box;
}

const inspectorRect = (): DOMRect =>
  (document.querySelector("#inspector") as HTMLElement).getBoundingClientRect();

describe("Keyboard shortcuts, in the inspector", () => {
  beforeEach(async () => {
    await page.viewport(1155, 896);
  });

  it("draws every binding, inside the inspector", () => {
    const box = mountPanel("light");
    const rows = box.querySelectorAll("[data-shortcut-row]");
    // Fixture guard: a legend that had emptied would make every geometry
    // assertion below true of nothing.
    expect(SHORTCUT_LEGEND.length).toBeGreaterThan(8);
    expect(rows).toHaveLength(SHORTCUT_LEGEND.length);
    const panel = inspectorRect();
    expect(panel.width).toBeGreaterThan(200);
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(panel.left - 1);
      expect(rect.right).toBeLessThanOrEqual(panel.right + 1);
    }
  });

  /**
   * A chord is adjacent caps with no separator — adjacency is the only thing
   * saying "held together" — so a break inside one turns ⇧ ← into two keys
   * that look unrelated. The rendered result at the widths people use, and
   * the rule that makes it true: a geometry test alone passes whether or not
   * the rule exists, since the keys never lack room in the panel.
   */
  for (const [label, width, height] of [
    ["the shell's floor", 800, 760],
    ["a full window", 1440, 900],
  ] as const) {
    it(`draws every chord on one line at ${label}`, async () => {
      await page.viewport(width, height);
      const box = mountPanel("light");
      const multi = [...box.querySelectorAll("[data-combo]")].filter(
        (c) => c.querySelectorAll("kbd").length > 1,
      );
      expect(multi.length).toBeGreaterThan(4);
      for (const combo of multi) {
        const caps = [...combo.querySelectorAll("kbd")];
        const lines = new Set(
          caps.map((c) => Math.round(c.getBoundingClientRect().top)),
        );
        expect({
          chord: caps.map((c) => c.textContent).join(" "),
          lines: lines.size,
        }).toEqual({
          chord: caps.map((c) => c.textContent).join(" "),
          lines: 1,
        });
      }
    });
  }

  it("holds a chord together by rule, not by having room", () => {
    const box = mountPanel("light");
    const style = getComputedStyle(
      box.querySelector("[data-combo]") as HTMLElement,
    );
    expect(style.flexWrap).toBe("nowrap");
    expect(style.whiteSpace).toBe("nowrap");
  });

  it("keeps every cap inside the inspector", async () => {
    await page.viewport(800, 760);
    const box = mountPanel("light");
    const panel = inspectorRect();
    for (const cap of box.querySelectorAll("kbd")) {
      const rect = cap.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(panel.left - 1);
      expect(rect.right).toBeLessThanOrEqual(panel.right + 1);
      expect(rect.width).toBeGreaterThan(12);
    }
  });

  // The 2026-09-19 "smudges", met again on 2026-10-19 as specks: ⌘ ⇧ ⌫ in a
  // face that lacks them fall back small. Red: drop the system face, or the
  // size, from `.keycap[data-symbol]`.
  it("draws ⌘ ⇧ ⌫ in the system's face, at a size that reads", () => {
    const box = mountPanel("light");
    const symbols = [...box.querySelectorAll<HTMLElement>("kbd[data-symbol]")];
    // Fixture guard: the Mac legend has symbol caps to measure.
    expect(symbols.map((s) => s.textContent)).toEqual(
      expect.arrayContaining(["\u2318", "\u21e7", "\u232b"]),
    );
    for (const cap of symbols) {
      const style = getComputedStyle(cap);
      expect(style.fontFamily, cap.textContent ?? "").toMatch(/system-ui/);
      expect(style.fontSize).toBe("14px");
    }
  });
});

/**
 * The tooltip, painted: the rules that keep it out of the way are geometry
 * and pointer events, which the node lane cannot see. Its timing is
 * `tooltip.test.ts`'s.
 */
describe("the tooltip", () => {
  beforeEach(async () => {
    await page.viewport(1155, 896);
  });

  it("names a control and its key below it, and is never what a click hits", async () => {
    mountPanel("light");
    renderHeaderIcons();
    const tip = installTooltips();
    const undo = document.querySelector("#undo") as HTMLElement;
    // Premise: Undo is marked for the tooltip, its native title dropped.
    expect(undo.dataset.tip).toBe("Undo");
    expect(undo.hasAttribute("title")).toBe(false);
    await userEvent.hover(undo);
    await vi.waitFor(
      () => {
        if (tip.hidden) throw new Error("not shown yet");
      },
      { timeout: SHOW_DELAY_MS + 1_000, interval: 25 },
    );
    expect(tip.textContent).toContain("Undo");
    expect(getComputedStyle(tip).pointerEvents).toBe("none");
    const at = undo.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    // Below its control, clear of it, and inside the window.
    expect(box.top).toBeGreaterThanOrEqual(at.bottom);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    // What a click at its centre reaches is not the tooltip.
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    expect(tip.contains(hit)).toBe(false);
    await userEvent.unhover(undo);
  });
});

describe("the ? button", () => {
  for (const [WIDTH, HEIGHT] of [
    [1155, 896],
    [800, 700],
  ] as const)
    it(`parks its own button clear of the timeline at ${WIDTH}px`, async () => {
      // `#shortcuts-open` is `position: fixed` at the bottom-right, which is
      // over the timeline's lane area — the Snap and Fit controls are at the
      // TOP of that box. A bounding rect reads clean through an overlap; this
      // asks the painted result, which is what CLAUDE.md's `#stage` note is
      // about.
      //
      // With a REAL timeline in the box: the shell's own `#timeline` is an
      // empty 755x24 stub, against which this assertion passed while proving
      // nothing at all.
      await page.viewport(WIDTH, HEIGHT);
      mountShell("light", css ?? "");
      document.body.innerHTML = bodyHtml ?? "";

      const scene = readonlyScene();
      const bundle = proceduralBundle();
      const resolved = resolvePlan(planScene(scene), bundle, scene);
      const model = buildLaneModel({
        scene,
        view: buildTimelineView({ scene, bundle, resolved }),
        bundle,
        resolved,
        hoverReport: null,
      });
      renderTimeline(
        document.querySelector("#timeline") as HTMLElement,
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
          onGesture: vi.fn(),
          onViewport: vi.fn(),
          onSnapping: vi.fn(),
          onSplit: vi.fn(),
          onRestorePiece: vi.fn(),
          onOpenJoin: vi.fn(),
        },
      );

      const button = document.querySelector("#shortcuts-open") as HTMLElement;
      const timeline = document.querySelector("#timeline") as HTMLElement;
      const lane = timeline.getBoundingClientRect();
      // Fixture guard: an empty box cannot be overlapped.
      expect(lane.height).toBeGreaterThan(80);
      expect(timeline.querySelectorAll("[data-tick]").length).toBeGreaterThan(
        0,
      );

      // In the header's own button group, not floating: that is what keeps it
      // off the lanes at every width rather than at the one that was checked.
      expect(button.closest("header")).not.toBeNull();
      expect(getComputedStyle(button).position).not.toBe("fixed");

      const rect = button.getBoundingClientRect();
      // The button is what you hit at its own centre, not something over it.
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      expect(button.contains(hit)).toBe(true);

      // And it covers none of the timeline's box.
      //
      // Geometry, not `elementFromPoint`: hit-testing at the button's own
      // corners always answers "the button", since it is the thing on top —
      // measured, that assertion passed with the button parked squarely in
      // the middle of the lanes.
      const overlapW =
        Math.min(rect.right, lane.right) - Math.max(rect.left, lane.left);
      const overlapH =
        Math.min(rect.bottom, lane.bottom) - Math.max(rect.top, lane.top);
      const covered = Math.max(0, overlapW) * Math.max(0, overlapH);
      expect({
        covered,
        button: `${Math.round(rect.left)},${Math.round(rect.top)}`,
        timeline: `${Math.round(lane.left)},${Math.round(lane.top)} ${Math.round(lane.width)}x${Math.round(lane.height)}`,
      }).toEqual({
        covered: 0,
        button: `${Math.round(rect.left)},${Math.round(rect.top)}`,
        timeline: `${Math.round(lane.left)},${Math.round(lane.top)} ${Math.round(lane.width)}x${Math.round(lane.height)}`,
      });
    });
});
