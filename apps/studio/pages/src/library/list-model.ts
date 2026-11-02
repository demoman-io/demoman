// apps/studio/pages/src/library/list-model.ts
//
// The library's list view as data: the entries a treegrid draws, in order.
// Spec 2026-10-31-library-list-view-design §2.1–2.3 and §3.
import type { LibrarySortColumn } from "@demoman/studio-protocol";
import { projectKeyOf } from "./projects";
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

/** A host as Where names it: a loopback one by its port alone (`:3001`),
 *  any other whole. */
export function hostLabel(origin: string): string {
  return (
    /^(?:localhost|127\.0\.0\.1|\[::1\])(:\d+)$/.exec(origin)?.[1] ?? origin
  );
}

/** `repo · host/route`, the card's where-line without its time: the repo
 *  when `withRepo` and known, the host when asked for (`short` as
 *  `hostLabel` names it), and the route the flow opened on, `/` for the
 *  home page. */
export function whereOf(
  card: LibraryCard,
  withRepo: boolean,
  host: "short" | "whole" | null,
): string {
  const repo =
    !withRepo || card.group === null ? null : repoLabel(card.group.video.repo);
  const { origin, path } = card.row;
  const at = host === null ? "" : host === "short" ? hostLabel(origin) : origin;
  return `${repo === null ? "" : `${repo} · `}${at}${path || "/"}`;
}

/** What Where says for a card, and its whole host for the title. */
export type Where = (card: LibraryCard) => { text: string; title: string };

/** Where for `cards` drawn together (2026-11-02): the route, and the host
 *  only where it tells flows apart. Under No project the site is what
 *  does; in a project, only when its flows here ran on more than one
 *  host (the admin app on another port, the production site). */
export function whereFor(
  cards: readonly LibraryCard[],
  withRepo: boolean,
): Where {
  const hosts = new Map<string, Set<string>>();
  for (const c of cards) {
    const k = projectKeyOf(c);
    if (k !== null) {
      hosts.set(k, (hosts.get(k) ?? new Set<string>()).add(c.row.origin));
    }
  }
  return (card) => {
    const k = projectKeyOf(card);
    const many = k === null || (hosts.get(k)?.size ?? 0) > 1;
    return {
      text: whereOf(card, withRepo, many ? "short" : null),
      title: whereOf(card, withRepo, "whole"),
    };
  };
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
): number | string | readonly string[] | null {
  switch (column) {
    case "name":
      return labelOf(c);
    case "where":
      // Project, then route, then host: every `/checkout` together, the
      // local one beside the production one.
      return [projectKeyOf(c) ?? "", c.row.path || "/", c.row.origin];
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

/** Part by part, the first that differs. */
function textCompare(x: readonly string[], y: readonly string[]): number {
  for (let i = 0; i < x.length; i++) {
    const c = (x[i] ?? "").localeCompare(y[i] ?? "", undefined, {
      numeric: true,
    });
    if (c !== 0) return c;
  }
  return 0;
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
        typeof x === "number"
          ? x - (y as number)
          : textCompare(
              typeof x === "string" ? [x] : x,
              typeof y === "string" ? [y] : (y as readonly string[]),
            );
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
