import { execFile } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FilmedCode } from "@demoman/run-core";
import { messageOf } from "../report.js";

export interface RepoRef {
  /** One key for every clone-by-remote, or every worktree of one local repo. */
  key: string;
  root: string;
  remote: string | null;
  branch: string | null;
  commit: string | null;
}

export type RepoRead =
  | { ok: true; repo: RepoRef }
  | { ok: false; none: string };

export type GitRunner = (
  args: string[],
  cwd: string,
  env?: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const execGit: GitRunner = (args, cwd, env) =>
  new Promise((done, fail) => {
    const options =
      env === undefined ? { cwd } : { cwd, env: { ...process.env, ...env } };
    execFile("git", args, options, (err, stdout, stderr) => {
      if (!err) return done({ code: 0, stdout, stderr });
      // A numeric code is git answering; a string code (ENOENT) is git not running.
      if (typeof err.code === "number") {
        return done({ code: err.code, stdout, stderr });
      }
      fail(err);
    });
  });

/** `host/path`, lowercased, without scheme, user, `.git` or trailing slash. */
export function normaliseRemote(url: string): string {
  let s = url.trim();
  const scp = /^[^/@:]+@([^/:]+):(?!\/\/)(.*)$/.exec(s);
  s = scp
    ? `${scp[1]}/${scp[2]}`
    : s.replace(/^[a-z+]+:\/\//i, "").replace(/^[^/@]+@/, "");
  return s
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** The remote as it is written down: a URL's user, password, query and
 *  fragment removed, since an https origin can carry a token
 *  (`https://x-access-token:TOKEN@github.com/o/r.git`). scp-style
 *  `git@host:o/r` is kept whole: `git` is a user, not a secret. */
export function storedRemote(url: string): string {
  const s = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;
  if (!scheme.test(s)) return s;
  return s
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1")
    .replace(/[?#].*$/, "");
}

export async function readRepo(
  dir: string,
  run: GitRunner = execGit,
): Promise<RepoRead> {
  try {
    const top = await run(["rev-parse", "--show-toplevel"], dir);
    if (top.code !== 0) {
      return {
        ok: false,
        none: `not a git checkout: ${top.stderr.trim() || `git exited ${top.code}`}`,
      };
    }
    const root = top.stdout.trim();
    const common = await run(["rev-parse", "--git-common-dir"], dir);
    if (common.code !== 0) {
      return {
        ok: false,
        none: `git could not find the repository: ${common.stderr.trim()}`,
      };
    }
    const branchRead = await run(["rev-parse", "--abbrev-ref", "HEAD"], dir);
    const commitRead = await run(["rev-parse", "HEAD"], dir);
    const originRead = await run(["remote", "get-url", "origin"], dir);

    const remote =
      originRead.code === 0 ? originRead.stdout.trim() || null : null;
    const key = remote
      ? normaliseRemote(remote)
      : `local:${await realpath(resolve(dir, common.stdout.trim()))}`;
    const branch = branchRead.code === 0 ? branchRead.stdout.trim() : "";
    return {
      ok: true,
      repo: {
        key,
        root,
        // The key is read from the remote as git gives it, so it is the
        // same as before; only what is written down loses its secrets.
        remote: remote === null ? null : storedRemote(remote),
        // Detached HEAD prints "HEAD"; an unborn branch fails. Neither is a branch name.
        branch: branch && branch !== "HEAD" ? branch : null,
        commit: commitRead.code === 0 ? commitRead.stdout.trim() : null,
      },
    };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return {
      ok: false,
      none:
        code === "ENOENT"
          ? "git is not installed (or not on PATH)"
          : `git failed: ${messageOf(err)}`,
    };
  }
}

/**
 * The tree on disk in `root`: every file git would commit, tracked or
 * untracked but not ignored, uncommitted edits included. Read through a copy
 * of the index (`GIT_INDEX_FILE`), so the user's own index is never written;
 * `git add -A` does write the files' blobs to the object store, as any add
 * would, and `git gc` takes them if nothing keeps them. `stash create` was
 * not enough: it leaves untracked files out, and a feature's new files are
 * untracked until committed.
 */
export async function readFilmedCode(
  root: string,
  run: GitRunner = execGit,
  deadlineMs = 20_000,
): Promise<FilmedCode> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<FilmedCode>((done) => {
    timer = setTimeout(
      () =>
        done({
          none: `recording the filmed tree timed out after ${deadlineMs / 1000} s`,
        }),
      deadlineMs,
    );
  });
  // shortcut: a git still running at the deadline is left to finish on its
  // own copy of the index; kill it if a hung git is ever seen.
  const temp = await mkdtemp(join(tmpdir(), "demoman-tree-")).catch(
    (error: unknown) => ({ failed: messageOf(error) }),
  );
  if (typeof temp !== "string") {
    clearTimeout(timer);
    return { none: `no temporary index could be made: ${temp.failed}` };
  }
  try {
    return await Promise.race([
      treeOf(root, run, join(temp, "index")),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    await rm(temp, { recursive: true, force: true });
  }
}

async function treeOf(
  root: string,
  run: GitRunner,
  index: string,
): Promise<FilmedCode> {
  try {
    const failed = (step: string, r: { code: number; stderr: string }) => ({
      none: `git ${step} failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`,
    });
    const where = await run(["rev-parse", "--git-path", "index"], root);
    if (where.code !== 0) return failed("rev-parse --git-path index", where);
    try {
      await copyFile(resolve(root, where.stdout.trim()), index);
    } catch (error) {
      // No index yet (a fresh repo) is an empty one; anything else is said.
      if ((error as { code?: unknown }).code !== "ENOENT")
        return { none: `the index could not be copied: ${messageOf(error)}` };
    }
    const env = { GIT_INDEX_FILE: index };
    const add = await run(["add", "-A"], root, env);
    if (add.code !== 0) return failed("add -A", add);
    const write = await run(["write-tree"], root, env);
    if (write.code !== 0) return failed("write-tree", write);
    const tree = write.stdout.trim();
    const head = await run(["rev-parse", "HEAD"], root);
    const commit = head.code === 0 ? head.stdout.trim() : null;
    const headTree =
      commit === null ? null : await run(["rev-parse", "HEAD^{tree}"], root);
    return {
      commit,
      tree,
      dirty:
        headTree === null ||
        headTree.code !== 0 ||
        headTree.stdout.trim() !== tree,
    };
  } catch (error) {
    return { none: `git failed: ${messageOf(error)}` };
  }
}
