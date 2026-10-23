import type {
  FailureReasonName,
  SceneAnchor,
  StrategyName,
} from "@demoman/scene-schema";
/**
 * What resolution actually needs: an id to report under, and a fingerprint to
 * walk. NOT a `SceneAnchor` — an authored step has no `resolution` yet,
 * because no resolution has happened, and there is no honest enum member for
 * "not resolved" (`broken` and `ambiguous` both claim a measurement).
 *
 * Provable rather than asserted: every touch of `.resolution` in this package
 * is a WRITE, in `capture.ts`. `test/node/resolve-intent.test.ts` passes an
 * object with no such field, so anybody who adds a read here goes red.
 */
export interface AnchorIntent {
  id: string;
  fingerprint: SceneAnchor["fingerprint"];
}

/** Identifies an iframe well enough that the hop itself survives drift. */
export interface FrameHop {
  origin: string;
  name: string;
  ordinal: number;
}

export type PathSegment =
  | { kind: "element"; tag: string; nth: number }
  | { kind: "shadow" }
  | { kind: "frame"; hop: FrameHop };

export type SignalName = "rect" | "role" | "name" | "text" | "path";

export interface CorroborationSignal {
  signal: SignalName;
  agreed: boolean;
}

export interface ShadowRegistry {
  getClosedRoot(host: Element): ShadowRoot | null;
}

export interface FrameBroker {
  /** Batched deliberately: one round trip per frame, never one per anchor.
   *  `AnchorIntent`, not `SceneAnchor`: the broker relays whatever
   *  `resolveBatch` was given, and it never reads `.resolution` either. */
  resolveInFrame(
    hop: FrameHop,
    anchors: AnchorIntent[],
  ): Promise<ResolutionReport[]>;
}

export interface ImagePatchMatcher {
  capture(el: Element): Promise<string | null>;
  match(
    ref: string,
    candidates: Element[],
  ): Promise<{ index: number; score: number }[]>;
}

export interface ResolveEnv {
  root: Document;
  shadow?: ShadowRegistry;
  frames?: FrameBroker;
  patch?: ImagePatchMatcher;
}

export interface ResolutionReport {
  anchorId: string;
  strategy: StrategyName;
  element: Element | null;
  candidates: number;
  failureReason: FailureReasonName | null;
  // On an "ambiguous" result, breakTie returns the signals of whichever tied
  // candidate happened to sort first — not a view of the disagreement between
  // the tied candidates. A consumer should not read these signals as a fact
  // about the resolution in that case, only about one arbitrary candidate.
  corroboration: CorroborationSignal[];
  durationMs: number;
}

export interface CaptureContext {
  anchorId: string;
  url: string;
  actionIndex: number;
  /** True iff nothing had yet changed page state at this URL (v8 §4). */
  entryState: boolean;
}

export interface CapturedAnchor {
  anchor: SceneAnchor;
  report: ResolutionReport;
}

export interface HealthSummary {
  total: number;
  byStrategy: Record<StrategyName, number>;
  sentence: string;
  /** Three-to-five words for a collapsed row. `sentence` is the full
   *  explanation and stays the only thing a reader is owed on expansion. */
  short: string;
}
