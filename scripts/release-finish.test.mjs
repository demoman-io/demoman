import assert from "node:assert/strict";
import { test } from "node:test";
import { distTags, finish } from "./release-finish.mjs";

const V = "0.9.10";
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const no = (stderr, status = 1) => ({ status, stdout: "", stderr });

/** A machine where every step holds; `over` breaks one answer. Every call
 *  is recorded, so a case can say what did not run. */
function machine(over = {}) {
  const calls = [];
  const answers = {
    [`npm view demoman@${V} version`]: ok(V),
    "npm dist-tag ls demoman": ok(`latest: ${V}\nnext: ${V}`),
    "git clone": ok(),
    rsync: ok(),
    "git -C add": ok(),
    "git -C diff": no("", 1), // the built plugin differs: there is a commit to make
    "git -C commit": ok(),
    "git -C push": ok(),
    "git -C log": ok(`demoman ${V}`),
    "git -C rev-parse": ok("abc1234"),
    "git ls-remote git@github.com:demoman-io/plugins.git HEAD": ok("abc1234\tHEAD"),
    "git push origin HEAD:main": ok(),
    "git rev-parse HEAD": ok("def4567"),
    "git ls-remote origin refs/heads/main": ok("def4567\trefs/heads/main"),
    [`npx -y demoman@${V} --version`]: ok(V),
    ...over.answers,
  };
  const files = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "demoman", version: V }),
    ".mcp.json": JSON.stringify({ mcpServers: { demoman: { args: ["-y", `demoman@${V}`] } } }),
    ...over.files,
  };
  const key = (cmd, args) => {
    const full = [cmd, ...args].join(" ");
    if (full in answers) return full;
    // `git -C <dir> <verb>`, `git clone <url> <dir>` and rsync's paths vary.
    if (cmd === "git" && args[0] === "-C") return `git -C ${args[2]}`;
    if (cmd === "git" && args[0] === "clone") return "git clone";
    if (cmd === "rsync") return "rsync";
    return full;
  };
  const deps = {
    run: (cmd, args, cwd) => {
      calls.push({ line: [cmd, ...args].join(" "), cwd });
      const a = answers[key(cmd, args)];
      if (a === undefined) throw new Error(`unexpected: ${[cmd, ...args].join(" ")}`);
      return a;
    },
    exists: (path) => !(over.missing ?? []).some((m) => path.endsWith(m)),
    readText: (path) => {
      const rel = Object.keys(files).find((f) => path.endsWith(f));
      if (rel === undefined) throw new Error(`ENOENT: ${path}`);
      return files[rel];
    },
    fetchText: async () => over.page ?? `<article class="entry" data-version="${V}">`,
    tempDir: () => "/tmp/plugins-x",
    removeDir: () => {},
    log: () => {},
  };
  return { deps, calls };
}
const lines = (m) => m.calls.map((c) => c.line);

test("refuses before npm serves the version, and pushes nothing", async () => {
  const m = machine({ answers: { [`npm view demoman@${V} version`]: no("npm ERR! code E404") } });
  const r = await finish(V, m.deps);
  assert.equal(r.at, "npm serves it");
  assert.match(r.why, /run the publish line first/);
  // The order RELEASING.md requires: a plugin pushed before npm breaks every user.
  assert.ok(!lines(m).some((l) => l.startsWith("git")), lines(m).join("\n"));
});

test("an npm that fails another way is said for what it is, not taken for an unpublished version", async () => {
  const m = machine({ answers: { [`npm view demoman@${V} version`]: no("npm ERR! network ETIMEDOUT") } });
  const r = await finish(V, m.deps);
  assert.equal(r.at, "npm serves it");
  assert.doesNotMatch(r.why, /run the publish line first/);
  assert.match(r.why, /ETIMEDOUT/);
});

test("refuses until both dist-tags name the version", async () => {
  const m = machine({ answers: { "npm dist-tag ls demoman": ok(`latest: ${V}\nnext: 0.9.9`) } });
  const r = await finish(V, m.deps);
  assert.equal(r.at, "npm serves it");
  assert.match(r.why, /next is 0\.9\.9, not 0\.9\.10/);
  assert.ok(!lines(m).some((l) => l.startsWith("git")));
});

test("an undeployed site stops the run before anything is pushed", async () => {
  const m = machine({ page: `<article class="entry" data-version="0.9.9">` });
  const r = await finish(V, m.deps);
  assert.equal(r.at, "the site lists it");
  assert.match(r.why, /npx wrangler deploy/);
  assert.ok(!lines(m).some((l) => l.startsWith("git")), lines(m).join("\n"));
});

test("runs every step in order, pushing HEAD to main here and in internal/, and finishes", async () => {
  const m = machine();
  const r = await finish(V, m.deps);
  assert.deepEqual(r, { ok: true });
  const first = (prefix) => lines(m).findIndex((l) => l.startsWith(prefix));
  const order = ["npm view", "git clone", "git -C /tmp/plugins-x commit", "git push origin HEAD:main", `npx -y demoman@${V}`].map(first);
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // The release commit (HEAD), not local main, which a detached release worktree never moves.
  const pushes = m.calls.filter((c) => c.line === "git push origin HEAD:main");
  assert.equal(pushes.length, 2);
  assert.match(String(pushes[1].cwd), /internal$/);
});

test("a plugin-out built for another version is refused before it is pushed", async () => {
  const m = machine({ files: { ".claude-plugin/plugin.json": JSON.stringify({ version: "0.9.9" }) } });
  const r = await finish(V, m.deps);
  assert.equal(r.at, "the plugin");
  assert.match(r.why, /pins 0\.9\.9, not 0\.9\.10/);
  assert.ok(!lines(m).some((l) => l.startsWith("git clone")));
});

test("a second run with the plugin already pushed commits nothing and still checks it", async () => {
  const m = machine({ answers: { "git -C diff": ok() } });
  const r = await finish(V, m.deps);
  assert.deepEqual(r, { ok: true });
  const plugin = lines(m).filter((l) => l.includes("plugins-x"));
  assert.ok(!plugin.some((l) => / (commit|push)( |$)/.test(l)), plugin.join("\n"));
  assert.ok(lines(m).some((l) => l.startsWith("git ls-remote git@github.com:demoman-io/plugins.git")));
});

test("an unchanged plugin whose last commit is another version is said, not taken for done", async () => {
  const m = machine({ answers: { "git -C diff": ok(), "git -C log": ok("demoman 0.9.9") } });
  const r = await finish(V, m.deps);
  assert.equal(r.at, "the plugin");
  assert.match(r.why, /last commit is "demoman 0\.9\.9"/);
});

test("a push the remote does not show stops at that push", async () => {
  const m = machine({ answers: { "git ls-remote origin refs/heads/main": ok("0000000\trefs/heads/main") } });
  const r = await finish(V, m.deps);
  assert.equal(r.at, "push main");
  assert.match(r.why, /origin\/main is 0000000, not the pushed def4567/);
});

test("two reads that both fail are never taken for a match", async () => {
  const m = machine({
    answers: { "git rev-parse HEAD": no("fatal: not a git repository"), "git ls-remote origin refs/heads/main": no("ssh: connect timed out") },
  });
  const r = await finish(V, m.deps);
  assert.equal(r.at, "push main");
  assert.match(r.why, /could not be read/);
});

test("a checkout with no internal/ says so, not as a git failure", async () => {
  const m = machine({ missing: ["internal"] });
  const r = await finish(V, m.deps);
  assert.equal(r.at, "push internal");
  assert.match(r.why, /internal is not here/);
});

test("dist-tag ls is read by tag", () => {
  assert.deepEqual(distTags("latest: 0.9.9\nnext: 0.9.10-rc.1\n"), { latest: "0.9.9", next: "0.9.10-rc.1" });
});
