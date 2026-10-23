import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The editor's HTML shell against the ids `main.ts` demands of it.
 *
 * `main.ts`'s `$(id)` THROWS on a missing element, and it is called at
 * module scope and on every render — so an id dropped from `index.html`
 * does not degrade the page, it kills it on first paint.
 *
 * Until 2026-09-21 nothing else caught that, because every
 * `editor-main-*.test.ts` mounted its own hand-written copy of the shell and
 * all nineteen would stay green against an `index.html` that no longer had
 * the element. They now mount the file itself through `helpers/editor-dom.ts`,
 * so a dropped id fails them too — loudly, but with `editor is missing #x`
 * and no word about which side is short. This file is still the one that
 * says it: the page does not declare what the source demands. It also stays
 * the only check that runs when `$()` GAINS an id, since the shared fixture
 * makes that case cost no test edits at all.
 *
 * Both sides are read from the real files, and the id list is derived from
 * the source rather than copied here — a hardcoded list is a second thing to
 * keep in sync, which is the problem this is meant to solve rather than
 * reproduce. The "every call site is a literal" assertion is what keeps the
 * derivation honest: a `$(someVariable)` this regex cannot see would
 * otherwise shrink the list silently, and a regex that matched nothing at
 * all would pass every other assertion here vacuously.
 */

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const MAIN = read("../../../pages/entrypoints/editor/main.ts");
const HTML = read("../../../pages/entrypoints/editor/index.html");

/** `$("name")` — the only shape of call site this file can verify. */
const LITERAL_CALL = /\$\("([A-Za-z][\w-]*)"\)/g;
/** Any `$(…)` call at all, literal or not. */
const ANY_CALL = /\$\(/g;

const required = (): string[] => [
  ...new Set([...MAIN.matchAll(LITERAL_CALL)].map((m) => m[1] as string)),
];

const declared = (): Set<string> =>
  new Set([...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1] as string));

describe("the editor's HTML shell", () => {
  it("declares every id main.ts looks up", () => {
    const ids = declared();
    const missing = required().filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
  });

  it("has no $() call this check cannot see", () => {
    // Not decoration: if `$()` ever takes a computed id, the assertion
    // above stops covering it and has to be told so out loud rather than
    // quietly checking fewer ids than there are.
    // Call sites, not distinct ids: several ids are looked up more than
    // once, and the question here is whether any single call site escaped
    // the literal pattern.
    expect(MAIN.match(ANY_CALL) ?? []).toHaveLength(
      [...MAIN.matchAll(LITERAL_CALL)].length,
    );
  });
});
