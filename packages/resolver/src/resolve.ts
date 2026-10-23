import { runLadder, runPatchTier } from "./ladder.js";
import { findFrameElement } from "./scope.js";
import { parseTreePath } from "./treepath.js";
import type {
  AnchorIntent,
  FrameHop,
  ResolutionReport,
  ResolveEnv,
} from "./types.js";

const failed = (
  anchor: AnchorIntent,
  failureReason: ResolutionReport["failureReason"],
): ResolutionReport => ({
  anchorId: anchor.id,
  strategy: "broken",
  element: null,
  candidates: 0,
  failureReason,
  corroboration: [],
  durationMs: 0,
});

/** The frame an anchor lives behind, or null when it is in this document. */
function frameHopOf(anchor: AnchorIntent): FrameHop | null {
  const path = anchor.fingerprint.treePath;
  if (path === null) return null;
  try {
    const seg = parseTreePath(path).find((s) => s.kind === "frame");
    return seg !== undefined && seg.kind === "frame" ? seg.hop : null;
  } catch {
    // A malformed path costs this signal, not the whole resolution: treat
    // the anchor as unframed. The ladder's own treePath tier guards its own
    // parseTreePath call, so nothing downstream re-throws on this path.
    return null;
  }
}

type FrameTarget =
  | { kind: "document"; doc: Document }
  | { kind: "broker" }
  | { kind: "failed"; reason: "frameGone" | "frameUnreachable" };

function frameTarget(hop: FrameHop, env: ResolveEnv): FrameTarget {
  const frameEl = findFrameElement(env.root, hop);
  if (frameEl === null) return { kind: "failed", reason: "frameGone" };
  try {
    const doc = frameEl.contentDocument;
    if (doc !== null) return { kind: "document", doc };
  } catch {
    // Cross-origin. Not ours to read; the broker handles it.
  }
  return env.frames === undefined
    ? { kind: "failed", reason: "frameUnreachable" }
    : { kind: "broker" };
}

/** Tiers 1–4, then the pixel tier if they came back broken for no better reason. */
async function runLocal(
  anchor: AnchorIntent,
  doc: Document,
  env: ResolveEnv,
): Promise<ResolutionReport> {
  const started = performance.now();
  const report = runLadder(anchor, doc, { ...env, root: doc });
  if (report.strategy !== "broken" || report.failureReason !== null)
    return report;
  const patched = await runPatchTier(
    anchor,
    doc,
    { ...env, root: doc },
    started,
  );
  return patched ?? report;
}

export async function resolveAnchor(
  anchor: AnchorIntent,
  env: ResolveEnv,
): Promise<ResolutionReport> {
  const hop = frameHopOf(anchor);
  if (hop === null) return runLocal(anchor, env.root, env);

  const target = frameTarget(hop, env);
  if (target.kind === "failed") return failed(anchor, target.reason);
  if (target.kind === "document") {
    return runLocal(anchor, target.doc, env);
  }
  const [report] = await resolveBatch(hop, [anchor], env);
  return report ?? failed(anchor, "frameGone");
}

async function resolveBatch(
  hop: FrameHop,
  group: AnchorIntent[],
  env: ResolveEnv,
): Promise<ResolutionReport[]> {
  if (env.frames === undefined)
    return group.map((a) => failed(a, "frameUnreachable"));
  try {
    const reports = await env.frames.resolveInFrame(hop, group);
    return group.map((a, i) => reports[i] ?? failed(a, "frameUnreachable"));
  } catch {
    // The frame element is present -- reaching it through the broker is what
    // failed, not the frame itself. "frameGone" is reserved for when
    // findFrameElement can't find the element at all.
    return group.map((a) => failed(a, "frameUnreachable"));
  }
}

type Entry = { index: number; anchor: AnchorIntent };
type DocEntry = Entry & { doc: Document };

/**
 * For the badge, which re-resolves a whole scene at once. Anchors behind the
 * same cross-origin frame are grouped so that frame costs one broker round
 * trip, not one per anchor. Order of the returned reports matches `anchors`.
 *
 * Keyed by array index, not anchor id: `SceneDocumentSchema` does not
 * require anchor ids to be unique, and keying by id would let two anchors
 * that happen to share one silently collapse onto a single, timing-dependent
 * report.
 */
export async function resolveAll(
  anchors: AnchorIntent[],
  env: ResolveEnv,
): Promise<ResolutionReport[]> {
  const local: Entry[] = [];
  const sameOrigin: DocEntry[] = [];
  const brokered = new Map<string, { hop: FrameHop; entries: Entry[] }>();
  const out: ResolutionReport[] = [];

  anchors.forEach((anchor, index) => {
    const hop = frameHopOf(anchor);
    if (hop === null) {
      local.push({ index, anchor });
      return;
    }
    const target = frameTarget(hop, env);
    if (target.kind === "failed") {
      out[index] = failed(anchor, target.reason);
    } else if (target.kind === "document") {
      sameOrigin.push({ index, anchor, doc: target.doc });
    } else {
      const key = `${hop.origin}|${hop.name}|${hop.ordinal}`;
      const bucket = brokered.get(key);
      if (bucket === undefined)
        brokered.set(key, { hop, entries: [{ index, anchor }] });
      else bucket.entries.push({ index, anchor });
    }
  });

  await Promise.all(
    local.map(async ({ index, anchor }) => {
      out[index] = await resolveAnchor(anchor, env);
    }),
  );
  await Promise.all(
    sameOrigin.map(async ({ index, anchor, doc }) => {
      out[index] = await runLocal(anchor, doc, env);
    }),
  );
  await Promise.all(
    Array.from(brokered.values()).map(async ({ hop, entries }) => {
      const reports = await resolveBatch(
        hop,
        entries.map((e) => e.anchor),
        env,
      );
      entries.forEach((e, i) => {
        out[e.index] = reports[i] ?? failed(e.anchor, "frameGone");
      });
    }),
  );

  return anchors.map(
    (anchor, index) => out[index] ?? failed(anchor, "frameGone"),
  );
}
