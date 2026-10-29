export {
  type AnchorRectEntry,
  COVERAGE_TOLERANCE,
  type CursorGap,
  type CursorSample,
  coversViewport,
  type Degradation,
  type FrameBundle,
  FrameBundleSchema,
  gapPacedLive,
  isRealTime,
  type KeyframeEntry,
  keyframeAt,
  type MadeFromStep,
  MadeFromStepSchema,
  type MarkerEntry,
  type MotionSpanEntry,
  madeFromOf,
  servingMotionSpan,
  type ViewportTransform,
  validateBundle,
} from "./bundle.js";
export { type EasingName, easings, springEase } from "./easing.js";
export type { Rect, Vec } from "./geometry.js";
export {
  CAMERA_DEFAULTS,
  type CameraKey,
  type CameraSegment,
  clampCameraCenter,
  fitScaleFor,
  frameCamera,
  MIN_PAN_MS,
  type MotionTimings,
  motionTimings,
  returnsBetween,
  sampleCamera,
  solveCamera,
} from "./plan/camera.js";
export {
  type CameraTrack,
  FOLLOW_STEP_MS,
  type FollowStretch,
  frameTrack,
  sampleTrack,
  solveFollow,
} from "./plan/camera-follow.js";
export {
  cursorEntryPoint,
  planCursorSegment,
  sampleSegment,
  segmentDurationMs,
} from "./plan/cursor.js";
export {
  MIN_SCREEN_MS,
  type ScreenMoment,
  type Screens,
  screenMoments,
} from "./plan/moments.js";
export { planScene, RETIMING_DEFAULTS } from "./plan/plan.js";
export {
  type ClampedRange,
  // Public with no importer inside this package's own tests today, and
  // deliberately so: `markerOutputMs`/`resolveRange` are what the editor's
  // gesture and lane code (and any future headless consumer that has to
  // place a marker without going through a full `resolvePlan`) needs to
  // answer "where does this marker land in output ms" the same way the
  // compositor itself answers it. Not a stray export to be withdrawn as
  // dead.
  markerOutputMs,
  type OutputRange,
  type RangeKind,
  resolveRange,
} from "./plan/ranges.js";
export {
  bridgeCutSeams,
  CURSOR_IDLE_FADE_MS,
  CURSOR_IDLE_HIDE_MS,
  CUT_BRIDGE_MS,
  cursorIdleAlpha,
  cursorMotionSpans,
  cursorRestSpans,
  type LoweredZoom,
  type ResolvedCosmetic,
  type ResolvedPlan,
  resolvePlan,
  sampleCursor,
} from "./plan/resolve.js";
export { inScreenSpace, transformAt } from "./plan/screen-space.js";
export {
  buildTimeline,
  insideCutClosed,
  insideCutOpen,
  isUnkeptMotion,
  type ResolvedCut,
  type Timeline,
  type TimelineSegment,
  type TimeSpan,
  toOutputMs,
  toSourceMs,
  type UnplacedCut,
} from "./plan/timeline.js";
export type {
  AttachedEdit,
  CameraIntent,
  CosmeticBinding,
  CursorSegment,
  PlannedHold,
  PlannedMarker,
  PlannedRemoval,
  PlannedTrim,
  PlanOptions,
  RenderPlan,
  RetimingPolicy,
} from "./plan/types.js";
export { VERBS, type VerbTraits } from "./plan/verbs.js";
export { createImageFrameSource } from "./ports/frame-source-images.js";
export { createVideoFrameSource } from "./ports/frame-source-video.js";
export {
  createGifSink,
  GifOverBudgetError,
  isGifOverBudget,
} from "./ports/sink-gif.js";
export {
  createMp4Sink,
  ENCODER_USED_GLOBAL,
  type EncoderUsed,
} from "./ports/sink-mp4.js";
export { createPngSink } from "./ports/sink-png.js";
export { createOffscreenSurface } from "./ports/surface.js";
export type {
  CompositorPorts,
  FrameImage,
  FrameSource,
  GifSink,
  ImageSink,
  Surface,
  UnavailableSpan,
  VideoSink,
} from "./ports/types.js";
export {
  CAMERA_BLUR_MIN_TRAVEL_PX,
  CAMERA_EXPOSURE_MS,
  type CameraBlurPass,
  cameraBlurTransforms,
} from "./render/camera-blur.js";
export { cssRectToOutput, cssToOutput, renderFrame } from "./render/compose.js";
export {
  type Composition,
  composeForTarget,
} from "./render/compose-for-target.js";
export {
  cursorPressScale,
  cursorTiltRad,
  PRESS_DEPTH,
  TILT_MAX_RAD,
} from "./render/cursor-pose.js";
export {
  clampToSourceDetail,
  type DetailViolation,
  sourceWidthAt,
} from "./render/detail.js";
export {
  CURSOR_ART,
  CURSOR_EXPOSURE_MS,
  CURSOR_TRAIL_MIN_TRAVEL_PX,
  CURSOR_UPRIGHT,
  type CursorPose,
  cursorTrailStamps,
  drawCursor,
  drawCursorTrail,
} from "./render/draw-cursor.js";
export {
  greyscaleProbe,
  meanAbsDiff,
  PROBE,
} from "./render/frame-diff.js";
export {
  HOVER_TIME_TOLERANCE_MS,
  type HoverProbeReason,
  type HoverVerdict,
  hoverVerdicts,
  planHoverProbes,
} from "./render/hover-verdict.js";
export { detectKeyframeMotion } from "./render/motion-detect.js";
export {
  BACKGROUND_PAINT_VERSION,
  clipToFrame,
  contentScale,
  derivePresentation,
  drawBackground,
  drawFrameChrome,
  drawLogo,
  gradientLine,
  type LogoPlacement,
  logoRasterHeight,
  outputRectToCss,
  outputToCss,
  type PlacedLogo,
  type Presentation,
  placeLogo,
} from "./render/presentation.js";
export type { RenderResult } from "./render/render.js";
export {
  renderScene,
  renderStills,
  type StillCamera,
  type UnplacedStill,
} from "./render/render.js";
export { type Seam, seamAt } from "./render/seam.js";
export {
  autoTarget,
  cameraIntentsForTarget,
  fitH264Frame,
  GIF_800,
  GIF_VERTICAL_450,
  HIGH_LANDSCAPE,
  HIGH_MAX_BITRATE,
  HIGH_VERTICAL,
  LANDSCAPE_4K,
  LANDSCAPE_1080P,
  LANDSCAPE_1440P,
  landscapeFrame,
  type Mp4EncoderHints,
  pickAutoTier,
  pickLandscapeTarget,
  pickMp4Tier,
  type RenderTarget,
  SHARE_LANDSCAPE,
  SHARE_QUALITY_FLOOR,
  SHARE_VERTICAL,
  STILL_1440,
  STILL_VERTICAL_1080,
  VERTICAL_1080,
  verticalCameraIntents,
} from "./render/target.js";
export {
  coverRect,
  WALLPAPER_LONG_SIDE,
  wallpaperRasterSize,
  wallpaperShape,
} from "./render/wallpaper.js";
export {
  blurWallpaper,
  WALLPAPER_BLUR_MAX,
  wallpaperBlurPx,
} from "./render/wallpaper-blur.js";
export { sceneCameraAt, windowOnScreen } from "./render/window.js";
export { COMPOSITOR_VERSION } from "./version.js";
