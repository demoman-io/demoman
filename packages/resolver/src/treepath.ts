import type { FrameHop, PathSegment } from "./types.js";

// The tag is whatever the platform reports as the element's name, lowercased
// — a custom element may carry "_", "." or non-ASCII letters, and an XML
// name a ":" — so the grammar claims only what the path itself reserves:
// "/" separates steps, and the LAST ":" separates the tag from its ordinal.
// Before 2026-09-06 this was `[a-z][a-z0-9-]*`, every consumer swallowed the
// parse error, and `<my-widget_v2>` lost its tree-path tier for good.
const STEP = /^([^/]+):([1-9][0-9]*)$/;
const FRAME = /^#frame\(origin=([^,]*),name=([^,]*),ordinal=([1-9][0-9]*)\)$/;

const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

// instanceof is realm-bound: an element inside an iframe document fails
// `instanceof Element` against this realm's constructor. nodeType is not.
const isElement = (n: Node): n is Element => n.nodeType === ELEMENT_NODE;
const isDocument = (n: Node): n is Document => n.nodeType === DOCUMENT_NODE;
const isShadowRoot = (n: Node): n is ShadowRoot =>
  n.nodeType === DOCUMENT_FRAGMENT_NODE && "host" in n;

// Frame hop values are author-controlled: an iframe name may legally contain
// "," or ")", which are this grammar's delimiters. Escape just those (and "%"
// itself, so the mapping stays reversible) rather than percent-encoding the
// whole value — a readable `origin=https://js.stripe.com` is worth keeping.
const escapeHopValue = (v: string): string =>
  v.replace(
    /[%,()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );

const unescapeHopValue = (v: string): string =>
  v.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

export function serializeTreePath(segs: PathSegment[]): string {
  return segs
    .map((seg) => {
      if (seg.kind === "element") return `${seg.tag}:${seg.nth}`;
      if (seg.kind === "shadow") return "#shadow";
      const { origin, name, ordinal } = seg.hop;
      return `#frame(origin=${escapeHopValue(origin)},name=${escapeHopValue(name)},ordinal=${ordinal})`;
    })
    .join("/");
}

/**
 * Splits a path into its segments. Not a plain `split("/")`: a frame hop's
 * origin (e.g. "https://js.stripe.com") itself contains "/", so a naive
 * split would shred it. A "#frame(" segment instead runs to its closing ")".
 */
function splitSegments(path: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < path.length) {
    let end: number;
    if (path.startsWith("#frame(", i)) {
      const close = path.indexOf(")", i);
      if (close === -1)
        throw new Error(`malformed tree-path step: "${path.slice(i)}"`);
      end = close + 1;
    } else {
      const slash = path.indexOf("/", i);
      end = slash === -1 ? path.length : slash;
    }
    parts.push(path.slice(i, end));
    i = path[end] === "/" ? end + 1 : end;
  }
  return parts;
}

export function parseTreePath(path: string): PathSegment[] {
  return splitSegments(path).map((raw) => {
    if (raw === "#shadow") return { kind: "shadow" } as const;
    const frame = FRAME.exec(raw);
    if (frame !== null) {
      const hop: FrameHop = {
        origin: unescapeHopValue(frame[1] ?? ""),
        name: unescapeHopValue(frame[2] ?? ""),
        ordinal: Number(frame[3]),
      };
      return { kind: "frame", hop } as const;
    }
    const step = STEP.exec(raw);
    if (step === null) throw new Error(`malformed tree-path step: "${raw}"`);
    return {
      kind: "element",
      tag: (step[1] ?? "").toLowerCase(),
      nth: Number(step[2]),
    } as const;
  });
}

function frameHopFor(doc: Document): PathSegment {
  const frameEl = doc.defaultView?.frameElement ?? null;
  const name = frameEl?.getAttribute("name") ?? "";
  const src = frameEl?.getAttribute("src") ?? "";
  let origin = "";
  try {
    origin = src === "" ? "" : new URL(src, doc.baseURI).origin;
  } catch {
    origin = "";
  }
  const siblings =
    frameEl?.ownerDocument.querySelectorAll(frameEl.tagName.toLowerCase()) ??
    [];
  const ordinal = Array.from(siblings).indexOf(frameEl as Element) + 1;
  return {
    kind: "frame",
    hop: { origin, name, ordinal: Math.max(ordinal, 1) },
  };
}

function nthAmongTag(el: Element): number {
  const parent = el.parentNode;
  if (parent === null) return 1;
  let n = 0;
  for (const child of Array.from(parent.children)) {
    if (child.tagName === el.tagName) {
      n += 1;
      if (child === el) return n;
    }
  }
  return 1;
}

export function buildTreePath(el: Element, root: Document): PathSegment[] {
  const segs: PathSegment[] = [];
  let node: Node | null = el;
  while (node !== null && node !== root) {
    if (isElement(node)) {
      // The documentElement is implicit — followTreePath starts there — so no
      // redundant leading "html:1" ever enters a scene document.
      if (node.parentNode !== null && isDocument(node.parentNode)) {
        node = node.parentNode;
        continue;
      }
      segs.unshift({
        kind: "element",
        tag: node.tagName.toLowerCase(),
        nth: nthAmongTag(node),
      });
      node = node.parentNode;
      continue;
    }
    if (isShadowRoot(node)) {
      segs.unshift({ kind: "shadow" });
      node = node.host;
      continue;
    }
    if (isDocument(node)) {
      // The hop already identifies the iframe, so skip past the element itself
      // rather than recording it twice.
      segs.unshift(frameHopFor(node));
      node = node.defaultView?.frameElement?.parentNode ?? null;
      continue;
    }
    node = node.parentNode;
  }
  return segs;
}

/**
 * Walks the path within one document. Shadow and frame hops are *scope*
 * changes, handled by scope.ts — here they simply end the walk, because a
 * caller that reaches one has been handed the wrong root.
 */
export function followTreePath(
  segs: PathSegment[],
  root: ParentNode,
): Element | null {
  // A Document's only element child is <html>, which paths omit — start there.
  const asNode = root as unknown as Node;
  let current: ParentNode | null =
    asNode.nodeType === DOCUMENT_NODE
      ? (asNode as Document).documentElement
      : root;
  if (current === null) return null;
  for (const seg of segs) {
    if (seg.kind !== "element" || current === null) return null;
    const matches: Element[] = Array.from(current.children).filter(
      (c) => c.tagName.toLowerCase() === seg.tag,
    );
    const next: Element | undefined = matches[seg.nth - 1];
    if (next === undefined) return null;
    current = next;
  }
  const finalNode = current as unknown as Node;
  return isElement(finalNode) ? finalNode : null;
}
