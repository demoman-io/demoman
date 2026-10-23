import type { AnchorIntent, ResolveEnv } from "@demoman/resolver";
import { captureAnchor, resolveAnchor } from "@demoman/resolver";
import type {
  FailureReasonName,
  SceneAnchor,
  StrategyName,
} from "@demoman/scene-schema";
import { scrubUrl } from "./url.js";

/** The intent's own resolution: how `resolveAnchor(intent, env)` found (or
 *  did not find) an element for this step, before `captureAnchor`'s own
 *  self-check ran against whatever it captured. Reported alongside the
 *  anchor, not folded into it -- see `captureForIntent`'s docblock for why
 *  the two can legitimately disagree. */
export interface IntentResolution {
  strategy: StrategyName;
  candidates: number;
  failureReason: FailureReasonName | null;
}

/** What `captureForIntent` came back with. See its own docblock, and
 *  `askPageToCapture`'s `CaptureFailure` for the wider, caller-side type
 *  this nests inside. */
export interface CaptureForIntentResult {
  anchor: SceneAnchor | null;
  failureReason: FailureReasonName | "unresolved" | null;
  intentResolution: IntentResolution;
  /**
   * The page this attempt was made on, and non-null on exactly the path where
   * nothing else carries it: the failure one.
   *
   * On success `anchor.resolution.url` is the same observation, taken from the
   * element that was actually found, so this stays null there rather than
   * become a second field claiming one fact — which is how two fields come to
   * disagree. The caller needs it because "the element is gone" and "you are
   * on a different page now" are different things to tell an author, and an
   * expired session that redirects to a login page produces the first message
   * for the second fact.
   */
  pageUrl: string | null;
  /**
   * Whether the element found is a credential field, by the rule the caller
   * passed (`options.credential`). Absent when no rule was passed (the
   * extension's sensor, unchanged); null when the rule threw, which the
   * caller treats as a credential and says so.
   */
  credentialField?: boolean | null;
}

/**
 * The `replayCapture` round trip's actual work, factored out of the message
 * listener below so the browser lane can drive it directly against this
 * frame's own document -- no window.top gate, no postMessage plumbing --
 * exactly as `resolveForReplay` is tested. See
 * `test/browser/capture-resolved.test.ts`.
 *
 * Resolves `intent` with the same `resolveAnchor` call the resolve path
 * uses, and on a real match captures a FULL anchor from the element
 * actually found.
 *
 * `captureAnchor`'s own self-check is left standing on `anchor.resolution`
 * rather than overwritten with `intent`'s report. The two can legitimately
 * disagree -- `intent` here has no `stableId`, so it can only resolve by
 * role+name, while the fingerprint `captureAnchor` just built from the live
 * element may carry a `stableId` the ladder checks first -- and
 * `resolution` is a persisted field every other take kind also writes,
 * meaning "by what strategy does this captured fingerprint resolve", a
 * forward-looking claim about re-findability. Overwriting it with how the
 * agent's intent happened to resolve would fork that meaning silently for
 * authored takes alone. The intent's own report is not thrown away: it
 * travels beside the anchor as `intentResolution`, which is where "which
 * strategy actually won for this step" belongs -- a later task's run
 * report, not the anchor.
 */
export async function captureForIntent(
  intent: AnchorIntent,
  env: ResolveEnv,
  options: { credential?: (el: Element) => boolean } = {},
): Promise<CaptureForIntentResult> {
  const report = await resolveAnchor(intent, env);
  const resolved =
    report.strategy !== "broken" && report.strategy !== "ambiguous";
  const intentResolution: IntentResolution = {
    strategy: report.strategy,
    candidates: report.candidates,
    failureReason: report.failureReason,
  };
  if (resolved && report.element !== null) {
    const { anchor } = await captureAnchor(
      report.element,
      {
        anchorId: intent.id,
        url: scrubUrl(window.location.href),
        // No step index exists yet for a freshly authored anchor;
        // driftPick's own remap capture makes the same choice.
        actionIndex: 0,
        // Not claimed true: unlike driftPick's remap, which only ever runs
        // right after a fresh load, an authored capture can happen at any
        // point in a live session, and this code has no signal either way.
        // Claiming entry state without evidence is exactly the fabrication
        // this design exists to rule out.
        entryState: false,
      },
      env,
    );
    let credentialField: boolean | null | undefined;
    if (options.credential !== undefined) {
      try {
        credentialField = options.credential(report.element);
      } catch {
        // Said by the value: null is "could not tell", which the run hides
        // and reports as `credentialUnchecked`.
        credentialField = null;
      }
    }
    return {
      anchor,
      failureReason: null,
      intentResolution,
      pageUrl: null,
      ...(credentialField === undefined ? {} : { credentialField }),
    };
  }
  return {
    anchor: null,
    // A resolved report with no element only happens behind a cross-origin
    // frame broker, which serializes its answer and so never hands back a
    // live element to capture from -- honestly that is this side of the
    // port failing to reach an element the resolver found, not a verdict
    // about the element. "unresolved" covers the ladder's own terminal
    // "broken, no verdict" outcome, which `SceneAnchor.resolution` is
    // content to store as a bare null but this round trip's caller is not.
    failureReason: resolved
      ? "frameUnreachable"
      : (report.failureReason ?? "unresolved"),
    intentResolution,
    // Read here rather than by the caller, which has no way to ask: only this
    // frame knows which document just failed to resolve the intent. Scrubbed
    // like every other URL that leaves the page.
    pageUrl: scrubUrl(window.location.href),
    // No element to ask: when the caller checks credentials, that is "could
    // not tell", which a typed step hides (launch C spec 3.5).
    ...(options.credential === undefined ? {} : { credentialField: null }),
  };
}
