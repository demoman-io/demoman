// The setup pull request, built in a detached temporary worktree and pushed
// to the branch on the repo's remote, so the person's checkout, branches, index and
// default branch are never touched.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { GitRunner } from "@demoman/runner/package";
import type { Gh } from "./gh-run.js";

export const SETUP_BRANCH = "demoman/setup";
export const SETUP_TITLE = "Set up Demoman";
export type SetupPr =
  | { opened: { number: number; url: string; branch: string; sha: string } }
  | {
      failed: "push" | "pr" | "worktree";
      detail: string;
      branchUrl?: string;
    };

export async function openSetupPr(
  a: {
    root: string;
    slug: string;
    /** The git remote that is `slug` (GithubFacts.remote). */
    remote: string;
    base: string;
    files: Array<{ path: string; text: string | Uint8Array }>;
    body: string;
    /** Defaults to SETUP_BRANCH / SETUP_TITLE. */
    branch?: string;
    title?: string;
  },
  deps: { git: GitRunner; gh: Gh },
): Promise<SetupPr> {
  const { git, gh } = deps;
  const branch = a.branch ?? SETUP_BRANCH;
  const title = a.title ?? SETUP_TITLE;
  const tmp = await mkdtemp(join(tmpdir(), "demoman-setup-"));
  let added = false;
  const stage = async (
    what: string,
    args: string[],
    cwd = tmp,
  ): Promise<string | undefined> => {
    const r = await git(args, cwd);
    return r.code === 0
      ? undefined
      : `\`git ${args.join(" ")}\` (${what}) exited with code ${r.code}: ${r.stderr.trim()}`;
  };
  try {
    const fetchFailed = await stage(
      "fetch",
      ["fetch", a.remote, a.base],
      a.root,
    );
    if (fetchFailed) return { failed: "worktree", detail: fetchFailed };
    const addFailed = await stage(
      "worktree",
      ["worktree", "add", "--detach", tmp, `${a.remote}/${a.base}`],
      a.root,
    );
    if (addFailed) return { failed: "worktree", detail: addFailed };
    added = true;
    try {
      for (const f of a.files) {
        const p = join(tmp, f.path);
        const rel = relative(tmp, p);
        if (isAbsolute(f.path) || rel.startsWith("..") || isAbsolute(rel))
          return {
            failed: "worktree",
            detail: `the file path ${f.path} points outside the repo, so nothing was written; give a path inside the repo and run setup again`,
          };
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, f.text);
      }
    } catch (e) {
      return {
        failed: "worktree",
        detail: `a setup file could not be written (${e instanceof Error ? e.message : String(e)}); check the folder is writable, then run setup again`,
      };
    }
    const built =
      (await stage("add", ["add", "--", ...a.files.map((f) => f.path)])) ??
      // The person's hooks expect their own checkout (node_modules and all):
      // in this bare worktree they fail on files they never wrote.
      (await stage("commit", ["commit", "--no-verify", "-m", title]));
    if (built) return { failed: "worktree", detail: built };

    const refspec = `HEAD:refs/heads/${branch}`;
    const pushed = await git(["push", "--no-verify", a.remote, refspec], tmp);
    if (pushed.code !== 0) {
      const words = pushed.stderr.trim();
      const exists = /non-fast-forward|fetch first|\(already exists\)/.test(
        words,
      );
      return {
        failed: "push",
        detail: exists
          ? branch === SETUP_BRANCH
            ? `a setup branch already exists on ${a.remote} (${SETUP_BRANCH}); merge or close its pull request, or delete the branch, then run setup again. git said: ${words}`
            : `a branch for this flow already exists on ${a.remote} (${branch}); merge or close its pull request, or delete the branch, then add the flow again. git said: ${words}`
          : `\`git push ${a.remote} ${refspec}\` exited with code ${pushed.code}: ${words}`,
      };
    }
    const sha = (await git(["rev-parse", "HEAD"], tmp)).stdout.trim();

    const pr = await gh([
      "pr",
      "create",
      "--repo",
      a.slug,
      "--base",
      a.base,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      a.body,
    ]);
    const url = pr.stdout.trim().split("\n").pop() ?? "";
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (pr.code !== 0 || !Number.isInteger(number))
      return {
        failed: "pr",
        branchUrl: `https://github.com/${a.slug}/tree/${branch}`,
        detail: `the branch ${branch} is pushed but the pull request was not opened (${pr.stderr.trim() || pr.stdout.trim() || `gh exited with code ${pr.code}`}); open it with: gh pr create --repo ${a.slug} --base ${a.base} --head ${branch} --title "${title}"`,
      };
    return { opened: { number, url, branch, sha } };
  } finally {
    if (added) await git(["worktree", "remove", "--force", tmp], a.root);
    await rm(tmp, { recursive: true, force: true });
    await git(["worktree", "prune"], a.root);
  }
}
