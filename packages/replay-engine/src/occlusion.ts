import { withAnswerDeadline } from "./answer-deadline.js";
import { HEARTBEAT_STALL_MS, OCCLUSION_TIMEOUT_MS } from "./constants.js";
import type { CdpSession, Clock } from "./types.js";

const BINDING = "__demomanHeartbeat";

/** How often the injected loop posts a beat while rAF is being driven.
 *  Inlined into the page script below; kept beside HEARTBEAT_STALL_MS's
 *  doc comment, which reasons about the ratio between the two. */
const BEAT_EVERY_MS = 250;

export interface OcclusionGuard {
  install(): Promise<void>;
  /** Resolves true once the page shows evidence of painting, false if it
   *  never does again. The name predates the heartbeat: "visible" here
   *  means *evidently being driven*, not what `visibilityState` claims. */
  ensureVisible(): Promise<boolean>;
  pauses(): number;
  pausedMs(): number;
  /**
   * On the clock `ensureVisible` runs on: the last beat heard before the
   * most recent pause — when the page stopped being evidently driven, which
   * is up to HEARTBEAT_STALL_MS before anything asked. Null before any
   * pause. A real-time film removes the stretch from here, not from the
   * check that noticed it: the frozen seconds before the check are the
   * pause too (review of 2026-10-03).
   */
  stalledSince(): number | null;
}

export interface OcclusionDeps {
  cdp: CdpSession;
  clock: Clock;
  onPause?: () => void;
  onResume?: () => void;
}

/**
 * v9's pause-and-surface, re-founded on evidence instead of hearsay.
 *
 * The first guard trusted `document.visibilityState`. That signal convicts
 * the wrong pages: real Chrome marks a covered or minimized window hidden
 * while the engine's lifecycle override keeps it painting — SP1 measured a
 * minimized window still painting at ~56fps — and four real runs on
 * 2026-08-31 died `occlusionTimeout` on the label alone, with no evidence
 * painting had stopped. (The reverse failure is quieter and worse: a page
 * that stops painting *without* a visibility event reads as visible
 * forever, and the harvest is throttled garbage.)
 *
 * So the guard now watches for proof of life: a requestAnimationFrame loop
 * in the page posts a beat over the binding channel every ~250ms. rAF only
 * runs when Chrome is actually driving frames — a timer would keep firing
 * on a frozen page — so a recent beat IS a recent paint, whatever the
 * visibility label says. The pause fires only when the beats stop; the
 * policy around it (one recovery attempt, the develop panel's button,
 * OCCLUSION_TIMEOUT_MS) is unchanged.
 *
 * `lastBeatMs` starts at construction rather than at zero: between install
 * and the navigated document's first rAF there are no beats to have heard,
 * and a guard that convicted there would pause every run at its first
 * check. The grace is HEARTBEAT_STALL_MS from construction — by the first
 * `ensureVisible` (after navigation and paint-settle) a living page has
 * long since taken over the clock.
 */
export function createOcclusionGuard(deps: OcclusionDeps): OcclusionGuard {
  const { clock } = deps;
  // Built by the host on its own session, outside the walk's deadline: see
  // `createNavigatingGuard`.
  const { cdp } = withAnswerDeadline(deps.cdp);
  let lastBeatMs = clock.now();
  let pauses = 0;
  let pausedMs = 0;
  let stalledSince: number | null = null;

  cdp.on("Runtime.bindingCalled", (params) => {
    if (params.name !== BINDING) return;
    lastBeatMs = clock.now();
  });

  const beating = (): boolean => clock.now() - lastBeatMs < HEARTBEAT_STALL_MS;

  return {
    async install() {
      await cdp.send("Runtime.addBinding", { name: BINDING });
      // On new document rather than once: a replay that navigates must not
      // lose the only thing that can tell it the page stopped painting.
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          (() => {
            let last = 0;
            const tick = (ts) => {
              if (ts - last >= ${BEAT_EVERY_MS}) {
                last = ts;
                window.${BINDING}(String(ts));
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          })();
        `,
      });
    },

    async ensureVisible() {
      if (beating()) return true;
      stalledSince = lastBeatMs;
      pauses++;
      deps.onPause?.();
      const started = clock.now();
      while (!beating()) {
        if (clock.now() - started >= OCCLUSION_TIMEOUT_MS) {
          pausedMs += clock.now() - started;
          return false;
        }
        await clock.sleep(200);
      }
      pausedMs += clock.now() - started;
      deps.onResume?.();
      return true;
    },

    pauses: () => pauses,
    pausedMs: () => pausedMs,
    stalledSince: () => stalledSince,
  };
}
