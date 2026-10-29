import { MOTION_DEFAULTS, type SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import type { ResolvedPlan } from "../../src/plan/resolve";
import { renderFrame } from "../../src/render/compose";
import { composeForTarget } from "../../src/render/compose-for-target";
import {
  LANDSCAPE_1080P,
  type RenderTarget,
  VERTICAL_1080,
} from "../../src/render/target";
import { sceneCameraAt, windowOnScreen } from "../../src/render/window";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene } from "../fixtures/scene";

// The window refresh compares by pixels is the one the frame paints: red if
// `windowOnScreen` and `renderFrame`'s scene transform disagree.
const MAGENTA = "#ff00ff";
/** The background, under the frame's shadow too; the fixture page has no
 *  such colour. */
const isBackground = ([r, g, b]: number[]) =>
  (r ?? 0) > 150 && (b ?? 0) > 150 && (g ?? 255) < 90;

function zoomed(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    branding: {
      background: { kind: "solid", color: MAGENTA },
      logo: null,
      padding: 0.1,
    },
    // Follow off: the zoom holds where it framed (point-zoom-pixels.test.ts).
    motion: { ...MOTION_DEFAULTS, follow: false },
    camera: [
      {
        id: "cam-p",
        kind: "zoom" as const,
        point: { x: 1060, y: 642 },
        marker: { actionId: "act-2", offsetMs: 0 },
        scale: 1.6,
      },
    ],
  };
}

const LANDSCAPE = { ...LANDSCAPE_1080P, width: 960, height: 540 };

async function edgesAt(
  scene: SceneDocument,
  at: (r: ResolvedPlan) => number,
  target: RenderTarget = LANDSCAPE,
) {
  const bundle = proceduralBundle();
  // As `renderScene` composes: a `cover` target caps its zooms here.
  const { resolved, presentation } = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target,
  });
  const outputTimeMs = at(resolved);
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  await renderFrame({
    resolved,
    target,
    presentation,
    frames: createProceduralFrameSource(bundle),
    ctx,
    outputTimeMs,
  });
  const camera = sceneCameraAt(resolved, presentation, target, outputTimeMs);
  const w = windowOnScreen(presentation, camera);
  const px = (x: number, y: number) =>
    Array.from(ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data);
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < target.width && y < target.height;
  // Each edge in view: 2 px inside it is page, 2 px outside is background,
  // at a quarter, half and three quarters along it.
  const checked: string[] = [];
  const wrong: string[] = [];
  const along = [0.25, 0.5, 0.75];
  const edges = [
    { name: "left", at: (t: number) => [w.x, w.y + w.height * t], d: [1, 0] },
    {
      name: "right",
      at: (t: number) => [w.x + w.width, w.y + w.height * t],
      d: [-1, 0],
    },
    { name: "top", at: (t: number) => [w.x + w.width * t, w.y], d: [0, 1] },
    {
      name: "bottom",
      at: (t: number) => [w.x + w.width * t, w.y + w.height],
      d: [0, -1],
    },
  ] as const;
  for (const e of edges) {
    for (const t of along) {
      const [x, y] = e.at(t) as [number, number];
      const [dx, dy] = e.d;
      const inside = [x + 2 * dx, y + 2 * dy] as const;
      const outside = [x - 2 * dx, y - 2 * dy] as const;
      if (!on(...inside) || !on(...outside)) continue;
      checked.push(`${e.name}@${t}`);
      if (isBackground(px(...inside)))
        wrong.push(`${e.name}@${t} inside ${px(...inside)}`);
      if (!isBackground(px(...outside)))
        wrong.push(`${e.name}@${t} outside ${px(...outside)}`);
    }
  }
  return { w, camera, checked, wrong };
}

describe("windowOnScreen", () => {
  it("is where the frame paints the window, unzoomed and zoomed", async () => {
    const plain = await edgesAt(zoomed(), () => 0);
    expect(plain.camera.scale, "premise: unzoomed at 0").toBe(1);
    expect(plain.checked, "premise: all four edges in view").toHaveLength(12);
    expect(plain.wrong).toEqual([]);

    const zoom = await edgesAt(zoomed(), (r) => {
      const seg = r.cameraSegments[0];
      if (!seg) throw new Error("no camera segment");
      return seg.startMs + 200;
    });
    expect(zoom.camera.scale, "premise: zoomed in").toBeGreaterThan(1.3);
    // Zoomed toward the bottom right: the window's top and left leave the
    // frame, and at least one edge stays in view to be checked.
    expect(zoom.checked.length, JSON.stringify(zoom.w)).toBeGreaterThan(0);
    expect(zoom.wrong, JSON.stringify(zoom.w)).toEqual([]);
    expect(zoom.w.width).toBeCloseTo(plain.w.width * zoom.camera.scale, 6);
  }, 60_000);

  // 9:16: the window is the padded box and the recording covers it.
  it("is where a cover frame paints the window", async () => {
    const tall = { ...VERTICAL_1080, width: 540, height: 960 };
    const plain = await edgesAt(zoomed(), () => 0, tall);
    expect(tall.fit, "premise: a cover target").toBe("cover");
    expect(plain.camera.scale, "premise: unzoomed at 0").toBe(1);
    expect(plain.checked, "premise: all four edges in view").toHaveLength(12);
    expect(plain.wrong, JSON.stringify(plain.w)).toEqual([]);
    // The premise: the window is the padded box, portrait like the frame,
    // not the landscape recording's contain fit.
    expect(plain.w.width / plain.w.height).toBeLessThan(1);
  }, 60_000);
});
