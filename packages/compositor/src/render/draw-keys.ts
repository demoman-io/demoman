/**
 * The key and click marks (DEM-154/155), drawn from the mockup's `.pill`,
 * `.k`, `.tag` and `.mouse` rules
 * (`docs/superpowers/specs/assets/2026-11-21-inputs/index.html`, option K1).
 *
 * The pill is in screen space, bottom centre, sized by `target.width / 1280`
 * (the mockup's stage is 1280 wide): the camera never crops it. The tag and
 * the mouse ride with the pointer, sized as it is.
 *
 * Text is Geist and nothing else, as the dialog card's is: a mark drawn in a
 * fallback face would differ between machines, so one throws instead.
 */
import type { Vec } from "../geometry.js";
import type { KeyCap } from "../plan/key-marks.js";
import { CURSOR_ART } from "./draw-cursor.js";
import { DIALOG_FONT, dialogFontLoaded } from "./draw-dialog.js";
import { KEY_GLYPHS } from "./key-glyphs.js";
import type { RenderTarget } from "./target.js";

/** The mockup's `.pill` and `.k`, in its 1280-wide stage's px. */
export const KEYCAP_PILL = {
  bottom: 58,
  padY: 10,
  padX: 14,
  gap: 6,
  radius: 14,
  cap: 44,
  capPadX: 12,
  capRadius: 10,
  capText: 21,
  suffixText: 18,
  suffixPadX: 4,
} as const;

/** The mockup draws a 32px pointer; ours is `CURSOR_ART`'s 40 at a ui
 *  scale of 1. The tag and mouse keep the mockup's size against it. */
const POINTER_UNIT = CURSOR_ART.light.height / 32;

/** The mockup's `.tag` and `.mouse`, placed against the pointer's tip. */
const TAG = { dx: 44, dy: 33, text: 15, padX: 9, padY: 4, radius: 7 };
const MOUSE = {
  dx: 30,
  dy: 25,
  width: 26,
  height: 38,
  border: 2.5,
  radius: 13,
};
const INK = "#18181b";
const BLUE = "#1a73e8";

function requireFont(): void {
  if (!dialogFontLoaded()) {
    throw new Error(
      `the video's text needs the font ${DIALOG_FONT}, which is not loaded (loadDialogFont); it is never drawn in another face`,
    );
  }
}

/** The pill's outer rect in output px, and each cap's (and the suffix's). */
export function keycapPillLayout(
  ctx: OffscreenCanvasRenderingContext2D,
  caps: readonly KeyCap[],
  suffix: string | undefined,
  target: Pick<RenderTarget, "width" | "height">,
) {
  const p = KEYCAP_PILL;
  const s = target.width / 1280;
  ctx.font = `500 ${p.capText * s}px ${DIALOG_FONT}`;
  const widths = caps.map((cap) =>
    "glyph" in cap
      ? p.cap * s
      : Math.max(
          p.cap * s,
          ctx.measureText(cap.text).width + 2 * p.capPadX * s,
        ),
  );
  ctx.font = `400 ${p.suffixText * s}px ${DIALOG_FONT}`;
  const suffixWidth =
    suffix === undefined
      ? 0
      : ctx.measureText(suffix).width + 2 * p.suffixPadX * s;
  const items = widths.length + (suffix === undefined ? 0 : 1);
  const width =
    2 * p.padX * s +
    widths.reduce((a, b) => a + b, 0) +
    suffixWidth +
    Math.max(0, items - 1) * p.gap * s;
  const height = (2 * p.padY + p.cap) * s;
  const pill = {
    x: (target.width - width) / 2,
    y: target.height - p.bottom * s - height,
    width,
    height,
  };
  let x = pill.x + p.padX * s;
  const top = pill.y + p.padY * s;
  const capRects = widths.map((w) => {
    const rect = { x, y: top, width: w, height: p.cap * s };
    x += w + p.gap * s;
    return rect;
  });
  const suffixRect =
    suffix === undefined
      ? null
      : { x, y: top, width: suffixWidth, height: p.cap * s };
  return { pill, caps: capRects, suffix: suffixRect, scale: s };
}

/** One pill of keycaps at the bottom centre of the output, at `alpha`. */
export function drawKeycapPill(
  ctx: OffscreenCanvasRenderingContext2D,
  caps: readonly KeyCap[],
  suffix: string | undefined,
  target: Pick<RenderTarget, "width" | "height">,
  alpha: number,
): void {
  requireFont();
  const p = KEYCAP_PILL;
  ctx.save();
  const layout = keycapPillLayout(ctx, caps, suffix, target);
  const s = layout.scale;
  ctx.globalAlpha *= alpha;
  const { pill } = layout;
  ctx.beginPath();
  ctx.roundRect(pill.x, pill.y, pill.width, pill.height, p.radius * s);
  ctx.fillStyle = "rgba(17, 17, 17, 0.8)"; // #111c
  ctx.fill();

  caps.forEach((cap, i) => {
    const r = layout.caps[i];
    if (r === undefined) return;
    const shape = () => {
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.width, r.height, p.capRadius * s);
    };
    shape();
    ctx.fillStyle = "rgba(255, 255, 255, 0.122)"; // #ffffff1f
    ctx.fill();
    // `box-shadow: inset 0 -2px 0 #0006`: the cap less itself raised 2px,
    // clipped to the cap, which leaves a band along its bottom edge.
    ctx.save();
    shape();
    ctx.clip();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.roundRect(r.x, r.y - 2 * s, r.width, r.height, p.capRadius * s);
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fill("evenodd");
    ctx.restore();

    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if ("glyph" in cap) {
      const glyph = KEY_GLYPHS[cap.glyph];
      // Lucide's 24-unit box at 60% of the cap's height, its 2-unit stroke.
      const unit = (0.6 * r.height) / 24;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(glyph.mirrored ? -unit : unit, unit);
      ctx.translate(-12, -12);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#ffffff";
      for (const d of glyph.paths) ctx.stroke(new Path2D(d));
      ctx.restore();
    } else {
      ctx.font = `500 ${p.capText * s}px ${DIALOG_FONT}`;
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(cap.text, cx, cy);
    }
  });

  if (suffix !== undefined && layout.suffix !== null) {
    const r = layout.suffix;
    ctx.globalAlpha *= 0.8;
    ctx.font = `400 ${p.suffixText * s}px ${DIALOG_FONT}`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(suffix, r.x + r.width / 2, r.y + r.height / 2);
  }
  ctx.restore();
}

/** Where the ×2/×3 tag sits against the pointer's tip `at`, in output px. */
export function clickTagRect(
  ctx: OffscreenCanvasRenderingContext2D,
  at: Vec,
  count: 2 | 3,
  uiScale: number,
) {
  const k = uiScale * POINTER_UNIT;
  ctx.font = `500 ${TAG.text * k}px ${DIALOG_FONT}`;
  return {
    x: at.x + TAG.dx * k,
    y: at.y + TAG.dy * k,
    width: ctx.measureText(`×${count}`).width + 2 * TAG.padX * k,
    // Geist's normal line height is about 1.2 em.
    height: (TAG.text * 1.2 + 2 * TAG.padY) * k,
  };
}

/** The ×2/×3 tag beside a multi-click's ripples. */
export function drawClickTag(
  ctx: OffscreenCanvasRenderingContext2D,
  at: Vec,
  count: 2 | 3,
  uiScale: number,
  alpha: number,
): void {
  requireFont();
  ctx.save();
  ctx.globalAlpha *= alpha;
  const r = clickTagRect(ctx, at, count, uiScale);
  const k = uiScale * POINTER_UNIT;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.width, r.height, TAG.radius * k);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`×${count}`, r.x + r.width / 2, r.y + r.height / 2);
  ctx.restore();
}

/** The mouse's outer rect against the pointer's tip `at`, in output px. */
export function rightClickMouseRect(at: Vec, uiScale: number) {
  const k = uiScale * POINTER_UNIT;
  return {
    x: at.x + MOUSE.dx * k,
    y: at.y + MOUSE.dy * k,
    width: MOUSE.width * k,
    height: MOUSE.height * k,
  };
}

/** A small mouse with its right button lit, by the pointer. No text. */
export function drawRightClickMouse(
  ctx: OffscreenCanvasRenderingContext2D,
  at: Vec,
  uiScale: number,
  alpha: number,
): void {
  const k = uiScale * POINTER_UNIT;
  const o = rightClickMouseRect(at, uiScale);
  const b = MOUSE.border * k;
  const inner = {
    x: o.x + b,
    y: o.y + b,
    width: o.width - 2 * b,
    height: o.height - 2 * b,
  };
  ctx.save();
  ctx.globalAlpha *= alpha;
  // The border is the outer shape in ink, under `0 3px 10px #0003`.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.2)";
  ctx.shadowBlur = 10 * k;
  ctx.shadowOffsetY = 3 * k;
  ctx.beginPath();
  ctx.roundRect(o.x, o.y, o.width, o.height, MOUSE.radius * k);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.restore();
  // `overflow: hidden`: the button and divider stay inside the body.
  ctx.beginPath();
  ctx.roundRect(
    inner.x,
    inner.y,
    inner.width,
    inner.height,
    (MOUSE.radius - MOUSE.border) * k,
  );
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(inner.x, inner.y, inner.width, inner.height);
  const mid = inner.x + inner.width / 2;
  const buttonHeight = inner.height * 0.45;
  ctx.fillStyle = BLUE;
  ctx.fillRect(mid, inner.y, inner.width / 2, buttonHeight);
  ctx.fillStyle = INK;
  ctx.fillRect(mid - k, inner.y, 2 * k, buttonHeight);
  ctx.restore();
}
