// apps/studio/pages/src/library/selection.ts

/** The flows ticked for a bulk delete, and the card a shift-click ranges
 *  from (docs/superpowers/specs/2026-10-30-flows-and-bulk-delete-design.md
 *  §1.2). Ids are flow ids. */
export interface Selection {
  readonly ids: ReadonlySet<string>;
  anchor: string | null;
}

export const emptySelection = (): Selection => ({
  ids: new Set(),
  anchor: null,
});

/** A plain click flips `id` and becomes the anchor. A shift-click ticks
 *  every id between the anchor and `id` in `visibleOrder`, the cards the
 *  page shows; with no anchor there, it is a plain click, so it never ticks
 *  a range the author cannot see. */
export function clickSelect(
  s: Selection,
  id: string,
  shift: boolean,
  visibleOrder: readonly string[],
): Selection {
  const from = s.anchor === null ? -1 : visibleOrder.indexOf(s.anchor);
  const to = visibleOrder.indexOf(id);
  if (shift && from >= 0 && to >= 0) {
    const ids = new Set(s.ids);
    for (const v of visibleOrder.slice(
      Math.min(from, to),
      Math.max(from, to) + 1,
    )) {
      ids.add(v);
    }
    return { ids, anchor: s.anchor };
  }
  const ids = new Set(s.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
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
  };
}
