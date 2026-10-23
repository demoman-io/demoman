import { madeFromOf } from "@demoman/compositor";
import {
  assertSceneWasLoaded,
  type CdpSession,
  createNavigatingGuard,
  createOcclusionGuard,
  type ReplayResult,
  replayPolicy,
  runReplay,
} from "@demoman/replay-engine";
import type { SceneDocument } from "@demoman/scene-schema";
import { createParkingEncoder, type ParkedSpan } from "./encoder.js";
import type { RunnerStore } from "./frame-store.js";
import type { Launched } from "./launch.js";
import { createHeadlessPageAgent, installResolver } from "./page-agent.js";
import type { Report } from "./report.js";

export interface ReplayPhase {
  result: ReplayResult;
  spans: ParkedSpan[];
  store: RunnerStore;
  /** Chromium's own reason the target URL did not load — verbatim, e.g.
   *  `net::ERR_CONNECTION_REFUSED` — or `null` when it loaded. See
   *  `watchNavigation` below. */
  navigationError: string | null;
}

/**
 * Reads `Page.navigate`'s `errorText`, which nothing else does.
 *
 * Whole-branch review finding 3, and row 5 of CLAUDE.md's own table — "an
 * error written to a field no consumer reads". CDP answers a `Page.navigate`
 * that could not load with `{frameId, loaderId, errorText:
 * "net::ERR_CONNECTION_REFUSED"}` and **resolves**; it does not reject. The
 * engine's `createNavigatingGuard` drops the result, so replay carried on
 * against `about:blank`, failed to resolve its first anchor, and the CLI told
 * the author to re-record a step that was never broken.
 *
 * Fixed at the RUNNER's edge rather than in the shared engine: the extension
 * calls the same `createNavigatingGuard` and has its own attended,
 * tab-shaped story for a target that will not load — changing what
 * `install()` does with `errorText` would change that behaviour too, for a
 * consumer this project is not verifying. Wrapping the `CdpSession` port
 * here changes nothing for anyone else.
 *
 * Recorded rather than thrown, for the same reason: throwing from inside
 * `occlusion.install()` would unwind out of `runReplay` as an exception and
 * land in the exit-70 "this is a bug in the runner" bucket — the very
 * mis-classification finding 2 is about. `replayPhase` hands the string back
 * and `runPipeline` reports it as the input failure it is.
 *
 * Assigned on EVERY `Page.navigate`, not only the first: a later successful
 * navigation clears an earlier failure, so this reports the state of the
 * page replay actually ran against.
 */
export function watchNavigation(cdp: CdpSession): {
  cdp: CdpSession;
  error: () => string | null;
} {
  let error: string | null = null;
  return {
    cdp: {
      ...cdp,
      send: async (method, params) => {
        const result = await cdp.send(method, params);
        if (method === "Page.navigate") {
          const errorText = result?.errorText;
          error =
            typeof errorText === "string" && errorText !== ""
              ? errorText
              : null;
        }
        return result;
      },
    },
    error: () => error,
  };
}

/**
 * Runs the fixture — or any resolved scene — against a real browser and
 * hands back what the engine produced plus the parked motion spans that go
 * with it.
 *
 * Mirrors `apps/extension/src/adapters/replay-runner.ts`'s assembly
 * (roughly lines 851-966 there): a navigating occlusion guard, the real
 * `mayReplay` derivation, and the post-run tripwire that refuses to leave a
 * blank-frame bundle where a later read would find it. See
 * `createNavigatingGuard`'s own docblock in
 * `packages/replay-engine/src/navigate.ts` for why the wrapper must never
 * be unwrapped back into a plain `OcclusionGuard`.
 */
export async function replayPhase(input: {
  scene: SceneDocument;
  targetUrl: string;
  store: RunnerStore;
  launched: Launched;
  /** Where the page agent's forgiven failures say why — see `report.ts`.
   *  `runPipeline` wires it to the result's `notes`. (The encoder has no
   *  reporter: a park it cannot make rejects `push`, and the engine's own
   *  recorder reports that as a bundle degradation.) */
  report: Report;
}): Promise<ReplayPhase> {
  const { scene, targetUrl, store, launched, report } = input;
  const { page, clock } = launched;
  // Every CDP call replay makes goes through the watcher, so whichever
  // `Page.navigate` the engine sends is the one whose `errorText` is read.
  const navigation = watchNavigation(launched.cdp);
  const cdp = navigation.cdp;

  // Before the first navigation: `addInitScript` only reaches a document
  // that starts loading after this runs (see installResolver's docblock),
  // and the guard's navigation below is that first navigation.
  await installResolver(page);

  const guard = createOcclusionGuard({ cdp, clock });
  // `createNavigatingGuard`, NEVER a bare `createOcclusionGuard`. The
  // navigation rides `install()` because the guard's visibility reporter is
  // registered with `Page.addScriptToEvaluateOnNewDocument`, which never
  // reaches a document that is already loaded. Unwrap this and replay runs
  // the whole take against `about:blank`, harvests a bundle of blank
  // frames, and reports `outcome: "complete"` over it.
  //
  // `targetUrl` (the CLI's `--url`) is what this navigates to — NOT
  // `replayUrl(scene)`. The scene's recorded URL is where the take was
  // captured; this project's whole premise is replaying it somewhere else.
  // This is the one call site where the two could be confused, and both
  // are exported from `@demoman/replay-engine`.
  const occlusion = createNavigatingGuard({
    guard,
    cdp,
    url: targetUrl,
    sleep: clock.sleep,
  });

  const encoder = createParkingEncoder(store, scene.meta.id);

  // Derived here, at the moment the run begins — not threaded in from the
  // caller. This is the fail-closed gate: a value passed in from a caller is
  // a gate a caller can forget.
  const mayReplay = replayPolicy(scene, {
    attended: false,
    targetUrl,
  }).mayReplay;

  const result = await runReplay(scene, {
    cdp,
    page: createHeadlessPageAgent(page, report),
    encoder,
    store,
    clock,
    mayReplay,
    occlusion,
    madeFrom: madeFromOf(scene),
  });

  if (!occlusion.navigated() && result.bundle !== null) {
    // The engine stores its bundle before returning, so a blank-frame
    // bundle is already on disk by now. It must not be left where a later
    // `getBundle` would serve it. Swallowed like the extension's own
    // `.catch(() => undefined)` here: `assertSceneWasLoaded` immediately
    // below is about to throw regardless, and that throw — not this
    // best-effort cleanup — is what reports the failure.
    await store.deleteBundle(scene.meta.id).catch(() => undefined);
  }
  assertSceneWasLoaded(result, occlusion.navigated());

  return {
    result,
    spans: encoder.spans(),
    store,
    navigationError: navigation.error(),
  };
}
