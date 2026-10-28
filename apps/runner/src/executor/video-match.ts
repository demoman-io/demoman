// Name matching for the video library: duplicate check, migration grouping, phrase search.
// Whole words only. shortcut: no stemming past a trailing "s" ("searching" != "search"),
// no fuzzy matching; a miss is a duplicate the author is not warned about, never a wrong merge.

import { nameWords, normaliseName } from "@demoman/run-core";

export { nameWords, normaliseName };

export const sameName = (a: string, b: string): boolean =>
  normaliseName(a) === normaliseName(b);

/** Equal names, or one name's word set contains the other's. */
export function similarNames(a: string, b: string): boolean {
  if (sameName(a, b)) return true;
  const wa = new Set(nameWords(a));
  const wb = new Set(nameWords(b));
  // An all-stop-word name has no words; it would be contained in every name.
  if (wa.size === 0 || wb.size === 0) return false;
  const within = (small: Set<string>, big: Set<string>) =>
    [...small].every((w) => big.has(w));
  return within(wa, wb) || within(wb, wa);
}

/** How many of the phrase's words appear as whole words in the haystack; 0 is no match. */
export function phraseHits(
  phrase: string,
  haystack: { name: string; pages: string[]; steps: string[] },
): number {
  const have = new Set(
    [haystack.name, ...haystack.pages, ...haystack.steps].flatMap(nameWords),
  );
  return new Set(nameWords(phrase).filter((w) => have.has(w))).size;
}

/** Origin + path of a URL; query and hash dropped. */
export function startPageOf(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}
