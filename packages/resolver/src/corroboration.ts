import type { SceneAnchor } from "@demoman/scene-schema";
import { computeName, computeRole } from "./accessibility.js";
import { normalizeText } from "./text.js";
import { buildTreePath, parseTreePath, serializeTreePath } from "./treepath.js";
import type { CorroborationSignal } from "./types.js";

type Fingerprint = SceneAnchor["fingerprint"];

/** Rects drift with layout; this is a coarse "same neighbourhood" test. */
const RECT_TOLERANCE_PX = 24;

/**
 * For a framed anchor, root is the frame document, so buildTreePath(el, root)
 * can never carry the #frame hop that fp.treePath always does -- comparing
 * them would be a guaranteed false negative, not evidence of drift. Detected
 * by whether the fingerprint's own recorded path crossed a frame boundary.
 */
function fingerprintCrossedFrame(path: string): boolean {
  try {
    return parseTreePath(path).some((seg) => seg.kind === "frame");
  } catch {
    // A malformed path costs this signal, not the whole resolution.
    return false;
  }
}

export function scoreCandidate(
  el: Element,
  fp: Fingerprint,
  root: Document,
): CorroborationSignal[] {
  const signals: CorroborationSignal[] = [];

  if (fp.role !== null) {
    signals.push({ signal: "role", agreed: computeRole(el) === fp.role });
  }
  if (fp.accessibleName !== null) {
    signals.push({
      signal: "name",
      agreed: computeName(el) === fp.accessibleName,
    });
  }
  if (fp.textContent !== null) {
    signals.push({
      signal: "text",
      agreed: normalizeText(el.textContent) === normalizeText(fp.textContent),
    });
  }
  // Omitted, not scored, when the fingerprint's own path crossed a frame
  // boundary: root is the frame document there, so the rebuilt path can
  // never carry the #frame hop fp.treePath does, and the comparison would
  // always disagree regardless of drift. Same treatment as every other null
  // field above -- an unavailable signal is left out, not reported false.
  if (fp.treePath !== null && !fingerprintCrossedFrame(fp.treePath)) {
    signals.push({
      signal: "path",
      agreed: serializeTreePath(buildTreePath(el, root)) === fp.treePath,
    });
  }
  if (fp.boundingRect !== null) {
    const r = el.getBoundingClientRect();
    const near =
      Math.abs(r.x - fp.boundingRect.x) <= RECT_TOLERANCE_PX &&
      Math.abs(r.y - fp.boundingRect.y) <= RECT_TOLERANCE_PX;
    signals.push({ signal: "rect", agreed: near });
  }
  return signals;
}

/**
 * Breaks a within-tier tie. Deliberately refuses to guess: if the best score is
 * shared, there is no winner and the ladder falls through to the next tier.
 */
export function breakTie(
  candidates: Element[],
  fp: Fingerprint,
  root: Document,
): { winner: Element | null; signals: CorroborationSignal[] } {
  const first = candidates[0];
  if (first === undefined) return { winner: null, signals: [] };
  if (candidates.length === 1) {
    return { winner: first, signals: scoreCandidate(first, fp, root) };
  }

  const scored = candidates.map((el) => {
    const signals = scoreCandidate(el, fp, root);
    return { el, signals, score: signals.filter((s) => s.agreed).length };
  });
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (best === undefined) return { winner: null, signals: [] };
  if (runnerUp !== undefined && runnerUp.score === best.score) {
    return { winner: null, signals: best.signals };
  }
  return { winner: best.el, signals: best.signals };
}
