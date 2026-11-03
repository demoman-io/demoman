// apps/studio/pages/src/library/projects.ts
//
// The library's project model: which project a card belongs to, the rail
// that lists them, and the narrowing the rail and tabs ask for. Spec
// 2026-11-01-library-projects-design, "The model".
import { type Place, parsePlace, placeSearch } from "@demoman/studio-protocol";
import type { LibraryCard, LibraryModel, LibraryRow } from "./state";
import { cardsOf } from "./state";

export { type Place, parsePlace, placeSearch };

export type Tab = "inRepo" | "notInRepo" | "all";

/** The repo a flow was added to beats the recorded one (a take made on a
 *  page the repo did not own is still its flow's project), even once that
 *  checkout is gone; null is No project. */
export function projectKeyOf(card: LibraryCard): string | null {
  const v = card.group?.video;
  if (v === undefined) return null;
  if (v.addedTo !== null) return v.addedTo;
  return "key" in v.repo ? v.repo.key : null;
}

export interface RailProject {
  key: string;
  /** The dim part before the name, with its slash left to the view; null
   *  for a local repo that needs none. */
  owner: string | null;
  name: string;
  /** Not on a host: the view marks it with a dim "local". */
  local: boolean;
  count: number;
}
export interface Rail {
  all: number;
  /** Hosted A→Z by owner/name, then local. */
  projects: RailProject[];
  none: number;
  unreadable: number;
}

const segments = (key: string): string[] =>
  key
    .replace(/^local:/, "")
    .split("/")
    .filter((p) => p !== "" && p !== ".git");

const isLocal = (k: string): boolean => k.startsWith("local:");

/** A hosted `host/owner…/name` reads as `owner/name`, the host only when
 *  another host holds the same one; a local repo reads as its folder, with
 *  its parent folder when another local repo has the same folder name. */
export function projectLabel(
  key: string,
  allKeys: readonly string[],
): { owner: string | null; name: string; local: boolean } {
  const parts = segments(key);
  const name = parts.at(-1) ?? key;
  if (isLocal(key)) {
    const twin = allKeys.some(
      (k) => k !== key && isLocal(k) && segments(k).at(-1) === name,
    );
    return { owner: twin ? (parts.at(-2) ?? null) : null, name, local: true };
  }
  const ownerOf = (k: string): string => {
    const p = segments(k);
    return p.length > 2 ? p.slice(1, -1).join("/") : (p[0] ?? k);
  };
  const owner = ownerOf(key);
  const clash = allKeys.some(
    (k) =>
      !isLocal(k) &&
      ownerOf(k) === owner &&
      segments(k).at(-1) === name &&
      segments(k)[0] !== parts[0],
  );
  return { owner: clash ? `${parts[0]}/${owner}` : owner, name, local: false };
}

const fullName = (p: RailProject): string =>
  p.owner === null ? p.name : `${p.owner}/${p.name}`;

export function railOf(
  cards: readonly LibraryCard[],
  unreadable: number,
  current: Place,
): Rail {
  const counts = new Map<string, number>();
  let none = 0;
  for (const c of cards) {
    const k = projectKeyOf(c);
    if (k === null) none += 1;
    else counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (typeof current === "object" && !counts.has(current.project)) {
    counts.set(current.project, 0); // the empty landing
  }
  const keys = [...counts.keys()];
  const projects = keys
    .map((key) => ({
      key,
      ...projectLabel(key, keys),
      count: counts.get(key) as number,
    }))
    .sort(
      (a, b) =>
        Number(a.local) - Number(b.local) ||
        fullName(a).localeCompare(fullName(b)),
    );
  return { all: cards.length, projects, none, unreadable };
}

export const inPlace = (c: LibraryCard, place: Place): boolean =>
  place === "all"
    ? true
    : place === "unreadable"
      ? false
      : place === "none"
        ? projectKeyOf(c) === null
        : projectKeyOf(c) === place.project;

const isKept = (c: LibraryCard): boolean => c.row.kept != null;
export const inTab = (c: LibraryCard, tab: Tab): boolean =>
  tab === "all" || (tab === "inRepo") === isKept(c);

export function narrow(
  model: LibraryModel,
  place: Place,
  tab: Tab,
): LibraryModel {
  const cards = cardsOf(model).filter(
    (c) => inPlace(c, place) && inTab(c, tab),
  );
  const groups = new Set(cards.flatMap((c) => (c.group ? [c.group] : [])));
  const ids = new Set<string>();
  for (const c of cards) {
    if (c.group === null) ids.add(c.row.sceneId);
    else for (const v of c.group.versions) ids.add(v.sceneId);
  }
  return {
    ...model,
    rows: model.rows.filter((r: LibraryRow) => ids.has(r.sceneId)),
    groups: model.groups?.filter((g) => groups.has(g)),
  };
}

export function tabCounts(
  cards: readonly LibraryCard[],
  place: Place,
): Record<Tab, number> {
  const here = cards.filter((c) => inPlace(c, place));
  const inRepo = here.filter(isKept).length;
  return {
    inRepo,
    notInRepo: here.length - inRepo,
    all: here.length,
  };
}

export function showsTabs(
  cards: readonly LibraryCard[],
  place: Place,
): boolean {
  if (place === "unreadable") return false;
  if (place === "none") {
    return cards.some((c) => inPlace(c, place) && isKept(c));
  }
  return true;
}
