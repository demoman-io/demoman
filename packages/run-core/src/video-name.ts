// Name matching for the video library: duplicate check, migration grouping, phrase search.
// Whole words only. shortcut: no stemming past a trailing "s" ("searching" != "search"),
// no fuzzy matching; a miss is a duplicate the author is not warned about, never a wrong merge.

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "in",
  "on",
  "of",
  "for",
  "by",
  "to",
  "with",
]);

const singular = (w: string) =>
  w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;

/** Lower-cased words, punctuation and the "—" separator dropped, stop words dropped, singularised. */
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP_WORDS.has(w))
    .map(singular);
}

export const normaliseName = (name: string): string =>
  nameWords(name).join(" ");
