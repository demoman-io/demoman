// What the repo has on GitHub, and the one Actions setting setup turns on.
import { execGit, type GitRunner } from "@demoman/runner/package";
import type { Gh } from "./gh-run.js";

export type GithubFacts = {
  slug: string;
  defaultBranch: string;
  canPush: boolean;
  isAdmin: boolean;
  deployments: Array<{
    environment: string;
    /** The success's environment_url: the deployed app, never a log page. */
    url: string | null;
    sha: string;
    /** GitHub's production_environment and transient_environment. */
    production?: boolean;
    transient?: boolean;
  }>;
  hasReleases: boolean;
  workflowOnDefault: boolean;
  setupBranch: { pr: { number: number; url: string } | null } | null;
  /** The git remote whose URL is `slug`: what setup fetches from and pushes
   *  to, so git and gh act on one repo. */
  remote: string;
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

/** git through the CLI's one runner; a git that would not start (missing,
 *  or the folder gone) answers as a failure that says why, never a throw. */
const gitIn = (git: GitRunner, root: string, args: string[]) =>
  git(args, root).catch((e: unknown) => ({
    code: -1,
    stdout: "",
    stderr: e instanceof Error ? e.message : String(e),
  }));

export async function readGithub(
  gh: Gh,
  root: string,
  o: {
    git?: GitRunner;
    /** The environment setup was asked to trigger on: looked for past the
     *  newest deployments when they hold none of it (DEM-89). */
    environment?: string;
  } = {},
): Promise<GithubFacts | GhUnusable | Unreadable> {
  const git = o.git ?? execGit;
  const v = await gh(["--version"]);
  if (v.code !== 0 && !(v.code === 127 || /ENOENT/.test(v.stderr))) {
    return unreadable("whether the GitHub CLI runs (gh --version)", v.stderr);
  }
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
      /not a git repository|known GitHub host|no git remotes/i.test(view.stderr)
    ) {
      return {
        reason: "notGitHub",
        detail:
          "this checkout has no GitHub remote; CI setup needs a repo on github.com",
      };
    }
    if (/Could not resolve to a Repository/i.test(view.stderr)) {
      return unreadable(
        "the repo (gh repo view)",
        "GitHub does not show this repo to the signed-in account; check that account has access to it",
      );
    }
    return unreadable("the repo (gh repo view)", view.stderr);
  }
  let repo: {
    nameWithOwner: string;
    defaultBranchRef: { name: string } | null;
    viewerPermission: string;
  };
  try {
    repo = JSON.parse(view.stdout);
  } catch {
    return unreadable("the repo (gh repo view)", "the answer was not JSON");
  }
  const slug = repo.nameWithOwner;
  if (!repo.defaultBranchRef?.name) {
    return {
      reason: "githubUnreadable",
      detail:
        "the repo has no default branch yet; push a first commit, then run setup again",
    };
  }
  const defaultBranch = repo.defaultBranchRef.name;

  // gh may answer for a repo origin is not (a fork's clone, gh's default
  // set to upstream): git must push where gh opens the pull request.
  const urls = await gitIn(git, root, [
    "config",
    "--get-regexp",
    "^remote\\..*\\.url$",
  ]);
  // Exit 1 is "no remotes": no match below, said there.
  if (urls.code !== 0 && urls.code !== 1)
    return unreadable("the git remotes (git config)", urls.stderr);
  const remotes = urls.stdout.split("\n").flatMap((l) => {
    const m = /^remote\.(.+)\.url (.+)$/.exec(l.trim());
    return m ? [{ name: m[1] as string, url: m[2] as string }] : [];
  });
  const named = (u: string) =>
    u
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .slice(-2)
      .join("/")
      .toLowerCase();
  const mine = remotes.filter((r) => named(r.url) === slug.toLowerCase());
  const remote = (mine.find((r) => r.name === "origin") ?? mine[0])?.name;
  if (remote === undefined)
    return {
      reason: "notGitHub",
      detail: `gh answers for ${slug}, and no git remote here is that repo (${remotes.map((r) => `${r.name} (${r.url.replace(/\/\/[^/@]*@/, "//")})`).join(", ") || "there are none"}); point gh at the repo to set up with \`gh repo set-default\`, or add a remote for ${slug}, then run setup again`,
    };

  type Deployment = {
    id: number;
    environment: string;
    sha: string;
    production_environment?: boolean;
    transient_environment?: boolean;
  };
  const listOf = async (query: string): Promise<Deployment[] | Unreadable> => {
    const dep = await read(gh, ["api", `repos/${slug}/deployments?${query}`]);
    return dep.ok && Array.isArray(dep.json)
      ? (dep.json as Deployment[])
      : unreadable(
          `repos/${slug}/deployments`,
          dep.ok ? "the answer was not a list" : dep.why,
        );
  };
  const found: Array<{ id: number; d: GithubFacts["deployments"][number] }> =
    [];
  // The API lists newest first: walk each environment's deployments until one is a success.
  const done = new Set<string>();
  const walk = async (list: Deployment[]): Promise<Unreadable | null> => {
    for (const d of list) {
      if (done.has(d.environment)) continue;
      const st = await read(gh, [
        "api",
        `repos/${slug}/deployments/${d.id}/statuses?per_page=30`,
      ]);
      if (!st.ok || !Array.isArray(st.json))
        return unreadable(
          `repos/${slug}/deployments/${d.id}/statuses`,
          st.ok ? "the answer was not a list" : st.why,
        );
      const win = (
        st.json as Array<{ state: string; environment_url?: string }>
      ).find((s) => s.state === "success");
      if (!win) continue;
      done.add(d.environment);
      found.push({
        id: d.id,
        d: {
          environment: d.environment,
          url: win.environment_url || null,
          sha: d.sha,
          production: d.production_environment === true,
          transient: d.transient_environment === true,
        },
      });
    }
    return null;
  };
  const newest = await listOf("per_page=30");
  if (!Array.isArray(newest)) return newest;
  const walked = await walk(newest);
  if (walked !== null) return walked;
  // A busy repo's newest page can be all another environment's: ask for the
  // chosen one by name, as the workflow's own check does.
  if (o.environment !== undefined && !done.has(o.environment)) {
    const seen = new Set(newest.map((d) => d.id));
    const own = await listOf(
      `environment=${encodeURIComponent(o.environment)}&per_page=30`,
    );
    if (!Array.isArray(own)) return own;
    const walkedOwn = await walk(own.filter((d) => !seen.has(d.id)));
    if (walkedOwn !== null) return walkedOwn;
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

  const heads = await gitIn(git, root, [
    "ls-remote",
    "--heads",
    remote,
    // In full: a short name matches the end of a ref, so alice/demoman/setup.
    `refs/heads/${BRANCH}`,
  ]);
  if (heads.code !== 0)
    return unreadable(`${BRANCH} on ${remote} (git ls-remote)`, heads.stderr);
  let setupBranch: GithubFacts["setupBranch"] = null;
  if (heads.stdout.trim()) {
    const prs = await read(gh, [
      "pr",
      "list",
      "--repo",
      slug,
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
    remote,
  };
}

export type ActionsSetting =
  | { kind: "alreadyOn" }
  | { kind: "turnedOn" }
  | { kind: "refused"; detail: string; url: string }
  | { kind: "unknown"; detail: string; url: string };

export async function allowActionPullRequests(
  gh: Gh,
  slug: string,
): Promise<ActionsSetting> {
  const url = `https://github.com/${slug}/settings/actions`;
  const path = `repos/${slug}/actions/permissions/workflow`;
  // Only a 403/409 is GitHub saying no, as "(HTTP 409)" or gh's
  // "(Conflict)"/"(Forbidden)"; anything else leaves the outcome unknown.
  const fail = (what: string, stderr: string): ActionsSetting => {
    const msg = stderr.trim().split("\n")[0] || "no message";
    if (!/HTTP (403|409)|\((Forbidden|Conflict)\)/.test(stderr)) {
      return {
        kind: "unknown",
        detail: `could not ${what} (${msg}); nothing was assumed. Check it at ${url}, or run setup again`,
        url,
      };
    }
    // Single sign-on also says "organization", but the token is what lacks
    // access: authorise it, no owner needed.
    if (/SAML|single sign-on|\bSSO\b/i.test(msg)) {
      return {
        kind: "refused",
        detail: `GitHub refused ${what}: ${msg}; the organisation uses single sign-on and gh's token is not authorised for it. Run \`gh auth refresh\` and authorise the organisation, then run setup again`,
        url,
      };
    }
    // An enterprise policy (a user's repo can be under one) is changed in
    // the enterprise's own settings: no organisation page to send to.
    if (/enterprise/i.test(msg)) {
      return {
        kind: "refused",
        detail: `GitHub refused ${what}: ${msg}; it reads as locked by an enterprise policy. An enterprise owner must allow "Allow GitHub Actions to create and approve pull requests" in the enterprise's Actions policies`,
        url,
      };
    }
    // The repo's checkbox is greyed out while the organisation forbids it:
    // the fix is the organisation's setting, by an owner (DEM-54).
    if (/organi[sz]ation/i.test(msg)) {
      const org = `https://github.com/organizations/${slug.split("/")[0]}/settings/actions`;
      return {
        kind: "refused",
        detail: `GitHub refused ${what}: ${msg}; it reads as locked by the organisation. An organisation owner must allow "Allow GitHub Actions to create and approve pull requests" at ${org}`,
        url: org,
      };
    }
    return {
      kind: "refused",
      detail: `GitHub refused ${what}: ${msg}; it reads as missing admin on the repo. Allow it at ${url}`,
      url,
    };
  };
  const got = await gh(["api", path]);
  if (got.code !== 0) return fail("read the Actions setting", got.stderr);
  let cur: {
    default_workflow_permissions: string;
    can_approve_pull_request_reviews: boolean;
  };
  try {
    cur = JSON.parse(got.stdout);
  } catch {
    return fail("read the Actions setting", "the answer was not JSON");
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
    : fail("confirm pull requests from workflows were turned on", put.stderr);
}
