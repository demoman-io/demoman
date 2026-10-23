import type { FrameHop, PathSegment } from "@demoman/resolver";
import { parseTreePath, serializeTreePath } from "@demoman/resolver";

// How capture names a frame and rebases a path captured inside it: the
// input `resolveForReplay` reads. Copied 2026-10-20 from the extension's
// sensor (`apps/extension/src/sensor/hops.ts`, tag `archive/extension`),
// which produced it at record time; the replay side's half of the
// contract is `src/geometry.ts`.

/**
 * Hops are assigned downward, because a cross-origin child cannot read
 * window.frameElement and so cannot describe how to reach itself. The parent
 * computes each child's hop and posts it down.
 *
 * Mirrors the resolver's own frameHopFor/findFrameElement convention exactly:
 * document-wide iframe order for the ordinal, the name attribute verbatim,
 * and the origin of src resolved against the document's base URI.
 */
export function hopsForChildren(
  doc: Document,
): { frame: HTMLIFrameElement; hop: FrameHop }[] {
  return Array.from(doc.querySelectorAll("iframe")).map((frame, index) => {
    const src = frame.getAttribute("src") ?? "";
    let origin = "";
    try {
      origin = src === "" ? "" : new URL(src, doc.baseURI).origin;
    } catch {
      // An unparseable src identifies nothing; the name and ordinal still do.
      origin = "";
    }
    return {
      frame,
      hop: {
        origin,
        name: frame.getAttribute("name") ?? "",
        ordinal: index + 1,
      },
    };
  });
}

/**
 * Rebases a path captured inside a frame onto the top document, using the
 * resolver's own serializer so the grammar stays in one place.
 */
export function prefixTreePath(
  path: string | null,
  hops: FrameHop[],
): string | null {
  if (path === null || hops.length === 0) return path;
  const segments: PathSegment[] = [
    ...hops.map((hop) => ({ kind: "frame" as const, hop })),
    ...parseTreePath(path),
  ];
  return serializeTreePath(segments);
}
