// The inspector's one design (the Cursor panel's), measured on every panel.
import { LANDSCAPE_1440P, planScene, resolvePlan } from "@demoman/compositor";
import {
  CURSOR_DEFAULTS,
  MOTION_DEFAULTS,
  type SceneDocument,
} from "@demoman/scene-schema";
import { page } from "@vitest/browser/context";
import { describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import { renderInspector } from "../../../pages/entrypoints/editor/inspector";
import {
  renderBranding,
  renderCursor,
  renderExport,
} from "../../../pages/entrypoints/editor/view";
import { buildLaneModel } from "../../../pages/src/editor/lanes";
import { createSections } from "../../../pages/src/editor/sections";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import { runsHref, runsRouteLabel } from "../../../pages/src/shell/runs-link";
import { mountShell, pageParts, parse, token } from "../helpers/shell-css";

/** A fresh `Sections` with Recent exports open. */
function openRecent() {
  const sections = createSections();
  sections.set("recent", true);
  return sections;
}

const { css } = pageParts(shell, "#inspector");
const handlers = () => new Proxy({}, { get: () => vi.fn() }) as never;

function scene(): SceneDocument {
  const s = readonlyScene();
  return {
    ...s,
    camera: [
      {
        id: "cam-1",
        kind: "zoom" as const,
        anchorId: "a-checkout",
        marker: { actionId: "act-3", offsetMs: -350 },
        scale: 1.6,
      },
    ],
    edits: {
      ...s.edits,
      masks: [
        {
          id: "mask-1",
          rect: { x: 0, y: 0, width: 80, height: 40 },
          start: { actionId: "act-1", sourceOffsetMs: 0 },
          end: { actionId: "act-3", sourceOffsetMs: 0 },
        },
      ],
    },
    branding: {
      background: {
        kind: "gradient",
        from: "#1b2a4a",
        to: "#3b5bdb",
        angle: 135,
      },
      logo: { ref: "logo:a", corner: "bottom-right", size: 0.06, opacity: 0.9 },
      padding: 0.08,
    },
  };
}

function mount(
  which: string,
  selection: unknown,
  rail: string,
  scheme: "light" | "dark" = "light",
) {
  mountShell(scheme, css);
  document.body.innerHTML =
    '<aside id="inspector" style="width: 320px"></aside>';
  const sc = scene();
  const bundle = proceduralBundle();
  const resolved = resolvePlan(planScene(sc), bundle, sc);
  const view = buildTimelineView({ scene: sc, bundle, resolved });
  const model = buildLaneModel({
    scene: sc,
    view,
    bundle,
    resolved,
    hoverReport: null,
  });
  const inspector = document.getElementById("inspector") as HTMLElement;
  renderInspector(
    inspector,
    {
      selection,
      view,
      model,
      scene: sc,
      hoverReport: null,
      viewport: sc.meta.capture.viewport,
      rail,
      sections: createSections(),
    } as never,
    handlers(),
  );
  if (which === "export") {
    renderExport(
      inspector.querySelector("[data-panel-export]") as HTMLElement,
      {
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ref: "r1",
              name: "landscape.mp4",
              byteLength: 1024,
              contentType: "video/mp4",
              detailViolations: [],
              renderedAt: "2026-08-25T00:00:00.000Z",
            },
          },
        ],
        fileType: "mp4",
        aspect: "16:9",
        target: LANDSCAPE_1440P,
        recording: { width: 1280, height: 800 },
        durationMs: 24_000,
        run: { phase: "idle" },
        save: null,
        readiness: { kind: "exact" },
        runsRoute: {
          takeId: "t1",
          authored: false,
          rerun: {
            kind: "link",
            href: runsHref("t1"),
            label: runsRouteLabel(false),
          },
        },
        currentDigest: "d-now",
        // Recent exports is collapsed at rest; opened here so the row
        // below is on the page to measure.
        sections: openRecent(),
        beatAt: () => null,
        hasReclaimedMotion: false,
      },
      handlers(),
    );
  }
  if (which === "background") {
    renderBranding(
      inspector.querySelector("[data-panel-branding]") as HTMLElement,
      {
        branding: sc.branding,
        logoThumb: null,
        logoPlacement: null,
        formatTitle: "Landscape video",
        logoNotes: [],
      },
      handlers(),
    );
  }
  if (which === "cursor") {
    renderCursor(
      inspector.querySelector("[data-panel-cursor]") as HTMLElement,
      CURSOR_DEFAULTS,
      MOTION_DEFAULTS,
      handlers(),
    );
  }
  return inspector;
}

/**
 * The inspector's one design, enforced. Every panel is measured against the
 * Cursor panel's rhythm and type (the author's standard, 2026-09-22):
 *
 *  - a control's label is `--row-label`, the panel's own weight, ink;
 *  - every control sits in a row primitive (`.control-row`, `.slider-row`,
 *    `.switch-row`, `.control-actions`) rather than spacing itself;
 *  - 12px painted between a row's label and its control;
 *  - 12px between one row and the next;
 *  - text only in the sizes the design has.
 *
 * A new panel, or a new control in an old one, fails here until it uses the
 * primitives — which is the point: the rhythm lives in one place.
 */
const PANELS: [string, unknown, string][] = [
  ["cursor", null, "cursor"],
  ["background", null, "background"],
  ["export", null, "export"],
  ["step", { kind: "tick", actionId: "act-2" }, "selection"],
  ["zoom", { kind: "zoom", id: "cam-1" }, "selection"],
  ["mask", { kind: "mask", id: "mask-1" }, "selection"],
];
const ROW = ".control-row, .slider-row, .switch-row, .control-actions";
const LABEL =
  ".control-label, .slider-label, .cursor-label, .switch-text strong";
/** h2 title, row label, body, button, note, chip/verb. */
const SIZES = new Set(["16px", "14px", "13px", "12.5px", "12px", "11px"]);
const visible = (el: Element) => el.getBoundingClientRect().height > 0;
const where = (el: Element) =>
  `${el.tagName.toLowerCase()}.${(el as HTMLElement).className || "-"} "${(el.textContent ?? "").trim().slice(0, 30)}"`;

describe.each(PANELS)(
  "the %s panel keeps the inspector's design",
  (which, selection, rail) => {
    it("labels every control in the row-label type", async () => {
      await page.viewport(420, 1400);
      const root = mount(which, selection, rail);
      const panelWeight = getComputedStyle(root).fontWeight;
      const labels = [...root.querySelectorAll<HTMLElement>(LABEL)].filter(
        visible,
      );
      // Premise: every panel but Export has control labels to measure, and
      // Export has its Share row's.
      expect(labels.length, "labels found").toBeGreaterThan(0);
      const size = getComputedStyle(document.documentElement)
        .getPropertyValue("--row-label")
        .trim();
      for (const label of labels) {
        const cs = getComputedStyle(label);
        expect(cs.fontSize, where(label)).toBe(size);
        expect(cs.fontWeight, where(label)).toBe(panelWeight);
        expect(parse(cs.color), where(label)).toEqual(token("--ink"));
      }
    });

    it("puts every control in a row primitive", async () => {
      await page.viewport(420, 1400);
      const root = mount(which, selection, rail);
      const controls = [
        ...root.querySelectorAll<HTMLElement>("input, select, textarea"),
        // Export's output list is its own pattern: a file beside its
        // Download, in the Exported and Share sections.
        // The card's close button is the card's, not a panel control: it
        // sits in the corner, beside the title, on every panel alike.
        ...[...root.querySelectorAll<HTMLElement>("button")].filter(
          (b) =>
            b.closest("details[data-section]") === null &&
            !b.hasAttribute("data-inspector-close"),
        ),
      ].filter((c) => (c as HTMLInputElement).type !== "file");
      const loose = controls
        .filter(
          (c) =>
            c.closest(ROW) === null && c.closest(".cursor-styles") === null,
        )
        .map(where);
      expect(loose, "controls outside a row").toEqual([]);
    });

    it("paints 12px between a row's label and its control", async () => {
      await page.viewport(420, 1400);
      const root = mount(which, selection, rail);
      const rows = [
        ...root.querySelectorAll<HTMLElement>(".control-row, .slider-row"),
      ].filter(visible);
      const off: string[] = [];
      for (const row of rows) {
        const label = row.querySelector(
          ":scope > .control-label, :scope > .slider-label",
        );
        const control = [...row.children].find(
          (c) =>
            !c.matches(
              ".control-label, .slider-label, .control-aside, .slider-value",
            ) && visible(c),
        );
        if (!label || !control) continue;
        // A range input's 16px box paints its 4px track 6px in.
        const inset = (control as HTMLInputElement).type === "range" ? 6 : 0;
        const gap =
          control.getBoundingClientRect().top +
          inset -
          label.getBoundingClientRect().bottom;
        if (Math.abs(gap - 12) > 0.5)
          off.push(`${where(label)} → ${where(control)}: ${gap.toFixed(1)}px`);
      }
      expect(off, "label-to-control gaps").toEqual([]);
    });

    it("spaces consecutive rows 12px apart", async () => {
      await page.viewport(420, 1400);
      const root = mount(which, selection, rail);
      const off: string[] = [];
      for (const row of root.querySelectorAll<HTMLElement>(
        ".control-row, .slider-row, .control-actions",
      )) {
        const next = row.nextElementSibling;
        if (!next?.matches(".control-row, .slider-row, .control-actions"))
          continue;
        if (!visible(row) || !visible(next)) continue;
        const gap =
          next.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
        if (Math.abs(gap - 12) > 0.5)
          off.push(`${where(row)} → ${where(next)}: ${gap.toFixed(1)}px`);
      }
      expect(off, "row-to-row gaps").toEqual([]);
    });

    it("sets text only in the design's sizes", async () => {
      await page.viewport(420, 1400);
      const root = mount(which, selection, rail);
      const odd: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (
        let n = walker.nextNode() as HTMLElement | null;
        n;
        n = walker.nextNode() as HTMLElement | null
      ) {
        const own = [...n.childNodes].some(
          (c) =>
            c.nodeType === Node.TEXT_NODE &&
            (c.textContent ?? "").trim() !== "",
        );
        if (!own || !visible(n)) continue;
        const size = getComputedStyle(n).fontSize;
        if (!SIZES.has(size)) odd.push(`${where(n)}: ${size}`);
      }
      expect(odd, "text in sizes outside the design").toEqual([]);
    });
  },
);

describe("the panels, as painted", () => {
  // Not an assertion: the pictures the author judges by, both themes.
  for (const scheme of ["light", "dark"] as const) {
    it(`screenshots every panel in ${scheme}`, async () => {
      await page.viewport(420, 1400);
      for (const [which, selection, rail] of PANELS) {
        const root = mount(which, selection, rail, scheme);
        await page.screenshot({
          path: `__screenshots__/panel-${which}-${scheme}.png`,
          element: root,
        });
      }
    });
  }
});
