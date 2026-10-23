import {
  CAMERA_DEFAULTS,
  composeForTarget,
  contentScale,
  fitScaleFor,
  frameCamera,
  LANDSCAPE_1440P,
  planScene,
  sampleCamera,
} from "@demoman/compositor";
import {
  MOTION_DEFAULTS,
  type SceneDocument,
  SceneDocumentSchema,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { proceduralBundle } from "../../../replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../replay-engine/test/helpers/scenes";
import {
  ZOOM_FIT_MARGIN_PX,
  ZOOM_FLOOR_SCALE,
  zoomSkippedNote,
  zoomsForClicks,
} from "../../src/index.js";

/**
 * A generated zoom on a page dense with text: fitted to what was clicked,
 * and to nothing else (the author's decision, 2026-10-10).
 *
 * From 2026-10-09 the zoom was also narrowed until its edges cut no line of
 * text on screen ("O2"). On the author's KitchenLink FAQ every click then
 * came out "target too wide to zoom without cutting text (would be 1x)" — a
 * page of paragraphs leaves no window above the floor that misses every
 * line. The FAQ here is that shape, synthetic: a 760x56 question row in a
 * 1200x796 viewport, with a paragraph line every 28 px above and below it.
 *
 * The window the plateau case checks is the compositor's own camera
 * (`composeForTarget` → `sampleCamera` → `frameCamera`), so "the row is
 * whole" is a claim about the frame the render draws.
 */
type Rect = { x: number; y: number; width: number; height: number };

const VIEWPORT = { width: 1200, height: 796 };
const ROW: Rect = { x: 220, y: 400, width: 760, height: 56 };
/** Paragraph lines filling the page above and below the row: full-measure
 *  body copy (40..1160) and the answer column's lines (220..980). */
const DENSE_LINES: Rect[] = Array.from({ length: 28 }, (_, i) => ({
  x: i % 2 === 0 ? 40 : 220,
  y: 8 + i * 28,
  width: i % 2 === 0 ? 1120 : 760,
  height: 20,
})).filter((l) => l.y + l.height <= ROW.y || l.y >= ROW.y + ROW.height);

const clickOn = (rect: Rect, textLines?: Rect[]) =>
  ({
    id: "act-2",
    kind: "click",
    anchorId: "a-row",
    timestamp: 3_200,
    marker: "click:a-row",
    rect,
    ...(textLines ? { textLines } : {}),
  }) as SceneDocument["actions"][number];

/** Whether a window centred on `target` at `scale` cuts any of `lines`:
 *  partly in it and partly out. The 2026-10-09 rule refused every such
 *  scale. */
function centredWindowCuts(target: Rect, scale: number, lines: Rect[]) {
  const w = VIEWPORT.width / scale;
  const h = VIEWPORT.height / scale;
  const x0 = target.x + target.width / 2 - w / 2;
  const y0 = target.y + target.height / 2 - h / 2;
  return lines.some((l) => {
    const out =
      l.x + l.width <= x0 ||
      l.x >= x0 + w ||
      l.y + l.height <= y0 ||
      l.y >= y0 + h;
    const inside =
      l.x >= x0 &&
      l.x + l.width <= x0 + w &&
      l.y >= y0 &&
      l.y + l.height <= y0 + h;
    return !out && !inside;
  });
}

/** The CSS rect the frame shows on the zoom's plateau, rendered landscape. */
function shownOnPlateau(
  rect: Rect,
  camera: SceneDocument["camera"],
  padding: number,
): Rect {
  const base = readonlyScene();
  const scene: SceneDocument = {
    ...base,
    meta: {
      ...base.meta,
      capture: { ...base.meta.capture, viewport: VIEWPORT },
    },
    branding: { ...base.branding, padding },
    // Follow off: the fixture's pointer is nowhere near the row, so the
    // follow-cam would pan off the zoom after it. This measures the window
    // the zoom itself frames.
    motion: { ...MOTION_DEFAULTS, follow: false },
    camera,
  };
  const b = proceduralBundle();
  const bundle = {
    ...b,
    viewport: VIEWPORT,
    anchorRects: b.anchorRects.map((e) =>
      e.actionId === "act-2" ? { ...e, rect } : e,
    ),
  };
  const target = LANDSCAPE_1440P;
  const composed = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target,
  });
  const segment = composed.resolved.cameraSegments[0];
  if (!segment) throw new Error("the zoom has no segment");
  const { frameRect } = composed.presentation;
  const k0 = contentScale(frameRect, VIEWPORT);
  const cam = frameCamera(
    sampleCamera(composed.resolved.cameraKeys, segment.startMs + 200),
    k0,
    frameRect,
    VIEWPORT,
    target,
  );
  const width = frameRect.width / (k0 * cam.scale);
  const height = frameRect.height / (k0 * cam.scale);
  return {
    x: cam.center.x - width / 2,
    y: cam.center.y - height / 2,
    width,
    height,
  };
}

describe("a generated zoom on a text-dense page", () => {
  // The author's case. Red on the 2026-10-09 code: the text-safe scale came
  // out at 1, under the floor, and the click was skipped as `textTooWide`
  // with no zoom at all.
  it("zooms a FAQ row at its target fit, whatever text surrounds it", () => {
    const fit = fitScaleFor(ROW, VIEWPORT);
    // Premises: the row fits above the floor and below the default, so the
    // zoom is narrowed, not dropped and not left at 1.8 …
    expect(fit).toBeCloseTo(1.48, 2);
    expect(fit).toBeGreaterThan(ZOOM_FLOOR_SCALE);
    // … and the lines are dense enough that every scale from the floor to
    // the fit cuts one — the page O2 could not zoom on.
    expect(DENSE_LINES.length).toBeGreaterThan(20);
    for (let s = ZOOM_FLOOR_SCALE; s <= fit + 1e-9; s += 0.01)
      expect(centredWindowCuts(ROW, s, DENSE_LINES), `scale ${s}`).toBe(true);

    const { camera, zoomsSkipped } = zoomsForClicks(
      [clickOn(ROW, DENSE_LINES)],
      VIEWPORT,
    );
    expect(zoomsSkipped, JSON.stringify(zoomsSkipped)).toEqual([]);
    expect(camera.map((c) => c.kind === "zoom" && c.scale)).toEqual([fit]);
    // The lines are not read: the same click without them gets the same.
    expect(zoomsForClicks([clickOn(ROW)], VIEWPORT).camera).toEqual(camera);

    // And the frame the render draws holds the row whole, with its margin.
    for (const padding of [0, 0.08, 0.2]) {
      const shown = shownOnPlateau(ROW, camera, padding);
      const evidence = `padding ${padding}: ${JSON.stringify(shown)}`;
      expect(shown.width, evidence).toBeLessThan(VIEWPORT.width - 1);
      expect(ROW.x - shown.x, evidence).toBeGreaterThanOrEqual(
        ZOOM_FIT_MARGIN_PX - 1,
      );
      expect(
        shown.x + shown.width - (ROW.x + ROW.width),
        evidence,
      ).toBeGreaterThanOrEqual(ZOOM_FIT_MARGIN_PX - 1);
    }
  });

  // Red without the floor (a 1.04x zoom is made), and red on the
  // 2026-10-09 wording ("would be"), which read as the zoom it would have
  // had rather than the scale the target fits at.
  it("skips a target too wide for the floor, and says what it fits at", () => {
    const wide: Rect = { x: 50, y: 400, width: 1100, height: 56 };
    const fit = fitScaleFor(wide, VIEWPORT);
    // Premise: above 1, so it is the floor that refuses it, not the fit.
    expect(fit).toBe(1.04);
    const { camera, zoomsSkipped } = zoomsForClicks(
      [clickOn(wide, DENSE_LINES)],
      VIEWPORT,
    );
    expect(camera).toEqual([]);
    expect(zoomsSkipped).toEqual([
      { actionId: "act-2", reason: "targetTooWide", scale: fit },
    ]);
    const [skip] = zoomsSkipped;
    if (!skip) throw new Error("no skip");
    expect(zoomSkippedNote(skip)).toBe(
      "No zoom on click act-2: target too wide to zoom (fits at 1.04x, floor 1.2x).",
    );
  });

  // A take saved from 2026-10-09 to 2026-10-10 carries `textLines` on its
  // clicks and may carry a `textTooWide` skip. Red if either is dropped from
  // the schema: without the reason the parse refuses the take, and the
  // editor cannot open it; without the field the lines are stripped.
  it("still opens and renders a document that carries text lines", () => {
    const base = readonlyScene();
    const lines = DENSE_LINES.slice(0, 3);
    const doc: SceneDocument = {
      ...base,
      actions: base.actions.map((a) =>
        a.id === "act-3" && a.kind === "click" ? { ...a, textLines: lines } : a,
      ),
      zoomsSkipped: [{ actionId: "act-3", reason: "textTooWide", scale: 1.1 }],
      // The author zoomed that click by hand since.
      camera: [
        {
          id: "zoom-1",
          kind: "zoom",
          anchorId: "a-checkout",
          marker: { actionId: "act-3", offsetMs: CAMERA_DEFAULTS.leadInMs },
          scale: 1.6,
        },
      ],
    };
    const parsed = SceneDocumentSchema.parse(doc);
    const click = parsed.actions.find((a) => a.id === "act-3");
    expect(click?.kind === "click" && click.textLines).toEqual(lines);
    expect(parsed.zoomsSkipped?.[0]?.reason).toBe("textTooWide");
    const composed = composeForTarget({
      plan: planScene(parsed),
      bundle: proceduralBundle(),
      scene: parsed,
      target: LANDSCAPE_1440P,
    });
    expect(composed.resolved.cameraSegments).toHaveLength(1);
  });
});
