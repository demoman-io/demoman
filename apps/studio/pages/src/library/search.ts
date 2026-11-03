// apps/studio/pages/src/library/search.ts
//
// The library's search as data. The words are run-core's matcher, the one
// the agent's flows({ query }) calls; this file only says what a card's
// text is and what the page does with the answer.
import {
  type FlowText,
  hasWords,
  matchAt,
  matchedOutsideName,
  phraseHits,
} from "@demoman/run-core";
import { inPlace, inTab, type Place, railOf, type Tab } from "./projects";
import { cardsOf, type LibraryCard, type LibraryModel, pathOf } from "./state";

/** Typing unless the query ends in whitespace, as the agent reads it. */
export const typingOf = (query: string): boolean => !/\s$/u.test(query);

export const searching = (query: string): boolean =>
  hasWords(query, typingOf(query));

/** A flow's video name (else the row's label), pages and steps; a take in
 *  no flow is its label alone. */
export function cardText(card: LibraryCard): FlowText {
  const v = card.group?.video;
  return v === undefined
    ? { name: card.row.label, pages: [], steps: [] }
    : {
        name: v.name || card.row.label,
        pages: v.pages,
        steps: v.steps,
      };
}

export const cardHits = (card: LibraryCard, query: string): number =>
  phraseHits(query, cardText(card), typingOf(query));

/** A why this long reads whole beside a name at its floor in the narrowest
 *  wide list: the name cell's 160px minimum leaves it 84px (index.html),
 *  twelve characters of 13px Geist. A longer one starts at its matched
 *  word, which a cut why then still paints. */
export const WHY_WHOLE = 12;

/** Where a match outside the name was found: `step: …` or `page: /route`,
 *  as shown (`text`, from the matched word on when it starts late) and in
 *  full for the title. */
export type Why = { text: string; full: string };
export function whyOf(card: LibraryCard, query: string): Why | null {
  const typing = typingOf(query);
  const m = matchedOutsideName(query, cardText(card), typing);
  if (m === null) return null;
  const [kind, said] =
    "step" in m ? ["step", m.step] : ["page", pathOf(m.page) || "/"];
  const full = `${kind}: ${said}`;
  const word = matchAt(query, said, typing);
  // A route keeps the slash its segment starts with.
  const at = kind === "page" ? said.lastIndexOf("/", word) : word;
  return at > 0 && full.length > WHY_WHOLE
    ? { text: `${kind}: …${said.slice(at)}`, full }
    : { text: full, full };
}

/** The cards with a hit, built the way `narrow` builds its model; every
 *  card when the query has no word to match. */
export function searchModel(model: LibraryModel, query: string): LibraryModel {
  if (!searching(query)) return model;
  const cards = cardsOf(model).filter((c) => cardHits(c, query) > 0);
  const groups = new Set(cards.flatMap((c) => (c.group ? [c.group] : [])));
  const ids = new Set<string>();
  for (const c of cards) {
    if (c.group === null) ids.add(c.row.sceneId);
    else for (const v of c.group.versions) ids.add(v.sceneId);
  }
  return {
    ...model,
    rows: model.rows.filter((r) => ids.has(r.sceneId)),
    groups: model.groups?.filter((g) => groups.has(g)),
  };
}

/** Matches in the other places (projects in rail order, then No project). */
export function elsewhere(
  cards: readonly LibraryCard[],
  here: Place,
  tab: Tab,
  query: string,
): { place: Place; count: number }[] {
  if (here === "all" || !searching(query)) return [];
  const hit = cards.filter((c) => inTab(c, tab) && cardHits(c, query) > 0);
  const places: Place[] = [
    ...railOf(cards, 0, "all").projects.map((p) => ({ project: p.key })),
    "none" as const,
  ];
  return places.flatMap((place) => {
    const same =
      typeof place === "object" && typeof here === "object"
        ? place.project === here.project
        : place === here;
    if (same) return [];
    const count = hit.filter((c) => inPlace(c, place)).length;
    return count > 0 ? [{ place, count }] : [];
  });
}
