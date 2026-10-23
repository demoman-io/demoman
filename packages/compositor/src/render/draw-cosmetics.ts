import type { Rect } from "../geometry.js";
import type { ResolvedCosmetic } from "../plan/resolve.js";

const MASK_FILL = "#4b5563";

/**
 * Masks are opaque fills. Never blur: a blur is statistically reversible,
 * and v8's data posture requires redacted material not to survive redaction.
 */
export function drawMask(
  ctx: OffscreenCanvasRenderingContext2D,
  rect: Rect,
): void {
  ctx.save();
  ctx.fillStyle = MASK_FILL;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

export function drawCosmetics(
  ctx: OffscreenCanvasRenderingContext2D,
  cosmetics: ResolvedCosmetic[],
  toOutput: (rect: Rect) => Rect,
): void {
  for (const cosmetic of cosmetics) drawMask(ctx, toOutput(cosmetic.rect));
}
