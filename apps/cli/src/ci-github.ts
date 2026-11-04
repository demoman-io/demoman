// What the repo has on GitHub, and the one Actions setting setup turns on.
import { execFile } from "node:child_process";
import type { Gh } from "./gh-run.js";

export type GithubFacts = {
  slug: string;
  defaultBranch: string;
  canPush: boolean;
  isAdmin: boolean;
  deployments: Array<{ environment: string; url: string | null; sha: string }>;
  hasReleases: boolean;
  workflowOnDefault: boolean;
  setupBranch: { pr: { number: number; url: string } | null } | null;
};
export type GhUnusable = {
  reason: "ghMissing" | "ghSignedOut" | "notGitHub";
  detail: string;
};
type Unreadable = { reason: "githubUnreadable"; detail: string };

const BRANCH = "demoman/setup";
const unreadable = (call: string, why: string): Unreadable => ({
  reason: "githubUnreadable",
  detail: `could not read ${call} from GitHub (${why.trim().split("\n")[0] || "no answer"}); nothing was assumed, try again`,
});

type Read =
  | { ok: true; json: unknown }
  | { ok: false; notFound: boolean; why: string };
async function read(gh: Gh, args: string[]): Promise<Read> {
  const r = await gh(args);
  if (r.code === 0) {
    try {
      return { ok: true, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
    } catch {
      return { ok: false, notFound: false, why: "the answer was not JSON" };
    }
  }
  return {
    ok: false,
    notFound: /HTTP 404|Not Found/i.test(r.stderr + r.stdout),
    why: r.stderr || r.stdout,
  };
}

function lsRemote(
  root: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) =>
    execFile(
      "git",
      ["ls-remote", "--heads", "origin", BRANCH],
      { cwd: root },
      (err, stdout, stderr) =>
        done({
          code: err ? 1 : 0,
          stdout,
          stderr: err ? stderr || String(err) : "",
        }),
    ),
  );
}

export async function readGithub(
  gh: Gh,
  root: string,
): Promise<GithubFacts | GhUnusable | Unreadable> {
  const v = await gh(["--version"]);
  if (v.code !== 0) {
    return {
      reason: "ghMissing",
      detail:
        "the GitHub CLI (gh) is not installed; install it from https://cli.github.com (brew install gh), then run setup again",
    };
  }
  if ((await gh(["auth", "status"])).code !== 0) {
    return {
      reason: "ghSignedOut",
      detail: "gh is not signed in; run `gh auth login`, then run setup again",
    };
  }
  const view = await gh([
    "repo",
    "view",
    "--json",
    "nameWithOwner,defaultBranchRef,viewerPermission",
  ]);
  if (view.code !== 0) {
    if (
      /not a git repository|known GitHub host|no git remotes|Could not resolve to a Repository/i.test(
        view.stderr,
      )
    ) {
      return {
        reason: "notGitHub",
        detail:
          "this checkout has no GitHub remote; CI setup needs a repo on github.com",
      };
    }
    return unreadable("the repo (gh repo view)", view.stderr);
  }
  let repo: {
    nameWithOwner: string;
    defaultBranchRef: { name: string };
    viewerPermission: string;
  };
  try {
    repo = JSON.parse(view.stdout);
  } catch {
    return unreadable("the repo (gh repo view)", "the answer was not JSON");
  }
  const slug = repo.nameWithOwner;
  const defaultBranch = repo.defaultBranchRef.name;

  const dep = await read(gh, ["api", `repos/${slug}/deployments?per_page=30`]);
  if (!dep.ok) return unreadable(`repos/${slug}/deployments`, dep.why);
  const found: Array<{ id: number; d: GithubFacts["deployments"][number] }> =
    [];
  // The API lists newest first: walk each environment's deployments until one is a success.
  const done = new Set<string>();
  for (const d of dep.json as Array<{
    id: number;
    environment: string;
    sha: string;
  }>) {
    if (done.has(d.environment)) continue;
    const st = await read(gh, [
      "api",
      `repos/${slug}/deployments/${d.id}/statuses?per_page=30`,
    ]);
    if (!st.ok)
      return unreadable(`repos/${slug}/deployments/${d.id}/statuses`, st.why);
    const win = (
      st.json as Array<{
        state: string;
        environment_url?: string;
        target_url?: string;
      }>
    ).find((s) => s.state === "success");
    if (!win) continue;
    done.add(d.environment);
    found.push({
      id: d.id,
      d: {
        environment: d.environment,
        url: win.environment_url || win.target_url || null,
        sha: d.sha,
      },
    });
  }
  // Newest deployment first.
  const deployments = found.sort((a, b) => b.id - a.id).map((f) => f.d);

  const rel = await read(gh, ["api", `repos/${slug}/releases?per_page=1`]);
  if (!rel.ok && !rel.notFound)
    return unreadable(`repos/${slug}/releases`, rel.why);
  const hasReleases = rel.ok && Array.isArray(rel.json) && rel.json.length > 0;

  const wf = await read(gh, [
    "api",
    `repos/${slug}/contents/.github/workflows/demoman.yml?ref=${defaultBranch}`,
  ]);
  if (!wf.ok && !wf.notFound)
    return unreadable(`${slug}'s .github/workflows/demoman.yml`, wf.why);

  const remote = await lsRemote(root);
  if (remote.code !== 0)
    return unreadable(`${BRANCH} on origin (git ls-remote)`, remote.stderr);
  let setupBranch: GithubFacts["setupBranch"] = null;
  if (remote.stdout.trim()) {
    const prs = await read(gh, [
      "pr",
      "list",
      "--head",
      BRANCH,
      "--state",
      "open",
      "--json",
      "number,url",
    ]);
    if (!prs.ok)
      return unreadable(`the pull request for ${BRANCH} (gh pr list)`, prs.why);
    const pr = (prs.json as Array<{ number: number; url: string }>)[0];
    setupBranch = { pr: pr ? { number: pr.number, url: pr.url } : null };
  }

  return {
    slug,
    defaultBranch,
    canPush: ["ADMIN", "MAINTAIN", "WRITE"].includes(repo.viewerPermission),
    isAdmin: repo.viewerPermission === "ADMIN",
    deployments,
    hasReleases,
    workflowOnDefault: wf.ok,
    setupBranch,
  };
}

export type ActionsSetting =
  | { kind: "alreadyOn" }
  | { kind: "turnedOn" }
  | { kind: "refused"; detail: string; url: string };

export async function allowActionPullRequests(
  gh: Gh,
  slug: string,
): Promise<ActionsSetting> {
  const url = `https://github.com/${slug}/settings/actions`;
  const path = `repos/${slug}/actions/permissions/workflow`;
  const refused = (what: string, stderr: string): ActionsSetting => {
    const msg = stderr.trim().split("\n")[0] || "no message";
    const why = /organi[sz]ation|enterprise/i.test(msg)
      ? "it reads as locked by the organisation"
      : "it reads as missing admin on the repo";
    return {
      kind: "refused",
      detail: `GitHub refused ${what}: ${msg}; ${why}. Allow it at ${url}`,
      url,
    };
  };
  const got = await gh(["api", path]);
  if (got.code !== 0) return refused("reading the Actions setting", got.stderr);
  let cur: {
    default_workflow_permissions: string;
    can_approve_pull_request_reviews: boolean;
  };
  try {
    cur = JSON.parse(got.stdout);
  } catch {
    return refused("reading the Actions setting", "the answer was not JSON");
  }
  if (cur.can_approve_pull_request_reviews) return { kind: "alreadyOn" };
  const put = await gh(["api", path, "-X", "PUT", "--input", "-"], {
    input: JSON.stringify({
      default_workflow_permissions: cur.default_workflow_permissions,
      can_approve_pull_request_reviews: true,
    }),
  });
  return put.code === 0
    ? { kind: "turnedOn" }
    : refused("turning on pull requests from workflows", put.stderr);
}
