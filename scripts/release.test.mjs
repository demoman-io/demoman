import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { authorSteps, bump, newestSiteEntry, preflight, strays } from "./release.mjs";

// The real files, so a reworded version line fails here, not mid-release.
// The site lives in internal/, which CI has no copy of: its version lines and
// newest entry are copied here as the page writes them (the hero's class line,
// the Premise drawing's two versions, an entry whose <time> carries a class),
// and bump still names the real file if the page stops matching.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const current = JSON.parse(read("apps/cli/package.json")).version;
const at = (v) => new RegExp(`v${v.replace(/\./g, "\\.")}<`, "g");
const texts = {
  pkg: read("apps/cli/package.json"),
  version: read("apps/cli/src/version.ts"),
  license: read("apps/docs/resources/license.mdx"),
  changelog: read("apps/docs/resources/changelog.mdx"),
  site: `<div class="class-line label"><b>v${current}</b> — <span>macOS / Linux</span></div>
<svg class="el" id="sync-code" viewBox="0 0 80 124"><text class="ver" x="40" y="18" text-anchor="middle">v${current}</text></svg>
<svg class="el" id="sync-video" viewBox="0 0 90 124"><text class="ver" x="45" y="18" text-anchor="middle">v${current}</text></svg>
<article class="entry" data-version="${current}">
  <p class="v label">${current}</p>
  <time class="label" datetime="2026-11-07">Nov 7, 2026</time>
  <h3>A release</h3>
  <p>What changed.</p>
</article>`,
};

test("bump sets the version in every file that carries it", () => {
  assert.equal((texts.license.match(/demoman@[^/\s)]+\//g) ?? []).length, 2, "premise: the License page links two files");
  assert.equal((texts.site.match(at(current)) ?? []).length, 3, "premise: the site names the version three times");
  assert.ok(current !== "9.9.9", "premise: the tree is not already at the test's version");
  const next = bump("9.9.9", texts);
  assert.equal(JSON.parse(next.pkg).version, "9.9.9");
  assert.match(next.version, /VERSION = "9\.9\.9"/);
  assert.deepEqual(next.license.match(/demoman@[^/\s)]+\//g), ["demoman@9.9.9/", "demoman@9.9.9/"]);
  assert.match(next.site, /<div class="class-line label"><b>v9\.9\.9<\/b>/);
  assert.equal((next.site.match(/<text class="ver"[^>]*>v9\.9\.9<\/text>/g) ?? []).length, 2, next.site);
  assert.doesNotMatch(next.site, at(current), "a version line was left behind");
  assert.deepEqual(bump("9.9.9", { ...texts, ...next }), next, "a second bump changes nothing");
});

test("an rc keeps its whole version on the class line", () => {
  assert.match(bump("0.8.0-rc.2", texts).site, /<b>v0\.8\.0-rc\.2<\/b>/);
});

// The old page's pill went with it (internal#4, 2026-11-08): a page that still
// carries it is refused by name rather than half bumped.
test("bump refuses a page without the class line, naming the file", () => {
  const pill = `<div class="pill"><span class="pl">Now in public beta</span><span class="ver">· ${current}</span></div>`;
  assert.throws(() => bump("9.9.9", { ...texts, site: pill }), /internal\/site\/public\/index\.html: no .*class-line/);
});

test("preflight reads the page's newest entry", () => {
  assert.deepEqual(newestSiteEntry(texts.site), { version: current, datetime: "2026-11-07" });
});

test("bump names the file whose version line is gone", () => {
  assert.throws(() => bump("9.9.9", { ...texts, version: "export const V = 1;" }), /apps\/cli\/src\/version\.ts/);
});

test("preflight asks for both changelog entries", () => {
  assert.deepEqual(preflight(current, texts), [], "the tree's own release passes");
  const missing = preflight("9.9.9", texts);
  assert.equal(missing.length, 2);
  assert.match(missing[0], /changelog\.mdx has no <Update label="9\.9\.9">/);
  assert.match(missing[1], /index\.html's newest changelog entry is data-version="[^"]+", not "9\.9\.9"/);
});

test("strays are paths outside what the package ships", () => {
  assert.deepEqual(strays(["dist/demoman.mjs", "LICENSE", "README.md", "package.json", "THIRD_PARTY_NOTICES"]), []);
  assert.deepEqual(strays(["src/main.ts", "dist/x.js", ".env"]), ["src/main.ts", ".env"]);
});

test("npm comes before the plugin, with the right dist-tags", () => {
  const order = (v) => authorSteps(v).findIndex((s) => s.includes("npm publish")) < authorSteps(v).findIndex((s) => s.includes("plugin-out"));
  assert.ok(order("0.8.0") && order("0.8.0-rc.1"));
  // No clone lives on disk: the step makes one, over SSH, and stages new files too.
  const plugin = authorSteps("0.8.0").find((s) => s.includes("plugin-out"));
  assert.match(plugin, /git clone git@github\.com:demoman-io\/plugins\.git "\$p"/);
  assert.match(plugin, /add -A && git -C "\$p" commit -m "demoman 0\.8\.0" && git -C "\$p" push/);
  assert.match(authorSteps("0.8.0-rc.1").join("\n"), /\(cd apps\/cli\/pkg && npm publish --tag next\)\n\s+npm dist-tag add demoman@0\.8\.0-rc\.1 latest/);
  assert.match(authorSteps("0.8.0").join("\n"), /\(cd apps\/cli\/pkg && npm publish\)\n\s+npm dist-tag add demoman@0\.8\.0 next/);
  // Every step runs from the repo root: none leaves the shell somewhere else.
  for (const s of authorSteps("0.8.0")) assert.doesNotMatch(s, /^\s+cd /m, s);
});

test("the docs' Studio stills are redrawn before main is pushed", () => {
  const steps = authorSteps("0.8.0");
  const stills = steps.findIndex((s) => s.includes("node scripts/docs-studio-stills.mjs"));
  const push = steps.findIndex((s) => s.includes("git push origin main"));
  assert.ok(stills >= 0, "no step redraws the stills");
  assert.ok(stills < push, "the stills are redrawn after main is pushed");
  assert.match(steps[stills], /studio-shots\.test\.ts/);
});
