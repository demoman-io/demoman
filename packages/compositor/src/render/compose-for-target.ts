import { BRANDING_DEFAULTS, type SceneDocument } from "@demoman/scene-schema";
import type { FrameBundle } from "../bundle.js";
import type { Rect } from "../geometry.js";
import {
  type ResolvedPlan,
  resolveCameraFollow,
  resolvePlan,
} from "../plan/resolve.js";
import type { TimeSpan } from "../plan/timeline.js";
import type { RenderPlan } from "../plan/types.js";
import type { FrameImage } from "../ports/types.js";
import { clampToSourceDetail, type DetailViolation } from "./detail.js";
import {
  contentScale,
  derivePresentation,
  type Presentation,
} from "./presentation.js";
import { cameraIntentsForTarget, type RenderTarget } from "./target.js";

export interface Composition {
  /** The plan as this target draws it: camera keys already cut to source detail. */
  resolved: ResolvedPlan;
  presentation: Presentation;
  /** Every zoom the source frames could not back. See `clampToSourceDetail`. */
  violations: DetailViolation[];
}

/** The plan a target actually renders: same plan, target-appropriate camera. */
function framedPlan(plan: RenderPlan, target: RenderTarget): RenderPlan {
  const cameraIntents = cameraIntentsForTarget(target, plan.cameraIntents);
  return cameraIntents === plan.cameraIntents
    ? plan
    : { ...plan, cameraIntents };
}

/**
 * The CSS px a `cover` frame shows at camera scale 1 — its crop — or null
 * for `contain`, whose frame shows the whole viewport.
 *
 * Every zoom in a `cover` render is fitted to this (`solveCamera`). The
 * zooms a take carries were fitted against the capture viewport when it was
 * made (`zoomsForClicks`, 2026-10-01), and a 9:16 crop is a fraction of that
 * width: a 900x552 capture shows 310 CSS px across, 270 at the vertical cap.
 * Measured from the deliverable's frame (`detailFrame`), for the reason the
 * detail clamp is: a preview of another size frames identically.
 *
 * Not for `contain`. Its window is the viewport, which the generated zooms
 * were already fitted to, and a zoom placed in the editor keeps the scale
 * its author chose; under `cover` the vertical cap overrides that scale
 * already, and this only lowers it further toward 1.
 */
function coverWindow(
  target: RenderTarget,
  frameRect: Rect,
  viewport: { width: number; height: number },
): { width: number; height: number } | null {
  if (target.fit !== "cover") return null;
  const k = contentScale(frameRect, viewport);
  return { width: frameRect.width / k, height: frameRect.height / k };
}

/**
 * Everything between a plan and the first drawn frame, for one target.
 *
 * This used to be inlined in `renderScene`, and the editor's preview
 * re-implemented the front half of it — `resolvePlan` — and stopped there.
 * The half it left out was the detail clamp, so a 1.8x zoom on a 1280-px
 * capture rendered at 4K was cut to ~1.23x with a violation on the record
 * while the preview scrubbed the full 1.8x: the framing you scrub was not
 * the framing you got, which is the one promise the preview exists to
 * keep. One function now, called by the render loop, the stills and the
 * preview alike, so there is no second copy to fall behind.
 *
 * The vertical cap is applied here, not by the caller: a `cover` target's
 * crop is already ~2.29x of magnification and the landscape zoom track
 * would compound with it. See `cameraIntentsForTarget`.
 *
 * Presentation first: the clamp needs the width the app is actually drawn
 * across — the inset, aspect-fitted frame rect, not the target's full
 * width.
 *
 * `detailTarget` is the target the clamp measures against, when that is not
 * the one being drawn. The editor's preview draws a bitmap whose height
 * follows the window and flips on every play and pause; clamped against
 * that, one 1.8x zoom scrubbed at ~1.44x parked and larger playing, and
 * neither was the deliverable's. Camera scale is a fraction of the frame, so
 * keys cut for the deliverable frame the preview identically.
 */
export function composeForTarget(args: {
  plan: RenderPlan;
  bundle: FrameBundle;
  scene?: SceneDocument;
  target: RenderTarget;
  /** The target the detail clamp measures against. Defaults to `target`. */
  detailTarget?: RenderTarget;
  /** Keyframe-diff motion, from `detectKeyframeMotion`. */
  hints?: TimeSpan[];
  logo?: FrameImage | null;
  /** The decoded wallpaper or uploaded image (`wallpaperRasterSize`). */
  wallpaper?: FrameImage | null;
}): Composition {
  const {
    plan,
    bundle,
    scene,
    target,
    hints,
    logo = null,
    wallpaper = null,
  } = args;
  const detailTarget = args.detailTarget ?? target;
  const presentation = derivePresentation(
    scene?.branding ?? BRANDING_DEFAULTS,
    target,
    plan.viewport,
    logo,
    wallpaper,
  );
  const detailFrame =
    detailTarget === target
      ? presentation.frameRect
      : derivePresentation(
          scene?.branding ?? BRANDING_DEFAULTS,
          detailTarget,
          plan.viewport,
          logo,
        ).frameRect;
  const resolved = resolvePlan(
    framedPlan(plan, target),
    bundle,
    scene,
    hints,
    coverWindow(target, detailFrame, plan.viewport),
  );
  const detail = clampToSourceDetail({
    keys: resolved.cameraKeys,
    timeline: resolved.timeline,
    bundle,
    outputPxPerCssPx: contentScale(detailFrame, plan.viewport),
    viewport: plan.viewport,
  });
  return {
    resolved: {
      ...resolved,
      cameraKeys: detail.keys,
      cameraFollow: resolveCameraFollow({
        keys: detail.keys,
        plan: resolved.plan,
        bundle,
        timeline: resolved.timeline,
        cursor: resolved.cursor,
        motion: resolved.motion,
        drawsPointer: !resolved.touch && !resolved.cursorLook.hidden,
      }),
    },
    presentation,
    violations: detail.violations,
  };
}
