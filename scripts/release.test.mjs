import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { authorSteps, bump, monthOf, newestSiteEntry, preflight, shortVersion, strays } from "./release.mjs";

// The real files, so a reworded version line fails here, not mid-release.
// The site lives in internal/, which CI has no copy of: its pill and newest
// entry are copied here as the page writes them, and bump still names the
// real file if the page stops matching.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const current = JSON.parse(read("apps/cli/package.json")).version;
const texts = {
  pkg: read("apps/cli/package.json"),
  version: read("apps/cli/src/version.ts"),
  license: read("apps/docs/resources/license.mdx"),
  changelog: read("apps/docs/resources/changelog.mdx"),
  site: `<div class="pill"><span class="ld" aria-hidden="true"></span><span class="pl">Now in public beta</span><span class="ver">· ${current}</span><span class="ver">· <span data-release-month>Oct 2026</span></span></div>
<article class="entry" data-version="${current}"><h3>A release</h3><p>What changed.</p><time datetime="2026-11-03">Nov 3, 2026</time></article>`,
};

test("bump sets the version in every file that carries it", () => {
  assert.equal((texts.license.match(/demoman@[^/\s)]+\//g) ?? []).length, 2, "premise: the License page links two files");
  assert.ok(current !== "9.9.9", "premise: the tree is not already at the test's version");
  const next = bump("9.9.9", texts);
  assert.equal(JSON.parse(next.pkg).version, "9.9.9");
  assert.match(next.version, /VERSION = "9\.9\.9"/);
  assert.deepEqual(next.license.match(/demoman@[^/\s)]+\//g), ["demoman@9.9.9/", "demoman@9.9.9/"]);
  assert.match(next.site, /<span class="pl">Now in public beta<\/span><span class="ver">· 9\.9\.9<\/span>/);
  const month = monthOf(newestSiteEntry(texts.site).datetime);
  assert.doesNotMatch(texts.site, new RegExp(`data-release-month>${month}<`), "premise: the fixture's written month is not its entry's, so the bump has to set it");
  assert.match(next.site, new RegExp(`<span data-release-month>${month}</span>`));
  assert.deepEqual(bump("9.9.9", { ...texts, ...next }), next, "a second bump changes nothing");
});

test("an rc shows as rc.N on the pill", () => {
  assert.equal(shortVersion("0.8.0-rc.2"), "rc.2");
  assert.equal(shortVersion("0.8.0"), "0.8.0");
  assert.match(bump("0.8.0-rc.2", texts).site, /<span class="ver">· rc\.2<\/span>/);
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
