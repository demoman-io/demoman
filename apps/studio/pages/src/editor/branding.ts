import {
  NEUTRAL_BACKGROUND,
  type SceneBackground,
  type SceneBranding,
  type SceneLogo,
} from "@demoman/scene-schema";

/** The three placement fields the panel adjusts one at a time. */
export type LogoAdjust = Partial<
  Pick<SceneLogo, "corner" | "size" | "opacity">
>;

/**
 * A gradient's own controls, one at a time: a colour, the angle, or Swap.
 * An adjustment rather than a whole background because a whole background
 * carries the fields the control did NOT touch as they were when it was
 * drawn — the Settings page, which commits before its re-render lands,
 * stored a Swap at the angle from before the Angle change it followed.
 */
export type GradientAdjust = Partial<
  Pick<Extract<SceneBackground, { kind: "gradient" }>, "from" | "to" | "angle">
> & { swap?: true };

/**
 * One branding edit. `background` replaces the background whole — a solid
 * and a gradient share no fields worth merging, so switching between them
 * is the one edit that does. `gradient` adjusts the gradient in place.
 * `logo` is a whole logo (it carries a `ref`: an upload, a replace, or
 * Reset to brand kit), `null` (Remove), or an adjustment of an existing one.
 */
export interface BrandingPatch {
  background?: SceneBackground;
  gradient?: GradientAdjust;
  logo?: SceneLogo | null | LogoAdjust;
  /** The margin, whole (spec 2026-10-05 §5). */
  padding?: number;
}

/**
 * The one merge rule, shared by the `setBranding` command and the live
 * preview so what the author drags is what the commit stores.
 */
export function applyBrandingPatch(
  branding: SceneBranding,
  patch: BrandingPatch,
): SceneBranding {
  let logo = branding.logo;
  if (patch.logo === null) logo = null;
  else if (patch.logo !== undefined) {
    if ("ref" in patch.logo) logo = patch.logo as SceneLogo;
    else if (logo === null)
      throw new Error("there is no logo to adjust — upload one first");
    else logo = { ...logo, ...patch.logo };
  }
  let background = patch.background ?? branding.background;
  if (patch.gradient !== undefined) {
    // Task 6 gives wallpaper and image their own controls; until then the
    // panel shows them as the neutral gradient, so a gradient edit starts there.
    if (background.kind === "wallpaper" || background.kind === "image")
      background = NEUTRAL_BACKGROUND;
    if (background.kind !== "gradient")
      throw new Error("the background is not a gradient any more");
    const { swap, ...fields } = patch.gradient;
    if (swap)
      background = { ...background, from: background.to, to: background.from };
    background = { ...background, ...fields };
  }
  return {
    ...branding,
    background,
    logo,
    padding: patch.padding ?? branding.padding,
  };
}

/** Key order aside, every field equal (backgrounds are flat records). */
export function sameBackground(a: object, b: object): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return (
    keys.length === Object.keys(y).length && keys.every((k) => x[k] === y[k])
  );
}

/**
 * Whether two brandings paint the same thing. Field by field rather than by
 * identity or JSON: a patch always builds a new object, and a kit's
 * background may carry its keys in another order than the one it replaces.
 * Colours compare as stored — the schema holds canonical lower-case hex.
 */
export function sameBranding(a: SceneBranding, b: SceneBranding): boolean {
  if (a.padding !== b.padding) return false;
  const bgA = a.background;
  const bgB = b.background;
  if (!sameBackground(bgA, bgB)) return false;
  if (a.logo === null || b.logo === null) return a.logo === b.logo;
  return (
    a.logo.ref === b.logo.ref &&
    a.logo.corner === b.logo.corner &&
    a.logo.size === b.logo.size &&
    a.logo.opacity === b.logo.opacity
  );
}

/** A control mid-gesture, and the document it was taken against. */
export interface BrandingPreview<Scene extends { branding: SceneBranding }> {
  patch: BrandingPatch;
  scene: Scene;
}

/**
 * What the frame should be drawn with, and the preview to keep.
 *
 * The preview applies only to the scene it was taken against, and once the
 * document moves on it is DROPPED, not merely ignored: undo hands back the
 * previous scene object — the very one the preview was keyed to — so a
 * preview that was only skipped would reappear after an undo, drawing a
 * colour the document no longer holds. A patch that no longer applies (an
 * adjustment to a logo an edit removed) is reported and dropped too.
 */
export function resolveBrandingPreview<
  Scene extends { branding: SceneBranding },
>(
  preview: BrandingPreview<Scene> | null,
  scene: Scene,
  report: (error: Error) => void = () => undefined,
): { branding: SceneBranding; preview: BrandingPreview<Scene> | null } {
  if (preview === null || preview.scene !== scene) {
    return { branding: scene.branding, preview: null };
  }
  try {
    return {
      branding: applyBrandingPatch(scene.branding, preview.patch),
      preview,
    };
  } catch (error) {
    report(error instanceof Error ? error : new Error(String(error)));
    return { branding: scene.branding, preview: null };
  }
}
