import type { SceneDocument } from "./document.js";

/**
 * The steps a removed piece takes out of the video, from the document alone.
 *
 * A step is inside when its own instant falls in the stretch: half-open at
 * the start (a range opening exactly on a step's instant takes it, as a
 * step cut did) and open at the end unless the end reaches past the end
 * step's instant. Frameless on purpose: `planScene` and `derive` have no
 * frames to measure against. A range naming a step the log does not hold
 * takes nothing here; the compositor names it when it resolves.
 */
export function stepsInsideRemoved(doc: SceneDocument): Set<string> {
  const index = new Map(doc.actions.map((a, i) => [a.id, i] as const));
  const inside = new Set<string>();
  for (const range of doc.edits.removed ?? []) {
    const s = range.start === null ? null : index.get(range.start.actionId);
    const e = range.end === null ? null : index.get(range.end.actionId);
    if (s === undefined || e === undefined) continue;
    doc.actions.forEach((action, i) => {
      const afterStart =
        range.start === null ||
        s === null ||
        s < i ||
        (i === s && range.start.sourceOffsetMs <= 0);
      const beforeEnd =
        range.end === null ||
        e === null ||
        i < e ||
        (i === e && range.end.sourceOffsetMs > 0);
      if (afterStart && beforeEnd) inside.add(action.id);
    });
  }
  return inside;
}
