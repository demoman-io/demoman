import {
  autoTarget,
  derivePresentation,
  drawBackground,
  drawLogo,
  type FrameImage,
  LANDSCAPE_1080P,
  type LogoPlacement,
  type RenderTarget,
} from "@demoman/compositor";
import { BrandingSchema, type SceneBranding } from "@demoman/scene-schema";

/**
 * The Brand kit preview's tier: landscape's, at a 480-wide working size. The
 * corner radius scales with the width.
 */
const KIT_TIER: RenderTarget = {
  ...LANDSCAPE_1080P,
  width: 480,
  height: 270,
  cornerRadius: (LANDSCAPE_1080P.cornerRadius * 480) / LANDSCAPE_1080P.width,
};

/** The recording the preview stands in for: the editor's default capture. */
export const KIT_VIEWPORT = { width: 1280, height: 800 };

/**
 * The Brand kit preview's frame: the Auto frame every new take starts on
 * (2026-10-06), for the kit's own padding, drawn by `derivePresentation` —
 * so the kit, its margin and its logo's cap are previewed the way a new
 * take frames them. It was a fixed 16:9 frame until then, which showed side
 * bars at padding 0 and capped a logo against bands no new take has.
 */
export function kitPreviewTarget(padding: number): RenderTarget {
  return autoTarget(KIT_TIER, KIT_VIEWPORT, padding);
}

const PADDING_CEILING = BrandingSchema.shape.padding.maxValue;
if (PADDING_CEILING === null) {
  throw new Error(
    "BrandingSchema's padding has no ceiling to size the preview by",
  );
}

/**
 * The preview canvas's own size, whatever the padding: the tallest Auto frame
 * the padding range makes, which is the frame at its ceiling. The frame
 * itself follows the padding and is painted at the top of this box. A canvas
 * resized to the frame grew under the pointer during a Padding drag and slid
 * the slider and everything below it down mid-gesture (review, 2026-10-06).
 * Also the size the logo is rasterised for, so mid-drag it is only ever
 * drawn smaller than its raster.
 */
export const KIT_PREVIEW_BOX: RenderTarget = kitPreviewTarget(PADDING_CEILING);

/** Where the kit's logo lands on the preview, for the panel's cap note. */
export function kitPlacement(
  branding: SceneBranding,
  logo: FrameImage | null,
): LogoPlacement | null {
  return derivePresentation(
    branding,
    kitPreviewTarget(branding.padding),
    KIT_VIEWPORT,
    logo,
  ).logoPlacement;
}

/**
 * Paints the kit onto `canvas`: the background, a plain card standing in
 * for the recording, and the logo — with the compositor's own painters, so
 * the preview is what an export draws. The canvas holds `KIT_PREVIEW_BOX`'s
 * size and the frame, whose shape follows the padding, is painted at its
 * top with `outerRadius` corners; the rest of the box is left clear.
 * Returns false when there was no 2D context to paint with, so the caller
 * can say the preview is not drawing.
 */
export function paintKitPreview(
  canvas: HTMLCanvasElement,
  branding: SceneBranding,
  logo: FrameImage | null,
  cardColour: string,
  outerRadius = 0,
): boolean {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return false;
  const box = KIT_PREVIEW_BOX;
  if (canvas.width !== box.width) canvas.width = box.width;
  if (canvas.height !== box.height) canvas.height = box.height;
  const target = kitPreviewTarget(branding.padding);
  ctx.clearRect(0, 0, box.width, box.height);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, target.width, target.height, outerRadius);
  ctx.clip();
  // The compositor's painters are typed for OffscreenCanvas; the 2D API
  // they use is the same on a DOM canvas.
  const paint2d = ctx as unknown as OffscreenCanvasRenderingContext2D;
  const presentation = derivePresentation(branding, target, KIT_VIEWPORT, logo);
  drawBackground(paint2d, target, presentation);
  const r = presentation.frameRect;
  ctx.save();
  ctx.fillStyle = cardColour;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.width, r.height, presentation.cornerRadius);
  ctx.fill();
  ctx.restore();
  drawLogo(paint2d, target, presentation);
  ctx.restore();
  return true;
}
