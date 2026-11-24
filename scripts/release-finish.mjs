// The release after the author's `npm publish` (DEM-224): every step the
// author used to run and paste back, run here and each one checked.
//   pnpm release:finish <version>
// Only the publish needs the author, for its security key. This refuses to
// start until npm serves the version on both dist-tags and the deployed site
// lists it, so nothing is pushed before them (internal/RELEASING.md: a plugin
// pushed before npm breaks every user). Run it from the checkout `pnpm
// release` committed in: it pushes that commit (HEAD), here and in internal/.
// Safe to run again: each step checks what is already true.
// Last line: `release: <version> finished` or `release: <version> stopped at …`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGINS = "git@github.com:demoman-io/plugins.git";
const CHANGELOG_URL = "https://demoman.io/changelog";
const PLUGIN_OUT = `${ROOT}apps/cli/plugin-out`;

/** A command's answer; never throws, so a failure is said by the step. A
 *  network call (`live`) shows its stderr as it comes, so a security key's
 *  touch prompt or a credential helper is seen, not swallowed. */
const realRun = (cmd, args, cwd = ROOT, { live = false } = {}) => {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", live ? "inherit" : "pipe"],
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? r.error?.message ?? (live ? "(said above)" : "")).trim(),
  };
};

const realDeps = () => ({
  run: realRun,
  exists: existsSync,
  readText: (path) => readFileSync(path, "utf8"),
  fetchText: async (url) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.text();
  },
  tempDir: () => mkdtempSync(join(tmpdir(), "demoman-plugins-")),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  log: (line) => console.log(line),
});

/** `latest: 0.9.9` lines into { latest: "0.9.9" }. */
export const distTags = (text) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => /^([\w-]+):\s*(\S+)/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );

/**
 * Runs the steps after the publish, in order, each checked. Answers
 * `{ ok: true }` or `{ ok: false, at, why }` naming the first step that
 * did not hold; nothing after it runs.
 */
export async function finish(version, deps = realDeps()) {
  const { run, log } = deps;
  const failed = (r) => `exit ${r.status}: ${r.stderr || r.stdout}`;
  /** A sha read from a command, or why it could not be read: an empty
   *  answer is never one, so two failed reads can never match. */
  const sha = (r, what) =>
    r.status === 0 && /^[0-9a-f]{7,}/.test(r.stdout)
      ? { sha: r.stdout.split(/\s+/)[0] }
      : { why: `${what} could not be read (${failed(r)})` };
  /** The remote's sha for `ref` equals `local`, or why not. */
  const landed = (local, remote, where) => {
    if ("why" in local) return local.why;
    if ("why" in remote) return remote.why;
    return remote.sha === local.sha ? null : `${where} is ${remote.sha}, not the pushed ${local.sha}`;
  };
  const steps = [
    [
      "npm serves it",
      async () => {
        const view = run("npm", ["view", `demoman@${version}`, "version"]);
        if (view.status !== 0)
          return /E404/.test(view.stderr)
            ? `npm does not serve demoman@${version}: run the publish line first`
            : `npm view failed (${failed(view)}); if the publish ran, wait a minute and run this again`;
        if (view.stdout !== version) return `npm answered "${view.stdout}" for demoman@${version}`;
        const tags = run("npm", ["dist-tag", "ls", "demoman"]);
        if (tags.status !== 0) return `npm dist-tag ls failed (${failed(tags)})`;
        const t = distTags(tags.stdout);
        const off = ["latest", "next"].filter((k) => t[k] !== version);
        return off.length === 0
          ? null
          : `${off.map((k) => `${k} is ${t[k] ?? "unset"}`).join(", ")}, not ${version}: run the dist-tag line`;
      },
    ],
    // Before anything is pushed: the site deploy was the agent's step before
    // the publish (release.mjs).
    [
      "the site lists it",
      async () => {
        const page = await deps.fetchText(CHANGELOG_URL).catch((e) => ({ error: e.message }));
        if (typeof page !== "string") return `${CHANGELOG_URL} could not be read (${page.error})`;
        return page.includes(`data-version="${version}"`)
          ? null
          : `${CHANGELOG_URL} does not list ${version} yet: deploy the site (cd internal/site && npx wrangler deploy)`;
      },
    ],
    [
      "the plugin",
      async () => {
        // What is pushed is plugin-out as built: it must pin this version,
        // not a build left from another release or an unreleased main.
        const read = (rel) => {
          try {
            return deps.readText(`${PLUGIN_OUT}/${rel}`);
          } catch (e) {
            return { error: `apps/cli/plugin-out/${rel} could not be read (${e.message})` };
          }
        };
        const manifest = read(".claude-plugin/plugin.json");
        const mcp = read(".mcp.json");
        for (const f of [manifest, mcp]) if (typeof f !== "string") return f.error;
        let pinned;
        try {
          pinned = JSON.parse(manifest).version;
        } catch (e) {
          return `apps/cli/plugin-out/.claude-plugin/plugin.json is not JSON (${e.message})`;
        }
        if (pinned !== version || !mcp.includes(`"demoman@${version}"`))
          return `apps/cli/plugin-out pins ${pinned}, not ${version}: build it from the release commit (pnpm --filter @demoman/cli build)`;
        const dir = deps.tempDir();
        try {
          const step = (args, live = false) => {
            const r = run("git", args, ROOT, { live });
            return r.status === 0 ? null : `\`git ${args.join(" ")}\` ${failed(r)}`;
          };
          const cloned = step(["clone", PLUGINS, dir], true);
          if (cloned) return cloned;
          const copied = run("rsync", ["-a", "--delete", "--exclude", ".git", `${PLUGIN_OUT}/`, `${dir}/`]);
          if (copied.status !== 0) return `rsync ${failed(copied)}`;
          const subject = `demoman ${version}`;
          const staged = step(["-C", dir, "add", "-A"]);
          if (staged) return staged;
          const diff = run("git", ["-C", dir, "diff", "--cached", "--quiet"]);
          if (diff.status === 1) {
            const committed = step(["-C", dir, "commit", "-m", subject]);
            if (committed) return committed;
            const pushed = step(["-C", dir, "push"], true);
            if (pushed) return pushed;
          } else if (diff.status !== 0) {
            return `\`git diff --cached --quiet\` ${failed(diff)}`;
          } else {
            const head = run("git", ["-C", dir, "log", "-1", "--format=%s"]);
            if (head.stdout !== subject)
              return `the plugin's files are already as built, but its last commit is "${head.stdout}", not "${subject}": check demoman-io/plugins by hand`;
          }
          return landed(
            sha(run("git", ["-C", dir, "rev-parse", "HEAD"]), "the plugin's local HEAD"),
            sha(run("git", ["ls-remote", PLUGINS, "HEAD"], ROOT, { live: true }), "demoman-io/plugins' HEAD"),
            "demoman-io/plugins' HEAD",
          );
        } finally {
          deps.removeDir(dir);
        }
      },
    ],
    // The commit `pnpm release` made, wherever this checkout is (a release
    // worktree is detached): HEAD, pushed to main.
    ...[
      ["main", ROOT],
      ["internal", `${ROOT}internal`],
    ].map(([name, cwd]) => [
      `push ${name}`,
      async () => {
        if (!deps.exists(cwd)) return `${cwd} is not here: run this from the checkout pnpm release committed in`;
        const pushed = run("git", ["push", "origin", "HEAD:main"], cwd, { live: true });
        if (pushed.status !== 0) return `git push origin HEAD:main ${failed(pushed)}`;
        return landed(
          sha(run("git", ["rev-parse", "HEAD"], cwd), `${name}'s HEAD`),
          sha(run("git", ["ls-remote", "origin", "refs/heads/main"], cwd, { live: true }), `${name}'s origin/main`),
          `${name}'s origin/main`,
        );
      },
    ]),
    [
      "npx runs it",
      async () => {
        const r = run("npx", ["-y", `demoman@${version}`, "--version"]);
        return r.status === 0 && r.stdout === version
          ? null
          : `npx demoman@${version} --version ${r.status === 0 ? `said "${r.stdout}"` : failed(r)}`;
      },
    ],
  ];
  for (const [label, check] of steps) {
    log(`── ${label}`);
    const why = await check();
    if (why !== null) {
      log(`release: ${version} stopped at ${label}: ${why}`);
      return { ok: false, at: label, why };
    }
    log("   ok");
  }
  log(`release: ${version} finished`);
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2] ?? "";
  if (!/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(version)) {
    console.log("usage: pnpm release:finish <X.Y.Z | X.Y.Z-rc.N>");
    process.exit(1);
  }
  const r = await finish(version);
  process.exit(r.ok ? 0 : 1);
}
