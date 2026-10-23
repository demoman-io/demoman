// THE anchor resolver — single shared implementation, versioned (v8 §5).
// Resolution runs in the extension at capture, in local replay, and (phase 2)
// in the headless runner. One implementation, one version, recorded per render.
// Must equal package.json's `version` — boundary.test.ts compares them.
export const RESOLVER_VERSION = "1.1.0";

export { computeName, computeRole } from "./accessibility.js";
export { captureAnchor } from "./capture.js";
export { anchorHealth } from "./health.js";
export { isAuthoredIdentifier, readStableId } from "./identifiers.js";
export { NO_FRAMES } from "./ports/frames.js";
export { NO_PATCH } from "./ports/patch.js";
export { createCanvasMatcher } from "./ports/patch-canvas.js";
export { createShadowRegistry, NO_SHADOW } from "./ports/shadow.js";
export { resolveAll, resolveAnchor } from "./resolve.js";
/**
 * `findFrameElement` is the headless runner's door, not the extension's.
 *
 * `apps/runner`'s `PageAgent` routes an anchor into the frame its hop names
 * *before* the resolver sees it — parking is replay's requirement, not
 * resolution's — so it needs the same "which iframe is this hop about?"
 * answer `frameTarget` asks internally. Reimplementing the question on the
 * caller's side is the divergent double this repo keeps paying for: an
 * ordinal-only match would happily route into the frame that has slid into
 * a removed one's index, where this function reports the hop's frame gone.
 * One matcher, two callers.
 */
export { findFrameElement, readDataKey } from "./scope.js";
/** The snapshot's walk (plan 2) lists text leaves by the rule capture and the
 *  text tier share, so it cannot list one the text tier would not match. */
export { isTextLeaf, normalizeText } from "./text.js";
export { buildTreePath, parseTreePath, serializeTreePath } from "./treepath.js";
export type {
  AnchorIntent,
  CaptureContext,
  CapturedAnchor,
  CorroborationSignal,
  FrameBroker,
  FrameHop,
  HealthSummary,
  ImagePatchMatcher,
  PathSegment,
  ResolutionReport,
  ResolveEnv,
  ShadowRegistry,
  SignalName,
} from "./types.js";
