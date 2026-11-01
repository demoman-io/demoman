// apps/studio/pages/src/library/list-model.ts
//
// The library's list view as data: the entries a treegrid draws, in order.
// Spec 2026-10-31-library-list-view-design §2.1–2.3 and §3.
import type { LibrarySortColumn } from "@demoman/studio-protocol";
import type {
  LibraryCard,
  LibraryModel,
  LibraryRow,
  LibrarySection,
} from "./state";
import { cardsOf, repoLabel, sectionsOf } from "./state";

export type { LibrarySortColumn };

export interface ListSort {
  column: LibrarySortColumn;
  descending: boolean;
}

/** Text columns start ascending; the rest biggest, longest, newest first. */
export const firstClickDescending = (c: LibrarySortColumn): boolean =>
  c !== "name" && c !== "where";

export function nextSort(
  current: ListSort,
  clicked: LibrarySortColumn,
): ListSort {
  return current.column === clicked
    ? { column: clicked, descending: !current.descending }
    : { column: clicked, descending: firstClickDescending(clicked) };
}

/** `repo · host/path`, the card's where-line without its time. */
export function whereOf(card: LibraryCard, withRepo: boolean): string {
  const repo =
    !withRepo || card.group === null ? null : repoLabel(card.group.video.repo);
  return `${repo === null ? "" : `${repo} · `}${card.row.origin}${card.row.path}`;
}

export type FlowSize =
  | { kind: "known"; bytes: number; unmeasured: number }
  | { kind: "unknown" };

/** The sum of the flow's videos; a video with no size is unknown, never 0. */
export function flowSize(card: LibraryCard): FlowSize {
  const rows = card.group === null ? [card.row] : card.group.versions;
  const known = rows.flatMap((r) =>
    r.sizeBytes === undefined ? [] : [r.sizeBytes],
  );
  return known.length === 0
    ? { kind: "unknown" }
    : {
        kind: "known",
        bytes: known.reduce((a, b) => a + b, 0),
        unmeasured: rows.length - known.length,
      };
}

const labelOf = (c: LibraryCard): string =>
  c.group === null ? c.row.label : c.group.video.name || c.row.label;
const timeOf = (c: LibraryCard): number => {
  const t = Date.parse(c.row.createdAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};
const countOf = (c: LibraryCard): number => c.group?.versions.length ?? 1;

/** A comparable value, or null when unknown (sorts last both ways). */
function keyOf(
  c: LibraryCard,
  column: LibrarySortColumn,
): number | string | null {
  switch (column) {
    case "name":
      return labelOf(c);
    case "where":
      return whereOf(c, true);
    case "videos":
      return countOf(c);
    case "recorded":
      return Number.isFinite(timeOf(c)) ? timeOf(c) : null;
    case "size": {
      const s = flowSize(c);
      return s.kind === "known" ? s.bytes : null;
    }
  }
}

export function sortCards(
  cards: readonly LibraryCard[],
  sort: ListSort,
): LibraryCard[] {
  const dir = sort.descending ? -1 : 1;
  return [...cards].sort((a, b) => {
    const x = keyOf(a, sort.column);
    const y = keyOf(b, sort.column);
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1;
    } else if (x !== y) {
      const c =
        typeof x === "string"
          ? x.localeCompare(y as string, undefined, { numeric: true })
          : x - (y as number);
      if (c !== 0) return c * dir;
    }
    return timeOf(b) - timeOf(a);
  });
}

export type ListEntry =
  | {
      kind: "heading";
      key: string;
      parent: null;
      level: 1;
      section: LibrarySection;
    }
  | {
      kind: "flow";
      key: string;
      parent: string | null;
      level: 1 | 2;
      card: LibraryCard;
      flowId: string | null;
      namesDay: boolean;
      size: FlowSize;
    }
  | {
      kind: "video";
      key: string;
      parent: string;
      level: 2 | 3;
      row: LibraryRow;
      flowId: string;
    };

export function listEntries(
  model: LibraryModel,
  sort: ListSort,
  now: Date,
): ListEntry[] {
  const cards = cardsOf(model);
  const out: ListEntry[] = [];
  const addFlow = (
    card: LibraryCard,
    parent: string | null,
    namesDay: boolean,
  ): void => {
    const level = parent === null ? 1 : 2;
    const { group } = card;
    const key =
      group === null ? `t:${card.row.sceneId}` : `f:${group.video.id}`;
    out.push({
      kind: "flow",
      key,
      parent,
      level,
      card,
      flowId: group === null ? null : group.video.id,
      namesDay,
      size: flowSize(card),
    });
    for (const row of group?.versions ?? []) {
      out.push({
        kind: "video",
        key: `v:${row.sceneId}`,
        parent: key,
        level: level === 1 ? 2 : 3,
        row,
        flowId: (group as NonNullable<typeof group>).video.id,
      });
    }
  };
  if (sort.column === "recorded" && sort.descending) {
    const sorted = sortCards(cards, sort);
    const byLead = new Map(sorted.map((c) => [c.row.sceneId, c]));
    for (const section of sectionsOf(
      sorted.map((c) => c.row),
      now,
    )) {
      const key = `h:${section.key}`;
      out.push({ kind: "heading", key, parent: null, level: 1, section });
      for (const r of section.rows) {
        addFlow(byLead.get(r.sceneId) as LibraryCard, key, section.namesDay);
      }
    }
  } else {
    for (const card of sortCards(cards, sort)) addFlow(card, null, false);
  }
  return out;
}
