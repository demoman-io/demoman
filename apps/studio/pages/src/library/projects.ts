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
  owner: string;
  name: string;
  count: number;
}
export interface Rail {
  all: number;
  owners: { owner: string; projects: RailProject[] }[];
  none: number;
  unreadable: number;
}

const LOCAL = "Local";

const segments = (key: string): string[] =>
  key
    .replace(/^local:/, "")
    .split("/")
    .filter((p) => p !== "" && p !== ".git");

/** `host/owner…/name` is read as owner and name; two hosts sharing an owner
 *  name each carry their host (`github.com/acme`). */
export function ownerAndName(
  key: string,
  allKeys: readonly string[],
): { owner: string; name: string } {
  const parts = segments(key);
  const name = parts.at(-1) ?? key;
  if (key.startsWith("local:")) return { owner: LOCAL, name };
  const ownerOf = (k: string): string => {
    const p = segments(k);
    return p.length > 2 ? p.slice(1, -1).join("/") : (p[0] ?? k);
  };
  const owner = ownerOf(key);
  const clash = allKeys.some(
    (k) =>
      !k.startsWith("local:") &&
      ownerOf(k) === owner &&
      segments(k)[0] !== parts[0],
  );
  return { owner: clash ? `${parts[0]}/${owner}` : owner, name };
}

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
  const byOwner = new Map<string, RailProject[]>();
  for (const key of keys) {
    const { owner, name } = ownerAndName(key, keys);
    const list = byOwner.get(owner) ?? [];
    list.push({ key, owner, name, count: counts.get(key) as number });
    byOwner.set(owner, list);
  }
  const owners = [...byOwner.entries()]
    .sort(([a], [b]) =>
      a === LOCAL ? 1 : b === LOCAL ? -1 : a.localeCompare(b),
    )
    .map(([owner, projects]) => ({
      owner,
      projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  return { all: cards.length, owners, none, unreadable };
}

const inPlace = (c: LibraryCard, place: Place): boolean =>
  place === "all"
    ? true
    : place === "unreadable"
      ? false
      : place === "none"
        ? projectKeyOf(c) === null
        : projectKeyOf(c) === place.project;

const isKept = (c: LibraryCard): boolean => c.row.kept != null;
const inTab = (c: LibraryCard, tab: Tab): boolean =>
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
