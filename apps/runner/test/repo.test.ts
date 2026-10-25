import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  normaliseRemote,
  readFilmedCode,
  readRepo,
  storedRemote,
} from "../src/executor/repo.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "demoman-repo-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeRepo(name: string): string {
  const dir = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  return dir;
}

describe("normaliseRemote", () => {
  it.each([
    ["git@github.com:Acme/Web.git", "github.com/acme/web"],
    ["https://github.com/Acme/Web", "github.com/acme/web"],
    ["https://GitHub.com/acme/web.git/", "github.com/acme/web"],
    ["ssh://git@github.com/acme/web.git", "github.com/acme/web"],
  ])("%s → %s", (raw, key) => expect(normaliseRemote(raw)).toBe(key));
});

describe("storedRemote", () => {
  it.each([
    ["git@github.com:acme/web.git", "git@github.com:acme/web.git"],
    ["https://github.com/acme/web", "https://github.com/acme/web"],
    ["https://tok@github.com/acme/web.git", "https://github.com/acme/web.git"],
    ["https://u:p@ss@host.test/a/b?x=1#y", "https://host.test/a/b"],
    ["ssh://git@github.com/acme/web.git", "ssh://github.com/acme/web.git"],
  ])("%s → %s", (raw, kept) => expect(storedRemote(raw)).toBe(kept));
});

describe("readRepo", () => {
  it("keys a repo with an origin by its remote", async () => {
    const dir = makeRepo("with-origin");
    git(dir, "remote", "add", "origin", "git@github.com:acme/web.git");
    const read = await readRepo(dir);
    expect(read).toEqual({
      ok: true,
      repo: {
        key: "github.com/acme/web",
        root: dir,
        remote: "git@github.com:acme/web.git",
        branch: "main",
        commit: git(dir, "rev-parse", "HEAD"),
      },
    });
  });

  it("stores an https remote without its token; the key is unchanged", async () => {
    // Red (second review 8): store the remote as git gives it — the token
    // is written into every take's video.json.
    const dir = makeRepo("with-token");
    const raw = "https://x-access-token:ghs_SECRET@github.com/acme/web.git";
    git(dir, "remote", "add", "origin", raw);
    const read = await readRepo(dir);
    if (!read.ok) throw new Error(read.none);
    expect(read.repo.remote).toBe("https://github.com/acme/web.git");
    expect(JSON.stringify(read.repo)).not.toContain("SECRET");
    expect(read.repo.key).toBe(normaliseRemote(raw));
    expect(read.repo.key).toBe("github.com/acme/web");
  });

  it("gives a repo and its worktree one key with no remote", async () => {
    const dir = makeRepo("main-checkout");
    const wt = join(scratch, "wt");
    git(dir, "worktree", "add", "-q", wt, "-b", "side");
    const a = await readRepo(dir);
    const b = await readRepo(wt);
    if (!a.ok || !b.ok) throw new Error(`not read: ${JSON.stringify([a, b])}`);
    expect(a.repo.root).not.toBe(b.repo.root);
    expect(a.repo.remote).toBeNull();
    expect(a.repo.key).toMatch(/^local:/);
    expect(b.repo.key).toBe(a.repo.key);
    expect(b.repo.branch).toBe("side");
  });

  it("answers none, saying why, outside a checkout", async () => {
    const dir = join(scratch, "plain");
    execFileSync("mkdir", [dir]);
    const read = await readRepo(dir);
    expect(read).toEqual({
      ok: false,
      none: expect.stringMatching(/not a git checkout/),
    });
  });

  it("answers none, saying why, when git is not installed", async () => {
    const read = await readRepo(scratch, async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    });
    expect(read).toEqual({
      ok: false,
      none: expect.stringMatching(/git is not installed/),
    });
  });

  it("names a git that fails without an exit code", async () => {
    const read = await readRepo(scratch, async () => {
      throw new Error("boom");
    });
    expect(read).toEqual({
      ok: false,
      none: expect.stringMatching(/git failed.*boom/),
    });
  });
});

describe("readFilmedCode", () => {
  /** A repo with one committed file and a .gitignore'd `ignored.txt`. */
  function committed(name: string): string {
    const dir = makeRepo(name);
    writeFileSync(join(dir, "app.txt"), "one\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "app");
    return dir;
  }

  it("a clean checkout films HEAD's tree", async () => {
    const dir = committed("film-clean");
    expect(await readFilmedCode(dir)).toEqual({
      commit: git(dir, "rev-parse", "HEAD"),
      tree: git(dir, "rev-parse", "HEAD^{tree}"),
      dirty: false,
    });
  });

  it("a new untracked file is in the tree filmed", async () => {
    const dir = committed("film-untracked");
    writeFileSync(join(dir, "new.txt"), "new\n");
    // Premise: git sees it as untracked, not staged.
    expect(git(dir, "status", "--porcelain")).toBe("?? new.txt");
    const filmed = await readFilmedCode(dir);
    expect(filmed).toMatchObject({ dirty: true });
    expect(filmed).not.toHaveProperty(
      "tree",
      git(dir, "rev-parse", "HEAD^{tree}"),
    );
  });

  it("a change to an ignored file is not", async () => {
    const dir = committed("film-ignored");
    writeFileSync(join(dir, "ignored.txt"), "changed\n");
    // Premise: the ignored file exists and git does not list it.
    expect(readFileSync(join(dir, "ignored.txt"), "utf8")).toBe("changed\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(await readFilmedCode(dir)).toMatchObject({ dirty: false });
  });

  it("leaves the real index byte for byte as it was, in a worktree too", async () => {
    const dir = committed("film-index");
    writeFileSync(join(dir, "new.txt"), "new\n");
    writeFileSync(join(dir, "app.txt"), "two\n");
    const index = join(dir, ".git", "index");
    const before = readFileSync(index);
    expect(await readFilmedCode(dir)).toMatchObject({ dirty: true });
    expect(readFileSync(index).equals(before)).toBe(true);
    // Nothing staged: the edit and the new file are still the user's own.
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
    expect(git(dir, "status", "--porcelain")).toContain("?? new.txt");

    const wt = join(scratch, "film-index-wt");
    git(dir, "worktree", "add", "-q", wt, "-b", "film-side");
    writeFileSync(join(wt, "wt.txt"), "wt\n");
    // Premise: the worktree's .git is a file, and its index lives elsewhere.
    expect(readFileSync(join(wt, ".git"), "utf8")).toMatch(/^gitdir: /);
    const wtIndex = git(
      wt,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    const wtBefore = readFileSync(wtIndex);
    expect(await readFilmedCode(wt)).toMatchObject({ dirty: true });
    expect(readFileSync(wtIndex).equals(wtBefore)).toBe(true);
    expect(git(wt, "status", "--porcelain")).toBe("?? wt.txt");
  });

  it("before the first commit, the tree is still read", async () => {
    const dir = join(scratch, "film-unborn");
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    const filmed = await readFilmedCode(dir);
    expect(filmed).toMatchObject({ commit: null, dirty: true });
    expect(filmed).toHaveProperty(
      "tree",
      expect.stringMatching(/^[0-9a-f]{40}$/),
    );
  });

  it("a git that never answers is cut off, saying so", async () => {
    const dir = committed("film-hang");
    const filmed = await readFilmedCode(dir, () => new Promise(() => {}), 50);
    expect(filmed).toEqual({ none: expect.stringContaining("timed out") });
  });

  it("a git step that fails says which, in git's words", async () => {
    const dir = committed("film-fail");
    const filmed = await readFilmedCode(dir, async (args) =>
      args[0] === "write-tree"
        ? { code: 128, stdout: "", stderr: "fatal: boom\nmore" }
        : { code: 0, stdout: ".git/index\n", stderr: "" },
    );
    expect(filmed).toEqual({ none: "git write-tree failed: fatal: boom" });
  });
});
