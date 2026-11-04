import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit, type GitRunner } from "@demoman/runner/package";
import { beforeEach, describe, expect, it } from "vitest";
import { openSetupPr, SETUP_BRANCH, SETUP_TITLE } from "../src/ci-pr.js";
import type { Gh } from "../src/gh-run.js";

// Real git, isolated from the developer's global config (identity, hooks, signing).
const iso = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git: GitRunner = (args, cwd, env) =>
  execGit(args, cwd, { ...iso, ...env });
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...iso },
  });

let origin: string;
let root: string;
let prs: string[][];
const gh =
  (code = 0): Gh =>
  async (args) => {
    prs.push(args);
    return code === 0
      ? { code, stdout: "https://github.com/o/r/pull/7\n", stderr: "" }
      : { code, stdout: "", stderr: "GraphQL: not allowed" };
  };
const args = (files: Array<{ path: string; text: string | Uint8Array }>) => ({
  root,
  slug: "o/r",
  base: "main",
  files,
  body: "the body",
});
const snapshot = () => [
  sh(root, "status", "--porcelain"),
  sh(root, "rev-parse", "--abbrev-ref", "HEAD"),
  sh(root, "diff", "--cached"),
];
const worktrees = () => sh(root, "worktree", "list", "--porcelain");

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "demoman-pr-"));
  origin = join(dir, "origin.git");
  root = join(dir, "work");
  prs = [];
  sh(dir, "init", "--bare", "-b", "main", origin);
  mkdirSync(root);
  sh(root, "init", "-b", "main");
  sh(root, "remote", "add", "origin", origin);
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  sh(root, "add", ".");
  sh(root, "commit", "-m", "init");
  sh(root, "push", "origin", "main");
  sh(root, "checkout", "-b", "feature");
  writeFileSync(join(root, "b.txt"), "b changed\n");
  sh(root, "add", "b.txt"); // staged
  writeFileSync(join(root, "c.txt"), "untracked\n");
});

describe("openSetupPr", () => {
  it("leaves the person's checkout untouched and pushes exactly the files on origin/main", async () => {
    const before = snapshot();
    expect(before[2]).toContain("b changed"); // premise: something is staged
    const png = new Uint8Array([0, 255, 1, 254, 137, 80]);
    const r = await openSetupPr(
      args([
        { path: ".demoman/flows/x.yml", text: "name: x\n" },
        { path: ".demoman/screens/x.png", text: png },
      ]),
      { git, gh: gh() },
    );
    expect(r).toMatchObject({
      opened: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        branch: SETUP_BRANCH,
      },
    });
    expect(snapshot()).toEqual(before);
    expect(
      sh(root, "ls-tree", "-r", "--name-only", `origin/${SETUP_BRANCH}`).trim(),
    ).toBe(
      ["a.txt", "b.txt", ".demoman/flows/x.yml", ".demoman/screens/x.png"]
        .sort()
        .join("\n"),
    );
    expect(sh(root, "show", `origin/${SETUP_BRANCH}:b.txt`)).toBe("b\n");
    const bytes = execFileSync(
      "git",
      ["show", `origin/${SETUP_BRANCH}:.demoman/screens/x.png`],
      {
        cwd: root,
        env: { ...process.env, ...iso },
      },
    );
    expect([...bytes]).toEqual([...png]);
    expect(
      sh(root, "log", "-1", "--format=%s", `origin/${SETUP_BRANCH}`).trim(),
    ).toBe(SETUP_TITLE);
    expect(prs).toEqual([
      [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        SETUP_BRANCH,
        "--title",
        SETUP_TITLE,
        "--body",
        "the body",
      ],
    ]);
    expect(worktrees().match(/^worktree /gm)).toHaveLength(1);
    expect(sh(root, "branch", "--list", SETUP_BRANCH)).toBe("");
  });

  it("says a refused push with git's words, opens no PR, and removes the worktree", async () => {
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'no pushes today' >&2\nexit 1\n", {
      mode: 0o755,
    });
    const r = await openSetupPr(args([{ path: "n.txt", text: "n" }]), {
      git,
      gh: gh(),
    });
    expect(r).toMatchObject({ failed: "push" });
    expect("failed" in r && r.detail).toContain("no pushes today");
    expect(prs).toEqual([]);
    expect(worktrees().match(/^worktree /gm)).toHaveLength(1);
  });

  it("names the branch and the line to run when gh pr create is refused after the push", async () => {
    const r = await openSetupPr(args([{ path: "n.txt", text: "n" }]), {
      git,
      gh: gh(1),
    });
    expect(r).toMatchObject({
      failed: "pr",
      branchUrl: `https://github.com/o/r/tree/${SETUP_BRANCH}`,
    });
    expect("failed" in r && r.detail).toContain("not allowed");
    expect("failed" in r && r.detail).toContain(
      `gh pr create --base main --head ${SETUP_BRANCH} --title "Set up Demoman"`,
    );
    expect(sh(root, "ls-remote", "origin", SETUP_BRANCH)).toContain(
      SETUP_BRANCH,
    );
    expect(worktrees().match(/^worktree /gm)).toHaveLength(1);
  });

  it("says a setup branch already exists when origin has one", async () => {
    const other = mkdtempSync(join(tmpdir(), "demoman-pr-other-"));
    sh(other, "clone", origin, "c");
    const c = join(other, "c");
    sh(c, "checkout", "-b", SETUP_BRANCH);
    writeFileSync(join(c, "z.txt"), "z");
    sh(c, "add", ".");
    sh(c, "commit", "-m", "earlier");
    sh(c, "push", "origin", SETUP_BRANCH);
    const r = await openSetupPr(args([{ path: "n.txt", text: "n" }]), {
      git,
      gh: gh(),
    });
    expect(r).toMatchObject({ failed: "push" });
    expect("failed" in r && r.detail).toContain(
      "a setup branch already exists",
    );
    expect(prs).toEqual([]);
    expect(existsSync(join(root, "n.txt"))).toBe(false);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
  });
});
