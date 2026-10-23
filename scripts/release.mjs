// Cuts a release of the `demoman` package up to the publish, which stays the
// author's (internal/RELEASING.md).
//   pnpm release <version>        e.g. 0.7.2 or 0.8.0-rc.1
// Write both changelog entries for <version> first: the docs'
// resources/changelog.mdx and the site's newest #changelog entry (the site
// lives in internal/, the author's private repo cloned here). Then this sets
// the version everywhere, commits "release: demoman <version>" here and the
// site's change in internal/, runs the gate one suite at a time, and prints
// the author's commands in order.
// Running it again after a fix is safe: an unchanged bump commits nothing.
// Last line: `release: <version> ready to publish` or `release: … stopped at …`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const FILES = {
  pkg: "apps/cli/package.json",
  version: "apps/cli/src/version.ts",
  license: "apps/docs/resources/license.mdx",
  changelog: "apps/docs/resources/changelog.mdx",
  site: "internal/site/public/index.html",
};
// What `npm publish` may ship (internal/RELEASING.md step 5).
const SHIPPED = /^(dist\/|LICENSE$|THIRD_PARTY_NOTICES$|README\.md$|package\.json$)/;

export const isVersion = (v) => /^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(v ?? "");
/** The pill's form: an rc shows as `rc.N`, a release as itself. */
export const shortVersion = (v) => v.match(/-(rc\.\d+)$/)?.[1] ?? v;
export const monthOf = (datetime) =>
  new Date(`${datetime}T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** The site's newest changelog entry, as look.test.mjs reads it. */
export function newestSiteEntry(html) {
  const m = html.match(/<article class="entry" data-version="([^"]+)"[^>]*>[\s\S]*?<time datetime="([^"]+)">/);
  return m && { version: m[1], datetime: m[2] };
}

/** What is missing before anything is touched; empty when ready. */
export function preflight(version, texts) {
  const missing = [];
  if (!texts.changelog.includes(`label="${version}"`))
    missing.push(`${FILES.changelog} has no <Update label="${version}"> entry`);
  const entry = newestSiteEntry(texts.site);
  if (entry?.version !== version)
    missing.push(`${FILES.site}'s newest changelog entry is ${entry ? `data-version="${entry.version}"` : "missing"}, not "${version}"`);
  return missing;
}

/** Each file's text with `version` set; throws naming any file whose pattern is gone. */
export function bump(version, texts) {
  const entry = newestSiteEntry(texts.site);
  const swap = (name, text, pattern, to) => {
    if (!pattern.test(text)) throw new Error(`${FILES[name]}: no ${pattern} to set the version in`);
    return text.replace(pattern, to);
  };
  return {
    pkg: swap("pkg", texts.pkg, /"version": "[^"]+"/, `"version": "${version}"`),
    version: swap("version", texts.version, /VERSION = "[^"]+"/, `VERSION = "${version}"`),
    license: swap("license", texts.license, /demoman@[^/\s)]+\//g, `demoman@${version}/`),
    site: swap(
      "site",
      swap("site", texts.site, /(<span class="pl">[^<]*<\/span><span class="ver">· )[^<]+/, `$1${shortVersion(version)}`),
      /(<span data-release-month>)[^<]+/,
      `$1${monthOf(entry.datetime)}`,
    ),
  };
}

/** Published paths outside what the package may ship. */
export const strays = (paths) => paths.filter((p) => !SHIPPED.test(p));

/** The author's steps after the gate, in the order internal/RELEASING.md requires. */
export function authorSteps(version) {
  const rc = version.includes("-rc.");
  return [
    `Deploy the site, then open https://demoman.io/#changelog and check it lists ${version}:\n    (cd internal/site && npx wrangler deploy)`,
    // A subshell: step 3's paths are the repo root's.
    `Publish npm (your security key's browser prompt):\n    ${
      rc
        ? `(cd apps/cli/pkg && npm publish --tag next)\n    npm dist-tag add demoman@${version} latest`
        : `(cd apps/cli/pkg && npm publish)\n    npm dist-tag add demoman@${version} next`
    }\n    npm dist-tag ls demoman`,
    // plugin-out is the whole of demoman-io/plugins; a fresh clone each time, so nothing stale rides along.
    `Only after npm answers: the plugin, from a fresh clone of demoman-io/plugins:\n    p=$(mktemp -d) && git clone git@github.com:demoman-io/plugins.git "$p"\n    rsync -a --delete --exclude .git apps/cli/plugin-out/ "$p"/\n    git -C "$p" add -A && git -C "$p" commit -m "demoman ${version}" && git -C "$p" push`,
    "Push main (Mintlify deploys the docs from it), and the site's commit:\n    git push origin main\n    git -C internal push",
    `Check:\n    npm view demoman@${version} version\n    npx demoman@${version} setup`,
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
    stop("internal/", ["internal/ is not cloned: the site, whose pill and changelog name the release, lives there"]);
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
  commit(".", Object.entries(FILES).filter(([k]) => k !== "site").map(([, p]) => p));
  commit("internal", [FILES.site.replace(/^internal\//, "")]);

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

  console.log("\nYour steps, in this order (a plugin pushed before npm breaks every user):");
  authorSteps(version).forEach((s, i) => console.log(`\n${i + 1}. ${s}`));
  for (const u of unchecked) console.log(`\nNOT CHECKED: ${u}`);
  console.log(`\nrelease: ${version} ready to publish${unchecked.length ? ` (${unchecked.length} check not run, above)` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]);
