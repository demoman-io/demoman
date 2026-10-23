import { type FrameHop, parseTreePath } from "@demoman/resolver";
import type { Rect } from "./types.js";

/** The shape `Page.getFrameTree` returns, narrowed to what the walk reads. */
export interface CdpFrameNode {
  frame: { id: string; url: string; name?: string };
  childFrames?: CdpFrameNode[];
}

/**
 * The frame hops an anchor's tree-path carries. An anchor captured inside an
 * iframe has its path prefixed with one `#frame(...)` segment per level (SP4
 * assigns hops downward), and those segments are how replay knows which
 * document to ask CDP about.
 */
export function hopsFromTreePath(treePath: string | null): FrameHop[] {
  if (treePath === null || treePath === "") return [];
  try {
    return parseTreePath(treePath).flatMap((seg) =>
      seg.kind === "frame" ? [seg.hop] : [],
    );
  } catch {
    // A malformed path names no frame. Resolution will fail on its own terms;
    // it must not fail here, in geometry, with a parse error.
    return [];
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // about:blank and sandboxed frames have opaque origins, which the
    // resolver's own hop convention records as the string "null".
    return "null";
  }
}

/**
 * Walk the CDP frame tree to the document a hop path names.
 *
 * The ordinal is a **global** 1-based index over every iframe in the parent
 * document, because that is what `hopsForChildren` assigns at capture
 * (`querySelectorAll("iframe")`, `index + 1`). Selecting by a per-origin
 * index instead would disagree with the recorded value on any page with more
 * than one iframe — the mainstream case, since a checkout page carrying a
 * payment frame carries analytics frames beside it.
 *
 * Origin and name are then corroboration rather than selection, and a
 * mismatch fails closed. A replay that cannot find its frame reports a
 * partial run, which is an outcome the product already states; a replay that
 * dispatches a click into the wrong document corrupts silently.
 *
 * The recorded origin is the origin of the iframe's **`src` attribute**,
 * while the frame tree reports the document that frame currently holds — so a
 * frame that has navigated since capture reports a URL the hop cannot match
 * and is refused. That is the fail-closed behaviour working as intended, not
 * an oversight: the hop describes an iframe the take was recorded against,
 * and a frame that has since gone somewhere else is not that iframe just
 * because it sits at the same index.
 *
 * An empty *recorded* value is "no claim", for the name exactly as for the
 * origin. `hopsForChildren` stores an empty origin for a frame whose `src` is
 * absent or unparseable, srcdoc frames included, and an empty name for a
 * frame with no `name` attribute — which is most of them, since an iframe is
 * usually addressed by `id`. Chrome does not agree about that last one:
 * `Page.getFrameTree` reports `frame.name` **falling back to the element's
 * `id`** when the attribute is absent, so `<iframe id="deep">` records `""`
 * at capture and reports `"deep"` at replay. Compared strictly, that is a
 * mismatch on the mainstream case, and every id-only iframe fails closed —
 * measured against real Chromium in the integration lane, not assumed.
 *
 * So an empty recorded name skips the check rather than demanding an empty
 * one. Note what this is not: the name is still compared strictly wherever
 * capture genuinely observed one, because there the two sides do agree and
 * the corroboration is worth having. Ordinal remains the selector throughout;
 * only a claim nobody made is skipped.
 */
export function findCdpFrameId(
  tree: CdpFrameNode,
  hops: FrameHop[],
): string | null {
  let node: CdpFrameNode = tree;
  for (const hop of hops) {
    const next = childForHop(node, hop);
    if (next === null) return null;
    node = next;
  }
  return node.frame.id;
}

/** One hop's worth of the walk above: index by global ordinal, then
 *  corroborate whatever the hop actually claimed. */
function childForHop(node: CdpFrameNode, hop: FrameHop): CdpFrameNode | null {
  const next = (node.childFrames ?? [])[hop.ordinal - 1];
  if (next === undefined) return null;
  if (hop.origin !== "" && originOf(next.frame.url) !== hop.origin) return null;
  if (hop.name !== "" && (next.frame.name ?? "") !== hop.name) return null;
  return next;
}

/**
 * Where the iframe element that owns a frame sits in its parent document's
 * `querySelectorAll("iframe")` order, 1-based — or null when that cannot be
 * established. The engine answers this over CDP; it is a port so the walk
 * below stays testable without a browser.
 */
export interface FrameOwnerLookup {
  documentOrdinalOf(frameId: string): Promise<number | null>;
}

/**
 * `findCdpFrameId`, with the ordinal corroborated for the hops that claim
 * nothing else.
 *
 * The ordinal capture assigns is **document** order — `hopsForChildren` reads
 * `querySelectorAll("iframe")`. `Page.getFrameTree`'s `childFrames` is
 * **attach** order. For a statically parsed page the two agree, which is why
 * indexing into `childFrames` works at all; for a JS-mounted frame they do
 * not. Measured against real Chromium: a frame appended by script ahead of a
 * static one in the document is reported *after* it in the tree, so document
 * order `[deep, named, late, static]` comes back as
 * `[deep, named, static, late]`. A JS-mounted iframe is the mainstream case
 * — `watchForLateFrames` exists in the sensor for exactly it.
 *
 * Where the hop records an origin or a name, that disagreement is caught by
 * the corroboration above. Where it records neither — two same-origin
 * `id`-only iframes, both relaxations skipping their checks — the ordinal is
 * the whole of the selection, and a disagreeing one names some other
 * document. So for those hops the frame's owner element is asked where it
 * actually sits, and a mismatch fails closed like every other one here.
 *
 * Failing closed rather than selecting by the answer: replay would then be
 * choosing frames by a rule capture's ordinals were never validated against,
 * on a path where nothing else corroborates it. A refusal is a reported
 * partial run; the alternative is a click in a document the author never
 * recorded.
 *
 * An owner lookup that cannot answer is also a refusal, for the same reason:
 * on these hops there is nothing else left to believe.
 */
export async function resolveCdpFrameId(
  tree: CdpFrameNode,
  hops: FrameHop[],
  owner: FrameOwnerLookup,
): Promise<string | null> {
  let node: CdpFrameNode = tree;
  for (const hop of hops) {
    const next = childForHop(node, hop);
    if (next === null) return null;
    if (hop.origin === "" && hop.name === "") {
      const ordinal = await owner.documentOrdinalOf(next.frame.id);
      if (ordinal !== hop.ordinal) return null;
    }
    node = next;
  }
  return node.frame.id;
}

/** DOM.getBoxModel quads are four corners in main-frame CSS pixels. A
 *  transformed element's quad is not axis-aligned, so bound it. */
export function rectFromQuad(quad: number[]): Rect {
  const xs = quad.filter((_, i) => i % 2 === 0);
  const ys = quad.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function rectCentre(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
