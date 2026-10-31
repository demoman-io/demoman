// apps/studio/pages/src/library/selection.ts

/** The ids ticked in a library, the row a range grows from, and the ids the
 *  last range added (so the next range can take them back, as Finder's
 *  Shift+arrow shrinks). Ids are flow ids
 *  (docs/superpowers/specs/2026-10-31-library-list-view-design.md §4.2). */
export interface Selection {
  readonly ids: ReadonlySet<string>;
  anchor: string | null;
  range: readonly string[];
}

export type SelectHow = "toggle" | "range";

export const emptySelection = (): Selection => ({
  ids: new Set(),
  anchor: null,
  range: [],
});

/** "toggle" flips `id` and makes it the anchor. "range" replaces the last
 *  range with anchor..`id` over `visibleOrder`, the rows the page shows.
 *  With no anchor there, `start` is the anchor (Shift+arrow passes the row
 *  it moved from, as Finder ranges from it); without one either it is a
 *  toggle, so it never ticks a range the author cannot see. */
export function clickSelect(
  s: Selection,
  id: string,
  how: SelectHow,
  visibleOrder: readonly string[],
  start?: string,
): Selection {
  const anchor =
    s.anchor !== null && visibleOrder.includes(s.anchor)
      ? s.anchor
      : (start ?? null);
  const from = anchor === null ? -1 : visibleOrder.indexOf(anchor);
  const to = visibleOrder.indexOf(id);
  if (how === "range" && from >= 0 && to >= 0) {
    const ids = new Set(s.ids);
    for (const v of s.range) ids.delete(v);
    const range: string[] = [];
    for (const v of visibleOrder.slice(
      Math.min(from, to),
      Math.max(from, to) + 1,
    )) {
      if (!ids.has(v)) {
        ids.add(v);
        range.push(v);
      }
    }
    return { ids, anchor, range };
  }
  const ids = new Set(s.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id, range: [] };
}

/** Cmd+A: every row on the page ticked; the anchor stays. */
export function selectAll(
  s: Selection,
  visibleOrder: readonly string[],
): Selection {
  return {
    ids: new Set([...s.ids, ...visibleOrder]),
    anchor: s.anchor,
    range: [],
  };
}

/** Drops ids no longer on the page — a flow another window or an agent
 *  deleted — and the anchor with them. */
export function pruneSelection(
  s: Selection,
  present: ReadonlySet<string>,
): Selection {
  return {
    ids: new Set([...s.ids].filter((id) => present.has(id))),
    anchor: s.anchor !== null && present.has(s.anchor) ? s.anchor : null,
    range: s.range.filter((id) => present.has(id)),
  };
}
