/**
 * Getting the scene's own document in front of the engine, and refusing to
 * report frames if it never arrived.
 *
 * Moved out of the extension's replay-runner on 2026-09-07: these three take
 * a `CdpSession` and a `sleep` and touch no `chrome.*`, and the headless
 * runner needs all three. The rest of that file — stage windows, popup
 * surfacing, attachment sweeps, telemetry, retro truncation — is
 * irreducibly the extension's and stayed.
 *
 * Not copied into the runner, on purpose. A second copy of the navigation's
 * coupling to `occlusion.install()` is exactly the divergent-double shape
 * that hid the same-origin parking bug.
 */

import type { SceneDocument } from "@demoman/scene-schema";
import { withAnswerDeadline } from "./answer-deadline.js";
import { NAVIGATE_TIMEOUT_MS } from "./constants.js";
import type { OcclusionGuard } from "./occlusion.js";
import type { CdpSession, ReplayResult } from "./types.js";

/** Where the take was recorded: the first URL the trace saw, or the origin
 *  the session was started on when the trace is empty. */
export function replayUrl(scene: SceneDocument): string {
  return scene.sideChannels.urlTrace[0]?.url ?? scene.meta.capture.originUrl;
}

export interface NavigatingGuard extends OcclusionGuard {
  /** Whether the scene's own document was ever loaded. */
  navigated(): boolean;
}

export interface NavigatingGuardDeps {
  guard: OcclusionGuard;
  cdp: CdpSession;
  url: string;
  timeoutMs?: number;
  /** The run's clock — never a bare `setTimeout`; see `createWorkerClock`. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * The occlusion guard, plus the navigation that has to happen immediately
 * after it installs.
 *
 * **Do not unwrap this back into a plain guard.** The engine calls
 * `occlusion.install()` in the one place in its setup that sits after
 * `Page.enable` and the emulation overrides and before the first keyframe —
 * which is exactly when the scene's document must be created, because the
 * guard's visibility reporter is registered with
 * `Page.addScriptToEvaluateOnNewDocument` and never reaches back into a
 * document already loaded. So the navigation rides that hook. That coupling
 * is a trap dressed as tidiness: delete the wrapper and replay runs the whole
 * take against `about:blank`, harvests a bundle of blank frames, and reports
 * `outcome: "complete"` over it. `assertSceneWasLoaded` is the tripwire for
 * that, and it is the reason `navigated()` is on this interface at all.
 *
 * Latched, so `install()` is idempotent: whoever calls it a second time gets
 * the reporter and the navigation once between them.
 */
export function createNavigatingGuard(
  deps: NavigatingGuardDeps,
): NavigatingGuard {
  const { guard, url } = deps;
  // The host built this guard on its own session, not the walk's, so the
  // walk's deadline never covered it — and its `Page.navigate` is the first
  // and slowest call of every run and snapshot: a server that takes the
  // connection and never answers holds it until the network gives up
  // (review 2026-10-13, #4). Every host gets the deadline here.
  const { cdp } = withAnswerDeadline(deps.cdp);
  const wait = deps.sleep;
  const timeoutMs = deps.timeoutMs ?? NAVIGATE_TIMEOUT_MS;
  let navigated = false;

  return {
    async install() {
      if (navigated) return;
      await guard.install();
      let off = (): void => undefined;
      // Subscribed before the navigate is sent, so the load cannot land in
      // the gap between the two.
      const loaded = new Promise<void>((resolve) => {
        off = cdp.on("Page.loadEventFired", () => resolve());
      });
      try {
        await cdp.send("Page.navigate", { url });
        // A page that never fires `load` still gets its shot at resolving:
        // the engine's own wait and resolve timeouts then say something more
        // specific than "navigation timed out" would.
        await Promise.race([loaded, wait(timeoutMs)]);
      } finally {
        off();
        // Set even if the load never arrived: the document was asked for,
        // which is what the tripwire is asking about.
        navigated = true;
      }
    },
    ensureVisible: () => guard.ensureVisible(),
    pauses: () => guard.pauses(),
    pausedMs: () => guard.pausedMs(),
    stalledSince: () => guard.stalledSince(),
    navigated: () => navigated,
  };
}

/**
 * Refuse to report frames harvested from a page that was never loaded.
 *
 * The single silently-wrong success this design can produce: if the
 * navigation hook above is ever severed — the guard omitted, the wrapper
 * "tidied" away — every frame in the run is of `about:blank`, and nothing
 * else in the system would notice. `outcome` would say `complete`, the
 * bundle would validate, and the author would be handed a video of a blank
 * page. A silently wrong success is worse than any reported failure, so this
 * is a throw rather than a stop reason: it is an invariant violation, not
 * something replay has a word for or an author can act on.
 *
 * Only trips when a bundle exists. A run that harvested nothing has nothing
 * to be wrong about, and its own reason — a port that gave way during setup,
 * say — is the honest explanation and must not be replaced by this one.
 */
export function assertSceneWasLoaded(
  result: ReplayResult,
  navigated: boolean,
): void {
  if (navigated || result.bundle === null) return;
  throw new Error(
    "replay harvested frames without ever loading the scene's app — the navigation that rides the occlusion guard's install did not happen, so every frame is blank",
  );
}
