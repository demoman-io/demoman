// Cuts a release of the `demoman` package up to the publish, which stays the
// author's (internal/RELEASING.md).
//   pnpm release <version>        e.g. 0.7.2 or 0.8.0-rc.1
// Write both changelog entries for <version> first: the docs'
// resources/changelog.mdx and the newest entry on the site's /changelog page
// (the site lives in internal/, the author's private repo cloned here). Then this sets
// the version everywhere, pins every earlier changelog entry as it shipped
// (apps/cli/test/changelog-shipped.json), commits "release: demoman <version>" here and the
// site's change in internal/, runs the gate one suite at a time, and prints
// the author's commands in order.
// Running it again after a fix is safe: an unchanged bump commits nothing.
// Last line: `release: <version> ready to publish` or `release: … stopped at …`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { changelogEntries } from "./changelog.mjs";

const ROOT = new URL("../", import.meta.url);
const FILES = {
  pkg: "apps/cli/package.json",
  version: "apps/cli/src/version.ts",
  license: "apps/docs/resources/license.mdx",
  changelog: "apps/docs/resources/changelog.mdx",
  shipped: "apps/cli/test/changelog-shipped.json",
  site: "internal/site/public/index.html",
  log: "internal/site/public/changelog.html",
};
// The site's two files, which commit in internal/ rather than here.
const SITE = new Set(["site", "log"]);
// What `npm publish` may ship (internal/RELEASING.md step 5).
const SHIPPED = /^(dist\/|LICENSE$|THIRD_PARTY_NOTICES$|README\.md$|package\.json$)/;

export const isVersion = (v) => /^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(v ?? "");
/** The site's newest changelog entry, as look.test.mjs reads it (its <time> carries a class first). */
export function newestSiteEntry(html) {
  const m = html.match(/<article class="entry" data-version="([^"]+)"[^>]*>[\s\S]*?<time[^>]* datetime="([^"]+)">/);
  return m && { version: m[1], datetime: m[2] };
}

/** Every entry but this release's, as it shipped, oldest first: a pin is never retaken
 * or dropped, so docs.test.ts fails on an entry edited or removed after it shipped. */
export function shippedEntries(version, changelog, shipped) {
  const pins = JSON.parse(shipped);
  for (const e of changelogEntries(changelog).reverse()) if (e.label !== version) pins[e.label] ??= e.body;
  return `${JSON.stringify(pins, null, 2)}\n`;
}

/** What is missing before anything is touched; empty when ready. */
export function preflight(version, texts) {
  const missing = [];
  if (!texts.changelog.includes(`label="${version}"`))
    missing.push(`${FILES.changelog} has no <Update label="${version}"> entry`);
  const entry = newestSiteEntry(texts.log);
  if (entry?.version !== version)
    missing.push(`${FILES.log}'s newest changelog entry is ${entry ? `data-version="${entry.version}"` : "missing"}, not "${version}"`);
  return missing;
}

/** Each file's text with `version` set; throws naming any file whose pattern is gone. */
export function bump(version, texts) {
  const swap = (name, text, pattern, to) => {
    if (!pattern.test(text)) throw new Error(`${FILES[name]}: no ${pattern} to set the version in`);
    return text.replace(pattern, to);
  };
  return {
    pkg: swap("pkg", texts.pkg, /"version": "[^"]+"/, `"version": "${version}"`),
    version: swap("version", texts.version, /VERSION = "[^"]+"/, `VERSION = "${version}"`),
    license: swap("license", texts.license, /demoman@[^/\s)]+\//g, `demoman@${version}/`),
    shipped: shippedEntries(version, texts.changelog, texts.shipped),
    // The hero's class line. (The Premise drawing that also carried it left the page with
    // internal feat/site-pitch, 2026-11-13; release.test.mjs runs this on the real page.)
    site: swap("site", texts.site, /(<div class="class-line[^"]*"><b>v)[^<]+/, `$1${version}`),
  };
}

/** Published paths outside what the package may ship. */
export const strays = (paths) => paths.filter((p) => !SHIPPED.test(p));

/** The author's one line: the publish, which signs with their security key
 *  (never an OTP), and the dist-tag beside it. A subshell, so it ends at the
 *  repo root. */
export function publishLine(version) {
  return version.includes("-rc.")
    ? `(cd apps/cli/pkg && npm publish --tag next) && npm dist-tag add demoman@${version} latest`
    : `(cd apps/cli/pkg && npm publish) && npm dist-tag add demoman@${version} next`;
}

/** The steps after the gate, in the order internal/RELEASING.md requires.
 *  Only the publish is the author's (DEM-224); the agent runs and checks the
 *  rest, the plugin and the pushes in `pnpm release:finish`, which refuses to
 *  start before npm serves the version. */
export function releaseSteps(version) {
  return [
    // The docs show the Studio as the lane draws it; a CI refresh cannot open the Studio (its entry is single-use).
    "The agent, on macOS: redraw the docs' Studio stills (the lane must pass for the copy to run):\n    pnpm --filter @demoman/studio exec vitest run test/browser/studio-shots.test.ts &&\n    node scripts/docs-studio-stills.mjs\n    Look at the stills in apps/docs/media/studio (open them for the author), then commit any that changed:\n    git add apps/docs/media/studio\n    git diff --cached --quiet -- apps/docs/media/studio || git commit -m \"docs: Studio stills for this release\" -- apps/docs/media/studio",

    `The agent: deploy the site (release:finish checks /changelog lists ${version}):\n    (cd internal/site && npx wrangler deploy)`,
    `The author, with their security key, as one line:\n    ! ${publishLine(version)}`,
    `The agent, once the author's line has run: push the plugin, main and the site's commit, and check npm, the plugin, the site and npx:\n    pnpm release:finish ${version}`,
  ];
}

const read = (path) => readFileSync(new URL(path, ROOT), "utf8");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function run(label, cmd, args, cwd = ROOT) {
  console.log(`\n── ${label}: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) stop(`${label} (${r.error?.message ?? `exit ${r.status}`})`);
}

let target = "?";
function stop(where, lines = []) {
  for (const l of lines) console.log(`  ${l}`);
  console.log(`release: ${target} stopped at ${where}; fix it and run pnpm release ${target} again`);
  process.exit(1);
}

function main(version) {
  if (!isVersion(version)) {
    console.log("usage: pnpm release <X.Y.Z | X.Y.Z-rc.N>");
    process.exit(1);
  }
  target = version;

  // Refuse a version npm already serves; any answer but "not found" is said, not taken as free.
  const view = spawnSync("npm", ["view", `demoman@${version}`, "version"], { encoding: "utf8" });
  if (view.status === 0 && view.stdout.trim() === version) stop("npm", [`demoman@${version} is already published`]);
  if (view.status !== 0 && !/E404/.test(view.stderr)) stop("npm", [`npm view failed: ${view.stderr.trim()}`]);

  if (!existsSync(new URL("internal/site/", ROOT)))
    stop("internal/", ["internal/ is not cloned: the site, whose version line and changelog name the release, lives there"]);
  const texts = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)]));
  const missing = preflight(version, texts);
  if (missing.length > 0) stop("the changelogs (write them first)", missing);

  let next;
  try {
    next = bump(version, texts);
  } catch (e) {
    stop("the bump", [e.message]);
  }
  for (const [k, text] of Object.entries(next)) writeFileSync(new URL(FILES[k], ROOT), text);
  console.log(`set ${version} in ${Object.keys(next).map((k) => FILES[k]).join(", ")}`);

  // Two repos: the product's files commit here, the site's in internal/.
  const subject = `release: demoman ${version}`;
  const commit = (repo, paths) => {
    if (git("-C", repo, "status", "--porcelain", "--", ...paths) === "") return console.log(`${repo}: nothing changed`);
    git("-C", repo, "commit", "-m", subject, "--", ...paths);
    console.log(`${repo}: committed "${subject}"`);
  };
  commit(".", Object.entries(FILES).filter(([k]) => !SITE.has(k)).map(([, p]) => p));
  commit("internal", [...SITE].map((k) => FILES[k].replace(/^internal\//, "")));

  run("gate", "pnpm", ["test"]);
  run("typecheck", "pnpm", ["typecheck"]);
  // Not `pnpm lint`: biome refuses outright while a worktree's biome.json is in .worktrees/.
  run("lint", "pnpm", ["exec", "biome", "check", "apps", "packages"]);
  run("site tests", "node", ["--test", "test/*.test.mjs"], new URL("internal/site/", ROOT));
  run("package test", "pnpm", ["test:package"]);

  const unchecked = [];
  if (spawnSync("claude", ["--version"]).status === 0) {
    run("plugin", "claude", ["plugin", "validate", "--strict", "apps/cli/plugin-out"]);
    run("plugin manifest", "claude", ["plugin", "validate", "--strict", "apps/cli/plugin-out/.claude-plugin/plugin.json"]);
  } else {
    unchecked.push("claude is not on PATH, so the plugin was NOT validated: run internal/RELEASING.md step 4 by hand");
  }

  console.log("\n── dry run: npm publish --dry-run --json");
  const dry = spawnSync("npm", ["publish", "--dry-run", "--json"], { cwd: new URL("apps/cli/pkg/", ROOT), encoding: "utf8" });
  let pack;
  try {
    pack = JSON.parse(dry.stdout);
  } catch {
    stop("the dry run", [`npm answered no JSON (exit ${dry.status}): ${dry.stderr.trim().split("\n").at(-1)}`]);
  }
  if (pack.version !== version) stop("the dry run", [`apps/cli/pkg packs ${pack.version}, not ${version}`]);
  const extra = strays(pack.files.map((f) => f.path));
  if (extra.length > 0) stop("the dry run", extra.map((p) => `would ship ${p}`));
  console.log(`${pack.files.length} files, ${(pack.size / 1e6).toFixed(1)} MB packed, ${(pack.unpackedSize / 1e6).toFixed(1)} MB unpacked`);

  console.log("\nThe rest, in this order; only the publish is the author's (a plugin pushed before npm breaks every user):");
  releaseSteps(version).forEach((s, i) => console.log(`\n${i + 1}. ${s}`));
  for (const u of unchecked) console.log(`\nNOT CHECKED: ${u}`);
  console.log(`\nrelease: ${version} ready to publish${unchecked.length ? ` (${unchecked.length} check not run, above)` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]);
