import type { GitRunner, RefreshResult } from "@demoman/runner/package";
import type { Gh } from "./gh-run.js";

export const COMMIT_SUBJECT = "Refresh demo videos";
export const BRANCH = "demoman/refresh";
// One identity, used to commit and to tell the bot's commits from a person's.
const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const BOT = ["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`];
const NOT_PERMITTED = /not permitted to create or approve pull requests/i;

type GhResult = Awaited<ReturnType<Gh>>;

export interface Delivered {
  delivered: "pr" | "main" | "nothing";
  /** False when delivery was attempted and failed: the CLI exits non-zero. */
  ok: boolean;
  detail: string;
}

const said = (r: { stderr: string; stdout: string; code: number }) =>
  r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`;

/** A video whose files a refresh wrote and the repo should take: a `commit`
 *  flow whose film changed, added an output, or was delivered as new. A
 *  failure that wrote some files partway is not one. */
const toCommit = (v: RefreshResult["videos"][number]): boolean =>
  v.deliver === "commit" &&
  (v.outcome === "changed" ||
    v.outcome === "added" ||
    v.outcome === "uncompared");

/** Where a pull request from here goes, decided once: null on a branch
 *  (its own), the default branch on a detached HEAD (a deployed sha, a
 *  release tag), or why there may be none. A detached HEAD must already be
 *  on that branch, or the PR carries another branch's commits into it
 *  (DEM-123). `named`: the default branch the workflow already checked
 *  against (DEMOMAN_DEFAULT_BRANCH); else gh says. */
export async function offBase(
  repoRoot: string,
  deps: { git: GitRunner; gh: Gh },
  named?: string,
): Promise<{ base: string | null } | { refused: string }> {
  const here = await deps.git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  if (here.code !== 0)
    return { refused: `git rev-parse failed: ${said(here)}` };
  if (here.stdout.trim() !== "HEAD") return { base: null };
  let base = named ?? "";
  if (base === "") {
    const view = await deps.gh([
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]);
    base = view.stdout.trim();
    if (view.code !== 0 || base === "")
      return {
        refused: `the checkout is a detached HEAD, and the default branch it would deliver to could not be read (gh repo view): ${said(view)}`,
      };
  }
  const fetched = await deps.git(["fetch", "origin", base], repoRoot);
  if (fetched.code !== 0)
    return { refused: `git fetch origin ${base} failed: ${said(fetched)}` };
  const on = await deps.git(
    ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"],
    repoRoot,
  );
  if (on.code === 0) return { base };
  if (on.code === 1)
    return {
      refused: `the checked-out commit is not on ${base}, so a refresh pull request into ${base} would carry its branch's commits; refresh only what ${base} holds`,
    };
  return { refused: `git merge-base failed: ${said(on)}` };
}

/** Puts the files a refresh wrote into the repo's history: one commit on
 *  the checked-out branch (`main`), or one commit on `demoman/refresh` with a
 *  pull request opened or updated (`pr`). Only those videos' outputs (with
 *  their receipts) are staged. */
export async function deliver(
  args: {
    route: "pr" | "main";
    repoRoot: string;
    result: RefreshResult;
    /** Only the named videos were filmed: the others' proposals are not judged. */
    named?: boolean;
    runUrl: string | null;
    /** offBase's answer, when the caller asked it before recording. */
    target?: Awaited<ReturnType<typeof offBase>>;
  },
  deps: { git: GitRunner; gh: Gh },
): Promise<Delivered> {
  const { route, repoRoot, result, named, runUrl } = args;
  // The PR's base on a detached HEAD; null on a branch, which is its own.
  let target: string | null = null;
  if (route === "pr") {
    const on = args.target ?? (await offBase(repoRoot, deps));
    if ("refused" in on)
      return { delivered: "nothing", ok: false, detail: on.refused };
    target = on.base;
  }
  const updated = result.videos.filter(toCommit);
  if (updated.length === 0) {
    const nothing = "no video changed";
    if (route === "main")
      return { delivered: "nothing", ok: true, detail: nothing };
    // A failed video may still be out of date: the open PR's proposal for it stands.
    if (result.videos.some((v) => v.outcome === "failed"))
      return {
        delivered: "nothing",
        ok: true,
        detail: `${nothing}; the open refresh pull request stays, because a flow failed`,
      };
    if (named)
      return {
        delivered: "nothing",
        ok: true,
        detail: `${nothing}; the open refresh pull request stays, because only the named flows were recorded`,
      };
    // An open refresh PR proposes videos this run just filmed equal to the
    // committed ones: left open, it could be merged.
    const found = await openRefreshPr();
    const failed = (step: string, r: GhResult): Delivered => ({
      delivered: "nothing",
      ok: false,
      detail: `${nothing}, and ${step} failed: ${said(r)}`,
    });
    if ("step" in found) return failed(found.step, found.r);
    if (found.open === null)
      return { delivered: "nothing", ok: true, detail: nothing };
    const close = await deps.gh([
      "pr",
      "close",
      String(found.open),
      "--comment",
      `Demoman's latest refresh changed no video, so the videos proposed here are out of date.${runUrl === null ? "" : ` Run: ${runUrl}`}`,
    ]);
    if (close.code !== 0)
      return failed(`closing pull request #${found.open} (gh pr close)`, close);
    return {
      delivered: "nothing",
      ok: true,
      detail: `${nothing}; closed pull request #${found.open}, whose videos are out of date`,
    };
  }
  const fail = (
    step: string,
    r: { stderr: string; stdout: string; code: number },
  ) =>
    ({
      delivered: "nothing",
      ok: false,
      detail: `${step} failed: ${said(r)}`,
    }) as Delivered;
  const git = (a: string[]) => deps.git(a, repoRoot);

  const paths = [...new Set(updated.flatMap((v) => v.outputs))];
  const bodyText = updated.map((v) => `- ${v.name}`).join("\n");
  const here = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (here.code !== 0) return fail("git rev-parse", here);
  const base = here.stdout.trim();

  let foreign = false;
  if (route === "pr") {
    // The branch is rebuilt from here; a person's commits on it are lost, so say so.
    const fetched = await git(["fetch", "origin", BRANCH]);
    if (fetched.code === 0) {
      const log = await git([
        "log",
        "HEAD..FETCH_HEAD",
        "--format=%an\t%ae\t%cn\t%ce\t%s",
      ]);
      if (log.code !== 0) return fail("git log of the existing branch", log);
      foreign = log.stdout
        .split("\n")
        .filter(Boolean)
        .some((l) => {
          const [an, ae, cn, ce, subject = ""] = l.split("\t");
          return !(
            an === BOT_NAME &&
            cn === BOT_NAME &&
            ae === BOT_EMAIL &&
            ce === BOT_EMAIL &&
            subject.startsWith(COMMIT_SUBJECT)
          );
        });
    } else if (!/couldn't find remote ref/i.test(fetched.stderr)) {
      return fail("git fetch", fetched);
    }
    const sw = await git(["checkout", "-B", BRANCH]);
    if (sw.code !== 0) return fail("git checkout", sw);
  }

  const add = await git(["add", "--", ...paths]);
  if (add.code !== 0) return fail("git add", add);
  const commit = await git([
    ...BOT,
    "commit",
    "-m",
    COMMIT_SUBJECT,
    "-m",
    `${bodyText}\n\n[skip demoman]`,
    "--only",
    "--",
    ...paths,
  ]);
  if (commit.code !== 0) return fail("git commit", commit);

  if (route === "main") {
    const push = await git(["push", "origin", "HEAD"]);
    if (push.code !== 0) return fail("git push", push);
    return {
      delivered: "main",
      ok: true,
      detail: `committed ${updated.length} video(s) on ${base}`,
    };
  }

  const push = await git(["push", "--force", "origin", BRANCH]);
  if (push.code !== 0) return fail("git push", push);

  const body = [
    `Demoman recorded the repo's flows again and updated ${updated.length}.`,
    "",
    'Videos cannot be attached with the workflow\'s token: open each file under "Files changed" to play it.',
    "",
    ...updated.flatMap((v) => [
      `- ${v.line ?? `\`${v.name}\``}`,
      ...v.outputs.map((o) => `  - \`${o}\``),
      ...v.notes.map((n) => `  - ${n}`),
    ]),
    ...(result.videos.some((v) => v.outcome === "failed")
      ? [
          "",
          "Not refreshed:",
          ...result.videos
            .filter((v) => v.outcome === "failed")
            .map((v) => `- \`${v.name}\`: ${v.detail}`),
        ]
      : []),
    ...(runUrl === null ? [] : ["", `Run: ${runUrl}`]),
    ...(foreign
      ? [
          "",
          `Commits that were on \`${BRANCH}\` before this run were replaced.`,
        ]
      : []),
  ].join("\n");

  const found = await openRefreshPr();
  if ("step" in found) return pushedButNo(found.step, found.r);
  const { open } = found;
  if (open !== null) {
    const edit = await deps.gh(["pr", "edit", String(open), "--body", body]);
    if (edit.code !== 0) return pushedButNo("gh pr edit", edit);
    return {
      delivered: "pr",
      ok: true,
      detail: `updated pull request #${open}`,
    };
  }
  const create = await deps.gh([
    "pr",
    "create",
    "--head",
    BRANCH,
    "--base",
    target ?? base,
    "--title",
    COMMIT_SUBJECT,
    "--body",
    body,
  ]);
  if (create.code !== 0) {
    if (NOT_PERMITTED.test(create.stderr))
      return {
        delivered: "nothing",
        ok: false,
        detail: `the files are pushed to ${BRANCH} but no pull request was opened: GitHub Actions is not permitted to create pull requests. Turn on "Allow GitHub Actions to create and approve pull requests" in the repository's Settings > Actions > General.`,
      };
    return pushedButNo("gh pr create", create);
  }
  return {
    delivered: "pr",
    ok: true,
    detail: `opened pull request ${create.stdout.trim()}`,
  };

  /** The open pull request from `demoman/refresh`, or the gh step that failed. */
  async function openRefreshPr(): Promise<
    { open: number | null } | { step: string; r: GhResult }
  > {
    const list = await deps.gh([
      "pr",
      "list",
      "--head",
      BRANCH,
      "--state",
      "open",
      "--json",
      "number",
    ]);
    if (list.code !== 0) return { step: "gh pr list", r: list };
    try {
      const rows = JSON.parse(list.stdout) as Array<{ number: number }>;
      return { open: rows[0]?.number ?? null };
    } catch (error) {
      return {
        step: "reading gh pr list",
        r: {
          code: 0,
          stdout: "",
          stderr: `${String(error)}: ${list.stdout.slice(0, 200)}`,
        },
      };
    }
  }

  function pushedButNo(step: string, r: GhResult): Delivered {
    return {
      delivered: "nothing",
      ok: false,
      detail: `${step} failed (the files are pushed to ${BRANCH}): ${said(r)}`,
    };
  }
}
