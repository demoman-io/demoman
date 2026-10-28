import {
  NEUTRAL_BACKGROUND,
  type SceneBackground,
  type SceneBranding,
  type SceneLogo,
} from "@demoman/scene-schema";
import { containRect, type Rect, type Vec } from "../geometry.js";
import type { FrameImage } from "../ports/types.js";
import type { RenderTarget } from "./target.js";

export interface LogoPlacement {
  rect: Rect;
  /** What the logo is actually drawn at, as a fraction of the shorter side.
   *  0 when the margin has no room for any legal size. */
  effectiveSize: number;
  /** True whenever `effectiveSize` is less than the authored size. */
  capped: boolean;
}

export interface PlacedLogo {
  image: FrameImage;
  opacity: number;
  rect: Rect;
}

/** The smallest logo the schema allows; below it, a mark is not drawn. */
const MIN_LOGO_SIZE = 0.02;

/**
 * Where the logo goes: in its corner, inset by `min(w, h) × 0.02`, and
 * never over the recording. The mark lives in the background margin; when
 * the authored size would reach `frameRect` it is drawn at the largest size
 * that clears it, and `capped` says so — spec §2. The stored size is not
 * changed: the same mark may fit in another format.
 *
 * It clears the frame by fitting EITHER in the band above/below the frame
 * OR in the band beside it, whichever allows the larger mark, and never
 * runs off the frame's own edge.
 */
export function placeLogo(
  logo: SceneLogo,
  aspect: number,
  target: RenderTarget,
  frameRect: Rect,
): LogoPlacement {
  const short = Math.min(target.width, target.height);
  const margin = short * 0.02;
  const top = logo.corner.startsWith("top");
  const left = logo.corner.endsWith("left");
  const bandV =
    (top ? frameRect.y : target.height - (frameRect.y + frameRect.height)) -
    margin;
  const bandH =
    (left ? frameRect.x : target.width - (frameRect.x + frameRect.width)) -
    margin;
  // In the band above or below, the mark's height is what the band limits,
  // but its width still has to fit the frame: a 12:1 wordmark sized to a
  // 21:9 recording's tall band ran off the side. (Beside the recording the
  // mirror case cannot arise — a mark is at most 0.2 of the short side,
  // which is always inside the frame's height less its margins.)
  const fitAboveOrBelow = Math.min(bandV, (target.width - 2 * margin) / aspect);
  const maxHeight = Math.max(fitAboveOrBelow, bandH / aspect, 0);
  const wanted = logo.size * short;
  // Float noise only, as with the minimum below: at the default 8% padding
  // the band is exactly the upload default, and 64.79999… of 64.8 px — or
  // 24.29999… of 24.3 at a 720px preview — must draw at the authored size,
  // not report a cap. A billionth of the short side is no overlap anyone
  // could see.
  const fitsAsAuthored = maxHeight >= wanted - short * 1e-9;
  const height = fitsAsAuthored ? wanted : maxHeight;
  // The guard is for float noise only: a band that is exactly the minimum
  // must not read as below it. It is not a tolerance on the cap.
  const effectiveSize =
    height / short < MIN_LOGO_SIZE - 1e-9 ? 0 : height / short;
  const drawn = effectiveSize * short;
  const width = drawn * aspect;
  return {
    rect: {
      x: left ? margin : target.width - margin - width,
      y: top ? margin : target.height - margin - drawn,
      width,
      height: drawn,
    },
    effectiveSize,
    // Decided from the comparison that caused it, not by round-tripping
    // the size: (size * short) / short is float-lossy at the editor's 720px
    // preview, and 0.06 came back as 0.0599…, reporting a cap on a logo
    // that fit.
    capped: effectiveSize === 0 || !fitsAsAuthored,
  };
}

export interface Presentation {
  background: SceneBackground;
  cornerRadius: number;
  frameRect: Rect;
  /** The branding's padding, as drawn. 0 is full screen: the frame meets
   *  the canvas on its tight axis, with square corners and no shadow. */
  padding: number;
  /** What gets drawn, or null: no logo, no decoded image yet, or no room. */
  logo: PlacedLogo | null;
  /** Where the authored logo lands for this target, whenever there is one
   *  and its image is decoded (the aspect comes from the image). The panel
   *  reads `capped` from here to say when the mark was shrunk. */
  logoPlacement: LogoPlacement | null;
}

/** The pixel height to rasterise a logo at for `target`: the authored
 *  size, which the cap only ever shrinks from. 0 with no logo. */
export function logoRasterHeight(
  branding: SceneBranding,
  target: RenderTarget,
): number {
  if (branding.logo === null) return 0;
  return Math.ceil(branding.logo.size * Math.min(target.width, target.height));
}

/**
 * The presented frame: the authored background, with the app inset on it,
 * rounded and shadowed. Paints `branding` as stored — since schema v6 there
 * is no derived tint and no fallback: a document always carries a background
 * (`BRANDING_DEFAULTS` is an ordinary gradient), so there is no "nothing
 * set" branch to fall through silently.
 */
export function derivePresentation(
  branding: SceneBranding,
  target: RenderTarget,
  viewport: { width: number; height: number },
  logo: FrameImage | null = null,
): Presentation {
  const pad = Math.min(target.width, target.height) * branding.padding;
  const box = {
    x: pad,
    y: pad,
    width: target.width - pad * 2,
    height: target.height - pad * 2,
  };
  // A box whose shape is the recording's to within its own rounding IS the
  // recording's shape. Integer frame sides cannot match every recording, so
  // the Auto frame — its short side S rounded to even — is a hair off it,
  // by up to 1/S in aspect. `contain` then fell short of the box by up to
  // `aspect` pixels on one axis, the recording was drawn from a fractional
  // edge, and the background blended into the edge columns: a hairline down
  // both sides at padding 0, in the editor and in the file (reported
  // 2026-10-06). Snapped, the recording covers the box (`contentScale` takes
  // the larger factor) and the clip trims what overhangs — at most a pixel
  // or two of page. 1.5/S, not 1/S, so a rounding at the bound still snaps.
  //
  // Only an Auto frame (`shapedToRecording`). The tolerance is a pixel at
  // the target's own size, so on a fixed preset a near fit — 1280x721 in
  // 16:9 — snapped in the 720 preview and kept its bars in the 4K file: the
  // author scrubbed a clean edge and exported hairlines (review, 2026-10-06).
  // A preset draws its contain fit at every size, bars and all, so the
  // preview and the file agree. An Auto frame snaps at every size, since
  // its gap is rounding at every size.
  const shortSide = Math.min(box.width, box.height);
  const aspectOff = Math.abs(
    box.width / box.height / (viewport.width / viewport.height) - 1,
  );
  const snapped =
    target.shapedToRecording === true &&
    shortSide > 0 &&
    aspectOff <= 1.5 / shortSide;
  const frameRect =
    target.fit === "cover" || snapped ? box : containRect(viewport, box);
  const spec = branding.logo;
  const placed =
    spec !== null && logo !== null
      ? placeLogo(spec, logo.width / logo.height, target, frameRect)
      : null;
  // Padding 0 is full screen, and full screen carries no logo — even where a
  // capture of another shape leaves bars a mark would fit in (the author's
  // call, 2026-10-06). Reported as no room, so the panel says why it is gone.
  const logoPlacement =
    placed !== null && branding.padding === 0
      ? {
          rect: { ...placed.rect, width: 0, height: 0 },
          effectiveSize: 0,
          capped: true,
        }
      : placed;
  return {
    background: branding.background,
    // At 0 the frame meets the canvas edge, where a radius would cut the
    // recording's corners away and show background in their place.
    cornerRadius: branding.padding === 0 ? 0 : target.cornerRadius,
    frameRect,
    padding: branding.padding,
    logo:
      spec !== null &&
      logo !== null &&
      logoPlacement !== null &&
      logoPlacement.effectiveSize > 0
        ? { image: logo, opacity: spec.opacity, rect: logoPlacement.rect }
        : null,
    logoPlacement,
  };
}

/**
 * Output pixels per CSS pixel at camera scale 1 — the factor everything that
 * transforms into the frame has to agree on.
 *
 * The *larger* factor is the one that fills. Under `cover` the aspects
 * differ on purpose, and taking the width would leave the frame short on the
 * other axis — the letterbox this mode exists to avoid. Under `contain` the
 * frame has the capture's aspect, so both axes agree — except when
 * `derivePresentation` snapped a fit within a pixel of its box to the box,
 * where the larger factor is what keeps the recording over the frame's edge.
 * So the answer never depends on `fit`, and it is not asked for: the frame
 * rect already carries the difference.
 */
export function contentScale(
  frameRect: Rect,
  viewport: { width: number; height: number },
): number {
  return Math.max(
    frameRect.width / viewport.width,
    frameRect.height / viewport.height,
  );
}

/**
 * Output pixels → CSS viewport coordinates. The strict inverse of
 * `cssToOutput`.
 *
 * Mask authoring needs this: the author drags a rectangle on a preview
 * canvas and the document stores capture-space CSS. Inverting the camera by
 * hand in the editor would be a second implementation of geometry this
 * package already owns, drifting against the first the moment either moves —
 * and the failure would be a mask that renders somewhere other than where it
 * was drawn, which is the one bug a redaction feature must never have.
 */
export function outputToCss(
  point: Vec,
  camera: { center: Vec; scale: number },
  frameRect: Rect,
  viewport: { width: number; height: number },
): Vec {
  const k = contentScale(frameRect, viewport) * camera.scale;
  return {
    x: camera.center.x + (point.x - (frameRect.x + frameRect.width / 2)) / k,
    y: camera.center.y + (point.y - (frameRect.y + frameRect.height / 2)) / k,
  };
}

export function outputRectToCss(
  rect: Rect,
  camera: { center: Vec; scale: number },
  frameRect: Rect,
  viewport: { width: number; height: number },
): Rect {
  const origin = outputToCss(
    { x: rect.x, y: rect.y },
    camera,
    frameRect,
    viewport,
  );
  const k = contentScale(frameRect, viewport) * camera.scale;
  return {
    x: origin.x,
    y: origin.y,
    width: rect.width / k,
    height: rect.height / k,
  };
}

/**
 * Where a CSS `linear-gradient(<angle>deg, …)` puts its start and end on a
 * `width` × `height` box: a line through the centre, in the angle's
 * direction (0 = up, clockwise), long enough that the corners land exactly
 * on 0 and 1 (CSS Images 3 §3.1.1).
 */
export function gradientLine(
  angle: number,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const cx = width / 2;
  const cy = height / 2;
  return {
    x0: cx - dx * half,
    y0: cy - dy * half,
    x1: cx + dx * half,
    y1: cy + dy * half,
  };
}

const neutralGradient = NEUTRAL_BACKGROUND as Extract<
  SceneBackground,
  { kind: "gradient" }
>;

export function drawBackground(
  ctx: OffscreenCanvasRenderingContext2D,
  target: RenderTarget,
  presentation: Presentation,
): void {
  const bg = presentation.background;
  if (bg.kind === "solid") {
    ctx.fillStyle = bg.color;
  } else {
    // Task 3 paints wallpaper and image; until then they draw the neutral.
    const g = bg.kind === "gradient" ? bg : neutralGradient;
    const { x0, y0, x1, y1 } = gradientLine(
      g.angle,
      target.width,
      target.height,
    );
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, g.from);
    gradient.addColorStop(1, g.to);
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, target.width, target.height);
}

function framePath(
  ctx: OffscreenCanvasRenderingContext2D,
  presentation: Presentation,
): void {
  const { frameRect: r, cornerRadius } = presentation;
  const radius = Math.min(cornerRadius, r.width / 2, r.height / 2);
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.width, r.height, radius);
}

/**
 * Two shadow passes: a tight contact shadow that seats the frame, and a wide
 * soft one that lifts it off the background. One pass reads as a sticker.
 *
 * Known approximation: the pass sizes come off `frameRect.height / 800`, i.e.
 * they read the frame's height as if it corresponded to an 800 px viewport.
 * That holds under `contain`; under `cover` the frame carries the target's
 * aspect instead, so `VERTICAL_1080`'s 1747.2 px frame blurs ~131 px at an
 * 8% padding's 86 px margin and the wide pass is largely clipped by the canvas edge. It still
 * reads — the contact pass seats the frame — so this is cosmetic, and it is
 * recorded in the README's limitations rather than fixed here. The principled
 * version scales off the padded margin, which is the room the shadow has.
 *
 * `zoom` is the camera scale the context is transformed by. Canvas shadows
 * are drawn in device pixels and ignore the transform, so without it the
 * shadow would stay its 1:1 size under a window the camera had grown.
 */
export function drawFrameChrome(
  ctx: OffscreenCanvasRenderingContext2D,
  presentation: Presentation,
  zoom: number,
): void {
  // Full screen has nothing to lift the frame off: at 0 the shadow would
  // only darken the bars a capture of another shape leaves at the sides.
  if (presentation.padding === 0) return;
  const scale = (presentation.frameRect.height / 800) * zoom;
  const passes = [
    { blur: 60 * scale, offset: 30 * scale, alpha: 0.18 },
    { blur: 12 * scale, offset: 4 * scale, alpha: 0.12 },
  ];
  for (const pass of passes) {
    ctx.save();
    ctx.shadowColor = `rgba(15, 23, 42, ${pass.alpha})`;
    ctx.shadowBlur = pass.blur;
    ctx.shadowOffsetY = pass.offset;
    ctx.fillStyle = "#000000";
    framePath(ctx, presentation);
    ctx.fill();
    ctx.restore();
  }
}

/** Clips subsequent drawing to the rounded app frame. Caller must save/restore. */
export function clipToFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  presentation: Presentation,
): void {
  framePath(ctx, presentation);
  ctx.clip();
}

export function drawLogo(
  ctx: OffscreenCanvasRenderingContext2D,
  _target: RenderTarget,
  presentation: Presentation,
): void {
  const logo = presentation.logo;
  if (!logo) return;
  const { rect } = logo;
  ctx.save();
  ctx.globalAlpha = logo.opacity;
  ctx.drawImage(logo.image.image, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}
