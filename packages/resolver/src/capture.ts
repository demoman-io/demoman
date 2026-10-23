import type { SceneAnchor } from "@demoman/scene-schema";
import { computeName, computeRole } from "./accessibility.js";
import { readStableId } from "./identifiers.js";
import { resolveAnchor } from "./resolve.js";
import { readDataKey } from "./scope.js";
import { isTextLeaf, normalizeText } from "./text.js";
import { buildTreePath, serializeTreePath } from "./treepath.js";
import type { CaptureContext, CapturedAnchor, ResolveEnv } from "./types.js";

function rectOf(el: Element): SceneAnchor["fingerprint"]["boundingRect"] {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/**
 * Captures the fingerprint bundle, then immediately resolves it back. The
 * round trip is the self-check, and its report is the capture-time anchor
 * health SP4 shows the author.
 */
export async function captureAnchor(
  el: Element,
  ctx: CaptureContext,
  env: ResolveEnv,
): Promise<CapturedAnchor> {
  // Paths are rooted at the caller's top document, not at el.ownerDocument, so
  // an element inside a frame records the hop that gets back to it.
  const root = env.root;
  const anchor: SceneAnchor = {
    id: ctx.anchorId,
    fingerprint: {
      stableId: readStableId(el),
      role: computeRole(el),
      accessibleName: computeName(el),
      // Only text leaves carry text — see `isTextLeaf`.
      textContent: isTextLeaf(el) ? normalizeText(el.textContent) : null,
      treePath: serializeTreePath(buildTreePath(el, root)),
      boundingRect: rectOf(el),
      imagePatchRef: env.patch ? await env.patch.capture(el) : null,
      dataKey: readDataKey(el),
    },
    resolution: {
      url: ctx.url,
      actionIndex: ctx.actionIndex,
      entryState: ctx.entryState,
      strategy: "broken",
      failureReason: null,
      candidates: 0,
    },
  };

  // Self-verify through resolveAnchor, not runLadder, so an element inside a
  // frame is checked the same way SP4 and SP8 will later resolve it.
  const report = await resolveAnchor(anchor, { ...env, root });
  anchor.resolution.strategy = report.strategy;
  anchor.resolution.failureReason = report.failureReason;
  anchor.resolution.candidates = report.candidates;
  return { anchor, report };
}
