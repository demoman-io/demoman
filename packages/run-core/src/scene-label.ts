// packages/run-core/src/scene-label.ts
import type { SceneDocument } from "@demoman/scene-schema";

/**
 * A name for a take wherever one is required — a share's title on the
 * server, a review card's sentence: its own name, else where it started.
 */
export function sceneLabel(meta: SceneDocument["meta"]): string {
  if (meta.name.trim() !== "") return meta.name;
  try {
    const url = new URL(meta.capture.originUrl);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host}${path}`;
  } catch {
    // `originUrl` is schema-validated as a URL, so this is unreachable for
    // a stored document; the raw string is still a truthful label.
    return meta.capture.originUrl;
  }
}
