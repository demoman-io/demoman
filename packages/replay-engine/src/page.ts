/**
 * The in-page half of replay: the code that runs inside the demoed app.
 *
 * The other door, `index.ts`, is the driver's — node, the service worker, an
 * extension page. This one is bundled into a script injected into every frame
 * of somebody else's site, so it must not drag that surface with it. That is
 * the whole reason this package has a second entry point.
 *
 * Reversal, recorded: the extraction that created this package chose one
 * curated door, and its plan's Task 2 contract said "Nothing is reachable by
 * subpath". This is the exception, and the `exports` map is deliberately
 * closed — two entries, no wildcard — so it stays the only one.
 *
 * Lived in `apps/extension/src/sensor/` until 2026-09-07. It moved because
 * the headless runner needs a `PageAgent` and cannot import an app. It must
 * not be copied: a divergent double of exactly this code is how the
 * same-origin parking bug hid behind `selectorPageAgent`, a test helper that
 * was more correct than production.
 */
import {
  type AnchorIntent,
  parseTreePath,
  type ResolutionReport,
  type ResolveEnv,
  resolveAll,
  serializeTreePath,
} from "@demoman/resolver";
import { REPLAY_TARGETS } from "./constants.js";

/**
 * A report that has crossed a message boundary. `element` is always null:
 * a DOM node cannot be serialized, and nothing needs it — the frame that
 * captured the element is the frame that has it.
 */
export type SerializedReport = Omit<ResolutionReport, "element"> & {
  element: null;
};

export function serializeReport(report: ResolutionReport): SerializedReport {
  return { ...report, element: null };
}

/**
 * Drops the hop the request is about to cross. Without this the child runs
 * resolveAll against a path that still names the iframe it is already inside,
 * looks for that iframe in its own document, and reports frameGone.
 *
 * Exactly one level, so a nested frame strips one hop per boundary.
 *
 * Generic over `T extends AnchorIntent` rather than fixed to one of
 * `SceneAnchor` or `AnchorIntent`: it only ever touches `.fingerprint`, so it
 * preserves whichever of the two it was handed — a courier broker relaying a
 * captured `SceneAnchor` onto the wire still gets a `SceneAnchor` back.
 */
export function stripLeadingHop<T extends AnchorIntent>(anchor: T): T {
  const path = anchor.fingerprint.treePath;
  if (path === null) return anchor;
  let segments: ReturnType<typeof parseTreePath>;
  try {
    segments = parseTreePath(path);
  } catch {
    // A malformed path costs this rewrite, not the request; the child's own
    // ladder guards its parse the same way.
    return anchor;
  }
  if (segments[0]?.kind !== "frame") return anchor;
  return {
    ...anchor,
    fingerprint: {
      ...anchor.fingerprint,
      treePath: serializeTreePath(segments.slice(1)),
    },
  };
}

/** This realm's park table, created on first use. */
function targetsOf(win: Window): Record<string, Element> {
  const scope = win as unknown as Record<string, unknown>;
  const parked = (scope[REPLAY_TARGETS] ?? {}) as Record<string, Element>;
  scope[REPLAY_TARGETS] = parked;
  return parked;
}

/**
 * Every realm this one can have parked in: itself and its same-origin
 * descendants, at any depth. A cross-origin child is skipped rather than
 * reached for — this code could never have parked there, since the broker
 * sends that frame the request and it parks in itself.
 */
function reachableWindows(from: Window): Window[] {
  const out: Window[] = [from];
  for (const frame of Array.from(
    from.document.querySelectorAll("iframe,frame"),
  )) {
    let child: Window | null = null;
    try {
      child = (frame as HTMLIFrameElement).contentDocument?.defaultView ?? null;
    } catch {
      // Cross-origin: not ours to read, and nothing of ours is in it.
    }
    if (child !== null) out.push(...reachableWindows(child));
  }
  return out;
}

/**
 * Drop this anchor's target from every realm that could be holding one.
 *
 * Takes the realms rather than the window to walk from: the walk is a
 * recursive full-document `querySelectorAll` per realm, and the caller
 * already knows it is doing this for a whole group of anchors at once.
 *
 * Never creates a table it did not find: an unpark that ran `targetsOf` would
 * leave an empty `__demomanReplayTargets` on every frame of the host page,
 * which is a footprint this owes nobody.
 */
function unparkEverywhere(anchorId: string, realms: Window[]): void {
  for (const win of realms) {
    const parked = (win as unknown as Record<string, unknown>)[
      REPLAY_TARGETS
    ] as Record<string, Element> | undefined;
    if (parked !== undefined) delete parked[anchorId];
  }
}

/**
 * Resolve, and leave the element where CDP can find it.
 *
 * `DOM.getBoxModel` returns quads in *main-frame* coordinates — the only
 * space `Input.dispatchMouseEvent` accepts — so replay needs the node, and a
 * serialized report cannot carry one. The element is parked on a MAIN-world
 * global instead, and the orchestrator evaluates that expression in the
 * owning frame's execution context to get an objectId.
 *
 * **Which realm gets the element is the element's, not the caller's.**
 * `replayResolve` is answered by the top frame only, and for a *same-origin*
 * child the resolver walks `contentDocument` itself rather than going through
 * the broker — "same-origin frames need no broker" is true of resolution and
 * false of parking. So the element handed back can live in a realm this code
 * is not running in, while the engine looks for it in the one the anchor's
 * frame hop names. Parking on `globalThis` put it in the top window and every
 * anchor captured inside a same-origin iframe resolved cleanly and then never
 * replayed. `ownerDocument.defaultView` is the realm that holds it at any
 * depth, which is exactly the realm the hop resolves to.
 */
export async function resolveForReplay(
  anchors: AnchorIntent[],
  env: ResolveEnv,
): Promise<SerializedReport[]> {
  const reports = await resolveAll(anchors, env);
  const here = globalThis as unknown as Window;
  /**
   * Walked at most once per call, and not at all when every anchor resolved.
   * The loop below is synchronous, so the frame set cannot move under it. A
   * brokered frame answers for a whole anchor group in one report batch, so
   * re-walking per failed anchor cost N×F recursive `querySelectorAll`s over
   * every document in the page where one walk does.
   */
  let realms: Window[] | null = null;
  for (const report of reports) {
    // An unresolved anchor parks nothing: a stale element from a previous
    // step would be measured as though this step had succeeded. That sweep
    // has to reach the frames too, now that a previous step's element can be
    // parked in one.
    const owner = report.element?.ownerDocument.defaultView ?? null;
    if (report.element !== null && owner !== null) {
      targetsOf(owner)[report.anchorId] = report.element;
    } else {
      realms ??= reachableWindows(here);
      unparkEverywhere(report.anchorId, realms);
    }
  }
  return reports.map(serializeReport);
}

/** Plan 2: the snapshot's walk turns each capture into a target and back
 *  with these, so it checks exactly the fingerprint a run will build. */
export { fingerprintFromTarget, targetFromFingerprint } from "./target.js";
