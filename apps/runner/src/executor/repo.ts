import { execFile } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
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

/** The filmed folder is the caller's choice: its config must not name a
 *  program git runs on its own account while Demoman only reads it (audit
 *  run 1). Demoman's git there reads and stages, never fetches or
 *  commits, so of the programs a config can name only two run: fsmonitor,
 *  off here, and a clean filter, left on on purpose — git-lfs is one, and
 *  the tree filmed has to be the one git would commit. The CLI's fetch and
 *  commit (core.sshCommand, hooks) act on the repo the person set up CI in,
 *  as their own push would. */
const GIT_GUARD = { key: "core.fsmonitor", value: "false" } as const;

/** `env` with the guard added for every git started under it — gh's own
 *  included, which no `-c` can reach. Appends to any GIT_CONFIG_COUNT
 *  already there rather than replacing it. */
export function guardedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: GIT_GUARD.key,
    [`GIT_CONFIG_VALUE_${n}`]: GIT_GUARD.value,
  };
}

export const execGit: GitRunner = (args, cwd, env) =>
  new Promise((done, fail) => {
    // execFile's 1 MB default refuses a big repo's `ls-tree -r -d` outright.
    const maxBuffer = 256 * 1024 * 1024;
    const options =
      env === undefined
        ? { cwd, maxBuffer }
        : { cwd, maxBuffer, env: { ...process.env, ...env } };
    // `-c` over the env form: it holds on a git older than 2.31 too.
    const guarded = ["-c", `${GIT_GUARD.key}=${GIT_GUARD.value}`, ...args];
    execFile("git", guarded, options, (err, stdout, stderr) => {
      if (!err) return done({ code: 0, stdout, stderr });
      // A numeric code is git answering; a string code (ENOENT) is git not running.
      if (typeof err.code === "number") {
        return done({ code: err.code, stdout, stderr });
      }
      // A gone cwd also fails as "spawn git ENOENT", which reads as if git
      // were missing: say which one is.
      if (err.code !== "ENOENT") return fail(err);
      stat(cwd).then(
        () => fail(err),
        (e: NodeJS.ErrnoException) =>
          fail(
            e.code === "ENOENT"
              ? new Error(`${cwd} is not there any more`)
              : err,
          ),
      );
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

/** Whether `sha` names a commit in the repo at `dir`: git answering no is
 *  false; git not running throws. */
export async function hasCommit(
  dir: string,
  sha: string,
  run: GitRunner = execGit,
): Promise<boolean> {
  return (await run(["cat-file", "-e", `${sha}^{commit}`], dir)).code === 0;
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
  log: (line: string) => void = () => undefined,
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
      treeOf(root, run, join(temp, "index"), log),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    // Forgiven, and said: a folder that will not come off (a git still
    // writing past the deadline) must not fail the run it was recording.
    await rm(temp, { recursive: true, force: true }).catch((error: unknown) => {
      log(
        `the filmed tree's temporary index at ${temp} would not be removed (${messageOf(error)})`,
      );
    });
  }
}

async function treeOf(
  root: string,
  run: GitRunner,
  index: string,
  log: (line: string) => void,
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
    // A clean or process filter runs as the user on `add`. The ones the
    // user's own global or system config sets up (git-lfs's install) stay
    // as they are, so the tree is the one git would commit; any this
    // folder's config sets or changes go back to the user's own value, or
    // off when there is none. Read as "every scope" against
    // global and system: `--show-scope` needs git 2.26, and `--worktree`
    // refuses a repo with several worktrees.
    const filters = async (
      scope: string[],
    ): Promise<Map<string, string> | { code: number; stderr: string }> => {
      const r = await run(
        [
          "config",
          "-z",
          ...scope,
          "--get-regexp",
          "^filter\\..+\\.(clean|process)$",
        ],
        root,
      );
      // Exit 1 is "no such key".
      if (r.code !== 0 && r.code !== 1) return r;
      const keys = new Map<string, string>();
      for (const entry of r.stdout.split("\0")) {
        if (entry === "") continue;
        const at = entry.indexOf("\n");
        // The last value wins, as it does for git.
        if (at === -1) keys.set(entry, "");
        else keys.set(entry.slice(0, at), entry.slice(at + 1));
      }
      return keys;
    };
    const effective = await filters([]);
    if (!(effective instanceof Map))
      return failed("config --get-regexp filter", effective);
    const outer = new Map<string, string>();
    for (const scope of ["--system", "--global"]) {
      const read = await filters([scope]);
      // Unreadable: every filter counts as the folder's, and goes off.
      if (!(read instanceof Map)) {
        log(
          `git's ${scope.slice(2)} config could not be read for filters (${read.stderr.trim() || `exit ${read.code}`}), so every filter is off while the filmed tree is read`,
        );
        continue;
      }
      for (const [k, v] of read) outer.set(k, v);
    }
    const nameOf = (key: string) =>
      key.slice("filter.".length, key.lastIndexOf("."));
    // Only the keys the folder changed: an empty `process` given with -c is
    // still a process, and git then runs no `clean` either. A key blanked
    // (none of the user's own) leaves the filter not `required`.
    const changed = [...effective.keys()].filter(
      (k) => outer.get(k) !== effective.get(k),
    );
    const own = new Set(changed.map(nameOf));
    const blanked = new Set(changed.filter((k) => !outer.has(k)).map(nameOf));
    const off = [
      ...changed.flatMap((k) => ["-c", `${k}=${outer.get(k) ?? ""}`]),
      ...[...blanked].flatMap((n) => ["-c", `filter.${n}.required=false`]),
    ];
    const unfiltered = [...own].sort();
    if (unfiltered.length > 0)
      log(
        `the filmed tree was read with the filters this folder's git config sets left out (${unfiltered.join(", ")}): Demoman runs only the ones your own global or system config sets up`,
      );
    const env = { GIT_INDEX_FILE: index };
    const add = await run([...off, "add", "-A"], root, env);
    if (add.code !== 0) return failed("add -A", add);
    // write-tree re-hashes racily clean files, filters and all: same -c.
    const write = await run([...off, "write-tree"], root, env);
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
      ...(unfiltered.length > 0 ? { unfiltered } : {}),
    };
  } catch (error) {
    return { none: `git failed: ${messageOf(error)}` };
  }
}
