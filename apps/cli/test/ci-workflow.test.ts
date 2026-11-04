import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, serializeApp } from "@demoman/run-core";
import type { Verified } from "@demoman/runner/package";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { GithubFacts } from "../src/ci-github.js";
import { envFileValues, type NeededSecret } from "../src/ci-secrets.js";
import type { CiDeps } from "../src/ci-setup.js";
import type { Watched } from "../src/ci-watch.js";
import {
  type CiAsk,
  type CiIo,
  type CiOptions,
  ciSetup,
  expr,
  ciWorkflow as workflow,
} from "../src/ci-workflow.js";

const ciWorkflow = (
  o: Omit<CiOptions, "app" | "secrets"> & Partial<CiOptions>,
): string => workflow({ app: null, secrets: { accounts: [], app: [] }, ...o });

// Most structure is asserted by the lines that carry it (every key sits at a
// fixed indent); `yaml`, a dev dependency, parses the variants where shape matters.
const push = ciWorkflow({ version: "0.2.0", trigger: "push", route: "pr" });
const deploy = ciWorkflow({
  version: "0.2.0",
  trigger: { deployment: "Production" },
  route: "pr",
});
const releaseY = ciWorkflow({
  version: "0.2.0",
  trigger: "release",
  route: "pr",
});
const dailyY = ciWorkflow({ version: "0.2.0", trigger: "daily", route: "pr" });
const triggers = [
  "push",
  "release",
  "daily",
  { deployment: "Production" },
] as const;
const app: AppSpec = {
  appVersion: 1,
  install: ["npm ci"],
  start: "npm start",
  url: "http://localhost:3000",
  timeoutSeconds: 60,
  env: {},
  secrets: ["STRIPE_KEY"],
  services: {
    postgres: {
      image: "postgres:16",
      ports: ["5432:5432"],
      env: { POSTGRES_PASSWORD: "dev" },
      options: "--health-cmd pg_isready",
    },
  },
};
const secrets = { accounts: ["SELLER"], app: ["STRIPE_KEY"] };
/** Every trigger, with and without an artifact, with and without app and secrets. */
const every = triggers.flatMap((trigger) =>
  [false, true].flatMap((artifact) =>
    [false, true].map((full) =>
      ciWorkflow({
        version: "0.2.0",
        trigger,
        route: "pr",
        ...(artifact ? { artifact } : {}),
        ...(full ? { app, secrets } : {}),
      }),
    ),
  ),
);
const withApp = ciWorkflow({
  version: "0.2.0",
  trigger: "push",
  route: "pr",
  app,
  secrets,
});
const lines = (y: string) => y.split("\n");
const npx = (y: string) => lines(y).filter((l) => l.includes("npx --prefix"));

describe("ciWorkflow artifact", () => {
  const art = ciWorkflow({
    version: "0.2.0",
    trigger: "push",
    route: "pr",
    artifact: true,
  });
  it("artifact adds out-dir and the upload step, always unless guarded off", () => {
    const refresh = lines(art).find((l) => l.includes(" refresh --deliver"));
    expect(refresh).toContain("--out-dir demoman-out");
    const at = lines(art).findIndex((l) =>
      l.includes("uses: actions/upload-artifact@v4"),
    );
    // Premise: the step exists and follows the refresh step.
    expect(at).toBeGreaterThan(lines(art).indexOf(refresh ?? ""));
    const step = lines(art).slice(at, at + 5);
    // Always, so a failed refresh still hands over what it made, but never
    // on Demoman's own commits, where the refresh step did not run.
    expect(step).toContain(
      `        if: ${expr("always() && steps.guard.outputs.skip != 'true'")}`,
    );
    expect(step).toContain("          name: demoman-videos");
    expect(step).toContain("          path: demoman-out");
  });
  it("artifact downloads the last artifact into demoman-out and compares against it there", () => {
    const refresh = lines(art).find((l) => l.includes(" refresh --deliver"));
    expect(refresh).toContain("--previous demoman-out");
    const at = lines(art).indexOf("      - name: Fetch the last run's videos");
    // Premise: the step exists and comes before the refresh step.
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(lines(art).indexOf(refresh ?? ""));
    const step = lines(art).slice(at, lines(art).indexOf(refresh ?? ""));
    expect(step).toContain(
      `        if: ${expr("steps.guard.outputs.skip != 'true'")}`,
    );
    expect(step).toContain(`          GH_TOKEN: ${expr("github.token")}`);
    expect(step).toContain("          EVENT: push");
    expect(step).toContain('          BRANCH: "main"');
    // gh reads another run's artifacts only with actions: read.
    expect(lines(art)).toContain("      actions: read");
  });

  /** The fetch step's script, as the workflow runs it. */
  const fetchScript = (y: string) => {
    const body = lines(y).slice(
      lines(y).indexOf("      - name: Fetch the last run's videos"),
    );
    const from = body.indexOf("        run: |") + 1;
    const end = body.findIndex(
      (l, i) => i >= from && !l.startsWith("          "),
    );
    return body
      .slice(from, end)
      .map((l) => l.slice(10))
      .join("\n");
  };
  const stepEnv = (y: string) => {
    const env: Record<string, string> = {};
    for (const k of ["EVENT", "BRANCH", "ENVIRONMENT"]) {
      const l = lines(y).find((x) => x.startsWith(`          ${k}: `)) ?? "";
      env[k] = l.slice(`          ${k}: `.length).replace(/^"|"$/g, "");
    }
    return env;
  };
  // A fake gh: `api` answers the fixture through the real jq the step passes
  // it (gh's --jq), and `run download` makes the folder, naming the run.
  const bin = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "gh $*" >> "$LOG"
if [ "$1" = api ] && [ "$2" = -X ]; then
  [ "$DEPLIST" = fail ] && exit 1
  sha=$(printf '%s' "$*" | sed 's|.* sha=\\([0-9a-f]*\\) .*|\\1|')
  env=$(printf '%s' "$*" | sed 's|.* environment=\\([^ ]*\\) .*|\\1|')
  grep -cx "$env" "$DEPLOYS/$sha" 2>/dev/null || echo 0
  exit 0
fi
if [ "$1" = api ]; then
  case "$2" in
    */actions/workflows/*) [ "$LIST" = fail ] && exit 1; jq -r "$4" "$RUNS"; exit $? ;;
    */actions/runs/*) [ "$ARTLIST" = fail ] && exit 1
      id=$(printf '%s' "$2" | sed 's|.*/runs/\\([0-9]*\\)/.*|\\1|')
      if [ -f "$ARTS/$id.json" ]; then jq -r "$4" "$ARTS/$id.json"; else echo '{"artifacts":[]}' | jq -r "$4"; fi
      exit $? ;;
  esac
  exit 3
fi
mkdir -p demoman-out && echo "$3" > demoman-out/from
[ "$GET" = fail ] && exit 1
exit 0
`,
    { mode: 0o755 },
  );
  type Run = {
    id: number;
    created_at: string;
    event: string;
    head_branch: string;
    /** "HEAD" (the checkout's), "OFF" (a commit not on it), or a sha. */
    head_sha: string;
    path: string;
    head_repository: { id: number };
    repository: { id: number };
  };
  const run = (id: number, day: number, more: Partial<Run> = {}): Run => ({
    id,
    created_at: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`,
    event: "push",
    head_branch: "main",
    head_sha: "HEAD",
    path: ".github/workflows/demoman.yml",
    head_repository: { id: 1 },
    repository: { id: 1 },
    ...more,
  });
  const shell = (
    y: string,
    runs: Run[],
    artifacts: Record<number, "ok" | "expired">,
    env: Record<string, string> = {},
    /** Each sha's deployments, by environment name. */
    deployments: Record<string, string[]> = {},
  ) => {
    const cwd = mkdtempSync(join(tmpdir(), "ws-"));
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
    git("init", "-q");
    // The repo's own identity: CI's runner has none, and commit-tree needs one too.
    git("config", "user.name", "t");
    git("config", "user.email", "t@t");
    for (const m of ["one", "two"])
      git("commit", "-q", "--allow-empty", "-m", m);
    const shas: Record<string, string> = {
      HEAD: git("rev-parse", "HEAD"),
      // A commit off the checkout's history, as a tag named like the branch.
      OFF: git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-m", "tag"),
    };
    const sha = (x: string) => shas[x] ?? x;
    const log = join(cwd, "log");
    writeFileSync(log, "");
    writeFileSync(
      join(cwd, "runs.json"),
      JSON.stringify({
        workflow_runs: runs.map((r) => ({ ...r, head_sha: sha(r.head_sha) })),
      }),
    );
    const deploys = join(cwd, "deploys");
    mkdirSync(deploys);
    for (const [k, envs] of Object.entries(deployments))
      writeFileSync(join(deploys, sha(k)), `${envs.join("\n")}\n`);
    const arts = join(cwd, "arts");
    mkdirSync(arts);
    for (const [id, state] of Object.entries(artifacts))
      writeFileSync(
        join(arts, `${id}.json`),
        JSON.stringify({
          artifacts: [{ name: "demoman-videos", expired: state === "expired" }],
        }),
      );
    const r = spawnSync("bash", ["-e", "-c", fetchScript(y)], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_WORKFLOW_REF:
          "o/r/.github/workflows/demoman.yml@refs/heads/main",
        LOG: log,
        RUNS: join(cwd, "runs.json"),
        ARTS: arts,
        DEPLOYS: deploys,
        ...stepEnv(y),
        ...env,
      },
    });
    const from = join(cwd, "demoman-out", "from");
    return {
      ...r,
      log: readFileSync(log, "utf8"),
      has: existsSync(join(cwd, "demoman-out")),
      from: existsSync(from) ? readFileSync(from, "utf8").trim() : null,
    };
  };
  it("premise: jq is here to run the step's selection, as gh's --jq would", () => {
    expect(spawnSync("jq", ["--version"]).status).toBe(0);
  });

  it("a push trigger takes this workflow's own newest push run on its branch with an artifact, never a fork's or another workflow's", () => {
    const runs = [
      run(400, 1),
      // Newer than ours, each with an artifact of the same name.
      run(900, 9, { event: "pull_request", head_repository: { id: 2 } }),
      run(850, 8, { head_repository: { id: 2 } }),
      run(800, 8, { path: ".github/workflows/other.yml" }),
      run(750, 7, { event: "deployment_status" }),
      run(700, 7, { head_branch: "feature" }),
      // A tag named "main": the branch filter matches it, its commit is off
      // the branch. Red: drop the merge-base check.
      run(650, 7, { head_sha: "OFF" }),
      // Ours: no artifact (a guard-skipped run), then an expired one.
      run(600, 6),
      run(550, 5),
      run(500, 4),
    ];
    const r = shell(art, runs, {
      400: "ok",
      900: "ok",
      850: "ok",
      800: "ok",
      750: "ok",
      700: "ok",
      650: "ok",
      550: "expired",
      500: "ok",
    });
    expect(r.status, r.stderr).toBe(0);
    // Red: drop the select — the fork's run 900 is the newest.
    expect(r.from, r.log).toBe("500");
    expect(r.log).toContain(
      "gh api repos/o/r/actions/workflows/demoman.yml/runs?event=push&status=completed&per_page=50&branch=main",
    );
    expect(r.log).toContain(
      "gh run download 500 --repo o/r --name demoman-videos --dir demoman-out",
    );
  });

  it("a deployment trigger takes this workflow's own newest deployment run with an artifact, on any branch", () => {
    const dep = ciWorkflow({
      version: "0.2.0",
      trigger: { deployment: "Production" },
      route: "pr",
      artifact: true,
    });
    expect(stepEnv(dep)).toEqual({
      EVENT: "deployment_status",
      BRANCH: "",
      ENVIRONMENT: "Production",
    });
    const d = { event: "deployment_status", head_branch: "v1.2" };
    const PREVIEW = "e".repeat(40);
    const r = shell(
      dep,
      [
        run(990, 9, { ...d, head_repository: { id: 2 } }),
        run(980, 8, { ...d, path: ".github/workflows/other.yml" }),
        run(970, 7),
        // A fork's preview deployment ran this workflow from this repo:
        // its commit was never deployed to Production. Red: drop the check.
        run(965, 7, { ...d, head_sha: PREVIEW }),
        run(960, 6, d),
      ],
      { 990: "ok", 980: "ok", 970: "ok", 965: "ok", 960: "ok" },
      {},
      { [PREVIEW]: ["Preview"], HEAD: ["Production"] },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.from, r.log).toBe("960");
    // Premise: the preview run was asked about, and refused for its environment.
    expect(r.log).toContain(`sha=${PREVIEW} -f environment=Production`);
    expect(r.log).toContain(
      "gh api repos/o/r/actions/workflows/demoman.yml/runs?event=deployment_status&status=completed&per_page=50 ",
    );
  });

  it("the download step says why there is nothing to compare against, and never stops the job", () => {
    const ours = [run(500, 4)];
    const listFails = shell(art, ours, { 500: "ok" }, { LIST: "fail" });
    expect(listFails.status, listFails.stderr).toBe(0);
    expect(listFails.stdout).toContain(
      "::warning::This workflow's earlier runs could not be listed",
    );
    const artFails = shell(art, ours, { 500: "ok" }, { ARTLIST: "fail" });
    expect(artFails.status, artFails.stderr).toBe(0);
    expect(artFails.stdout).toContain(
      "::warning::Run 500's artifacts could not be listed",
    );
    expect(artFails.log).not.toContain("run download");
    const none = shell(art, ours, {});
    expect(none.status, none.stderr).toBe(0);
    expect(none.stdout).toContain(
      "None of this workflow's newest 50 runs here has a demoman-videos artifact",
    );
    expect(none.log).not.toContain("run download");
    const getFails = shell(art, ours, { 500: "ok" }, { GET: "fail" });
    expect(getFails.status, getFails.stderr).toBe(0);
    expect(getFails.stdout).toContain(
      "::warning::Run 500's demoman-videos artifact could not be downloaded",
    );
    expect(getFails.has, "a half download is removed").toBe(false);
    const dep = ciWorkflow({
      version: "0.2.0",
      trigger: { deployment: "Production" },
      route: "pr",
      artifact: true,
    });
    const depOurs = [run(500, 4, { event: "deployment_status" })];
    const deployFails = shell(dep, depOurs, { 500: "ok" }, { DEPLIST: "fail" });
    expect(deployFails.status, deployFails.stderr).toBe(0);
    expect(deployFails.stdout).toContain(
      "::warning::The deployments of run 500's commit could not be listed",
    );
    expect(deployFails.log).not.toContain("run download");
    const got = shell(art, ours, { 500: "ok" });
    expect(got.status, got.stderr).toBe(0);
    expect(got.stdout).toBe("");
    expect(got.from).toBe("500");
  });
  it("without artifact, neither appears", () => {
    // The check job's own --out-dir is not the cumulative artifact's.
    expect(push.slice(0, push.indexOf("\n  check:\n"))).not.toContain(
      "--out-dir",
    );
    expect(push).not.toContain("--previous");
    expect(push.slice(0, push.indexOf("\n  check:\n"))).not.toContain(
      "upload-artifact",
    );
    expect(push).not.toContain("gh run download");
    expect(push).not.toContain("actions: read");
  });
});

describe("ciWorkflow", () => {
  it("pins the version in both npx lines", () => {
    expect(npx(push)).toHaveLength(4); // two per job
    for (const l of npx(push)) expect(l).toContain("demoman@0.2.0");
    expect(push).toContain("setup --browser-only");
    expect(push).not.toContain("setup --yes");
  });

  it("indents with spaces only and has the three top-level keys", () => {
    expect(push).not.toContain("\t");
    for (const key of ["name:", "on:", "jobs:"]) {
      expect(lines(push)).toContain(key === "name:" ? "name: Demoman" : key);
    }
    // Write permission is the refresh job's, never the workflow's.
    expect(lines(push)).not.toContain("permissions:");
    expect(push).toContain("      contents: write");
    expect(push).toContain("      pull-requests: write");
  });

  it("checks out the full history, for deliver's commit check", () => {
    expect(push).toContain("uses: actions/checkout@v4");
    expect(push).toContain("fetch-depth: 0");
  });

  it("checks out LFS files, so refresh compares videos and not pointers", () => {
    for (const y of [push, deploy]) {
      const checkout = y
        .split("uses: actions/checkout@v4\n")[1]
        ?.split("\n      - ")[0];
      expect(checkout).toContain("          lfs: true");
    }
  });

  it("guards the push job against its own commits", () => {
    expect(push).toContain("[skip demoman]");
    expect(push).toContain("github.actor != 'github-actions[bot]'");
    expect(parse(push).jobs.refresh.if).toContain(
      "!contains(github.event.head_commit.message, '[skip demoman]')",
    );
  });

  it("has no start step in any trigger", () => {
    for (const y of [push, deploy, releaseY, dailyY]) {
      expect(y).not.toMatch(/Start your app/);
      expect(y).not.toContain("wait-on");
    }
  });

  it("triggers on deployment_status and refreshes the deployed URL", () => {
    expect(lines(deploy)).toContain("  deployment_status:");
    expect(deploy).toContain(
      "github.event.deployment_status.state == 'success'",
    );
    expect(deploy).toContain(
      "github.event.deployment.environment == 'Production'",
    );
    // The URL reaches the shell through env, never interpolated into it.
    expect(deploy).toContain('--base-url "${DEMOMAN_BASE_URL:?');
    expect(deploy).toContain(
      `DEMOMAN_BASE_URL: ${expr("github.event.deployment_status.environment_url")}`,
    );
    expect(deploy).toContain(`ref: ${expr("github.event.deployment.sha")}`);
    expect(push).not.toContain("--base-url");
  });

  it("says the deployment named no URL, rather than misusing --base-url", () => {
    const line = npx(deploy).find((l) => l.includes(" refresh "));
    const run = line?.trim().replace(/^run: /, "") ?? "";
    expect(run, "premise: the refresh run line").toContain("refresh --deliver");
    const bin = mkdtempSync(join(tmpdir(), "npx-"));
    writeFileSync(join(bin, "npx"), '#!/bin/sh\necho "npx $*"\n', {
      mode: 0o755,
    });
    const shell = (url: string) =>
      spawnSync("bash", ["-e", "-c", run], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEMOMAN_BASE_URL: url,
        },
      });
    const empty = shell("");
    expect(empty.status).not.toBe(0);
    expect(empty.stdout, "npx must not run").toBe("");
    expect(empty.stderr).toContain("named no environment_url");
    const set = shell("https://app.example.com");
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain("--base-url https://app.example.com");
  });

  it("interpolates no expression into any run line, in either shape", () => {
    for (const y of [push, deploy, withApp]) {
      const runs = lines(y).filter((l) => l.trim().startsWith("run:"));
      expect(
        runs.length,
        "premise: the workflow has run lines",
      ).toBeGreaterThan(3);
      for (const l of runs) expect(l, l).not.toContain("${{");
    }
  });

  it("passes the route to --deliver", () => {
    expect(push).toContain("refresh --deliver pr");
    expect(deploy).toContain("refresh --deliver pr");
    expect(
      ciWorkflow({ version: "0.2.0", trigger: "push", route: "main" }),
    ).toContain("refresh --deliver main");
    expect(push).toContain(`GH_TOKEN: ${expr("github.token")}`);
  });

  it("installs exactly the named fonts", () => {
    const apt = lines(push).find((l) => l.includes("apt-get install"));
    expect(apt).toContain("fonts-noto-core fonts-noto-color-emoji");
    expect(apt?.trim().endsWith("fonts-noto-color-emoji")).toBe(true);
  });

  it("caches Playwright's browsers keyed on the version", () => {
    expect(push).toContain("path: ~/.cache/ms-playwright");
    expect(push).toContain("key: playwright-0.2.0");
  });

  it("refuses an environment name that would break the quoting", () => {
    expect(() =>
      ciWorkflow({
        version: "0.2.0",
        trigger: { deployment: "a'b" },
        route: "pr",
      }),
    ).toThrow(/environment/);
  });
});

describe("the loop guard", () => {
  const skipIf = expr("steps.guard.outputs.skip != 'true'");
  /** The steps of the job, each as its own block of lines. */
  const steps = (y: string) =>
    y
      .slice(y.indexOf("    steps:\n") + 11, y.indexOf("\n  check:\n"))
      .split(/\n(?= {6}- )/)
      .filter((b) => b.startsWith("      - "));

  for (const [name, y, sha] of [
    ["push", push, "github.sha"],
    ["deployment", deploy, "github.event.deployment.sha"],
  ] as const) {
    it(`${name}: a guard step follows the checkout and every later step is conditioned on it`, () => {
      const all = steps(y);
      expect(all.length).toBeGreaterThan(4);
      expect(all[0]).toContain("actions/checkout@v4");
      expect(all[1]).toContain("id: guard");
      expect(all[1]).toContain(`SHA: ${expr(sha)}`);
      for (const later of all.slice(2)) {
        expect(later, later).toContain(`if: ${skipIf}`);
      }
      // The sha reaches the script through env, never interpolated into it.
      expect(all[1]?.split("run: |")[1]).not.toContain("${{");
    });
  }

  it("outputs skip for the refresh PR's merge commit and a marked commit, not an ordinary one", () => {
    const script = (push.split("run: |\n")[1] ?? "")
      .split("\n      - ")[0]
      ?.split("\n")
      .map((l) => l.slice(10))
      .join("\n");
    expect(script).toContain("GITHUB_OUTPUT");
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    git("init", "-q");
    const answer = (message: string): string => {
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        message,
      );
      const out = join(dir, "out.txt");
      writeFileSync(out, "");
      execFileSync("bash", ["-c", script ?? ""], {
        cwd: dir,
        env: { ...process.env, SHA: "HEAD", GITHUB_OUTPUT: out },
      });
      return readFileSync(out, "utf8");
    };
    expect(answer("Merge pull request #7 from acme/demoman/refresh")).toBe(
      "skip=true\n",
    );
    expect(answer("Refresh the demo\n\n[skip demoman]")).toBe("skip=true\n");
    expect(answer("Fix the invoice filter")).toBe("");
    // A squash merge of the refresh PR, as each of GitHub's squash
    // messages writes it: the PR title alone, or with its description.
    expect(answer("Refresh demo videos (#12)")).toBe("skip=true\n");
    expect(
      answer(
        "Refresh demo videos (#12)\n\nDemoman filmed the kept flows again and replaced 1.",
      ),
    ).toBe("skip=true\n");
    expect(answer("Refresh demo videos for the new nav")).toBe("");
  });

  it("keeps the push job's own guard", () => {
    expect(push).toContain("github.actor != 'github-actions[bot]'");
  });
});

describe("the workflow's shape", () => {
  it("serialises runs", () => {
    expect(push).toContain(
      "    concurrency:\n      group: demoman-refresh\n      cancel-in-progress: false",
    );
    for (const y of every) {
      expect(parse(y).jobs.refresh.concurrency).toEqual({
        group: "demoman-refresh",
        "cancel-in-progress": false,
      });
      expect(parse(y).concurrency).toBeUndefined();
    }
  });
  it("watches the branch it is given, main by default", () => {
    expect(push).toContain("branches: [main]");
    const m = ciWorkflow({
      version: "0.2.0",
      trigger: "push",
      route: "pr",
      branch: "master",
    });
    expect(m).toContain("branches: [master]");
  });
  it("refuses the main route on a deployment", () => {
    expect(() =>
      ciWorkflow({
        version: "0.2.0",
        trigger: { deployment: "P" },
        route: "main",
      }),
    ).toThrow(/not a branch/);
  });
});

describe("release and daily triggers", () => {
  const release = ciWorkflow({
    version: "0.2.0",
    trigger: "release",
    route: "pr",
  });
  const daily = ciWorkflow({ version: "0.2.0", trigger: "daily", route: "pr" });

  it("records a published release at its tag", () => {
    expect(release).toContain("on:\n  release:\n    types: [published]\n");
    expect(release).toContain(`ref: ${expr("github.event.release.tag_name")}`);
    expect(release).not.toContain("push:");
  });

  it("records once a day on the branch it watches, and only on the schedule", () => {
    expect(daily).toContain('on:\n  schedule:\n    - cron: "17 6 * * *"\n');
    expect(daily).not.toContain("workflow_dispatch");
    // The schedule runs on the default branch: the checkout names no ref.
    expect(lines(daily).filter((l) => l.trim().startsWith("ref:"))).toEqual([]);
  });

  it("guards neither with the loop guard, which only a push can trip", () => {
    for (const y of [release, daily]) {
      expect(y).not.toContain("Skip Demoman's own commits");
      expect(y).not.toContain("steps.guard");
      // Only the pull_request exclusion conditions the refresh job.
      expect(parse(y).jobs.refresh.if).toBe(
        expr("github.event_name != 'pull_request'"),
      );
    }
    // Premise: the push workflow still has it.
    expect(push).toContain("Skip Demoman's own commits");
  });

  it("refuses the main route on a release, which checks out a tag", () => {
    expect(() =>
      ciWorkflow({ version: "0.2.0", trigger: "release", route: "main" }),
    ).toThrow(
      "--route main cannot go with a release trigger: the released commit is a tag, not a branch, so the refresh cannot commit on main from it. Use --route pr there, or a daily or push trigger.",
    );
    expect(() =>
      ciWorkflow({ version: "0.2.0", trigger: "daily", route: "main" }),
    ).not.toThrow();
  });
});

describe("the daily run stops early when nothing is new", () => {
  const daily = (artifact: boolean) =>
    ciWorkflow({
      version: "0.2.0",
      trigger: "daily",
      route: "pr",
      ...(artifact ? { artifact: true } : {}),
    });
  const names = (y: string) =>
    lines(y)
      .filter(
        (l) => l.startsWith("      - name:") || l.startsWith("      - uses:"),
      )
      .map((l) => l.trim());
  const at = (y: string, name: string) =>
    names(y).findIndex((n) => n.includes(name));

  it("checks before Chromium and the app, after the last run's videos are fetched", () => {
    for (const y of [daily(false), daily(true)]) {
      const check = at(y, "Anything new since the last refresh?");
      expect(check, names(y).join("\n")).toBeGreaterThan(
        at(y, "actions/setup-node"),
      );
      expect(check).toBeLessThan(at(y, "Install Chromium"));
      expect(check).toBeLessThan(at(y, "Refresh the repo's flows"));
      expect(y.indexOf("id: fresh")).toBeLessThan(
        y.indexOf("Refresh the repo's flows"),
      );
    }
    const a = daily(true);
    expect(at(a, "Fetch the last run's videos")).toBeLessThan(
      at(a, "Anything new since the last refresh?"),
    );
  });

  it("runs the check with the fetched receipts, and stops only on its 3", () => {
    expect(daily(true)).toContain(
      "if npx --prefix ~/ -y demoman@0.2.0 refresh --check --previous demoman-out $since; then",
    );
    expect(daily(false)).toContain(
      "if npx --prefix ~/ -y demoman@0.2.0 refresh --check $since; then",
    );
    const y = daily(false);
    expect(y).toContain('[ "$code" -eq 3 ] || exit "$code"');
    expect(y).toContain('echo "skip=true" >> "$GITHUB_OUTPUT"');
    expect(y).toContain(
      `echo "Nothing but the refresh's own files changed since each repo flow was last recorded or refreshed; nothing to refresh."`,
    );
  });

  it("anchors on this workflow's own last successful scheduled run, an ancestor of HEAD", () => {
    const y = daily(false);
    expect(y).toContain("actions: read");
    expect(y).toContain("runs?event=schedule&status=success&per_page=20");
    expect(y).toContain(
      'select(((.path // "") | startswith($ENV.WF)) and .head_repository.id == .repository.id)',
    );
    expect(y).toContain('git merge-base --is-ancestor "$s" HEAD');
    expect(y).toContain('since="--since $s"');
    // A listing that fails is said, and the check judges by the receipts.
    expect(y).toContain(
      "::warning::This workflow's earlier runs could not be listed, so each flow is judged by its receipt.",
    );
    expect(y).toContain(`GH_TOKEN: ${expr("github.token")}`);
  });

  it("skips every step after the check when it says so", () => {
    const y = daily(true);
    const refreshJob = lines(y.slice(0, y.indexOf("\n  check:\n")));
    const after = refreshJob.slice(
      refreshJob.findIndex((l) => l.includes("id: fresh")) + 1,
    );
    const conds = after.filter((l) => l.trim().startsWith("if: ${{"));
    expect(conds.length).toBeGreaterThanOrEqual(5);
    for (const c of conds)
      expect(c).toContain("steps.fresh.outputs.skip != 'true'");
  });

  it("is the daily run's alone: every other trigger records regardless", () => {
    for (const t of ["push", "release", { deployment: "P" }] as const)
      expect(
        ciWorkflow({
          version: "0.2.0",
          trigger: t,
          route: "pr",
          artifact: true,
        }),
      ).not.toContain("refresh --check");
  });
});

describe("ciSetup", () => {
  const SECRET = "sk_live_terminal-door-secret-42";
  const checkApp: AppSpec = {
    appVersion: 1,
    install: ["npm ci"],
    start: "npm start",
    url: "http://127.0.0.1:3999/",
    timeoutSeconds: 60,
    env: {},
    secrets: [],
    services: {},
  };
  /** A repo with one kept flow and, unless `appJson` is false, app.json. */
  function repoDir(o: { appJson?: boolean; envFile?: string } = {}): string {
    const root = mkdtempSync(join(tmpdir(), "demoman-ci-door-"));
    mkdirSync(join(root, ".demoman", "flows"), { recursive: true });
    writeFileSync(
      join(root, ".demoman", "flows", "checkout.json"),
      JSON.stringify({
        keptVersion: 2,
        flow: randomUUID(),
        deliver: "files",
        name: "Checkout",
        script: {
          scriptVersion: 1,
          name: "Checkout",
          target: "http://127.0.0.1:3999/",
          viewport: { width: 1280, height: 800 },
          steps: [{ do: "waitForLoad" }],
        },
        scale: 1,
        logo: null,
        wallpaper: null,
        outputs: [
          { path: "o.mp4", fileType: "mp4", aspect: "16:9", quality: "share" },
        ],
        report: null,
      }),
    );
    if (o.appJson !== false)
      writeFileSync(join(root, ".demoman", "app.json"), serializeApp(checkApp));
    if (o.envFile !== undefined) writeFileSync(join(root, ".env"), o.envFile);
    return root;
  }
  const passedCheck: Verified = {
    passed: true,
    flow: "Checkout",
    outcome: "unchanged",
    recordSeconds: 8,
    appSeconds: 3,
    lines: [],
  };
  const passedRun: Watched = {
    passed: {
      runUrl: "https://github.com/o/r/actions/runs/9",
      artifactUrl: "https://github.com/o/r/actions/runs/9#artifacts",
      lines: [],
    },
  };
  /** Every question answered by `answers`; one not given fails the test. */
  function asker(answers: Partial<CiAsk>) {
    const asked: Array<[string, unknown[]]> = [];
    const ask = Object.fromEntries(
      (
        ["trigger", "route", "appHole", "secret", "envFile", "confirm"] as const
      ).map((k) => [
        k,
        async (...a: unknown[]) => {
          asked.push([k, a]);
          const f = answers[k] as ((...x: unknown[]) => unknown) | undefined;
          if (f === undefined) throw new Error(`asked ${k}`);
          return f(...a);
        },
      ]),
    ) as unknown as CiAsk;
    return { ask, asked };
  }
  function door(
    o: {
      root?: string;
      ask?: CiAsk | null;
      facts?: Partial<GithubFacts>;
      needed?: NeededSecret[];
      detected?: Awaited<ReturnType<CiDeps["detectApp"]>>;
      verify?: CiDeps["verifySetup"];
      watched?: Watched;
      /** Runs inside each readGithub. */
      onRead?: () => void;
    } = {},
  ) {
    const root = o.root ?? repoDir();
    const said: string[] = [];
    const calls: string[] = [];
    const seen: {
      verify?: Parameters<CiDeps["verifySetup"]>;
      set?: Parameters<CiDeps["setSecrets"]>;
      pr?: Parameters<CiDeps["openSetupPr"]>[0];
    } = {};
    const sig: { interrupt: (() => void) | null; restored: number } = {
      interrupt: null,
      restored: 0,
    };
    const deps: Omit<CiDeps, "log" | "signal"> = {
      version: "0.9.0",
      env: {},
      git: async (args) =>
        args[0] === "ls-tree"
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 128, stdout: "", stderr: "fatal: no such path" },
      readGithub: async () => {
        calls.push("readGithub");
        o.onRead?.();
        return {
          slug: "o/r",
          defaultBranch: "trunk",
          canPush: true,
          isAdmin: true,
          deployments: [],
          hasReleases: false,
          workflowOnDefault: false,
          setupBranch: null,
          remote: "origin",
          ...o.facts,
        };
      },
      detectApp: async () =>
        o.detected ?? { none: "nothing to propose from: looked nowhere" },
      neededSecrets: async () => ({ needed: o.needed ?? [] }),
      localValues: async (_root, needed) => ({
        values: new Map(),
        missing: needed.map((n) => n.name),
        tooShort: [],
      }),
      envFileValues,
      existingSecrets: async () => [],
      verifySetup: async (...a) => {
        calls.push("verifySetup");
        seen.verify = a;
        return o.verify ? o.verify(...a) : passedCheck;
      },
      setSecrets: async (...a) => {
        calls.push("setSecrets");
        seen.set = a;
        return { set: [...a[1].keys()], kept: [], failed: [] };
      },
      allowActionPullRequests: async () => {
        calls.push("allowActionPullRequests");
        return { kind: "turnedOn" };
      },
      openSetupPr: async (a) => {
        calls.push("openSetupPr");
        seen.pr = a;
        return {
          opened: {
            number: 7,
            url: "https://github.com/o/r/pull/7",
            branch: "demoman/setup",
            sha: "s1",
          },
        };
      },
      watchSetupRun: async () => {
        calls.push("watchSetupRun");
        return o.watched ?? passedRun;
      },
    };
    const io: CiIo = {
      ask: o.ask ?? null,
      root: async () => ({ root }),
      deps: () => deps,
      exists: (p) => existsSync(join(root, p)),
      onInterrupt: (h) => {
        sig.interrupt = h;
        return () => {
          sig.interrupt = null;
          sig.restored += 1;
        };
      },
      say: (l) => void said.push(l),
    };
    return { io, said, calls, seen, sig, root };
  }
  const yes = ["--ci", "--yes"];
  const outward = ["setSecrets", "allowActionPullRequests", "openSetupPr"];

  it("with no terminal and no --yes, reads and writes nothing and names exactly the flags missing", async () => {
    // Red if ciSetup reads GitHub before refusing, or names a flag already given.
    const a = door();
    expect(await ciSetup(["--ci"], a.io)).toBe(1);
    expect(a.calls).toEqual([]);
    expect(a.said.join("\n")).toMatch(/--yes/);
    expect(a.said.join("\n")).toMatch(/--trigger/);
    expect(a.said.join("\n")).toMatch(/--route/);
    const b = door();
    expect(await ciSetup(["--ci", "--route", "pr"], b.io)).toBe(1);
    expect(b.said.join("\n")).toMatch(/--trigger/);
    expect(b.said.join("\n")).not.toMatch(/--route/);
    const c = door();
    expect(
      await ciSetup(["--ci", "--trigger", "daily", "--route", "pr"], c.io),
    ).toBe(1);
    expect(c.said.join("\n")).toMatch(/--yes/);
    expect(c.said.join("\n")).not.toMatch(/--trigger|--route/);
    expect([...a.calls, ...b.calls, ...c.calls]).toEqual([]);
  });

  it("--yes takes the default trigger and a pull request, asking nothing, and says the plan", async () => {
    // Red if --yes asks, or does not default trigger and route.
    const { ask, asked } = asker({});
    const m = door({ ask, facts: { hasReleases: true } });
    expect(await ciSetup(yes, m.io)).toBe(0);
    expect(asked).toEqual([]);
    const body = m.seen.pr?.body ?? "";
    expect(body).toContain(
      "Records the repo flows when a release is published.",
    );
    expect(body).toContain("Delivers what changed as a pull request.");
    expect(m.said).toContain(
      "Records the repo flows when a release is published.",
    );
    expect(m.calls).toEqual([
      "readGithub",
      "verifySetup",
      "setSecrets",
      "allowActionPullRequests",
      "openSetupPr",
      "watchSetupRun",
    ]);
  });

  it("asks a missing secret with a password prompt and never says its value, the check's log included", async () => {
    // Red if the check's log reaches say unredacted, or secret() is not asked.
    const { ask, asked } = asker({
      secret: async () => SECRET,
      confirm: async () => true,
    });
    const m = door({
      ask,
      needed: [{ name: "STRIPE_KEY", for: "app", why: "app.json" }],
      verify: async (_a, d) => {
        d.log(`the app said STRIPE_KEY=${SECRET}`);
        return passedCheck;
      },
    });
    expect(
      await ciSetup(["--ci", "--trigger", "daily", "--route", "pr"], m.io),
    ).toBe(0);
    expect(asked.filter(([k]) => k === "secret")).toEqual([
      ["secret", ["STRIPE_KEY", "app.json"]],
    ]);
    expect(m.seen.set?.[1].get("STRIPE_KEY")).toBe(SECRET);
    const all = m.said.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).toContain("the app said STRIPE_KEY=<redacted>");
  });

  it("with --yes and no terminal, a missing secret stops naming it and .demoman/secrets.env", async () => {
    const m = door({
      needed: [
        {
          name: "DEMOMAN_SECRET_SELLER",
          for: "account",
          why: "account seller",
        },
      ],
    });
    expect(await ciSetup(yes, m.io)).toBe(1);
    const all = m.said.join("\n");
    expect(all).toContain("DEMOMAN_SECRET_SELLER");
    expect(all).toContain(".demoman/secrets.env");
    expect(m.calls.filter((c) => c !== "readGithub")).toEqual([]);
  });

  it("--env-file offers only the names the setup asks for, and imports the chosen", async () => {
    // Red if the prompt lists every name in the file.
    const root = repoDir();
    const file = join(root, "prod.env");
    writeFileSync(file, `STRIPE_KEY=${SECRET}\nUNRELATED=nope\n`);
    const { ask, asked } = asker({
      envFile: async (_p, names) => names,
      confirm: async () => true,
    });
    const m = door({
      root,
      ask,
      needed: [{ name: "STRIPE_KEY", for: "app", why: "app.json" }],
    });
    expect(
      await ciSetup(
        ["--ci", "--trigger", "daily", "--route", "pr", "--env-file", file],
        m.io,
      ),
    ).toBe(0);
    expect(asked.find(([k]) => k === "envFile")?.[1]).toEqual([
      file,
      ["STRIPE_KEY"],
    ]);
    expect(asked.some(([k]) => k === "secret")).toBe(false);
    expect(m.seen.set?.[1].get("STRIPE_KEY")).toBe(SECRET);
    expect(m.said.join("\n")).not.toContain(SECRET);
  });

  it("offers a .env at the root in a terminal", async () => {
    const root = repoDir({ envFile: `STRIPE_KEY=${SECRET}\n` });
    const { ask, asked } = asker({
      envFile: async (_p, names) => names,
      confirm: async () => true,
    });
    const m = door({
      root,
      ask,
      needed: [{ name: "STRIPE_KEY", for: "app", why: "app.json" }],
    });
    expect(
      await ciSetup(["--ci", "--trigger", "daily", "--route", "pr"], m.io),
    ).toBe(0);
    expect(asked.find(([k]) => k === "envFile")?.[1]).toEqual([
      join(root, ".env"),
      ["STRIPE_KEY"],
    ]);
  });

  it("runs the check before the one confirmation, shows the plan there, and a no writes nothing", async () => {
    // Red if confirm is asked before the check, or a "no" still applies.
    const order: string[] = [];
    const { ask, asked } = asker({
      confirm: async () => {
        order.push("confirm");
        return false;
      },
    });
    const m = door({
      ask,
      verify: async () => {
        order.push("check");
        return passedCheck;
      },
    });
    expect(
      await ciSetup(["--ci", "--trigger", "push", "--route", "pr"], m.io),
    ).toBe(1);
    expect(order).toEqual(["check", "confirm"]);
    const lines = asked.find(([k]) => k === "confirm")?.[1][0] as string[];
    expect(lines).toContain(
      'Opens the pull request "Set up Demoman" from demoman/setup into trunk with:',
    );
    expect(lines).toContain("  .github/workflows/demoman.yml");
    expect(lines.some((l) => l.startsWith("Runner time: about"))).toBe(true);
    expect(m.calls.filter((c) => outward.includes(c))).toEqual([]);
    expect(m.said.join("\n")).toContain("nothing was written");
  });

  it("closes on the pull request, the run's verdict and the artifact link", async () => {
    const m = door({ ask: asker({ confirm: async () => true }).ask });
    expect(
      await ciSetup(["--ci", "--trigger", "daily", "--route", "pr"], m.io),
    ).toBe(0);
    const all = m.said.join("\n");
    // Once, before the watch's verdict.
    expect(
      m.said.filter((l) => l.includes("https://github.com/o/r/pull/7")),
    ).toEqual(["Opened the setup pull request: https://github.com/o/r/pull/7"]);
    expect(m.said.findIndex((l) => l.includes("pull/7"))).toBeLessThan(
      m.said.findIndex((l) => l.includes("passed")),
    );
    expect(all).toMatch(
      /passed.*https:\/\/github\.com\/o\/r\/actions\/runs\/9/,
    );
    expect(all).toContain("https://github.com/o/r/actions/runs/9#artifacts");
  });

  it("closes a failed run on its step and tail, and an unread count as unknown with the note", async () => {
    const m = door({
      watched: {
        failed: {
          runUrl: "https://github.com/o/r/actions/runs/9",
          step: "Refresh the repo flows",
          tail: "Error: the app did not answer",
          failedRuns: null,
          gaveUp: false,
          note: "How many setup runs have failed is unknown (the list could not be read).",
        },
      },
    });
    expect(await ciSetup(yes, m.io)).toBe(1);
    const all = m.said.join("\n");
    expect(all).toContain("Refresh the repo flows");
    expect(all).toContain("Error: the app did not answer");
    expect(all).toContain(
      "How many setup runs have failed is unknown (the list could not be read).",
    );
    expect(all).not.toMatch(/null/);
  });

  it("says an unknown outcome as unknown, never failed", async () => {
    // Red if unknown is worded as a failure.
    const m = door({
      watched: {
        unknown: {
          runUrl: "https://github.com/o/r/actions/runs/9",
          why: "GitHub could not be read 5 times in a row.",
        },
      },
    });
    expect(await ciSetup(yes, m.io)).toBe(1);
    const last = m.said.slice(-2).join("\n");
    expect(last).toContain("unknown");
    expect(last).toContain("GitHub could not be read 5 times in a row.");
    expect(last).not.toMatch(/fail/i);
  });

  it("Ctrl-C during the check stops it, says the stop line, and restores Ctrl-C", async () => {
    // Red if no signal reaches verifySetup, or the handler is left installed.
    const m = door({
      verify: async (_a, d) => {
        expect(d.signal?.aborted).toBe(false);
        m.sig.interrupt?.();
        expect(d.signal?.aborted).toBe(true);
        return {
          passed: false,
          step: "app",
          reason: "checkStopped",
          detail: "stopped; removed the checkout at /tmp/demoman-verify-x",
          tail: "",
        };
      },
    });
    expect(await ciSetup(yes, m.io)).toBe(1);
    expect(m.said.join("\n")).toContain(
      "stopped; removed the checkout at /tmp/demoman-verify-x; nothing was written",
    );
    expect(m.sig.interrupt).toBeNull();
    expect(m.sig.restored).toBe(1);
    expect(m.calls.filter((c) => outward.includes(c))).toEqual([]);
  });

  it("asks each hole in the proposed app.json, then checks the filled one", async () => {
    const { ask, asked } = asker({
      appHole: async () => "http://127.0.0.1:3999/app",
      confirm: async () => true,
    });
    const m = door({
      root: repoDir({ appJson: false }),
      ask,
      detected: {
        draft: { ...checkApp, url: null },
        source: { kind: "packageJson", file: "package.json" },
        holes: [{ field: "url", why: "no recorded origin to serve" }],
      },
    });
    expect(
      await ciSetup(["--ci", "--trigger", "daily", "--route", "pr"], m.io),
    ).toBe(0);
    expect(asked.find(([k]) => k === "appHole")?.[1]).toEqual([
      "url",
      "no recorded origin to serve",
    ]);
    expect(m.seen.verify?.[0].target).toEqual({
      app: { ...checkApp, url: "http://127.0.0.1:3999/app" },
    });
    expect(m.seen.pr?.files.map((f) => f.path)).toContain(".demoman/app.json");
  });

  it("with --yes, a hole stops naming it and app.json", async () => {
    const m = door({
      root: repoDir({ appJson: false }),
      detected: {
        draft: { ...checkApp, url: null },
        source: { kind: "packageJson", file: "package.json" },
        holes: [{ field: "url", why: "no recorded origin to serve" }],
      },
    });
    expect(await ciSetup(yes, m.io)).toBe(1);
    const all = m.said.join("\n");
    expect(all).toContain("url (no recorded origin to serve)");
    expect(all).toContain(".demoman/app.json");
    expect(m.calls).toEqual(["readGithub"]);
  });

  it("takes an environment named like a trigger by deployment:, and refuses --route main with it", async () => {
    const m = door({
      facts: {
        deployments: [
          { environment: "release", url: "https://x.example", sha: "a" },
        ],
      },
    });
    expect(
      await ciSetup(
        ["--ci", "--yes", "--trigger", "deployment:release", "--route", "main"],
        m.io,
      ),
    ).toBe(1);
    expect(m.said.join("\n")).toContain("not a branch");
    expect(m.calls).toEqual(["readGithub"]);
  });

  it("stops outside a git repo, and on an unknown --route", async () => {
    const a = door();
    a.io.root = async () => ({ none: "not a git repository" });
    expect(await ciSetup(yes, a.io)).toBe(1);
    expect(a.said.join("")).toContain("not a git repository");
    const b = door();
    expect(await ciSetup([...yes, "--route", "sideways"], b.io)).toBe(1);
    expect(b.said.join("")).toContain("--route is pr or main");
    expect([...a.calls, ...b.calls]).toEqual([]);
  });

  it("Ctrl-C while GitHub is read cancels setup, asking nothing after", async () => {
    // Red if the swallowed Ctrl-C lets the door go on to prompt for a secret.
    const { ask, asked } = asker({
      secret: async () => SECRET,
      confirm: async () => true,
    });
    const m = door({
      ask,
      needed: [{ name: "STRIPE_KEY", for: "app", why: "app.json" }],
      onRead: () => m.sig.interrupt?.(),
    });
    expect(
      await ciSetup(["--ci", "--trigger", "daily", "--route", "pr"], m.io),
    ).toBe(1);
    expect(asked).toEqual([]);
    expect(m.said).toContain("Setup cancelled; nothing was written.");
    expect(m.sig.restored).toBe(1);
    expect(m.calls).toEqual(["readGithub"]);
  });

  it("stops on a --replace-secret name the setup does not use, naming it", async () => {
    // Red if a mistyped name is ignored and the old secret silently kept.
    const m = door({
      needed: [{ name: "STRIPE_KEY", for: "app", why: "app.json" }],
    });
    const root = m.root;
    writeFileSync(join(root, "prod.env"), `STRIPE_KEY=${SECRET}\n`);
    expect(
      await ciSetup(
        [
          ...yes,
          "--env-file",
          join(root, "prod.env"),
          "--replace-secret",
          "STRPE_KEY",
        ],
        m.io,
      ),
    ).toBe(1);
    const all = m.said.join("\n");
    expect(all).toContain("STRPE_KEY");
    expect(all).toContain("STRIPE_KEY");
    expect(all).not.toContain(SECRET);
    expect(m.calls.filter((c) => outward.includes(c))).toEqual([]);
    // Review finding 5: refused before the check, not after it.
    expect(m.calls).not.toContain("verifySetup");
  });

  it("with no terminal, leaves --route out when the trigger allows only a pull request", async () => {
    for (const t of ["release", "Production"]) {
      const m = door();
      expect(await ciSetup(["--ci", "--trigger", t], m.io)).toBe(1);
      expect(m.said.join("\n")).toMatch(/--yes/);
      expect(m.said.join("\n")).not.toMatch(/--route/);
    }
  });

  it("with --route main, offers only the triggers main can take", async () => {
    // Red if release or a deployment is offered and refused after the answer.
    const { ask, asked } = asker({
      trigger: async () => "daily",
      confirm: async () => true,
    });
    const m = door({
      ask,
      facts: {
        hasReleases: true,
        deployments: [
          { environment: "production", url: "https://x.example", sha: "a" },
        ],
      },
    });
    expect(await ciSetup(["--ci", "--route", "main"], m.io)).toBe(0);
    const offers = asked.find(([k]) => k === "trigger")?.[1][0] as Array<{
      trigger: unknown;
      offered: boolean;
    }>;
    expect(offers.filter((o) => o.offered).map((o) => o.trigger)).toEqual([
      "daily",
      "push",
    ]);
  });

  it("asks the trigger from the offers and the route with the real branch", async () => {
    const { ask, asked } = asker({
      trigger: async () => "push",
      route: async () => "main",
      confirm: async () => true,
    });
    const m = door({ ask });
    expect(await ciSetup(["--ci"], m.io)).toBe(0);
    const offers = asked.find(([k]) => k === "trigger")?.[1][0] as Array<{
      label: string;
    }>;
    expect(offers.map((o) => o.label)).toContain("on each merge to trunk");
    expect(asked.find(([k]) => k === "route")?.[1]).toEqual(["trunk"]);
    expect(m.seen.pr?.body).toContain(
      "Delivers what changed as a commit on trunk.",
    );
  });
});

describe("the workflow starts nothing, passes named secrets, runs services, and checks itself", () => {
  type Job = {
    if?: string;
    permissions?: Record<string, string>;
    concurrency?: Record<string, unknown>;
    services?: Record<string, Record<string, unknown>>;
    steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
  };
  const jobs = (y: string) => parse(y).jobs as { refresh: Job; check: Job };
  const refreshStep = (j: Job, deliver: boolean) =>
    j.steps.find(
      (s) =>
        s.name === "Refresh the repo's flows" &&
        s.run?.includes(" --deliver") === deliver,
    );

  it("passes each account's secret and origin and each app secret, in both jobs", () => {
    for (const y of every.filter((y) => y.includes("DEMOMAN_SECRET_SELLER"))) {
      for (const [job, deliver] of [
        [jobs(y).refresh, true],
        [jobs(y).check, false],
      ] as const) {
        expect(refreshStep(job, deliver)?.env).toMatchObject({
          DEMOMAN_SECRET_SELLER: expr("secrets.DEMOMAN_SECRET_SELLER"),
          DEMOMAN_SECRET_SELLER_ORIGIN: expr(
            "secrets.DEMOMAN_SECRET_SELLER_ORIGIN",
          ),
          STRIPE_KEY: expr("secrets.STRIPE_KEY"),
        });
      }
    }
    expect(withApp, "premise: the secrets are in this variant").toContain(
      "DEMOMAN_SECRET_SELLER",
    );
  });

  it("names no secret and keeps no commented secret lines when there are none", () => {
    for (const y of [push, deploy, releaseY, dailyY]) {
      expect(y).not.toContain("secrets.");
      expect(y).not.toContain("# DEMOMAN_SECRET");
      expect(y).not.toContain("Secrets on a fork's pull request");
    }
  });

  it("refuses a secret name a workflow cannot carry", () => {
    for (const bad of ["a b", "GITHUB_TOKEN", "X\n  Y: z"]) {
      expect(() =>
        ciWorkflow({
          version: "0.2.0",
          trigger: "push",
          route: "pr",
          secrets: { accounts: [], app: [bad] },
        }),
      ).toThrow(/secret name/);
    }
  });

  it("renders the app's services into both jobs, and none without them", () => {
    const j = jobs(withApp);
    for (const job of [j.refresh, j.check]) {
      expect(job.services).toEqual({
        postgres: {
          image: "postgres:16",
          ports: ["5432:5432"],
          env: { POSTGRES_PASSWORD: "dev" },
          options: "--health-cmd pg_isready",
        },
      });
    }
    for (const y of [push, deploy, releaseY, dailyY]) {
      expect(y).not.toContain("services:");
    }
    expect(() =>
      ciWorkflow({
        version: "0.2.0",
        trigger: "push",
        route: "pr",
        app: {
          ...app,
          services: {
            x: { image: "i", ports: [], env: {}, options: expr("secrets.A") },
          },
        },
      }),
    ).toThrow(/service/);
  });

  it("watches the pull request's own paths under every trigger", () => {
    for (const y of every) {
      expect(parse(y).on.pull_request).toEqual({
        paths: [".github/workflows/demoman.yml", ".demoman/**"],
      });
    }
  });

  it("keeps the refresh job off pull requests under every trigger", () => {
    for (const y of every) {
      expect(jobs(y).refresh.if, y).toMatch(
        /^\$\{\{ github\.event_name != 'pull_request'( && \(.+\))? \}\}$/,
      );
    }
    expect(jobs(deploy).refresh.if).toContain(
      "github.event.deployment.environment == 'Production'",
    );
  });

  it("checks on the pull request alone, read-only, delivering nothing, in its own group", () => {
    for (const y of every) {
      const { check, refresh } = jobs(y);
      expect(check.if).toBe(expr("github.event_name == 'pull_request'"));
      expect(check.permissions).toEqual(
        y.includes("deployment_status:")
          ? { contents: "read", deployments: "read" }
          : { contents: "read" },
      );
      expect(check.concurrency).toEqual({
        group: `demoman-check-${expr("github.ref")}`,
        "cancel-in-progress": true,
      });
      const mine = refreshStep(check, false);
      expect(mine?.run).toMatch(
        / refresh( --base-url "[^"]+")? --out-dir demoman-check$/,
      );
      expect(JSON.stringify(check)).not.toContain("--deliver");
      expect(JSON.stringify(check)).not.toContain("contents: write");
      expect(refresh.permissions?.contents).toBe("write");
    }
  });

  it("says why a fork's pull request cannot run the check, and stops", () => {
    const step = jobs(withApp).check.steps.find((s) =>
      s.name?.startsWith("Secrets on a fork"),
    ) as { if?: string; run?: string } | undefined;
    expect(step?.if).toBe(
      expr(
        "github.event.pull_request.head.repo.full_name != github.repository",
      ),
    );
    const r = spawnSync("bash", ["-c", step?.run ?? ""], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe(
      "::error::Secrets are not given to pull requests from forks, so this check cannot sign in or start the app; a maintainer can run it from a branch in this repository.",
    );
    // It is the first step (review finding 7), so a fork's pull request
    // fails in seconds, before checkout, Node, Chromium and fonts, and the
    // sign-in never gets to fail.
    const names = jobs(withApp).check.steps.map((s) => s.name ?? "");
    expect(names.findIndex((n) => n.startsWith("Secrets on a fork"))).toBe(0);
    expect(names.indexOf("Install Chromium")).toBeGreaterThan(0);
  });

  it("copies the commit flows' files under demoman-check/repo and uploads always", () => {
    const { steps } = jobs(withApp).check;
    const gather = steps.find((s) => s.name?.startsWith("Gather"));
    const dir = mkdtempSync(join(tmpdir(), "check-"));
    mkdirSync(join(dir, "demoman-check"));
    mkdirSync(join(dir, ".demoman/flows"), { recursive: true });
    writeFileSync(join(dir, ".demoman/flows/a b.mp4"), "v");
    writeFileSync(join(dir, "other.txt"), "x");
    writeFileSync(
      join(dir, "demoman-check/demoman-refresh.json"),
      JSON.stringify({
        videos: [
          { deliver: "commit", files: [{ path: ".demoman/flows/a b.mp4" }] },
          { deliver: "files", files: [{ path: "other.txt" }] },
        ],
      }),
    );
    // BSD cp has no --parents; the runner is Linux, so ditto it with ditto-free rsync -R.
    const gnu = spawnSync("cp", ["--parents", "--version"]);
    if (gnu.status === 0) {
      const r = spawnSync("bash", ["-e", "-c", gather?.run ?? ""], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(
        existsSync(join(dir, "demoman-check/repo/.demoman/flows/a b.mp4")),
      ).toBe(true);
      expect(existsSync(join(dir, "demoman-check/repo/other.txt"))).toBe(false);
    }
    expect(gather).toMatchObject({ if: "always()" });
    const up = steps.at(-1) as Record<string, unknown>;
    expect(up).toMatchObject({
      if: "always()",
      with: { name: "demoman-check", path: "demoman-check" },
    });
  });

  it("fetches the last run's videos in the refresh job only, and writes no undefined", () => {
    const withArtifact = triggers.flatMap((trigger) =>
      [false, true].map((full) =>
        ciWorkflow({
          version: "0.2.0",
          trigger,
          route: "pr",
          artifact: true,
          ...(full ? { app, secrets } : {}),
        }),
      ),
    );
    for (const y of withArtifact) {
      expect(y).not.toContain("undefined");
      const { check, refresh } = jobs(y);
      expect(check.steps.filter((s) => s.name?.startsWith("Fetch"))).toEqual(
        [],
      );
      expect(refresh.steps.some((s) => s.name?.startsWith("Fetch"))).toBe(true);
    }
  });

  it("checks out, installs and records the same way in both jobs", () => {
    const { check, refresh } = jobs(dailyY);
    expect(check.steps.map((s) => s.name).filter(Boolean)).toEqual(
      expect.arrayContaining(["Install Chromium", "Install fonts"]),
    );
    expect(JSON.stringify(check)).not.toContain("steps.fresh");
    expect(JSON.stringify(refresh)).toContain("steps.fresh");
  });
});

// R30: the check runs on a pull request, where no deployment_status event
// names a URL; it reads the environment's newest successful deployment.
describe("the deployment trigger's check records the deployed app", () => {
  type Step = {
    name?: string;
    id?: string;
    run?: string;
    env?: Record<string, string>;
  };
  type Job = {
    permissions?: Record<string, string>;
    services?: unknown;
    steps: Step[];
  };
  const deployApp = ciWorkflow({
    version: "0.2.0",
    trigger: { deployment: "Production" },
    route: "pr",
    app,
    secrets,
  });
  const jobs = (y: string) => parse(y).jobs as { refresh: Job; check: Job };

  // Red: refreshSteps sets the check's deployment to null again.
  it("passes --base-url from the found deployment, read through env", () => {
    const { check } = jobs(deployApp);
    const refresh = check.steps.find(
      (s) => s.name === "Refresh the repo's flows",
    );
    expect(refresh?.run).toContain('--base-url "${DEMOMAN_BASE_URL:?');
    expect(refresh?.run).toContain("refresh --base-url");
    expect(refresh?.env?.DEMOMAN_BASE_URL).toBe(
      expr("steps.deployed.outputs.url"),
    );
    const names = check.steps.map((s) => s.name ?? "");
    expect(names.indexOf("Find the deployed app")).toBeGreaterThan(-1);
    expect(names.indexOf("Find the deployed app")).toBeLessThan(
      names.indexOf("Refresh the repo's flows"),
    );
    const find = check.steps.find((s) => s.name === "Find the deployed app");
    expect(find?.id).toBe("deployed");
    expect(find?.env).toEqual({
      GH_TOKEN: expr("github.token"),
      ENVIRONMENT: "Production",
    });
    expect(check.permissions).toEqual({
      contents: "read",
      deployments: "read",
    });
  });

  // Red: drop the deployment test on the services block.
  it("serves nothing under a deployment trigger, even with app.json's services", () => {
    const { check, refresh } = jobs(deployApp);
    expect(check.services).toBeUndefined();
    expect(refresh.services).toBeUndefined();
    expect(
      jobs(withApp).check.services,
      "premise: services render elsewhere",
    ).toBeDefined();
  });

  const find = jobs(deployApp).check.steps.find(
    (s) => s.name === "Find the deployed app",
  );
  /** The step's script with a fake gh: `ids` the deployments, `statuses` each one's. */
  const shell = (
    ids: string,
    statuses: Record<string, unknown[]>,
    fail = "",
  ) => {
    const cwd = mkdtempSync(join(tmpdir(), "dep-"));
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    for (const [id, list] of Object.entries(statuses))
      writeFileSync(join(cwd, `${id}.json`), JSON.stringify(list));
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
echo "gh $*" >> "${cwd}/log"
[ "$FAIL" = "$2" ] && exit 1
case "$2" in
  -X) printf '%s\\n' ${ids} ;;
  *) id=$(printf '%s' "$2" | sed 's|.*/deployments/\\([0-9]*\\)/.*|\\1|'); jq -r "$4" "${cwd}/$id.json" ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(join(cwd, "out"), "");
    const r = spawnSync("bash", ["-e", "-c", find?.run ?? ""], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_OUTPUT: join(cwd, "out"),
        ENVIRONMENT: "Production",
        FAIL: fail,
      },
    });
    return {
      ...r,
      out: readFileSync(join(cwd, "out"), "utf8"),
      log: readFileSync(join(cwd, "log"), "utf8"),
    };
  };

  it("takes the newest successful deployment's environment_url", () => {
    const r = shell("9 8", {
      9: [{ state: "failure", environment_url: "https://bad.example" }],
      8: [
        { state: "success", environment_url: "https://new.example" },
        { state: "success", environment_url: "https://old.example" },
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toBe("url=https://new.example\n");
    expect(r.log).toContain(
      "gh api -X GET repos/o/r/deployments -f environment=Production -f per_page=30",
    );
  });

  it("fails naming the environment when no successful deployment names a URL", () => {
    const r = shell("9", {
      9: [{ state: "success", target_url: "https://logs.example" }],
    });
    expect(r.status).toBe(1);
    expect(r.out).toBe("");
    expect(r.stdout).toContain(
      "No successful deployment to Production names an environment_url",
    );
  });

  it("says the list could not be read, never that there is no deployment", () => {
    const r = shell("9", {}, "-X");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      "The Production deployments could not be listed",
    );
  });
});

// Finding 2: ubuntu-24.04 has npm alone; pnpm and yarn need corepack, bun its action.
describe("the app's package manager is there in both jobs", () => {
  type Job = { steps: Array<{ name?: string; uses?: string; run?: string }> };
  const jobs = (y: string) => parse(y).jobs as { refresh: Job; check: Job };
  const corepack = (j: Job) =>
    j.steps.filter((s) => s.run === "corepack enable");
  const bun = (j: Job) =>
    j.steps.filter((s) => s.uses === "oven-sh/setup-bun@v2");
  const bunApp = ciWorkflow({
    version: "0.2.0",
    trigger: "daily",
    route: "pr",
    app: {
      ...app,
      install: ["bun install --frozen-lockfile"],
      start: "bun run dev",
    },
  });

  // Red: drop the corepack step.
  it("enables corepack before the refresh wherever refresh starts the app", () => {
    for (const j of [jobs(withApp).refresh, jobs(withApp).check]) {
      expect(corepack(j)).toHaveLength(1);
      const at = (f: (s: Job["steps"][number]) => boolean) =>
        j.steps.findIndex(f);
      expect(at((s) => s.run === "corepack enable")).toBeLessThan(
        at((s) => s.name === "Refresh the repo's flows"),
      );
      expect(bun(j)).toEqual([]);
    }
  });

  // Red: drop the setup-bun step.
  it("sets up bun when app.json's commands use it", () => {
    for (const j of [jobs(bunApp).refresh, jobs(bunApp).check]) {
      expect(bun(j)).toHaveLength(1);
      expect(corepack(j)).toHaveLength(1);
    }
  });

  it("adds neither when no app is started", () => {
    const deployApp = ciWorkflow({
      version: "0.2.0",
      trigger: { deployment: "Production" },
      route: "pr",
      app: { ...app, start: "bun run dev" },
    });
    for (const y of [push, deployApp])
      for (const j of [jobs(y).refresh, jobs(y).check]) {
        expect(corepack(j)).toEqual([]);
        expect(bun(j)).toEqual([]);
      }
  });
});
