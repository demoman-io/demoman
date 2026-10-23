import type { StrategyName } from "@demoman/scene-schema";
import type { HealthSummary, ResolutionReport } from "./types.js";

const EMPTY: Record<StrategyName, number> = {
  stableId: 0,
  roleName: 0,
  text: 0,
  treePath: 0,
  imagePatch: 0,
  ambiguous: 0,
  broken: 0,
};

/**
 * v8 §4: the take's summary is surfaced immediately, because setting the
 * expectation before the first alert is worth more than any threshold.
 */
export function anchorHealth(reports: ResolutionReport[]): HealthSummary {
  const byStrategy = { ...EMPTY };
  for (const r of reports) byStrategy[r.strategy] += 1;

  const total = reports.length;
  const strong = byStrategy.stableId;
  // Weaker-but-resolved: the anchor is in the tree and was found, just not by
  // stable ID. Unresolved: broken or ambiguous -- the anchor did not resolve
  // at all, which "fell back to a weaker fingerprint" would overstate.
  const weak =
    byStrategy.roleName +
    byStrategy.text +
    byStrategy.treePath +
    byStrategy.imagePatch;
  const unresolved = byStrategy.broken + byStrategy.ambiguous;

  let sentence: string;
  if (total === 0) {
    sentence = "no anchors captured";
  } else if (strong === total) {
    sentence = `${strong} of ${total} anchors matched by stable ID — this demo is in good shape`;
  } else if (unresolved === total) {
    sentence = `0 of ${total} anchors matched by stable ID — none of them resolved; check this take before you rely on it`;
  } else if (unresolved === 0 && strong === 0) {
    sentence = `0 of ${total} anchors matched by stable ID — all resolved by weaker fingerprints; drift alerts on this app will be noisier`;
  } else if (unresolved === 0) {
    sentence = `${strong} of ${total} anchors matched by stable ID — ${weak} fell back to weaker fingerprints`;
  } else if (weak === 0) {
    sentence = `${strong} of ${total} anchors matched by stable ID — ${unresolved} did not resolve at all`;
  } else {
    sentence = `${strong} of ${total} anchors matched by stable ID — ${weak} fell back to weaker fingerprints, ${unresolved} did not resolve at all`;
  }

  // Derived from the same three counts the sentence branches on, so the row
  // and the sentence can never disagree about what happened.
  const short =
    total === 0
      ? "no anchors captured"
      : strong === total
        ? `all ${total} strong`
        : unresolved === total
          ? "none resolved"
          : `${strong} of ${total} strong`;

  return { total, byStrategy, sentence, short };
}
