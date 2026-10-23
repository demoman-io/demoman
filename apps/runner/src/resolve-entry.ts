/**
 * The in-page half of the runner's `PageAgent` port.
 *
 * Bundled into an IIFE by `bundle-js.ts` and injected into every frame with
 * `page.addInitScript`, standing in for the extension's sensor content
 * script — which is not here, because the whole point of `apps/runner` is a
 * replay with no extension anywhere.
 *
 * It imports `@demoman/replay-engine/page`, the subpath the engine's
 * extraction opened for exactly this, and `@demoman/resolver`'s own frame
 * matcher. It must NOT reimplement any of them: a divergent double of
 * `resolveForReplay` is how the same-origin parking bug hid behind
 * `selectorPageAgent` for weeks — a test helper more correct than
 * production, so the extension lane's frame coverage proved the engine's CDP
 * frame-walking and nothing at all about where the real resolver parked.
 *
 * Two entry points, both called from node by `page-agent.ts`:
 *
 * - `frameElementForHop` answers "which iframe in *this* document is that
 *   hop about?", so node can take its `contentFrame()` and re-enter there.
 * - `resolveHere` resolves against this document only — no `FrameBroker`,
 *   because by the time node calls it, node has already walked the anchor
 *   into the frame that owns the element and stripped the hops it crossed.
 *   See `entry-globals.ts` for why there is no broker binding.
 */
import {
  resolveForReplay,
  type SerializedReport,
} from "@demoman/replay-engine/page";
import {
  type AnchorIntent,
  type FrameHop,
  findFrameElement,
} from "@demoman/resolver";
import { ENTRY_GLOBAL } from "./entry-globals.js";

/** What node calls through `ENTRY_GLOBAL`. */
export interface RunnerEntry {
  resolveHere(anchors: AnchorIntent[]): Promise<SerializedReport[]>;
  frameElementForHop(hop: FrameHop): HTMLIFrameElement | null;
}

/**
 * Resolve against this document, and park each element on the realm that
 * owns it — which, after node's hop walk, is this one.
 */
function resolveHere(anchors: AnchorIntent[]): Promise<SerializedReport[]> {
  return resolveForReplay(anchors, { root: document });
}

/**
 * The iframe a hop names, by the resolver's own scoring rather than by the
 * hop's ordinal alone.
 *
 * The difference is a failure path: an ordinal-only match routes into
 * whatever iframe now sits at the recorded index, so an anchor behind a
 * frame that has been removed resolves cleanly against a stranger's
 * document. `findFrameElement` refuses that — a candidate matching on
 * ordinal alone is rejected outright whenever the hop also carries a name or
 * an origin — and returns null, which node reports as `frameGone`.
 */
function frameElementForHop(hop: FrameHop): HTMLIFrameElement | null {
  return findFrameElement(document, hop);
}

const entry: RunnerEntry = { frameElementForHop, resolveHere };
(globalThis as unknown as Record<string, unknown>)[ENTRY_GLOBAL] = entry;
