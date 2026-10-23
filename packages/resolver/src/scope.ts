import type { SceneAnchor } from "@demoman/scene-schema";
import { NO_SHADOW } from "./ports/shadow.js";
import { parseTreePath } from "./treepath.js";
import type { FrameHop, ResolveEnv } from "./types.js";

export const DATA_KEY_ATTRS = [
  "data-key",
  "data-row-key",
  "data-id",
  "data-item-id",
] as const;

/** Nearest ancestor data key: a row is identified by data, not position (v8 §7). */
export function readDataKey(el: Element): string | null {
  let node: Element | null = el;
  while (node !== null) {
    for (const attr of DATA_KEY_ATTRS) {
      const value = node.getAttribute(attr);
      if (value !== null && value.length > 0) return value;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * v8 §7: a list row is identified by its data key, never by position. The key
 * selects the row container; the ladder then runs inside it.
 */
export function findDataKeyRow(root: ParentNode, key: string): Element | null {
  const escaped = CSS.escape(key);
  const selector = DATA_KEY_ATTRS.map((a) => `[${a}="${escaped}"]`).join(",");
  return root.querySelector(selector);
}

/**
 * Resolves the dataKey scope for ranking: the given root as-is when the
 * fingerprint carries no dataKey; the row container when it does and the row
 * is present; or null when the row is genuinely absent (callers report
 * notInTree for that case).
 *
 * Searches across every root the document contains, including shadow roots —
 * `root.querySelector` alone never pierces one, so a row inside a shadow
 * tree would otherwise be reported absent even though it is right there.
 */
export function scopeToDataKey(
  root: Document,
  dataKey: string | null,
  env: ResolveEnv,
): (ParentNode & Node) | null {
  if (dataKey === null) return root;
  const row = searchRoots(root, env)
    .map((r) => findDataKeyRow(r, dataKey))
    .find((el): el is Element => el !== null);
  return row ?? null;
}

/**
 * Every root the ladder should search: the given root plus every shadow root
 * beneath it, open or registry-known-closed, recursively.
 */
export function searchRoots(root: ParentNode, env: ResolveEnv): ParentNode[] {
  const shadow = env.shadow ?? NO_SHADOW;
  const out: ParentNode[] = [root];
  const walk = (scope: ParentNode) => {
    for (const el of Array.from(scope.querySelectorAll("*"))) {
      const sub = el.shadowRoot ?? shadow.getClosedRoot(el);
      if (sub !== null) {
        out.push(sub);
        walk(sub);
      }
    }
  };
  walk(root);
  return out;
}

/** True iff the element hosts a shadow root we cannot see into. */
export function hasOpaqueShadow(root: ParentNode, env: ResolveEnv): boolean {
  const shadow = env.shadow ?? NO_SHADOW;
  return Array.from(root.querySelectorAll("*")).some((el) => {
    if (el.shadowRoot !== null || shadow.getClosedRoot(el) !== null)
      return false;
    // A custom element with no reachable root is the closed-root signature.
    return el.tagName.includes("-");
  });
}

/**
 * Whether this anchor was captured inside a shadow root. Evidence rather than
 * inference: capture records a #shadow segment in the path if and only if it
 * walked out through one.
 */
export function wasCapturedInShadow(fp: SceneAnchor["fingerprint"]): boolean {
  if (fp.treePath === null) return false;
  try {
    return parseTreePath(fp.treePath).some((seg) => seg.kind === "shadow");
  } catch {
    // A malformed path costs this signal, not the whole resolution.
    return false;
  }
}

/** Frame documents this context may legally touch. */
export function sameOriginFrames(root: ParentNode): Document[] {
  const out: Document[] = [];
  for (const frame of Array.from(root.querySelectorAll("iframe,frame"))) {
    try {
      const doc = (frame as HTMLIFrameElement).contentDocument;
      if (doc !== null) out.push(doc);
    } catch {
      // Cross-origin: not ours to read. The broker handles it.
    }
  }
  return out;
}

function frameOrigin(f: HTMLIFrameElement, base: string): string {
  try {
    return f.src === "" ? "" : new URL(f.src, base).origin;
  } catch {
    return "";
  }
}

/**
 * Finds the iframe a hop refers to. Scores every candidate against all three
 * hop fields (name, origin, ordinal) rather than committing to the first
 * name match: two same-named iframes are legal HTML, and picking the
 * DOM-order-first one would silently resolve an anchor against a stranger's
 * document. A tie for the best score means the hop cannot tell the
 * candidates apart, so no guess is better than a wrong one — mirroring
 * breakTie's rule that no winner beats a wrong winner.
 *
 * Ordinal is a positional signal, not an identifying one. When the hop also
 * carries a name or origin, a candidate that matches on ordinal alone is
 * rejected outright rather than scored — an unrelated frame at the recorded
 * index is not evidence the named frame moved there, it's evidence the named
 * frame is gone. When the hop carries neither (an anonymous frame), ordinal
 * is all there ever was, so it may still match alone.
 */
export function findFrameElement(
  root: ParentNode & { baseURI?: string },
  hop: FrameHop,
): HTMLIFrameElement | null {
  const base = root.baseURI ?? location.href;
  const frames = Array.from(root.querySelectorAll("iframe"));
  const hopHasIdentifyingSignal = hop.name !== "" || hop.origin !== "";
  const scored = frames
    .map((f, index) => {
      const nameMatch = hop.name !== "" && f.getAttribute("name") === hop.name;
      const originMatch =
        hop.origin !== "" && frameOrigin(f, base) === hop.origin;
      let score = 0;
      if (nameMatch) score += 1;
      if (originMatch) score += 1;
      if (index + 1 === hop.ordinal) score += 1;
      return { frame: f, score, nameMatch, originMatch };
    })
    .filter((c) => !hopHasIdentifyingSignal || c.nameMatch || c.originMatch);
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1];
  if (best === undefined || best.score === 0) return null;
  // Two frames the hop cannot tell apart: report the frame gone rather than
  // resolve the anchor against a stranger's document.
  if (runnerUp !== undefined && runnerUp.score === best.score) return null;
  return best.frame;
}
