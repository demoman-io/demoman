import { planScene, resolvePlan } from "@demoman/compositor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureBundle,
  proceduralBundle,
  stillCursorBundle,
} from "../../../../../packages/replay-engine/test/helpers/bundles";
import {
  hoverScene,
  readonlyScene,
  redactedScene,
} from "../../../../../packages/replay-engine/test/helpers/scenes";
import {
  renderInspector,
  type Selection,
} from "../../../pages/entrypoints/editor/inspector";
import type { RailEntry } from "../../../pages/entrypoints/editor/rail";
import { applyCommand } from "../../../pages/src/editor/commands";
import type { HoverReport } from "../../../pages/src/editor/hover-report";
import { buildLaneModel } from "../../../pages/src/editor/lanes";
import { createSections } from "../../../pages/src/editor/sections";
import { buildTimelineView } from "../../../pages/src/editor/timeline";

const ids = () => {
  let n = 0;
  return () => `gen-${++n}`;
};
let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
});

const handlers = () => ({
  onClose: vi.fn(),
  onGap: vi.fn(),
  onGapClear: vi.fn(),
  onKeepHover: vi.fn(),
  onZoomOnStep: vi.fn(),
  onZoomScale: vi.fn(),
  onRemoveZoom: vi.fn(),
  onMaskNote: vi.fn(),
  onRemoveMask: vi.fn(),
});

function propsFor(
  scene = readonlyScene(),
  selection: Selection = null,
  hoverReport: HoverReport | null = null,
) {
  const bundle = proceduralBundle();
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const view = buildTimelineView({ scene, bundle, resolved });
  const model = buildLaneModel({ scene, view, bundle, resolved, hoverReport });
  return {
    selection,
    view,
    model,
    scene,
    hoverReport,
    viewport: scene.meta.capture.viewport,
    // The rail entry `main.ts` would be on: picking anything opens
    // Selection, and nothing selected leaves it wherever it was, which at
    // boot is Export. A caller that wants another entry spreads over it.
    rail: (selection === null ? "export" : "selection") as RailEntry,
    sections: createSections(),
    attachedToCuts: [],
  };
}

describe("nothing selected", () => {
  // The Steps disclosure and its replacements list are gone as of Task 5:
  // the demo panel now has the three sections only, and the anchor a step
  // touches is fixed from that step's own panel
  // (`editor-inspector.test.ts`'s "replace on-screen text" describe) rather
  // than a collapsed list reached from here. This test used to also assert
  // that disclosure existed, collapsed, with the hover report inside it —
  // the report itself moved to the timeline bar on 2026-09-14
  // (`editor-timeline-view.test.ts`), and Task 5 removed what was left.
  it("shows the demo's own panels, and no step panel", () => {
    // Branding left this list on 2026-09-14: the rail split the one demo
    // panel in two, and the logo and colour are the Background entry's now
    // (the describe below). What Export still carries is the outputs — the
    // render-mode box itself retired with Task 10 (spec §2), and with it
    // `[data-panel-mode]`: `editor-main-render-mode.test.ts`'s absence tests
    // are what cover that now.
    renderInspector(root, propsFor(hoverScene()), handlers());
    expect(root.querySelector("[data-panel-export]")).not.toBeNull();
    expect(root.querySelector("[data-panel-mode]")).toBeNull();
    expect(root.querySelector("[data-steps]")).toBeNull();
    expect(root.querySelector("[data-step-panel]")).toBeNull();
    expect(root.querySelector(".tabs")).toBeNull();
  });
});

describe("panels by rail entry", () => {
  // The file's summary line moved inside the export box itself
  // (`renderExport`'s `[data-export-summary]`, editor-view-export.test.ts).
  //
  // The Source disclosure this test used to also check retired with
  // Task 10: it held only the render-mode banner (spec §2 asks nothing
  // about where the frames came from any more), so once that banner went
  // there was nothing left for a settings disclosure here to hold — see
  // `inspector.ts`'s `renderExportPanel` docblock.
  it("shows Export, and no Steps", () => {
    renderInspector(root, { ...propsFor(), rail: "export" }, handlers());
    expect(root.querySelector("[data-format-line]")).toBeNull();
    expect(root.querySelector('details[data-section="source"]')).toBeNull();
    expect(root.querySelector("[data-panel-mode]")).toBeNull();
    expect(root.querySelector("[data-panel-export]")).not.toBeNull();
    expect(root.querySelector("[data-panel-branding]")).toBeNull();
    expect(root.querySelector("[data-steps]")).toBeNull();
  });
  it("shows Background alone", () => {
    renderInspector(root, { ...propsFor(), rail: "background" }, handlers());
    expect(root.querySelector("h2")?.textContent).toBe("Background");
    expect(root.querySelector("[data-panel-branding]")).not.toBeNull();
    expect(root.querySelector("[data-panel-export]")).toBeNull();
  });

  it("shows Cursor alone", () => {
    renderInspector(root, { ...propsFor(), rail: "cursor" }, handlers());
    expect(root.querySelector("h2")?.textContent).toBe("Cursor");
    expect(root.querySelector("[data-panel-cursor]")).not.toBeNull();
    expect(root.querySelector("[data-panel-branding]")).toBeNull();
    expect(root.querySelector("[data-panel-export]")).toBeNull();
  });

  // The author, 2026-10-19: Keyboard shortcuts is one of the inspector's
  // panels, not a panel of its own. Red: drop its branch in
  // `renderInspector`, and Export is drawn instead.
  it("shows Keyboard shortcuts alone, with the panels' own close", () => {
    renderInspector(root, { ...propsFor(), rail: "shortcuts" }, handlers());
    expect(root.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
    expect(root.querySelector("[data-panel-shortcuts]")).not.toBeNull();
    expect(root.querySelector("[data-panel-export]")).toBeNull();
    expect(root.querySelector("[data-inspector-close]")).not.toBeNull();
  });

  // Review 2026-10-19: every render replaced the panel, search field and
  // all, under the author's typing. Red: drop the early return at the top
  // of `renderInspector`.
  it("keeps Keyboard shortcuts as drawn across a redraw, and leaves it for another panel", () => {
    renderInspector(root, { ...propsFor(), rail: "shortcuts" }, handlers());
    const panel = root.querySelector("[data-panel-shortcuts]");
    expect(panel, "premise: the panel drew").not.toBeNull();
    renderInspector(root, { ...propsFor(), rail: "shortcuts" }, handlers());
    expect(root.querySelector("[data-panel-shortcuts]")).toBe(panel);
    renderInspector(root, { ...propsFor(), rail: "cursor" }, handlers());
    expect(root.querySelector("[data-panel-shortcuts]")).toBeNull();
    expect(root.querySelector("[data-panel-cursor]")).not.toBeNull();
  });
});

// The author, 2026-10-19: every panel closes on Escape, and its X says so
// in a tooltip with the key as a cap rather than on screen. Red: give the
// X a native title again, or drop its key.
describe("every panel's close", () => {
  it("names Escape in its tooltip, and to a screen reader", () => {
    for (const rail of [
      "export",
      "background",
      "cursor",
      "shortcuts",
    ] as const) {
      renderInspector(root, { ...propsFor(), rail }, handlers());
      const close = root.querySelector<HTMLElement>("[data-inspector-close]");
      expect({
        rail,
        tip: close?.dataset.tip,
        keys: close?.dataset.tipKeys,
      }).toEqual({
        rail,
        tip: "Close",
        keys: "Esc",
      });
      expect(close?.getAttribute("aria-keyshortcuts")).toBe("Escape");
      // No native tooltip beside the drawn one.
      expect(close?.hasAttribute("title")).toBe(false);
    }
  });
});

describe("a step selected", () => {
  // Step editing left the Studio (spec 2026-10-22 split-tool): a step is a
  // read-only label, with the pause after it and a zoom on it.
  it("keeps the pause and zoom-on-step, and offers no way to change what the step did", () => {
    const h = handlers();
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-2" }),
      h,
    );
    expect(root.querySelector("[data-step-panel]")).not.toBeNull();
    for (const sel of ['[data-gap="act-2"]', '[data-zoom-on-step="act-2"]']) {
      expect(root.querySelector(sel), sel).not.toBeNull();
    }
    for (const sel of [
      "[data-trim]",
      "[data-delete]",
      "[data-uncut]",
      "[data-retext]",
      "[data-replace-text]",
    ]) {
      expect(root.querySelector(sel), sel).toBeNull();
    }
    root.querySelector<HTMLElement>('[data-zoom-on-step="act-2"]')?.click();
    expect(h.onZoomOnStep).toHaveBeenCalledWith("act-2");
    expect(root.querySelector("[data-panel-export]")).toBeNull();
  });

  // A typed step's own text shows the replace field's absence too: the
  // anchor of act-3 carries on-screen text, which used to offer it.
  it("offers no replace field even where the step's element shows text", () => {
    const anchor = readonlyScene().anchors.find((a) => a.id === "a-checkout");
    // Premise: the element act-3 clicks shows text on screen.
    expect(
      anchor?.fingerprint.textContent ?? anchor?.fingerprint.accessibleName,
    ).toBeTruthy();
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-3" }),
      handlers(),
    );
    expect(root.querySelector("[data-step-panel]")).not.toBeNull();
    expect(root.querySelector("[data-replace-text]")).toBeNull();
  });

  it("says a step in a removed piece is not in the video", () => {
    const scene = readonlyScene();
    const removed = {
      ...scene,
      edits: {
        ...scene.edits,
        removed: [
          {
            id: "r-1",
            start: { actionId: "act-2", sourceOffsetMs: 0 },
            end: { actionId: "act-3", sourceOffsetMs: 0 },
          },
        ],
      },
    };
    const props = propsFor(removed, { kind: "tick", actionId: "act-2" });
    // Premise: act-2 is inside the piece.
    expect(props.view.beats.find((b) => b.actionId === "act-2")?.cut).toBe(
      true,
    );
    renderInspector(root, props, handlers());
    expect(root.querySelector('[data-cut-panel="act-2"]')?.textContent).toBe(
      "This step is in a removed piece, so it is not in the video.",
    );
  });

  it("withholds zoom-on-step where nothing is on screen", () => {
    const scene = readonlyScene();
    const withNav = {
      ...scene,
      actions: [
        ...scene.actions,
        {
          id: "act-nav",
          anchorId: null,
          timestamp: 9400,
          marker: "waitFor:navigation",
          kind: "waitFor" as const,
          condition: "loaded" as const,
        },
      ],
    };
    renderInspector(
      root,
      propsFor(withNav, { kind: "tick", actionId: "act-nav" }),
      handlers(),
    );
    expect(root.querySelector("[data-zoom-on-step]")).toBeNull();
    expect(root.textContent).toMatch(/nothing on screen to aim at/);
  });

  it("shows a typed step's text, read-only", () => {
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-1" }),
      handlers(),
    );
    expect(root.querySelector('[data-typed-text="act-1"]')?.textContent).toBe(
      "northwind",
    );
    expect(root.querySelector("[data-step-panel] input[type=text]")).toBeNull();
  });
});

describe("a zoom selected", () => {
  it("shows level, aim, times with an automatic end, and remove", () => {
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
    const h = handlers();
    renderInspector(root, propsFor(scene, { kind: "zoom", id: "gen-1" }), h);
    expect(root.querySelector("[data-zoom-panel]")).not.toBeNull();
    expect(
      root.querySelector<HTMLInputElement>('[data-zoom-scale="gen-1"]')?.value,
    ).toBe("1.8");
    expect(root.querySelector("[data-zoom-aim]")?.textContent).toMatch(
      /order-row-8891|a-row/,
    );
    expect(root.querySelector("[data-zoom-range]")?.textContent).toMatch(
      /automatic/,
    );
    expect(root.querySelector("[data-zoom-fallback]")).toBeNull();
    const remove = root.querySelector<HTMLElement>(
      '[data-remove-zoom="gen-1"]',
    );
    // The Delete key removes the selected zoom; the button says so.
    expect(remove?.dataset.tipKeys).toBe("Delete");
    remove?.click();
    expect(h.onRemoveZoom).toHaveBeenCalledWith("gen-1");
  });

  /**
   * The Level control takes the same row shape as the Cursor panel's two
   * sliders, so the inspector has one slider layout rather than two. What
   * that shape PAINTS is asserted in `editor-cursor-panel.test.ts` against
   * the real stylesheet; this case only proves the Zoom panel opts into
   * it — the class and the source order the grid places by.
   */
  it("gives the level slider the shared row: label, value, then the track", () => {
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
    renderInspector(
      root,
      propsFor(scene, { kind: "zoom", id: "gen-1" }),
      handlers(),
    );
    const slider = root.querySelector<HTMLInputElement>(
      '[data-zoom-scale="gen-1"]',
    );
    const row = slider?.closest(".slider-row");
    if (!slider || !row) throw new Error("the level slider is not in a row");
    expect([...row.children].map((c) => c.className)).toEqual([
      "control-label slider-label",
      "slider-value",
      "",
    ]);
    expect(row.querySelector(".slider-label")?.textContent).toBe("Level");
    expect(row.querySelector(".slider-value")?.textContent).toBe("1.80x");
    // The readout is no longer a pill, and `.chip` still belongs to the
    // things that are — a leftover here would draw one inside the row.
    expect(row.querySelector(".chip")).toBeNull();
  });

  it("names a point aim and shows the fallback reason", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 900 },
        target: { kind: "point", x: 300, y: 400 },
        scale: 1.8,
        note: "Aimed at x instead of the cursor: the pointer was off the page here.",
      },
      ids(),
    );
    renderInspector(
      root,
      propsFor(scene, { kind: "zoom", id: "gen-1" }),
      handlers(),
    );
    expect(root.querySelector("[data-zoom-aim]")?.textContent).toMatch(
      /cursor at 0:0\d/,
    );
    expect(root.querySelector("[data-zoom-fallback]")?.textContent).toMatch(
      /off the page/,
    );
  });

  // Ported from Task 6's "authors a scale from the slider", which dispatched
  // against `data-camera-scale` on the beat panel — that field is gone
  // (Task 11 moved zoom level onto the zoom's own panel), but the underlying
  // behaviour — dragging the slider authors a new scale — still exists here,
  // on `data-zoom-scale`, wired to `onZoomScale` instead of `onCameraScale`.
  it("authors a new scale from the zoom panel's slider", () => {
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
    const h = handlers();
    renderInspector(root, propsFor(scene, { kind: "zoom", id: "gen-1" }), h);
    const slider = root.querySelector(
      '[data-zoom-scale="gen-1"]',
    ) as HTMLInputElement;
    slider.value = "2.0";
    slider.dispatchEvent(new Event("change"));
    expect(h.onZoomScale).toHaveBeenCalledWith("gen-1", 2);
  });
});

describe("a mask selected", () => {
  it("shows position, size, note, range and remove; says whole-take for a pre-spec mask", () => {
    const scene = {
      ...readonlyScene(),
      edits: {
        ...readonlyScene().edits,
        masks: [
          {
            id: "old",
            rect: { x: 60, y: 380, width: 400, height: 24 },
            note: "email column",
          },
        ],
      },
    };
    const h = handlers();
    renderInspector(root, propsFor(scene, { kind: "mask", id: "old" }), h);
    expect(root.querySelector("[data-mask-panel]")).not.toBeNull();
    expect(root.querySelector("[data-mask-rect]")?.textContent).toMatch(
      /400 ?x ?24/,
    );
    expect(root.querySelector("[data-mask-whole-take]")).not.toBeNull();
    const note = root.querySelector<HTMLInputElement>('[data-mask-note="old"]');
    expect(note?.value).toBe("email column");
    const remove = root.querySelector<HTMLElement>('[data-remove-mask="old"]');
    expect(remove?.dataset.tipKeys).toBe("Delete");
    remove?.click();
    expect(h.onRemoveMask).toHaveBeenCalledWith("old");
  });
});

describe("a selection that no longer exists", () => {
  it("falls back to the demo panel rather than an empty panel, and says why", () => {
    // `main.ts` asks for the Selection entry only while the selection
    // resolves, so arriving here means a deselect path missed that funnel.
    // The control flow is forgiven — the Export panel is drawn rather than
    // nothing — but a silent fallback would make a rail stuck on Selection
    // look exactly like an author who never selected anything.
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "zoom", id: "gone" }),
      handlers(),
    );
    expect(root.querySelector("[data-panel-export]")).not.toBeNull();
    expect(root.querySelector("[data-zoom-panel]")).toBeNull();
    expect(said).toHaveBeenCalledWith(
      expect.stringMatching(/Selection with nothing selected/),
    );
    said.mockRestore();
  });
});

/**
 * Everything below is ported from Task 6's version of this file (the one
 * `git show 2166e33:…editor-inspector.test.ts` still has) — assertions on
 * `renderStepPanel` behaviour this task carried over verbatim from the old
 * `renderBeatPanel` and did not change. Only the shape changed: `selectedId`
 * is now `selection: { kind: "tick", actionId }`, and a handful of tests
 * that used to render alongside a fixed `selectedId: "act-1"` are rebuilt
 * against whichever selection actually reaches the behaviour under test
 * (often `null`, now that the take-wide hover report only renders inside
 * the demo panel's Steps disclosure, not beside every beat).
 *
 * The old file's own retired tests (tabs, the zoom checkbox/slider/lead-in,
 * `onCameraClear`) are NOT here — see the fix-round report for the full
 * retired list with reasons.
 */

describe("a step selected — carried over from the old Beat tab", () => {
  it("shows a value only on a type step", () => {
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-1" }),
      handlers(),
    );
    expect(root.querySelector("[data-typed-text]")).not.toBeNull();
    // Both of the other two verbs in the fixture, not just one: act-2 is a
    // scrollTo, act-3 is a click, and "every verb except type" is the rule.
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-2" }),
      handlers(),
    );
    expect(root.querySelector("[data-typed-text]")).toBeNull();
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-3" }),
      handlers(),
    );
    expect(root.querySelector("[data-typed-text]")).toBeNull();
  });

  it("names an editor whose typing could not be followed, not a credential field", () => {
    // A contenteditable host whose text went unknown mid-field takes the
    // same no-text path as a credential, and `host` is what tells them
    // apart. Calling Gmail's compose box a credential field sends the
    // author looking for a password that was never there.
    const scene = redactedScene();
    const hosted = {
      ...scene,
      actions: scene.actions.map((a) =>
        a.id === "act-1" && a.kind === "type"
          ? { ...a, host: true as const }
          : a,
      ),
    };
    renderInspector(
      root,
      propsFor(hosted, { kind: "tick", actionId: "act-1" }),
      handlers(),
    );
    expect(root.textContent).toMatch(/editor/i);
    expect(root.textContent).not.toMatch(/credential/i);
  });

  it("still says a redacted step's value was never recorded, and promises nothing drawn", () => {
    renderInspector(
      root,
      propsFor(redactedScene(), { kind: "tick", actionId: "act-1" }),
      handlers(),
    );
    expect(root.textContent).toMatch(/never recorded/i);
    expect(root.textContent).toMatch(/credential/i);
    // Nothing draws over the video since text overlays left.
    expect(root.textContent).not.toMatch(/over the video/);
  });

  it("shows an anchor-health chip carrying the strategy that won", () => {
    const health = (actionId: string): string | null | undefined => {
      renderInspector(
        root,
        propsFor(readonlyScene(), { kind: "tick", actionId }),
        handlers(),
      );
      return root.querySelector("[data-health]")?.getAttribute("data-health");
    };
    expect(["act-1", "act-2", "act-3"].map(health)).toEqual([
      "roleName",
      "stableId",
      "stableId",
    ]);
  });

  it("gives an estimated step's hatching a reason", () => {
    const scene = hoverScene();
    const bundle = proceduralBundle();
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const view = buildTimelineView({ scene, bundle, resolved });
    // Fixture guard: if act-h ever gets a marker, this stops testing
    // anything at all.
    expect(view.beats.find((b) => b.actionId === "act-h")?.timing).toBe(
      "estimated",
    );

    renderInspector(
      root,
      propsFor(scene, { kind: "tick", actionId: "act-h" }),
      handlers(),
    );
    expect(root.textContent).toContain("Not in the video");
    expect(root.textContent).toMatch(/no marker/i);
    expect(root.textContent).not.toContain("Rebuild");
    // A step is not removable, so the sentence names no way to remove it.
    expect(root.textContent).not.toContain("Delete");

    // And silent on a step whose position IS measured, or the sentence
    // would fire whether or not anything was wrong.
    renderInspector(
      root,
      propsFor(scene, { kind: "tick", actionId: "act-1" }),
      handlers(),
    );
    expect(root.textContent).not.toContain("Not in the video");
  });

  it("offers no way to add or move a step", () => {
    const scene = readonlyScene();
    const view = propsFor(scene, { kind: "tick", actionId: "act-2" }).view;
    // Premise: act-2 is a middle step, so both arrows would have been drawn.
    const beat = view.beats.find((b) => b.actionId === "act-2");
    expect(beat?.index).toBeGreaterThan(0);
    expect(beat?.isLast).toBe(false);
    renderInspector(
      root,
      propsFor(scene, { kind: "tick", actionId: "act-2" }),
      handlers(),
    );
    expect(root.querySelector("[data-step-panel]")).not.toBeNull();
    expect(root.querySelector("[data-insert-after]")).toBeNull();
    expect(root.querySelector("[data-move-up]")).toBeNull();
    expect(root.querySelector("[data-move-down]")).toBeNull();
  });
});

describe("pause after a step — gap and legacy hold, carried over", () => {
  it("shows an authored gap's current duration", () => {
    const paced = applyCommand(
      readonlyScene(),
      { kind: "setGap", afterActionId: "act-1", durationMs: 800 },
      ids(),
    );
    renderInspector(
      root,
      propsFor(paced, { kind: "tick", actionId: "act-1" }),
      handlers(),
    );
    expect(
      (root.querySelector('input[data-gap="act-1"]') as HTMLInputElement).value,
    ).toBe("800");
  });

  it("leaves the field empty, not zero, when nothing is authored", () => {
    // Absence means "play back the recorded pause"; zero means "no pause at
    // all". A field pre-filled with 0 would tell the author the take has no
    // pause here when it may have seconds of one.
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-1" }),
      handlers(),
    );
    const input = root.querySelector(
      'input[data-gap="act-1"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toMatch(/recorded/i);
  });

  it("offers no pause control on the last step", () => {
    // A gap is the time BETWEEN two steps, and `applyCommand` refuses one on
    // the final step.
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-3" }),
      handlers(),
    );
    expect(root.querySelector('input[data-gap="act-3"]')).toBeNull();
  });

  it("reports a gap stranded on the last step, and can still clear it", () => {
    // A trim or a reorder after the gap was authored leaves it naming a step
    // that has no step after it. `prune` keeps it and `planScene` never
    // reads it, so the pause has silently stopped playing.
    const scene = readonlyScene();
    const stranded = {
      ...scene,
      actions: scene.actions.slice(0, 2),
      edits: {
        ...scene.edits,
        gaps: [{ id: "g-1", afterActionId: "act-2", durationMs: 800 }],
      },
    };
    renderInspector(
      root,
      propsFor(stranded, { kind: "tick", actionId: "act-2" }),
      handlers(),
    );
    const note = root.querySelector('[data-gap-inert="act-2"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toMatch(/800ms/);
    expect(note?.textContent).toMatch(/not playing/i);
    expect(note?.textContent).toMatch(/last step/i);
    // No editable field — authoring a new number there would do nothing —
    // but the clear is there, because it is the only way out.
    expect(root.querySelector('input[data-gap="act-2"]')).toBeNull();
    expect(root.querySelector('[data-gap-clear="act-2"]')).not.toBeNull();
  });

  it("says when a rebuild floored an authored pause to nothing", () => {
    // Rebuild mode reconstructs `max(0, idleTarget − replayIdle)`, a floor
    // never a ceiling. An 800ms gap on a stretch where the rebuild already
    // left 5000ms of dead air adds nothing to the video, and until
    // 2026-09-08 the editor said nothing about it at all.
    const scene = readonlyScene();
    const paced = {
      ...scene,
      edits: {
        ...scene.edits,
        gaps: [{ id: "g-1", afterActionId: "act-2", durationMs: 800 }],
      },
    };
    const bundle = stillCursorBundle();
    const resolved = resolvePlan(planScene(paced), bundle, paced);
    const view = buildTimelineView({ scene: paced, bundle, resolved });

    // Fixture guards: the bundle has to be a rebuild, the render has to
    // contain no pause, and the step has to be one the editor still offers
    // the control on — otherwise this is the "stranded" case above wearing a
    // different attribute.
    expect(bundle.source).toBe("replay");
    expect(
      resolved.timeline.segments.filter((s) => s.kind === "pace"),
    ).toHaveLength(0);
    const beat = view.beats.find((b) => b.actionId === "act-2");
    expect(beat?.canPace).toBe(true);
    expect(beat?.renderedPauseMs).toBe(5000);
    expect(beat?.renderedPaceFreezeMs).toBe(0);

    const model = buildLaneModel({
      scene: paced,
      view,
      bundle,
      resolved,
      hoverReport: null,
    });
    renderInspector(
      root,
      {
        selection: { kind: "tick", actionId: "act-2" },
        view,
        model,
        scene: paced,
        hoverReport: null,
        viewport: paced.meta.capture.viewport,
        rail: "selection" as RailEntry,
        sections: createSections(),
        attachedToCuts: [],
      },
      handlers(),
    );
    const note = root.querySelector('[data-gap-floored="act-2"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toMatch(/800ms/);
    expect(note?.textContent).toMatch(/adds nothing/i);
    // Plan 2, Task 7: the frames are a re-shoot's, and the way back to the
    // recording is on its Recordings card; the editor names no rebuild.
    expect(note?.textContent).toMatch(/re-shot frames/);
    expect(note?.textContent).not.toMatch(/rebuil/i);
    // The control STAYS: raising the number above what the rebuild left is
    // the move that fixes it, and this is not the stranded case.
    expect(root.querySelector('input[data-gap="act-2"]')).not.toBeNull();
  });

  it("says nothing about a pause the rebuild does play", () => {
    // The control: the same step, the same bundle, a gap large enough to
    // clear the rebuild's own dead air. Without this the note above would
    // pass just as well if it were printed unconditionally.
    const scene = readonlyScene();
    const paced = {
      ...scene,
      edits: {
        ...scene.edits,
        gaps: [{ id: "g-1", afterActionId: "act-2", durationMs: 12_000 }],
      },
    };
    const bundle = stillCursorBundle();
    const resolved = resolvePlan(planScene(paced), bundle, paced);
    expect(
      resolved.timeline.segments.filter((s) => s.kind === "pace"),
    ).toHaveLength(1);
    const view = buildTimelineView({ scene: paced, bundle, resolved });
    const model = buildLaneModel({
      scene: paced,
      view,
      bundle,
      resolved,
      hoverReport: null,
    });
    renderInspector(
      root,
      {
        selection: { kind: "tick", actionId: "act-2" },
        view,
        model,
        scene: paced,
        hoverReport: null,
        viewport: paced.meta.capture.viewport,
        rail: "selection" as RailEntry,
        sections: createSections(),
        attachedToCuts: [],
      },
      handlers(),
    );
    expect(root.querySelector('[data-gap-floored="act-2"]')).toBeNull();
    expect(root.querySelector('input[data-gap="act-2"]')).not.toBeNull();
  });

  it("says nothing about a pause on a last step that never had one", () => {
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-3" }),
      handlers(),
    );
    expect(root.querySelector('[data-gap-inert="act-3"]')).toBeNull();
    expect(root.querySelector('input[data-gap="act-3"]')).toBeNull();
  });

  it("withholds the pause where a capture bundle finds no dead air, and says why", () => {
    // On a capture bundle `authoredPaceCovering` matches idle segments only,
    // so a stretch that is motion end to end never has the target applied.
    const scene = readonlyScene();
    const bundle = {
      ...captureBundle(),
      sceneId: "scene-readonly-001",
      motionSpans: [
        {
          startMs: 400,
          endMs: 3200,
          ref: "m-0",
          width: 2560,
          height: 1600,
          fps: 60,
          byteLength: 0,
        },
      ],
    };
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const view = buildTimelineView({ scene, bundle, resolved });
    // Fixture guard: act-1 is the step with no idle after it, act-2 is not.
    expect(view.beats.find((b) => b.actionId === "act-1")?.canPace).toBe(false);
    expect(view.beats.find((b) => b.actionId === "act-2")?.canPace).toBe(true);

    const model = buildLaneModel({
      scene,
      view,
      bundle,
      resolved,
      hoverReport: null,
    });
    const propsWith = (actionId: string) => ({
      selection: { kind: "tick" as const, actionId },
      view,
      model,
      scene,
      hoverReport: null,
      viewport: scene.meta.capture.viewport,
      rail: "selection" as RailEntry,
      sections: createSections(),
      attachedToCuts: [],
    });
    renderInspector(root, propsWith("act-1"), handlers());
    expect(root.querySelector('input[data-gap="act-1"]')).toBeNull();
    renderInspector(root, propsWith("act-2"), handlers());
    expect(root.querySelector('input[data-gap="act-2"]')).not.toBeNull();
  });

  it("names a legacy hold the author can no longer edit", () => {
    // Every stored hold had `offsetMs: 0`, so the survivors of
    // `migrateHoldsToGaps` are the ones on a take's final step. They still
    // play through `plan.holds`, and no command authors or removes one any
    // more.
    const scene = readonlyScene();
    const held = {
      ...scene,
      edits: {
        ...scene.edits,
        holds: [
          {
            id: "h-1",
            marker: { actionId: "act-3", offsetMs: 0 },
            durationMs: 800,
          },
        ],
      },
    };
    renderInspector(
      root,
      propsFor(held, { kind: "tick", actionId: "act-3" }),
      handlers(),
    );
    const note = root.querySelector('[data-legacy-hold="act-3"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toMatch(/800ms/);
    expect(note?.textContent).toMatch(/earlier edit/i);
    expect(note?.textContent).toMatch(/still plays/i);
    expect(note?.textContent).toMatch(/no control for it/i);
    expect(note?.textContent).toMatch(/deleting this step removes it/i);
  });

  it("does not claim a legacy hold plays when the bundle never reached it", () => {
    // `holdInstants` drops a hold whose action the bundle carries no marker
    // for, so on a partial run the pause is not in the video.
    const scene = readonlyScene();
    const held = {
      ...scene,
      edits: {
        ...scene.edits,
        holds: [
          {
            id: "h-1",
            marker: { actionId: "act-3", offsetMs: 0 },
            durationMs: 800,
          },
        ],
      },
    };
    const bundle = proceduralBundle({
      markers: [
        { actionId: "act-1", sourceTimeMs: 400 },
        { actionId: "act-2", sourceTimeMs: 3200 },
      ],
    });
    const resolved = resolvePlan(planScene(held), bundle, held);
    const view = buildTimelineView({ scene: held, bundle, resolved });
    // Fixture guard: the run really did stop short of act-3.
    expect(view.beats.find((b) => b.actionId === "act-3")?.timing).toBe(
      "estimated",
    );

    const model = buildLaneModel({
      scene: held,
      view,
      bundle,
      resolved,
      hoverReport: null,
    });
    renderInspector(
      root,
      {
        selection: { kind: "tick", actionId: "act-3" },
        view,
        model,
        scene: held,
        hoverReport: null,
        viewport: held.meta.capture.viewport,
        rail: "selection" as RailEntry,
        sections: createSections(),
        attachedToCuts: [],
      },
      handlers(),
    );
    const note = root.querySelector('[data-legacy-hold="act-3"]');
    // Still named — it is in the document and a later rebuild would play it
    // — but named as what it is.
    expect(note).not.toBeNull();
    expect(note?.textContent).toMatch(/800ms/);
    expect(note?.textContent).not.toMatch(/still plays/i);
    expect(note?.textContent).toMatch(/not in the video/i);
  });

  it("says nothing about a legacy hold on a step that carries none", () => {
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-1" }),
      handlers(),
    );
    expect(root.querySelector("[data-legacy-hold]")).toBeNull();
  });

  it("offers the recorded-pace restore only once a gap exists", () => {
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-1" }),
      handlers(),
    );
    expect(root.querySelector('[data-gap-clear="act-1"]')).toBeNull();

    const paced = applyCommand(
      readonlyScene(),
      { kind: "setGap", afterActionId: "act-1", durationMs: 800 },
      ids(),
    );
    renderInspector(
      root,
      propsFor(paced, { kind: "tick", actionId: "act-1" }),
      handlers(),
    );
    expect(root.querySelector('[data-gap-clear="act-1"]')).not.toBeNull();
  });

  it("authors a pace in milliseconds after the step", () => {
    const h = handlers();
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-1" }),
      h,
    );
    const input = root.querySelector(
      'input[data-gap="act-1"]',
    ) as HTMLInputElement;
    input.value = "800";
    input.dispatchEvent(new Event("change"));
    expect(h.onGap).toHaveBeenCalledWith("act-1", 800);
  });

  it("stores a typed zero rather than treating it as a deletion", () => {
    // `Gap.durationMs` is `nonnegative`, unlike `Hold.durationMs`, precisely
    // so that zero stays sayable: typing 0 authors "no pause here". Routing
    // it to `onGapClear` would restore the recorded pause instead — the
    // opposite of what was asked.
    const h = handlers();
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-1" }),
      h,
    );
    const input = root.querySelector(
      'input[data-gap="act-1"]',
    ) as HTMLInputElement;
    input.value = "0";
    input.dispatchEvent(new Event("change"));
    expect(h.onGap).toHaveBeenCalledWith("act-1", 0);
    expect(h.onGapClear).not.toHaveBeenCalled();
  });

  it("restores the recorded pace when the field is emptied", () => {
    const h = handlers();
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-1" }),
      h,
    );
    const input = root.querySelector(
      'input[data-gap="act-1"]',
    ) as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("change"));
    expect(h.onGapClear).toHaveBeenCalledWith("act-1");
    expect(h.onGap).not.toHaveBeenCalled();
  });

  it("restores the recorded pace from the button beside the field", () => {
    const h = handlers();
    const paced = applyCommand(
      readonlyScene(),
      { kind: "setGap", afterActionId: "act-1", durationMs: 800 },
      ids(),
    );
    renderInspector(
      root,
      propsFor(paced, { kind: "tick", actionId: "act-1" }),
      h,
    );
    (
      root.querySelector('[data-gap-clear="act-1"]') as HTMLButtonElement
    ).click();
    expect(h.onGapClear).toHaveBeenCalledWith("act-1");
  });
});

describe("keep-hover, on the step itself", () => {
  it("offers Keep on a flagged hover, so one wrong verdict is survivable", () => {
    renderInspector(
      root,
      propsFor(
        readonlyScene(),
        { kind: "tick", actionId: "act-1" },
        {
          removable: ["act-1"],
          checked: 1,
          unchecked: 0,
          failed: false,
        },
      ),
      handlers(),
    );
    expect(root.querySelector("[data-keep-hover]")).not.toBeNull();
  });

  it("calls onKeepHover with the flagged step's id", () => {
    const h = handlers();
    renderInspector(
      root,
      propsFor(
        readonlyScene(),
        { kind: "tick", actionId: "act-1" },
        {
          removable: ["act-1"],
          checked: 1,
          unchecked: 0,
          failed: false,
        },
      ),
      h,
    );
    (root.querySelector("[data-keep-hover]") as HTMLButtonElement).click();
    expect(h.onKeepHover).toHaveBeenCalledWith("act-1");
  });
});

describe("the step panel's blocks", () => {
  it("emits no empty block for a step with nothing more to say than its heading", () => {
    // A click with measured timing: no text to retype, no estimate to
    // explain. The block that would hold those must not be appended empty,
    // or the first `.beat-panel > div` rule to paint a box paints a hole.
    renderInspector(
      root,
      propsFor(readonlyScene(), { kind: "tick", actionId: "act-2" }),
      handlers(),
    );
    const panel = root.querySelector("[data-step-panel]");
    expect(panel?.querySelector("h2")?.textContent).toContain("a-row");
    expect(panel?.querySelectorAll(":scope > div:empty")).toHaveLength(0);
  });
});
