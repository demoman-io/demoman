import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The shipped editor markup, not a copy of it.
 *
 * `main.ts`'s `$()` throws on a missing id — the right trade, and the reason
 * a newly-required element has to exist in the fixture before any test in
 * this directory can run. Nineteen hand-rolled copies of the markup meant
 * every such id cost nineteen identical edits, four times over (`#stage`,
 * `#stage-bar`, `#stage-frame`, `#timeline-tools`). Reading the file means
 * a test can only pass against markup that actually ships, and a new id
 * costs nothing here at all.
 *
 * The copies had already drifted, which is the more expensive half: they
 * carried none of `#brand`, `#dock`, `#stage-box`, `#status` or `#wordmark`,
 * and they flattened `#stage > #stage-box > #stage-frame` to
 * `#stage > #stage-frame`. Tests measuring the editor's structure were
 * measuring a shape the editor does not have.
 *
 * This is `popup-dom.ts`'s argument, made a second time. That helper retired
 * seven copies for the popup on the same reasoning.
 */
const HTML = readFileSync(
  join(import.meta.dirname, "../../../pages/entrypoints/editor/index.html"),
  "utf8",
);

const BODY = /<body[^>]*>([\s\S]*)<\/body>/i.exec(HTML);
if (BODY === null || BODY[1] === undefined) {
  throw new Error("editor/index.html has no <body> — the fixture cannot load");
}

// The <script type="module"> is stripped: jsdom would try to fetch and
// evaluate main.ts itself, and every test in this directory imports the
// entrypoint deliberately, after stubbing `chrome`.
const MARKUP = BODY[1].replace(/<script[\s\S]*?<\/script>/gi, "");

// A body regex that matched nothing would mount an empty page, and an empty
// page fails every test here with `editor is missing #name` rather than with
// the reason. Said once, at import, by the module that knows it. `#stage` and
// `#timeline` are the two structural anchors every editor test reaches
// through; `editor-dom.test.ts` asserts the full set `$()` requires.
if (!MARKUP.includes('id="stage"') || !MARKUP.includes('id="timeline"')) {
  throw new Error(
    "editor/index.html's <body> parsed, but carries neither #stage nor " +
      "#timeline — the extraction is wrong, not the page",
  );
}

/** Mounts the shipped editor body over `document.body`. */
export function editorDom(): void {
  document.body.innerHTML = MARKUP;
}

/** The markup itself, for tests that assert on it rather than mount it. */
export const editorMarkup = MARKUP;
