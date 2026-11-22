import type { DialogRecord } from "@demoman/scene-schema";
import { beforeAll, describe, expect, it } from "vitest";
import geistUrl from "../../../../apps/studio/pages/public/fonts/geist-variable.woff2?url";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { cssRectToOutput, renderFrame } from "../../src/render/compose";
import {
  DIALOG_CARD,
  DIALOG_FONT,
  dialogCardLayout,
  dialogFontLoaded,
  drawDialogCard,
  loadDialogFont,
} from "../../src/render/draw-dialog";
import {
  contentScale,
  derivePresentation,
} from "../../src/render/presentation";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { sceneCameraAt } from "../../src/render/window";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene } from "../fixtures/scene";

const confirm: DialogRecord = {
  kind: "confirm",
  host: "localhost:8130",
  message: "Delete Northwind?",
  answer: "accept",
  by: "default",
  beatMs: 1500,
};

/** The page's colour: not white, so the card's white tells apart from it. */
const PAGE = { r: 154, g: 154, b: 154 };
/** The page area: it starts 100px down the canvas, the way a frame is inset. */
const PAGE_RECT = { x: 0, y: 100, width: 1280, height: 700 };
const BLUE = { r: 0x1a, g: 0x73, b: 0xe8 };

type Px = { r: number; g: number; b: number };
const luma = (p: Px) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
const near = (p: Px, q: Px, tol: number) =>
  Math.abs(p.r - q.r) <= tol &&
  Math.abs(p.g - q.g) <= tol &&
  Math.abs(p.b - q.b) <= tol;
const show = (p: Px) => `rgb(${p.r}, ${p.g}, ${p.b})`;

function at(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number): Px {
  const [r, g, b] = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return { r: r as number, g: g as number, b: b as number };
}

function draw(card: DialogRecord, pressed = false) {
  const canvas = new OffscreenCanvas(1280, 800);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = show(PAGE);
  ctx.fillRect(0, 0, 1280, 800);
  drawDialogCard(ctx, card, PAGE_RECT, 1, pressed);
  return { ctx, layout: dialogCardLayout(ctx, card, PAGE_RECT, 1) };
}

/** A point inside OK's right padding at the button row's middle, from the
 *  card's fixed layout only: no glyph's width moves it. */
function okPoint(
  card: { x: number; y: number; width: number; height: number },
  s = 1,
) {
  const c = DIALOG_CARD;
  return {
    x: card.x + card.width - (c.padX + 1 + c.buttonPadX / 2) * s,
    y: card.y + card.height - (c.padBottom + c.buttonHeight / 2) * s,
  };
}

/** The darkest pixel in a region, by luma. */
function darkest(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): Px {
  const data = ctx.getImageData(Math.round(x), Math.round(y), w, h).data;
  let min: Px = { r: 255, g: 255, b: 255 };
  for (let i = 0; i < data.length; i += 4) {
    const p = {
      r: data[i] as number,
      g: data[i + 1] as number,
      b: data[i + 2] as number,
    };
    if (luma(p) < luma(min)) min = p;
  }
  return min;
}

beforeAll(async () => {
  const response = await fetch(geistUrl);
  expect(response.ok, `fetching ${geistUrl}: ${response.status}`).toBe(true);
  await loadDialogFont(await response.arrayBuffer());
});

describe("drawDialogCard", () => {
  it("premise: Geist is loaded", () => {
    expect(dialogFontLoaded()).toBe(true);
    expect(document.fonts.check(`15px ${DIALOG_FONT}`)).toBe(true);
  });

  it("a one-line confirm has the card's fixed height", () => {
    const { layout } = draw(confirm);
    const c = DIALOG_CARD;
    // Premise for every point sampled below: the message fits one line.
    expect(layout.lines).toEqual(["Delete Northwind?"]);
    expect(layout.card.height).toBeCloseTo(
      c.padTop +
        c.whoSize * c.lineHeight +
        c.whoGap +
        c.msgSize * c.lineHeight +
        c.msgGap +
        c.buttonHeight +
        c.padBottom,
      6,
    );
    expect(layout.card.x).toBe((1280 - c.width) / 2);
  });

  it("fills OK with Chrome's blue", () => {
    const { ctx, layout } = draw(confirm);
    const p = at(ctx, okPoint(layout.card).x, okPoint(layout.card).y);
    expect(near(p, BLUE, 12), `OK at ${show(p)}`).toBe(true);
  });

  it("sits at the top centre, flush under the page's top edge", () => {
    const { ctx } = draw(confirm);
    const above = at(ctx, 640, PAGE_RECT.y - 1);
    const inside = at(ctx, 640, PAGE_RECT.y + 2);
    expect(near(above, PAGE, 0), `row above the page: ${show(above)}`).toBe(
      true,
    );
    expect(inside, `row 2 into the card: ${show(inside)}`).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
    // Beyond the shadow's 28px blur, left of the card, the page is untouched.
    const left = at(ctx, (1280 - DIALOG_CARD.width) / 2 - 40, PAGE_RECT.y + 30);
    expect(near(left, PAGE, 2), `left of the card: ${show(left)}`).toBe(true);
  });

  it("draws Cancel on a confirm and none on an alert", () => {
    const region = (layout: ReturnType<typeof draw>["layout"]) => {
      const { x, y, width, height } = layout.card;
      const c = DIALOG_CARD;
      // From 75px left of the card's right padding (OK is narrower) to 200.
      return [
        x + width - c.padX - 200,
        y + height - c.padBottom - c.buttonHeight + 4,
        125,
        c.buttonHeight - 8,
      ] as const;
    };
    const withCancel = draw(confirm);
    const ink = darkest(withCancel.ctx, ...region(withCancel.layout));
    // Positive control: Cancel's border and label are in the region.
    expect(
      luma(ink),
      `confirm's Cancel region darkest ${show(ink)}`,
    ).toBeLessThan(220);
    const alert = draw({ ...confirm, kind: "alert", message: "Saved." });
    const blank = darkest(alert.ctx, ...region(alert.layout));
    expect(blank, `alert's Cancel region darkest ${show(blank)}`).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
  });

  it("darkens OK when pressed", () => {
    const up = draw(confirm);
    const down = draw(confirm, true);
    const a = at(up.ctx, okPoint(up.layout.card).x, okPoint(up.layout.card).y);
    const b = at(
      down.ctx,
      okPoint(down.layout.card).x,
      okPoint(down.layout.card).y,
    );
    expect(
      luma(a) - luma(b),
      `OK up ${show(a)}, pressed ${show(b)}`,
    ).toBeGreaterThanOrEqual(15);
  });

  it("draws a prompt's field holding the answered text", () => {
    const prompt: DialogRecord = {
      ...confirm,
      kind: "prompt",
      message: "Your name?",
      text: "Ada Lovelace",
    };
    const crop = (card: DialogRecord) => {
      const { ctx, layout } = draw(card);
      const field = layout.field;
      expect(field, "premise: a prompt has a field").not.toBeNull();
      if (field === null) throw new Error("no field");
      // Inside the field's border.
      return darkest(ctx, field.x + 4, field.y + 4, 120, field.height - 8);
    };
    const written = crop(prompt);
    expect(
      luma(written),
      `field with text, darkest ${show(written)}`,
    ).toBeLessThan(120);
    // Control: the ink is the text, not the field's border.
    const empty = crop({ ...prompt, text: "" });
    expect(empty, `empty field, darkest ${show(empty)}`).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
  });

  it("refuses to draw in another face when Geist is not loaded", () => {
    // TypeScript's DOM lib leaves out FontFaceSet's set-like members.
    const fonts = document.fonts as unknown as {
      forEach(each: (face: FontFace) => void): void;
      add(face: FontFace): unknown;
      delete(face: FontFace): boolean;
    };
    const geist: FontFace[] = [];
    fonts.forEach((face) => {
      if (face.family.replace(/"/g, "") === DIALOG_FONT) geist.push(face);
    });
    expect(geist.length, "premise: Geist faces to take away").toBeGreaterThan(
      0,
    );
    for (const face of geist) fonts.delete(face);
    try {
      expect(() => draw(confirm)).toThrow(/never drawn in another face/);
    } finally {
      for (const face of geist) fonts.add(face);
    }
    expect(dialogFontLoaded()).toBe(true);
  });

  it("says why a font that will not load did not", async () => {
    await expect(loadDialogFont(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      /the dialog card's font, Geist, did not load/,
    );
  });
});

describe("renderFrame's dialog card", () => {
  it("draws the card on a take whose cursor is off", async () => {
    const base = readonlyScene();
    const scene = {
      ...base,
      cursor: { ...base.cursor, hidden: true },
      actions: base.actions.map((a) =>
        a.id === "act-1" ? { ...a, dialogs: [confirm] } : a,
      ),
    };
    const bundle = proceduralBundle();
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    expect(resolved.cursorLook.hidden, "premise: no cursor").toBe(true);
    const [card] = resolved.dialogCards;
    if (card === undefined) throw new Error("premise: one card");
    const target = LANDSCAPE_1080P;
    const viewport = resolved.plan.viewport;
    const presentation = derivePresentation(scene.branding, target, viewport);

    const okAt = async (outputTimeMs: number) => {
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
      const camera = sceneCameraAt(
        resolved,
        presentation,
        target,
        outputTimeMs,
      );
      const { frameRect } = presentation;
      const pageRect = cssRectToOutput(
        { x: 0, y: 0, ...viewport },
        camera,
        frameRect,
        viewport,
      );
      const s = contentScale(frameRect, viewport) * camera.scale;
      const point = okPoint(
        dialogCardLayout(ctx, card.card, pageRect, s).card,
        s,
      );
      return at(ctx, point.x, point.y);
    };

    const during = await okAt(card.range.startMs + 100);
    expect(near(during, BLUE, 12), `OK during the hold: ${show(during)}`).toBe(
      true,
    );
    // Control: once the beat is over, the card is gone from the same spot.
    const after = await okAt(card.range.endMs + 100);
    expect(near(after, BLUE, 12), `same spot after: ${show(after)}`).toBe(
      false,
    );
  });
});
