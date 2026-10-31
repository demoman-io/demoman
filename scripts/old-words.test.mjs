// scripts/old-words.test.mjs
//
// The words people and agents read (spec 2026-10-30 flows-and-bulk-delete):
// a flow is what is filmed, a video one recording of it, an export a file.
// "take", "version", "recording" and "demo" are retired as nouns wherever
// a person or an agent reads them. This scans the prose in those surfaces
// and names every old word it finds, with its file and line. Each surface
// the rename reaches is added to SURFACES as it is rewritten.
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { test } from "node:test";

const SURFACES = [
  "apps/studio/pages/src/**/*.ts",
  "apps/studio/pages/entrypoints/**/*.ts",
  "apps/studio/pages/entrypoints/**/*.html",
];

/** Exact prose an old word may stay in, each with why. */
const ALLOWED = [
  { text: "a demo video", why: "what people ask an agent for; the product's own phrase" },
  { text: "the export takes the source's shape", why: "the verb" },
  { text: "to take the focus", why: "the verb" },
  { text: "To take it out of the video", why: "the verb" },
];

const OLD = /(?<![\w./-])(takes?|versions?|recordings?|demos?)(?![\w-])/gi;

/** The prose of a TypeScript file: its string and template literals,
 *  comments dropped, `${…}` holes blanked. A literal with no space between
 *  two words is an identifier, a key or a selector, not prose. */
function tsProse(text) {
  const out = [];
  const lit = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs;
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

function scan(patterns) {
  const found = [];
  const read = new Map();
  for (const pattern of patterns) {
    const files = globSync(pattern);
    read.set(pattern, files);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const prose = file.endsWith(".html") ? htmlProse(text) : tsProse(text);
      for (const { line, text: p } of prose) {
        if (ALLOWED.some((a) => p.includes(a.text))) continue;
        for (const w of p.matchAll(OLD)) {
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
