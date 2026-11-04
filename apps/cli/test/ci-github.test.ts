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
  "pr list --head demoman/setup --state open --json number,url": ok([]),
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

// A checkout whose origin is a bare repo, with or without demoman/setup on it.
function checkout(withSetup: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-github-"));
  const run = (cwd: string, ...a: string[]) =>
    execFileSync("git", a, { cwd, stdio: "pipe" });
  run(dir, "init", "-q", "-b", "main", "work");
  run(dir, "init", "-q", "--bare", "origin.git");
  const work = join(dir, "work");
  run(work, "remote", "add", "origin", join(dir, "origin.git"));
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

describe("readGithub", () => {
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
          { id: 3, environment: "production", sha: "c3" },
          { id: 2, environment: "preview", sha: "b2" },
          { id: 1, environment: "production", sha: "a1" },
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
    expect((r as { deployments: unknown }).deployments).toEqual([
      { environment: "preview", url: "https://pv.example", sha: "b2" },
      { environment: "production", url: "https://prod.example", sha: "a1" },
    ]);
  });

  it("reads releases, the workflow, and the setup branch with its pull request", async () => {
    const r = await readGithub(
      fake({
        [`api repos/${S}/releases?per_page=1`]: ok([{ id: 1 }]),
        [`api repos/${S}/contents/.github/workflows/demoman.yml?ref=main`]: ok({
          name: "demoman.yml",
        }),
        "pr list --head demoman/setup --state open --json number,url": ok([
          { number: 7, url: "https://github.com/o/r/pull/7" },
        ]),
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
    expect(r).toMatchObject({
      kind: "refused",
      url: `https://github.com/${S}/settings/actions`,
    });
    const d = (r as { detail: string }).detail;
    expect(d).toContain("controlled by the organization");
    expect(d).toContain("organisation");
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
