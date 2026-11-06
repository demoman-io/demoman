import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowActionPullRequests, readGithub } from "../src/ci-github.js";
import type { Gh } from "../src/gh-run.js";

type Answer = { code?: number; stdout?: string; stderr?: string };
const ok = (v: unknown): Answer => ({ stdout: JSON.stringify(v) });
const http = (n: number, msg = "x"): Answer => ({
  code: 1,
  stderr: `gh: ${msg} (HTTP ${n})`,
});

const S = "o/r";
const base: Record<string, Answer> = {
  "--version": { stdout: "gh version 2.50.0" },
  "auth status": { stdout: "Logged in" },
  "repo view --json nameWithOwner,defaultBranchRef,viewerPermission": ok({
    nameWithOwner: S,
    defaultBranchRef: { name: "main" },
    viewerPermission: "ADMIN",
  }),
  [`api repos/${S}/deployments?per_page=30`]: ok([]),
  [`api repos/${S}/releases?per_page=1`]: ok([]),
  [`api repos/${S}/contents/.github/workflows/demoman.yml?ref=main`]: http(
    404,
    "Not Found",
  ),
  "pr list --repo o/r --head demoman/setup --state open --json number,url": ok(
    [],
  ),
};
function fake(
  over: Record<string, Answer> = {},
  calls: Array<{ args: string[]; input?: string }> = [],
): Gh {
  const table = { ...base, ...over };
  return async (args, o) => {
    calls.push({ args, input: o?.input });
    const a = table[args.join(" ")];
    if (!a) throw new Error(`unscripted gh ${args.join(" ")}`);
    return {
      code: a.code ?? 0,
      stdout: a.stdout ?? "",
      stderr: a.stderr ?? "",
    };
  };
}

const run = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, stdio: "pipe" });
/** A remote named for its GitHub URL, which git reads as a local bare repo. */
function remote(work: string, name: string, slug: string): string {
  const bare = join(work, "..", `${name}.git`);
  run(join(work, ".."), "init", "-q", "--bare", bare);
  const url = `https://github.com/${slug}.git`;
  run(work, "remote", "add", name, url);
  run(work, "config", `url.${bare}.insteadOf`, url);
  return bare;
}

// A checkout whose origin is o/r (a bare repo), with or without
// demoman/setup on it.
function checkout(withSetup: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-github-"));
  run(dir, "init", "-q", "-b", "main", "work");
  const work = join(dir, "work");
  remote(work, "origin", S);
  run(
    work,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "a",
  );
  if (withSetup)
    run(work, "push", "-q", "origin", "HEAD:refs/heads/demoman/setup");
  return work;
}

// A fork's clone: origin is the person's fork, upstream the repo gh answers
// for, which alone has demoman/setup.
function forkClone(withUpstream: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-github-"));
  run(dir, "init", "-q", "-b", "main", "work");
  const work = join(dir, "work");
  remote(work, "origin", "me/r");
  run(
    work,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "a",
  );
  if (withUpstream) {
    remote(work, "upstream", S);
    run(work, "push", "-q", "upstream", "HEAD:refs/heads/demoman/setup");
  }
  return work;
}

describe("readGithub", () => {
  // Review finding 6. Red when the branch is read on origin (the fork) while
  // gh answers for upstream, or `gh pr list` runs without --repo.
  it("in a fork's clone, reads the setup branch on the remote that is gh's repo, and asks gh about that repo", async () => {
    const calls: Array<{ args: string[] }> = [];
    const r = await readGithub(fake({}, calls), forkClone(true));
    expect(r).toMatchObject({
      slug: S,
      remote: "upstream",
      setupBranch: { pr: null },
    });
    const list = calls.find((c) => c.args[0] === "pr")?.args;
    expect(list?.slice(0, 4)).toEqual(["pr", "list", "--repo", S]);
  });
  it("refuses notGitHub naming gh's repo and each remote when no remote is that repo", async () => {
    const calls: Array<{ args: string[] }> = [];
    const work = forkClone(false);
    run(work, "remote", "add", "x", "https://me:tok123@github.com/x/y.git");
    const r = await readGithub(fake({}, calls), work);
    expect(r).toMatchObject({ reason: "notGitHub" });
    const detail = (r as { detail: string }).detail;
    expect(detail).toContain(S);
    expect(detail).toContain("origin (https://github.com/me/r.git)");
    expect(detail).toContain("gh repo set-default");
    // A token in a remote's URL is never said.
    expect(detail).toContain("x (https://github.com/x/y.git)");
    expect(detail).not.toContain("tok123");
    // Nothing else was read off a repo the push would not reach.
    expect(calls.some((c) => c.args[0] === "api")).toBe(false);
  });

  it("says ghMissing, with how to install, when gh cannot be spawned", async () => {
    const r = await readGithub(
      fake({ "--version": { code: 127, stderr: "Error: spawn gh ENOENT" } }),
      "/x",
    );
    expect(r).toMatchObject({ reason: "ghMissing" });
    expect((r as { detail: string }).detail).toContain(
      "https://cli.github.com",
    );
  });
  it("says ghSignedOut with gh auth login", async () => {
    const r = await readGithub(
      fake({ "auth status": { code: 1, stderr: "not logged in" } }),
      "/x",
    );
    expect(r).toMatchObject({ reason: "ghSignedOut" });
    expect((r as { detail: string }).detail).toContain("gh auth login");
  });
  it("says notGitHub when the checkout has no GitHub remote", async () => {
    const r = await readGithub(
      fake({
        "repo view --json nameWithOwner,defaultBranchRef,viewerPermission": {
          code: 1,
          stderr:
            "none of the git remotes configured for this repository point to a known GitHub host",
        },
      }),
      "/x",
    );
    expect(r).toMatchObject({ reason: "notGitHub" });
  });

  it("a gh --version that fails for another reason is githubUnreadable, not ghMissing", async () => {
    const r = await readGithub(
      fake({ "--version": { code: 1, stderr: "boom" } }),
      "/x",
    );
    expect(r).toMatchObject({ reason: "githubUnreadable" });
  });
  it("an inaccessible repo is githubUnreadable naming access, not notGitHub", async () => {
    const r = await readGithub(
      fake({
        "repo view --json nameWithOwner,defaultBranchRef,viewerPermission": {
          code: 1,
          stderr:
            "GraphQL: Could not resolve to a Repository with the name 'o/r'.",
        },
      }),
      "/x",
    );
    expect(r).toMatchObject({ reason: "githubUnreadable" });
    expect((r as { detail: string }).detail).toContain("access");
  });
  it("an empty repo (no default branch) is githubUnreadable asking for a first commit", async () => {
    const r = await readGithub(
      fake({
        "repo view --json nameWithOwner,defaultBranchRef,viewerPermission": ok({
          nameWithOwner: S,
          defaultBranchRef: null,
          viewerPermission: "ADMIN",
        }),
      }),
      "/x",
    );
    expect(r).toMatchObject({ reason: "githubUnreadable" });
    expect((r as { detail: string }).detail).toContain("push a first commit");
  });
  it("a deployments answer of null is githubUnreadable, not a throw", async () => {
    const r = await readGithub(
      fake({ [`api repos/${S}/deployments?per_page=30`]: ok(null) }),
      checkout(false),
    );
    expect(r).toMatchObject({ reason: "githubUnreadable" });
  });

  it("reads the repo, its permissions, and a missing workflow and setup branch", async () => {
    const r = await readGithub(fake(), checkout(false));
    expect(r).toEqual({
      slug: S,
      defaultBranch: "main",
      canPush: true,
      isAdmin: true,
      deployments: [],
      hasReleases: false,
      workflowOnDefault: false,
      setupBranch: null,
      remote: "origin",
    });
  });
  it("reads a read-only viewer as unable to push", async () => {
    const r = await readGithub(
      fake({
        "repo view --json nameWithOwner,defaultBranchRef,viewerPermission": ok({
          nameWithOwner: S,
          defaultBranchRef: { name: "main" },
          viewerPermission: "READ",
        }),
      }),
      checkout(false),
    );
    expect(r).toMatchObject({ canPush: false, isAdmin: false });
  });

  it("takes production's older success when its newest deployment failed", async () => {
    const r = await readGithub(
      fake({
        [`api repos/${S}/deployments?per_page=30`]: ok([
          {
            id: 3,
            environment: "production",
            sha: "c3",
            production_environment: true,
          },
          {
            id: 2,
            environment: "preview",
            sha: "b2",
            transient_environment: true,
          },
          {
            id: 1,
            environment: "production",
            sha: "a1",
            production_environment: true,
          },
        ]),
        [`api repos/${S}/deployments/3/statuses?per_page=30`]: ok([
          { state: "failure" },
        ]),
        [`api repos/${S}/deployments/1/statuses?per_page=30`]: ok([
          { state: "success", environment_url: "https://prod.example" },
        ]),
        [`api repos/${S}/deployments/2/statuses?per_page=30`]: ok([
          { state: "success", target_url: "https://pv.example" },
        ]),
      }),
      checkout(false),
    );
    // A target_url is a build log, never the app: no URL (finding 7; red
    // with the target_url fallback back).
    expect((r as { deployments: unknown }).deployments).toEqual([
      {
        environment: "preview",
        url: null,
        sha: "b2",
        production: false,
        transient: true,
      },
      {
        environment: "production",
        url: "https://prod.example",
        sha: "a1",
        production: true,
        transient: false,
      },
    ]);
  });

  it("reads releases, the workflow, and the setup branch with its pull request", async () => {
    const r = await readGithub(
      fake({
        [`api repos/${S}/releases?per_page=1`]: ok([{ id: 1 }]),
        [`api repos/${S}/contents/.github/workflows/demoman.yml?ref=main`]: ok({
          name: "demoman.yml",
        }),
        "pr list --repo o/r --head demoman/setup --state open --json number,url":
          ok([{ number: 7, url: "https://github.com/o/r/pull/7" }]),
      }),
      checkout(true),
    );
    expect(r).toMatchObject({
      hasReleases: true,
      workflowOnDefault: true,
      setupBranch: { pr: { number: 7, url: "https://github.com/o/r/pull/7" } },
    });
  });
  it("reports a setup branch with no pull request", async () => {
    const r = await readGithub(fake(), checkout(true));
    expect(r).toMatchObject({ setupBranch: { pr: null } });
  });

  it("a 404 on releases is no releases", async () => {
    const r = await readGithub(
      fake({ [`api repos/${S}/releases?per_page=1`]: http(404, "Not Found") }),
      checkout(false),
    );
    expect(r).toMatchObject({ hasReleases: false });
  });
  it("a 500 on releases is githubUnreadable naming the call, never no releases", async () => {
    const r = await readGithub(
      fake({
        [`api repos/${S}/releases?per_page=1`]: http(500, "Server Error"),
      }),
      checkout(false),
    );
    expect(r).toMatchObject({ reason: "githubUnreadable" });
    expect((r as { detail: string }).detail).toContain(`repos/${S}/releases`);
  });
  it("a 500 on the workflow file is githubUnreadable, never absent", async () => {
    const r = await readGithub(
      fake({
        [`api repos/${S}/contents/.github/workflows/demoman.yml?ref=main`]:
          http(502, "Bad Gateway"),
      }),
      checkout(false),
    );
    expect(r).toMatchObject({ reason: "githubUnreadable" });
  });
});

describe("allowActionPullRequests", () => {
  const path = `api repos/${S}/actions/permissions/workflow`;
  it("does not write when the setting is already on", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const r = await allowActionPullRequests(
      fake(
        {
          [path]: ok({
            default_workflow_permissions: "read",
            can_approve_pull_request_reviews: true,
          }),
        },
        calls,
      ),
      S,
    );
    expect(r).toEqual({ kind: "alreadyOn" });
    expect(calls.some((c) => c.args.includes("PUT"))).toBe(false);
  });
  it("turns it on, sending back the default permissions it read", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const r = await allowActionPullRequests(
      fake(
        {
          [path]: ok({
            default_workflow_permissions: "write",
            can_approve_pull_request_reviews: false,
          }),
          [`${path} -X PUT --input -`]: { stdout: "" },
        },
        calls,
      ),
      S,
    );
    expect(r).toEqual({ kind: "turnedOn" });
    const put = calls.find((c) => c.args.includes("PUT"));
    expect(JSON.parse(put?.input ?? "{}")).toEqual({
      default_workflow_permissions: "write",
      can_approve_pull_request_reviews: true,
    });
  });
  it("refuses on a 409 naming GitHub's message and the settings URL", async () => {
    const r = await allowActionPullRequests(
      fake({
        [path]: ok({
          default_workflow_permissions: "read",
          can_approve_pull_request_reviews: false,
        }),
        [`${path} -X PUT --input -`]: http(
          409,
          "Setting is controlled by the organization",
        ),
      }),
      S,
    );
    // An organisation lock is changed in the organisation's settings, where
    // the repo's checkbox is greyed out (DEM-54).
    expect(r).toMatchObject({
      kind: "refused",
      url: "https://github.com/organizations/o/settings/actions",
    });
    const d = (r as { detail: string }).detail;
    expect(d).toContain("controlled by the organization");
    expect(d).toContain("organisation");
  });
  // Red when gh's "(Conflict)" form, with no status number, reads as unknown (DEM-54).
  it("refuses gh's (Conflict) form as an organisation lock", async () => {
    const r = await allowActionPullRequests(
      fake({
        [path]: ok({
          default_workflow_permissions: "read",
          can_approve_pull_request_reviews: false,
        }),
        [`${path} -X PUT --input -`]: {
          code: 1,
          stderr:
            "gh: The organization does not allow GitHub Actions to create or approve pull requests (Conflict)",
        },
      }),
      S,
    );
    expect(r).toMatchObject({
      kind: "refused",
      url: "https://github.com/organizations/o/settings/actions",
    });
    expect((r as { detail: string }).detail).toContain(
      "An organisation owner must allow",
    );
  });
  const gets = {
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: false,
  };
  const notAskedAboutAdmin = (r: { kind: string; detail?: string }) => {
    expect(r.kind).toBe("unknown");
    expect(r.detail).not.toMatch(/admin|organisation/i);
    expect(r.detail).toContain(`https://github.com/${S}/settings/actions`);
  };
  it("a 500 on the GET is unknown, never refused", async () => {
    notAskedAboutAdmin(
      await allowActionPullRequests(
        fake({ [path]: http(500, "Server Error") }),
        S,
      ),
    );
  });
  it("a 502 on the PUT is unknown, never refused", async () => {
    notAskedAboutAdmin(
      await allowActionPullRequests(
        fake({
          [path]: ok(gets),
          [`${path} -X PUT --input -`]: http(502, "Bad Gateway"),
        }),
        S,
      ),
    );
  });
  it("a missing gh is unknown, never refused", async () => {
    notAskedAboutAdmin(
      await allowActionPullRequests(
        fake({ [path]: { code: 127, stderr: "Error: spawn gh ENOENT" } }),
        S,
      ),
    );
  });
  it("refuses on a 403 as missing admin", async () => {
    const r = await allowActionPullRequests(
      fake({
        [path]: ok({
          default_workflow_permissions: "read",
          can_approve_pull_request_reviews: false,
        }),
        [`${path} -X PUT --input -`]: http(403, "Resource not accessible"),
      }),
      S,
    );
    expect((r as { detail: string }).detail).toContain("admin");
  });
});
