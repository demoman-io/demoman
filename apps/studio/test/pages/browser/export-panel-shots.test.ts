import {
  composeForTarget,
  createImageFrameSource,
  planScene,
  renderFrame,
  resolvePlan,
} from "@demoman/compositor";
import { DEFAULT_EXPORT_QUALITY } from "@demoman/run-core";
import type { SceneAspect } from "@demoman/scene-schema";
import { page } from "@vitest/browser/context";
import { describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import { renderInspector } from "../../../pages/entrypoints/editor/inspector";
import { renderRail } from "../../../pages/entrypoints/editor/rail";
import {
  renderExport,
  renderHeaderIcons,
  renderStageBar,
  renderTransport,
} from "../../../pages/entrypoints/editor/view";
import type {
  ExportReadiness,
  ExportRun,
  SaveView,
} from "../../../pages/src/editor/export-run";
import { targetFor } from "../../../pages/src/editor/formats";
import { type FileType, frameOf } from "../../../pages/src/editor/jobs";
import { buildLaneModel } from "../../../pages/src/editor/lanes";
import { previewTarget } from "../../../pages/src/editor/preview";
import { createSections } from "../../../pages/src/editor/sections";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import { runsHref, runsRouteLabel } from "../../../pages/src/shell/runs-link";
import { createFixtureBundleSource } from "../helpers/fixture-bundle-source";
import { proceduralFrames } from "../helpers/frames";
import { mountShell } from "../helpers/shell-css";

/**
 * The export panel and the stage's aspect toggle in every state the author
 * meets, painted by the real shell, stylesheet and renderers, in both
 * themes, at a full-screen window and below it — and saved to
 * `__screenshots__/export-panel/` (gitignored) for the handover.
 *
 * Each case also asserts the painted result, not a rect (CLAUDE.md, "Assert
 * on the picture" and "Check the editor below full screen, and in dark
 * mode"): the element that carries the state is the one hit at its own
 * centre, and that centre is on screen. A state drawn under something
 * else, or scrolled out of the panel, fails here rather than in a
 * screenshot nobody opens.
 */

const css = /<style>([\s\S]*?)<\/style>/.exec(shell)?.[1] ?? "";
const bodyHtml = (/<body>([\s\S]*?)<\/body>/.exec(shell)?.[1] ?? "").replace(
  /<script[\s\S]*?<\/script>/g,
  "",
);
if (!css.includes("#stage") || !bodyHtml.includes('id="timeline"')) {
  throw new Error("index.html no longer carries the editor's shell");
}

const handlers = () => new Proxy({}, { get: () => vi.fn() }) as never;

const output = (ref: string, name: string, sceneDigest?: string) => ({
  ref,
  name,
  byteLength: 13_002_342,
  contentType: "video/mp4",
  detailViolations: [],
  renderedAt: "2026-09-23T10:00:00.000Z",
  ...(sceneDigest === undefined ? {} : { sceneDigest }),
});

interface Shot {
  name: string;
  aspect: SceneAspect;
  fileType: FileType;
  run: ExportRun;
  save: SaveView | null;
  /** Absent means `exact`. */
  readiness?: ExportReadiness;
  /** The element that carries this state; must be what paints at its centre. */
  carrier: string;
  /** The Export button's label in this state, when the shot is about it. */
  label?: string;
}

const SHOTS: Shot[] = [
  {
    name: "rest-16x9",
    aspect: "16:9",
    fileType: "mp4",
    run: { phase: "idle" },
    save: null,
    carrier: "[data-export-start]",
  },
  {
    name: "rest-9x16-gif",
    aspect: "9:16",
    fileType: "gif",
    run: { phase: "idle" },
    save: null,
    carrier: '#stage-tools [data-aspect="9:16"]',
  },
  {
    name: "exporting",
    aspect: "16:9",
    fileType: "mp4",
    run: { phase: "encoding", done: 248, total: 576 },
    save: null,
    carrier: "[data-export-progress]",
  },
  {
    name: "saved",
    aspect: "16:9",
    fileType: "mp4",
    run: { phase: "idle" },
    save: {
      kind: "saved",
      names: ["Checkout flow.mp4"],
      byteLength: 13_002_342,
      reveal: { kind: "download", id: 7 },
      summary: null,
      outputRefs: [],
    },
    carrier: "[data-show-in-folder]",
  },
  {
    name: "cancelled",
    aspect: "16:9",
    fileType: "mp4",
    run: { phase: "idle" },
    save: { kind: "cancelled", refs: ["r-now"], saved: 0, total: 1 },
    carrier: "[data-save-again]",
  },
  {
    name: "failed",
    aspect: "16:9",
    fileType: "stills",
    run: { phase: "idle" },
    save: {
      kind: "failed",
      error:
        "Checkout flow stills/act-2.png: Chrome stopped the download: the disk is full.",
      refs: ["r-now"],
      saved: 4,
      total: 5,
    },
    carrier: '[data-save-outcome="failed"]',
  },
  // Plan 2, Task 7: the rebuild left the editor, so a take with no frames is
  // answered by the Runs route beneath a disabled Export — never a disabled
  // Export alone (spec §7). The five rebuild shots (`rebuildable`,
  // `rebuilding`, `frozen`, `rebuild-stopped`, `rebuild-refused`) went with it.
  {
    name: "no-frames",
    aspect: "16:9",
    fileType: "mp4",
    run: { phase: "idle" },
    save: null,
    readiness: { kind: "noFrames" },
    carrier: "[data-export-no-frames] [data-runs-route]",
    label: "Export MP4",
  },
];

const VIEWPORTS = [
  // A MacBook's full-screen browser window, and one below the ~900px
  // height CLAUDE.md names as where the preview first overflowed.
  { name: "full", width: 1512, height: 945 },
  { name: "short", width: 1280, height: 820 },
] as const;

async function mount(scheme: "light" | "dark", shot: Shot): Promise<void> {
  mountShell(scheme, css);
  document.body.innerHTML = bodyHtml;
  document.body.removeAttribute("data-panel");
  renderHeaderIcons();

  const scene = { ...readonlyScene(), canvas: { aspect: shot.aspect } };
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

  const node = (selector: string) => {
    const found = document.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`no ${selector} in the shell`);
    return found;
  };
  renderRail(
    node("#rail"),
    { rail: "export", panelOpen: true, hasSelection: false },
    handlers(),
  );
  renderTransport(
    node("#transport"),
    { authored: false, playing: false, enabled: true, rate: 1, looping: false },
    handlers(),
  );
  renderInspector(
    node("#inspector"),
    {
      selection: null,
      view,
      model,
      scene,
      hoverReport: null,
      viewport: scene.meta.capture.viewport,
      rail: "export",
      sections: createSections(),
      attachedToCuts: [],
    },
    handlers(),
  );
  // The studio's panel: an MP4 carries the Quality row, at the default.
  const quality = shot.fileType === "mp4" ? DEFAULT_EXPORT_QUALITY : null;
  const target = targetFor(
    shot.fileType,
    shot.aspect,
    bundle,
    frameOf(scene),
    quality === null ? {} : { quality },
  );
  const sections = createSections();
  renderExport(
    node("[data-panel-export]"),
    {
      outputs: [
        {
          kind: "stored" as const,
          output: output("r-now", "Checkout flow.mp4", "d-now"),
        },
        {
          kind: "stored" as const,
          output: output("r-old", "Checkout flow (vertical).mp4", "d-then"),
        },
      ],
      fileType: shot.fileType,
      quality,
      aspect: shot.aspect,
      target,
      recording: bundle.viewport,
      durationMs: 24_400,
      run: shot.run,
      save: shot.save,
      readiness: shot.readiness ?? { kind: "exact" },
      runsRoute: {
        takeId: "take 1&x",
        authored: false,
        rerun: {
          kind: "link",
          href: runsHref("take 1&x"),
          label: runsRouteLabel(false),
        },
      },
      currentDigest: "d-now",
      // The launch configuration: no share surface at all.
      sections,
      beatAt: () => null,
      hasReclaimedMotion: false,
    },
    handlers(),
  );
  // Both of `main.ts`'s roots: the toolbar's switch is the one the author
  // sees outside full screen, and the one the 9:16 shot's carrier names.
  for (const root of ["#stage-tools", "#stage-bar"]) {
    renderStageBar(
      node(root),
      {
        authored: false,
        positionMs: 2_000,
        durationMs: 24_400,
        aspect: shot.aspect,
        enabled: true,
        fullscreen: false,
        error: null,
        zoom: "fit",
      },
      handlers(),
    );
  }

  // A real frame on the stage, so each shot shows the picture the page
  // draws beside the panel.
  const preview = previewTarget(target);
  const canvas = node("#preview") as HTMLCanvasElement;
  canvas.width = preview.width;
  canvas.height = preview.height;
  const stage = node("#stage");
  stage.style.setProperty(
    "--frame-ratio",
    `${target.width} / ${target.height}`,
  );
  stage.style.setProperty("--frame-px", String(preview.width));
  const source = createFixtureBundleSource(bundle, proceduralFrames(bundle));
  const composed = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target: preview,
  });
  const offscreen = new OffscreenCanvas(preview.width, preview.height);
  await renderFrame({
    resolved: composed.resolved,
    target: preview,
    presentation: composed.presentation,
    frames: createImageFrameSource(bundle, source.load),
    ctx: offscreen.getContext("2d") as OffscreenCanvasRenderingContext2D,
    outputTimeMs: 2_000,
  });
  canvas.getContext("2d")?.drawImage(offscreen, 0, 0);
}

/** What paints at the centre of `selector`, and whether that is on screen. */
function paintedAtCentre(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const onScreen =
    r.width > 0 &&
    r.height > 0 &&
    x >= 0 &&
    y >= 0 &&
    x <= window.innerWidth &&
    y <= window.innerHeight;
  const hit = document.elementFromPoint(x, y);
  return { onScreen, hitsIt: hit !== null && el.contains(hit), rect: r, hit };
}

/**
 * The screenshot's own pixel at a CSS point — what was painted, not what a
 * rect or a computed style claims. The capture may be at a device pixel
 * ratio above 1, so the point is scaled by the bitmap's own width.
 */
async function pixelsAt(
  points: { x: number; y: number }[],
): Promise<[number, number, number][]> {
  // Unsaved, the provider answers with the base64 string itself rather than
  // the `{ path, base64 }` its typing describes; both are read.
  const shot: unknown = await page.screenshot({ base64: true, save: false });
  const base64 =
    typeof shot === "string" ? shot : (shot as { base64: string }).base64;
  const png = base64.startsWith("data:")
    ? base64
    : `data:image/png;base64,${base64}`;
  const bitmap = await createImageBitmap(await (await fetch(png)).blob());
  const scale = bitmap.width / window.innerWidth;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0);
  return points.map(({ x, y }) => {
    const d = ctx.getImageData(
      Math.floor(x * scale),
      Math.floor(y * scale),
      1,
      1,
    ).data;
    return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
  });
}

describe("the export panel, painted", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const viewport of VIEWPORTS) {
      for (const shot of SHOTS) {
        // Composing one frame costs ~1-3s locally and CI is ~5x slower
        // (CLAUDE.md, "CI runs on a different machine").
        it(`${shot.name} in ${scheme} at ${viewport.name}`, async () => {
          await page.viewport(viewport.width, viewport.height);
          await mount(scheme, shot);
          const { onScreen, hitsIt, rect, hit } = paintedAtCentre(shot.carrier);
          const evidence = `${shot.carrier} at ${JSON.stringify(rect)}; hit ${hit?.outerHTML.slice(0, 120)}`;
          expect(onScreen, evidence).toBe(true);
          expect(hitsIt, evidence).toBe(true);
          if (shot.label !== undefined) {
            expect(
              document.querySelector("[data-export-start]")?.textContent,
            ).toBe(shot.label);
          }
          // No shot draws a rebuild-failure row any more: it left with the
          // rebuild. Asserted so a row that came back would be seen here.
          expect(document.querySelector("[data-rebuild-failure]")).toBeNull();
          const start = document.querySelector<HTMLButtonElement>(
            "[data-export-start]",
          );
          // The panel draws a route to Runs only where it is the way on: the
          // no-frames line in the shots whose readiness is `noFrames` (the
          // button disabled with it). A take with frames had one quiet
          // "Re-shoot this take in Runs" here too (final review I3) until
          // 2026-10-19; that is Take info's Re-film row now.
          const frameless = shot.readiness?.kind === "noFrames";
          const links = document.querySelectorAll<HTMLAnchorElement>(
            "[data-panel-export] [data-runs-route]",
          );
          expect(links.length, shot.name).toBe(frameless ? 1 : 0);
          expect(start?.disabled, shot.name).toBe(
            frameless || shot.run.phase !== "idle",
          );
          const link = links[0];
          if (frameless && link !== undefined) {
            expect(link.getAttribute("href")).toBe(
              "run.html?take=take%201%26x",
            );
            expect(link.closest("[data-export-no-frames]")?.textContent).toBe(
              "This take has no frames — re-shoot it in Runs",
            );
            // On screen and not covered, the same test the carrier gets.
            const r0 = link.getBoundingClientRect();
            const at = document.elementFromPoint(
              r0.left + r0.width / 2,
              r0.top + r0.height / 2,
            );
            expect(
              r0.width > 0 && r0.bottom <= window.innerHeight && r0.top >= 0,
              `${shot.name}: the Runs link at ${JSON.stringify(r0)}`,
            ).toBe(true);
            expect(
              at !== null && link.contains(at),
              `${shot.name}: the Runs link is covered by ${at?.outerHTML.slice(0, 120)}`,
            ).toBe(true);
            // Painted, not only present: the hit test above says nothing
            // covers it; this says its box holds ink — across the link's
            // text the screenshot's pixels are not one flat colour, which a
            // box with invisible (or background-coloured) text would be.
            const r = link.getBoundingClientRect();
            const points = Array.from({ length: 24 }, (_, i) => ({
              x: r.left + ((i + 0.5) * r.width) / 24,
              y: r.top + r.height / 2,
            }));
            const pixels = await pixelsAt(points);
            const distinct = new Set(pixels.map((p) => p.join(",")));
            expect(
              distinct.size,
              `the link's pixels are one colour: ${[...distinct].join(" | ")}`,
            ).toBeGreaterThan(1);
          }
          // The toggle names the scene's aspect in every shot.
          expect(
            document
              .querySelector(`#stage-tools [data-aspect="${shot.aspect}"]`)
              ?.getAttribute("aria-checked"),
          ).toBe("true");
          await page.screenshot({
            path: `__screenshots__/export-panel/${shot.name}-${scheme}-${viewport.name}.png`,
          });
        }, 30_000);
      }
    }
  }
});
