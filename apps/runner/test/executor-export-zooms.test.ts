import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAMERA_DEFAULTS } from "@demoman/compositor";
import {
  type ExportAnswer,
  ZOOM_FLOOR_SCALE,
  type ZoomWarning,
} from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { ownVideo } from "./fixture.js";

// Measured as executor-export.test.ts measures its own (2026-10-12, x5 for
// CI): a run of a three-click take and one 9:16 export at 1080x1920.
const RUN_MS = 60_000;
const VERTICAL_EXPORT_MS = 120_000;

/**
 * Three buttons on a 1280x800 page, one per way a zoom can fail to play as
 * asked in a 9:16 export with no padding, whose crop shows 800 x 9/16 = 450
 * CSS px across at 1x and 391 at the 1.15x vertical cap:
 *
 * - "Full width" (1180 px): with the 24 px margin each side it fits the
 *   1280 px viewport only at 1.04x, under the 1.2x floor, so the take has no
 *   zoom on it at all.
 * - "Wide row" (360 px): fits the viewport at 1.8x, but 408 px with its
 *   margins is wider than the crop at the cap, so the fit narrows it to 1.1x.
 * - "Go" and "Next" (120 px each): fit the crop at the cap, so the cap
 *   alone holds them. Two, so the answer keeps more than one capped click.
 *
 * Explicit widths and absolute positions, so no glyph advance moves a rect
 * (CLAUDE.md, "The runner's fonts are not your fonts"). Every one of these
 * claims is asserted from the take before the export is read.
 */
const ZOOMS_APP = `<!doctype html><meta charset=utf-8><title>Zooms</title>
<style>
  body { margin: 0; background: #fff; font: 16px sans-serif; }
  button { position: absolute; height: 48px; border: 0; padding: 0;
    background: #1e40af; color: #fff; font: 16px sans-serif; }
  #full { left: 50px; top: 80px; width: 1180px; }
  #row { left: 460px; top: 360px; width: 360px; }
  #go { left: 580px; top: 560px; width: 120px; }
  #next { left: 580px; top: 680px; width: 120px; }
</style>
<button id=full>Full width</button>
<button id=row>Wide row</button>
<button id=go>Go</button>
<button id=next>Next</button>`;

let server: Server;
let url: string;
let home: string;
let executor: LocalExecutor;
let takeId: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(ZOOMS_APP);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = await mkdtemp(join(tmpdir(), "demoman-export-zooms-"));
  executor = createLocalExecutor({
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
  // Pauses well past the closeness rule between the two zoomed clicks, so
  // neither is skipped as too close to the other.
  const run = await executor.request("run", {
    video: ownVideo(),
    callId: "make-zooms-take",
    script: {
      scriptVersion: 1,
      name: "Zooms",
      target: url,
      viewport: { width: 1280, height: 800 },
      look: {
        branding: {
          background: { kind: "solid", color: "#00c853" },
          logo: null,
          padding: 0,
        },
        canvas: { aspect: "9:16" },
      },
      steps: [
        { do: "waitForLoad" },
        { do: "click", on: { text: "Full width" } },
        { do: "pause", ms: 1500 },
        { do: "click", on: { text: "Wide row" } },
        { do: "pause", ms: 2500 },
        { do: "click", on: { text: "Go" } },
        { do: "pause", ms: 2500 },
        { do: "click", on: { text: "Next" } },
        { do: "pause", ms: 1500 },
      ],
    },
  });
  const id = run.ok
    ? (run.value as { provenance?: { takeId?: unknown } }).provenance?.takeId
    : undefined;
  if (typeof id !== "string") {
    throw new Error(`the zooms take was not made: ${JSON.stringify(run)}`);
  }
  takeId = id;
}, RUN_MS);

afterAll(async () => {
  await executor.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});

/** The click action whose anchor carries `name`, with its recorded rect. */
function clickNamed(scene: SceneDocument, name: string) {
  const anchor = scene.anchors.find(
    (a) => a.fingerprint.accessibleName === name,
  );
  const action = scene.actions.find(
    (a) => a.kind === "click" && a.anchorId === anchor?.id,
  );
  if (!action) {
    throw new Error(
      `no click on "${name}": ${JSON.stringify(scene.actions.map((a) => [a.kind, a.anchorId]))}`,
    );
  }
  return action;
}

describe("a 9:16 export of a take whose zooms do not all play as asked", () => {
  it(
    "keeps the skipped, narrowed and capped zooms in the answer, each by its click, and out of the sentence",
    async () => {
      const scene = (await createLibrary(home).getScene(
        takeId,
      )) as SceneDocument;
      const full = clickNamed(scene, "Full width");
      const row = clickNamed(scene, "Wide row");
      const go = clickNamed(scene, "Go");
      const next = clickNamed(scene, "Next");
      const evidence = JSON.stringify({
        camera: scene.camera,
        zoomsSkipped: scene.zoomsSkipped,
        rects: [full.rect, row.rect, go.rect, next.rect],
      });

      // The premises, from the take itself. The full-width click was left
      // without a zoom for being under the floor...
      expect(scene.zoomsSkipped, evidence).toContainEqual({
        actionId: full.id,
        reason: "targetTooWide",
        scale: expect.any(Number),
      });
      // ...and the other three each carry the landscape default, 1.8x.
      const zoomOn = (actionId: string) =>
        scene.camera.find((c) => c.marker.actionId === actionId)?.scale;
      expect(zoomOn(row.id), evidence).toBe(1.8);
      expect(zoomOn(go.id), evidence).toBe(1.8);
      expect(zoomOn(next.id), evidence).toBe(1.8);
      // The crop the 9:16 frame shows at the cap, in CSS px: the row and its
      // margins do not fit it, the "Go" and "Next" buttons and theirs do.
      const margin = 2 * CAMERA_DEFAULTS.fitMarginPx;
      const atCap = (800 * 9) / 16 / CAMERA_DEFAULTS.verticalMaxScale;
      expect((row.rect?.width ?? 0) + margin, evidence).toBeGreaterThan(atCap);
      for (const capOnly of [go, next]) {
        expect(
          (capOnly.rect?.width ?? Infinity) + margin,
          evidence,
        ).toBeLessThan(atCap);
      }

      const out = await executor.request("export", {
        takeId,
        callId: "e-zooms",
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as ExportAnswer;
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "saved",
        aspect: "9:16",
      });
      if (answer.outcome !== "saved") return;
      const zooms = answer.warnings.zooms ?? [];
      const said = JSON.stringify({ zooms, summary: answer.summary });

      const skipped = zooms.find((z) => z.actionId === full.id);
      expect(skipped, said).toMatchObject({
        kind: "skipped",
        click: 'click on button "Full width"',
        floor: ZOOM_FLOOR_SCALE,
      });
      const narrowed = zooms.find((z) => z.actionId === row.id) as
        | Exclude<ZoomWarning, { kind: "skipped" }>
        | undefined;
      expect(narrowed, said).toMatchObject({
        kind: "lowered",
        by: "fit",
        click: 'click on button "Wide row"',
        asked: 1.8,
      });
      // Narrowed below the cap, and not all the way to a pan.
      expect(narrowed?.got, said).toBeGreaterThan(1);
      expect(narrowed?.got, said).toBeLessThan(
        CAMERA_DEFAULTS.verticalMaxScale,
      );
      // Each capped click stays in the answer, so an agent can ask which.
      for (const [capOnly, name] of [
        [go, "Go"],
        [next, "Next"],
      ] as const) {
        expect(
          zooms.find((z) => z.actionId === capOnly.id),
          said,
        ).toEqual({
          kind: "lowered",
          by: "cap",
          actionId: capOnly.id,
          click: `click on button "${name}"`,
          asked: 1.8,
          got: CAMERA_DEFAULTS.verticalMaxScale,
        });
      }
      expect(zooms, said).toHaveLength(4);

      // Red if any of the four reaches the sentence: they are Demoman's own
      // framing calls, kept above for an agent that asks (author, 2026-10-20).
      expect(answer.summary, said).toMatch(
        /^Saved .*\(1080×1920, 60 fps, [\d.]+ [KM]B\)\.$/,
      );
    },
    VERTICAL_EXPORT_MS,
  );
});
