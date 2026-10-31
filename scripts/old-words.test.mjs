// scripts/old-words.test.mjs
//
// The words people and agents read (spec 2026-10-30 flows-and-bulk-delete):
// a flow is what is filmed, a video one recording of it, an export a file.
// "take", "version", "recording" and "demo" are retired as nouns wherever
// a person or an agent reads them. This scans the prose in those surfaces
// and names every old word it finds, with its file and line. Each surface
// the rename reaches is added to SURFACES as it is rewritten.
import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import { test } from "node:test";

const SURFACES = [
  "apps/studio/pages/src/**/*.ts",
  "apps/studio/pages/entrypoints/**/*.ts",
  "apps/studio/pages/entrypoints/**/*.html",
  "apps/studio/src/**/*.ts",
  "apps/runner/src/executor/**/*.ts",
  "packages/run-core/src/**/*.ts",
  "apps/mcp/src/**/*.ts",
  "apps/cli/src/**/*.ts",
  "apps/mcp/recipe.md",
  "apps/cli/plugin/skills/record-demo/SKILL.md",
  "internal/.claude/skills/record-demo/SKILL.md",
  // The changelog's past entries keep the words they shipped with.
  "apps/docs/!(resources)/**/*.mdx",
  "apps/docs/*.mdx",
  "apps/docs/AGENTS.md",
];

/** A surface in the private repo cloned at internal/. CI checks out the
 *  public repo alone, so there it is skipped, and says so: a skipped
 *  surface must not read as one that was scanned clean. */
const PRIVATE = /^internal\//;
const present = (pattern) => !PRIVATE.test(pattern) || existsSync("internal");
for (const pattern of SURFACES.filter((p) => !present(p))) {
  console.log(`old-words: internal/ absent, skipped ${pattern}`);
}

/** Exact prose an old word may stay in, each with why. */
const ALLOWED = [
  { text: "one recording of it", why: "the definition of a video" },
  { text: "demo video", why: "what people ask an agent for; the product's own phrase" },
  { text: "demo account", why: "a sign-in account for filming (.demoman/accounts.json)" },
  { text: "demo data", why: "an app's sample data" },
  { text: "record a demo", why: "the product's own phrase, the recipe's title" },
  { text: "make a demo of", why: "the skill's trigger words: what people say" },
  { text: "No demo:", why: "the line a pull request gets when it has no video" },
  { text: "Record a demo", why: "the skill's title: the product's own phrase" },
  { text: "Recording a demo", why: "the recipe's title: the verb, the product's phrase" },
  { text: "Recording a phone demo", why: "the verb; a demo, what is made" },
  { text: "a demo script", why: "a script for a demo: what is made" },
  { text: "sign-up demo", why: "a demo of a sign-up: what is made" },
  { text: "demo value", why: "a made-up value for filming" },
  { text: "**demo** value", why: "a made-up value for filming" },
  { text: "the demo.", why: "what is made, as people say it" },
  { text: "the demo needs", why: "what is made, as people say it" },
  { text: "`version`", why: "status's field: the software's version" },
  { text: "`recording`", why: "the run report's key (served as it is)" },
  { text: "takes `", why: "the verb: a tool or field takes an argument" },
  { text: "take `", why: "the verb: tools take an argument" },
  { text: "takes an optional", why: "the verb" },
  { text: "Stills take", why: "the verb" },
  { text: "draft takes the verb", why: "the verb" },
  { text: "Either takes", why: "the verb" },
  { text: "take the file out of git", why: "the verb" },
  { text: "Before recording", why: "the verb" },
  { text: "takes one", why: "the verb: a command takes an argument" },
  { text: "takes post-tool-use", why: "the verb" },
  { text: "takes  , comma-separated", why: "the verb (its `${…}` hole blanked)" },
  { text: "does not take", why: "the verb" },
  { text: "cannot take here", why: "the verb" },
  { text: "can take a minute", why: "the verb" },
  { text: "ask for a demo", why: "what people ask their agent for" },
  { text: "this version's", why: "the software's version" },
  { text: "if it says this again, the plugin has not been released for this version yet", why: "the software's version" },
  { text: "Make a demo of", why: "what people ask their agent for" },
  { text: "Ask for a demo", why: "what people ask their agent for" },
  { text: "for a demo of", why: "what people ask their agent for" },
  { text: "get a demo", why: "what people ask their agent for" },
  { text: "first demo", why: "what is made, as people say it" },
  { text: "A demo Demoman made", why: "what is made, as people say it" },
  { text: "phone demo", why: "what is made, as people say it" },
  { text: "desktop demo", why: "what is made, as people say it" },
  { text: "Demo accounts", why: "a sign-in account for filming" },
  { text: "demo password", why: "a demo account's password" },
  { text: "for a demo.", why: "what people ask their agent for" },
  { text: "phone version", why: "a site's phone layout" },
  { text: "newer version", why: "the software's version" },
  { text: "name a version", why: "the software's version" },
  { text: "Versions in prose", why: "the software's version" },
  { text: "Demoman's version", why: "the software's version" },
  { text: "takes two", why: "the verb" },
  { text: "takes the account", why: "the verb" },
  { text: "To take one out", why: "the verb" },
  { text: "Phone and tablet", why: "a page's name" },
  { text: "`demoman refresh --deliver`, and takes", why: "the verb" },
  { text: "`takes/`", why: "the library's folder, kept (spec non-goals)" },
  { text: "the export takes the source's shape", why: "the verb" },
  { text: "to take the focus", why: "the verb" },
  { text: "To take it out of the video", why: "the verb" },
  { text: "takes longer", why: "the verb" },
  { text: "takes only", why: "the verb" },
  { text: "takes no", why: "the verb" },
  { text: "options take", why: "the verb" },
  { text: "to take them", why: "the verb" },
  { text: "could not take", why: "the verb: a lock" },
  { text: "would not take the sessions", why: "the verb" },
  { text: "may not take drags", why: "the verb" },
  { text: "take over", why: "the verb: a lock" },
  { text: "take it over", why: "the verb: a lock" },
  { text: "takes it over", why: "the verb: a lock" },
  { text: "recording at the window", why: "the verb" },
  { text: "; recording on", why: "the verb" },
  { text: "recording the filmed tree", why: "the verb" },
  { text: "demoman run: the recording", why: "film-compare's reference recording, another thing" },
  { text: "the comparison with the recording", why: "film-compare's reference recording, another thing" },
  { text: "Answers version", why: "the software's version" },
  { text: "latest version", why: "the software's version" },
  { text: "names no version", why: "the software's version" },
  { text: "version   was written by a newer Demoman", why: "a file format's version (its `${…}` hole blanked)" },
  { text: "read a version from gh", why: "gh's version" },
  { text: "starts the new version", why: "the software's version" },
];

const OLD = /(?<![\w./-])(takes?|versions?|recordings?|demos?)(?![\w-])/gi;

/** The prose of a TypeScript file: its string and template literals,
 *  comments dropped, `${…}` holes blanked. A literal with no space between
 *  two words is an identifier, a key or a selector, not prose. */
function tsProse(text) {
  const out = [];
  // A quote right after a letter or a closing brace is an apostrophe in
  // prose (`${id}'s`), not the start of a string.
  const lit = /(?<![\w}])(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs;
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) =>
      lead + " ".repeat(m.length - lead.length),
    );
  for (const m of code.matchAll(lit)) {
    const body = m[2].replace(/\$\{[^}]*\}/g, " ");
    if (!/[A-Za-z]{2,} [A-Za-z]{2,}/.test(body)) continue;
    if (/^\s*[[.#:@]/.test(body)) continue;
    const line = code.slice(0, m.index).split("\n").length;
    out.push({ line, text: body });
  }
  return out;
}

/** The prose of an HTML file: text between tags and the attributes a
 *  person reads; comments, styles and scripts dropped. */
function htmlProse(text) {
  const out = [];
  const code = text.replace(
    /<!--[\s\S]*?-->|<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g,
    (m) => m.replace(/[^\n]/g, " "),
  );
  const at = (i) => code.slice(0, i).split("\n").length;
  for (const m of code.matchAll(/>([^<]+)</g)) {
    if (m[1].trim() !== "") out.push({ line: at(m.index), text: m[1] });
  }
  for (const m of code.matchAll(
    /\b(?:title|aria-label|placeholder|alt)="([^"]*)"/g,
  )) {
    out.push({ line: at(m.index), text: m[1] });
  }
  return out;
}

/** The prose of a Markdown file: every line outside fenced code. */
function mdProse(text) {
  const out = [];
  let fenced = false;
  for (const [i, line] of text.split("\n").entries()) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && line.trim() !== "") out.push({ line: i + 1, text: line });
  }
  return out;
}

function scan(patterns) {
  const found = [];
  const read = new Map();
  for (const pattern of patterns.filter(present)) {
    const files = globSync(pattern);
    read.set(pattern, files);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const prose = file.endsWith(".html")
        ? htmlProse(text)
        : /\.mdx?$/.test(file)
          ? mdProse(text)
          : tsProse(text);
      for (const { line, text: p } of prose) {
        // An allowed phrase is taken out, not its whole string: a real old
        // word beside it is still found.
        let q = p;
        for (const a of ALLOWED) q = q.split(a.text).join(" ");
        for (const w of q.matchAll(OLD)) {
          found.push(`${file}:${line}: ${w[0]} — "${p.trim().slice(0, 120)}"`);
        }
      }
    }
  }
  return { found, read };
}

test("every surface pattern reads files, and the scan reads their prose", () => {
  const { read } = scan(SURFACES);
  for (const [pattern, files] of read) {
    assert.ok(files.length > 0, `${pattern} matched no file`);
  }
  // Premise: the extractor finds the confirmation's copy, so a scan that
  // reads nothing cannot pass for one that found nothing.
  const prose = tsProse(
    readFileSync("apps/studio/pages/src/shell/confirm-dialog.ts", "utf8"),
  ).map((p) => p.text);
  assert.ok(
    prose.some((p) => p.includes("It can’t be undone.")),
    `the extractor read ${prose.length} literals from confirm-dialog.ts`,
  );
});

test("the scan names an old word in prose, and passes an identifier", () => {
  assert.deepEqual(
    tsProse('const a = "Delete this take"; const b = statusKey("take", id);')
      .flatMap((p) => [...p.text.matchAll(OLD)].map((w) => w[0])),
    ["take"],
  );
  assert.deepEqual(
    htmlProse('<a title="Recordings" class="take-info">Old demos</a>')
      .flatMap((p) => [...p.text.matchAll(OLD)].map((w) => w[0]))
      .sort(),
    ["Recordings", "demos"],
  );
});

test("no old word where people and agents read", () => {
  const { found } = scan(SURFACES);
  assert.deepEqual(found, [], `\n${found.join("\n")}`);
});
