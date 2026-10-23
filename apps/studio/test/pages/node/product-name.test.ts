import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The product is **Demoman**, all the way down.
 *
 * It was not always. Between 2026-09-07 and 2026-09-15 the name was split:
 * Demoman to an author, Rookie underneath, because the rename was declared
 * user-facing only and spec §0 forbade touching wiring. That split is what
 * this file originally guarded, and it guarded it badly — it could only check
 * page `<title>`s, because a general "no Rookie here" sweep would have fired
 * on `@rookie/*` imports, `rookie:` message kinds and forty `[rookie]`
 * console prefixes that were all supposed to stay. A test suppressed at forty
 * sites teaches people to suppress it.
 *
 * The split cost what a split costs: `entrypoints/library/index.html` missed
 * the 2026-09-07 rename and nothing noticed for two days, because its stale
 * `<title>` looked exactly like the hundreds of internal mentions that were
 * meant to be stale. It was found by a human looking at a browser tab.
 *
 * The 2026-09-15 rename collapsed the split, which is what lets this file do
 * its actual job. "Rookie" is now grep-able — there is no legitimate mention
 * of it anywhere under `entrypoints/`, in markup or in TypeScript — so this
 * asserts the whole directory rather than six title tags.
 *
 * **The production change that reddens this:** writing `Rookie` into any file
 * under `entrypoints/` — a `<title>`, a heading, a message kind, a console
 * prefix. Checked by making it, 2026-09-15: adding `[rookie]` to a
 * `console.warn` in `entrypoints/background.ts` fails the sweep, and putting
 * "Rookie" back in `library/index.html`'s title fails both the sweep and the
 * title check below.
 *
 * `editor-copy-vocabulary.test.ts` remains where in-page author copy is
 * guarded. This is the coarser net: not "is the wording right" but "did a
 * rename miss a file".
 */

const ENTRYPOINTS = join(__dirname, "..", "..", "..", "pages", "entrypoints");

/** The one string that may never appear under `entrypoints/` again. Built in
 *  two halves so this line does not itself trip the sweep it defines. */
const RETIRED_NAME = new RegExp(`${"roo"}${"kie"}`, "i");

/** Every file an entrypoint ships, walked rather than listed: a page added
 *  later is exactly the case this exists for, and a hand-kept list would not
 *  cover it. */
function entrypointFiles(dir = ENTRYPOINTS): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...entrypointFiles(path));
    else found.push(path);
  }
  return found;
}

/** The `<title>` of every entrypoint that ships an `index.html`. */
function entrypointTitles(): { page: string; title: string }[] {
  const found: { page: string; title: string }[] = [];
  for (const entry of readdirSync(ENTRYPOINTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(ENTRYPOINTS, entry.name, "index.html");
    let html: string;
    try {
      html = readFileSync(path, "utf8");
    } catch {
      // A directory with no page: the count assertion below is what would
      // catch a read that started failing for a real reason.
      continue;
    }
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    expect(title, `${entry.name}/index.html has no <title>`).toBeDefined();
    found.push({ page: entry.name, title: title ?? "" });
  }
  return found;
}

describe("the product name", () => {
  it("has no trace of the retired name anywhere under entrypoints/", () => {
    const files = entrypointFiles();

    // Assert the fixture too: a walk that found nothing, or that stopped at
    // the top level without descending, would make the sweep below pass
    // without reading a single page. Checked structurally rather than by a
    // file count, so adding a module to an existing page does not force a
    // number here to be retuned — which is how a fixture guard rots into
    // something people edit reflexively until it stops guarding.
    const relative = files.map((f) => f.slice(ENTRYPOINTS.length + 1)).sort();

    // Only pages since 2026-10-20 (the extension's service worker and
    // content scripts were archived with it): nothing at the top level.
    expect(
      relative.filter((f) => !f.includes("/")),
      "top-level entrypoint modules",
    ).toEqual([]);

    // And every page's markup, which is where the 2026-09-07 rename's miss
    // actually lived.
    expect(
      relative.filter((f) => f.endsWith("index.html")),
      "page markup reached by the walk",
    ).toEqual([
      "editor/index.html",
      "library/index.html",
      "settings/index.html",
    ]);

    const offenders = files
      .filter((f) => RETIRED_NAME.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ENTRYPOINTS.length + 1));
    expect(
      offenders.join(", "),
      "files under entrypoints/ still naming the retired product",
    ).toBe("");
  });

  it("says Demoman in every page title", () => {
    const titles = entrypointTitles();
    // Assert the fixture too: a walk that found nothing would make the
    // assertion below pass without reading a single title.
    expect(
      titles.map((t) => t.page).sort(),
      "entrypoint pages discovered",
    ).toEqual(["editor", "library", "settings"]);

    // The positive half, so a title emptied to "" could not pass the sweep
    // above by saying nothing at all.
    for (const { page, title } of titles) {
      expect(title, `${page}/index.html title`).toMatch(/Demoman/);
    }
  });
});
