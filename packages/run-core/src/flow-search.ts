// One phrase matcher for the agent's flows({ query }) and the Studio's search box.
import { nameWords, singular } from "./video-name.js";

export interface FlowText {
  name: string;
  pages: readonly string[];
  steps: readonly string[];
}

/** The phrase's whole words, plus (while typing, no space after it) the last word as a prefix. */
function parse(
  phrase: string,
  typing: boolean,
): { words: string[]; prefix: string | null } {
  const tokens = phrase
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const open = typing && tokens.length > 0 && /[\p{L}\p{N}]$/u.test(phrase);
  const last = open ? (tokens.pop() as string) : null;
  return {
    words: tokens.flatMap(nameWords),
    prefix: last === null ? null : singular(last),
  };
}

/** Whether `phrase` has any word to match; a stop word counts only while it is being typed. */
export function hasWords(phrase: string, typing = false): boolean {
  const { words, prefix } = parse(phrase, typing);
  return words.length > 0 || prefix !== null;
}

function hits(
  phrase: string,
  typing: boolean,
  parts: readonly string[],
): Set<string> {
  const { words, prefix } = parse(phrase, typing);
  const have = [...new Set(parts.flatMap(nameWords))];
  const found = new Set(words.filter((w) => have.includes(w)));
  if (prefix !== null && have.some((h) => h.startsWith(prefix)))
    found.add(prefix);
  return found;
}

const allParts = (f: FlowText) => [f.name, ...f.pages, ...f.steps];

/** Distinct words of `phrase` the flow holds as whole words; 0 is no match. */
export function phraseHits(
  phrase: string,
  flow: FlowText,
  typing = false,
): number {
  return hits(phrase, typing, allParts(flow)).size;
}

/** null when the name holds a matched word or nothing matches; else the first step, else the first page, that does. */
export function matchedOutsideName(
  phrase: string,
  flow: FlowText,
  typing = false,
): { step: string } | { page: string } | null {
  if (hits(phrase, typing, [flow.name]).size > 0) return null;
  const step = flow.steps.find((s) => hits(phrase, typing, [s]).size > 0);
  if (step !== undefined) return { step };
  const page = flow.pages.find((p) => hits(phrase, typing, [p]).size > 0);
  return page !== undefined ? { page } : null;
}

/** Where in `text` the first word `phrase` matches begins; -1 when none.
 *  A word is what `nameWords` splits on, so it answers as the matcher does. */
export function matchAt(phrase: string, text: string, typing = false): number {
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (hits(phrase, typing, [m[0]]).size > 0) return m.index;
  }
  return -1;
}
