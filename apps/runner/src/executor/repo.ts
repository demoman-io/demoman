import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
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
) => Promise<{ code: number; stdout: string; stderr: string }>;

const execGit: GitRunner = (args, cwd) =>
  new Promise((done, fail) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
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
