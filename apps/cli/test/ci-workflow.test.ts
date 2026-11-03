import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciSetup, ciWorkflow, expr } from "../src/ci-workflow.js";

// No YAML parser is in the repo's dependencies, so the structure is asserted
// by the lines that carry it; every key sits at a fixed indent.
const push = ciWorkflow({ version: "0.2.0", trigger: "push", route: "pr" });
const deploy = ciWorkflow({
  version: "0.2.0",
  trigger: { deployment: "Production" },
  route: "pr",
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
    expect(lines(art)).toContain("  actions: read");
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
    expect(push).not.toContain("--out-dir");
    expect(push).not.toContain("--previous");
    expect(push).not.toContain("upload-artifact");
    expect(push).not.toContain("gh run download");
    expect(push).not.toContain("actions: read");
  });
});

describe("ciWorkflow", () => {
  it("pins the version in both npx lines", () => {
    expect(npx(push)).toHaveLength(2);
    for (const l of npx(push)) expect(l).toContain("demoman@0.2.0");
    expect(push).toContain("setup --browser-only");
    expect(push).not.toContain("setup --yes");
  });

  it("indents with spaces only and has the three top-level keys", () => {
    expect(push).not.toContain("\t");
    for (const key of ["name:", "on:", "permissions:", "jobs:"]) {
      expect(lines(push)).toContain(key === "name:" ? "name: Demoman" : key);
    }
    expect(push).toContain("  contents: write");
    expect(push).toContain("  pull-requests: write");
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
    expect(lines(push).filter((l) => l.startsWith("    if:"))).toHaveLength(1);
  });

  it("starts the app for push, and not for a deployment", () => {
    expect(push).toContain("Start your app");
    expect(deploy).not.toContain("Start your app");
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
    for (const y of [push, deploy]) {
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
      .slice(y.indexOf("    steps:\n") + 11)
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
      "concurrency:\n  group: demoman-refresh\n  cancel-in-progress: false",
    );
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
  it("names _ORIGIN beside each secret", () => {
    expect(push).toContain("# DEMOMAN_SECRET_SELLER: ");
    expect(push).toContain("# DEMOMAN_SECRET_SELLER_ORIGIN: ");
    expect(push).toContain("{ secret: NAME }");
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
      expect(lines(y).filter((l) => l.startsWith("    if:"))).toEqual([]);
    }
    // Premise: the push workflow still has it.
    expect(push).toContain("Skip Demoman's own commits");
  });

  it("asks both to start the app, as push does", () => {
    for (const y of [release, daily]) expect(y).toContain("Start your app");
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
        y.indexOf("# Start your app"),
      );
    }
    const a = daily(true);
    expect(at(a, "Fetch the last run's videos")).toBeLessThan(
      at(a, "Anything new since the last refresh?"),
    );
  });

  it("runs the check with the fetched receipts, and stops only on its 3", () => {
    expect(daily(true)).toContain(
      "if npx --prefix ~/ -y demoman@0.2.0 refresh --check --previous demoman-out; then",
    );
    expect(daily(false)).toContain(
      "if npx --prefix ~/ -y demoman@0.2.0 refresh --check; then",
    );
    const y = daily(false);
    expect(y).toContain('[ "$code" -eq 3 ] || exit "$code"');
    expect(y).toContain('echo "skip=true" >> "$GITHUB_OUTPUT"');
    expect(y).toContain(
      'echo "Every repo flow was recorded at this commit; nothing to refresh."',
    );
  });

  it("skips every step after the check when it says so", () => {
    const y = daily(true);
    const after = lines(y).slice(
      lines(y).findIndex((l) => l.includes("id: fresh")) + 1,
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
  const io = (
    over: {
      exists?: boolean;
      root?: { root: string } | { none: string };
      branch?: string | null;
      ask?: unknown;
    } = {},
  ) => {
    const said: string[] = [];
    const wrote: Array<[string, string]> = [];
    const asked = { n: 0 };
    return {
      said,
      wrote,
      asked,
      io: {
        version: "0.2.0",
        ask: (over.ask ?? null) as never,
        root: async () => over.root ?? { root: "/repo" },
        defaultBranch: async () =>
          over.branch === undefined ? "main" : over.branch,
        exists: () => over.exists ?? false,
        write: (p: string, t: string) => void wrote.push([p, t]),
        say: (l: string) => void said.push(l),
      },
    };
  };
  const flags = ["--ci", "--trigger", "push", "--route", "pr"];

  it("writes the file and says the settings that make it work", async () => {
    const m = io();
    expect(await ciSetup(flags, m.io)).toBe(0);
    expect(m.wrote[0]?.[0]).toBe(".github/workflows/demoman.yml");
    expect(m.wrote[0]?.[1]).toBe(push);
    const said = m.said.join("\n");
    expect(said).toContain(
      "Allow GitHub Actions to create and approve pull requests",
    );
    expect(said).toContain("Start your app");
    expect(said).toContain("_ORIGIN");
  });

  it("takes release and daily by name, and an environment named like them by deployment:", async () => {
    const r = io();
    expect(
      await ciSetup(["--ci", "--trigger", "release", "--route", "pr"], r.io),
    ).toBe(0);
    expect(r.wrote[0]?.[1]).toContain("  release:");
    const d = io();
    expect(
      await ciSetup(["--ci", "--trigger", "daily", "--route", "main"], d.io),
    ).toBe(0);
    expect(d.wrote[0]?.[1]).toContain("  schedule:");
    const e = io();
    expect(
      await ciSetup(
        ["--ci", "--trigger", "deployment:release", "--route", "pr"],
        e.io,
      ),
    ).toBe(0);
    expect(e.wrote[0]?.[1]).toContain(
      "github.event.deployment.environment == 'release'",
    );
    const m = io();
    expect(
      await ciSetup(["--ci", "--trigger", "release", "--route", "main"], m.io),
    ).toBe(1);
    expect(m.said.join("\n")).toContain("cannot go with a release trigger");
    expect(m.wrote).toEqual([]);
  });

  it("names every trigger when there is no terminal to ask in", async () => {
    const m = io();
    expect(await ciSetup(["--ci"], m.io)).toBe(1);
    expect(m.said.join("\n")).toContain(
      "pass --trigger release|daily|push|<environment> and --route pr|main",
    );
  });

  it("stops, writing nothing, without a terminal or with a file already there", async () => {
    const a = io();
    expect(await ciSetup(["--ci"], a.io)).toBe(1);
    expect(a.said.join("")).toContain("--trigger");
    const b = io({ exists: true });
    expect(await ciSetup(flags, b.io)).toBe(1);
    expect(a.wrote.length + b.wrote.length).toBe(0);
  });

  it("stops outside a git repo", async () => {
    const m = io({ root: { none: "not a git repository" } });
    expect(await ciSetup(flags, m.io)).toBe(1);
    expect(m.said.join("")).toContain("not a git repository");
    expect(m.wrote).toEqual([]);
  });

  it("looks for an existing file before asking anything", async () => {
    const m = io({
      exists: true,
      ask: {
        trigger: async () => {
          throw new Error("asked");
        },
        route: async () => "pr",
      },
    });
    expect(await ciSetup(["--ci"], m.io)).toBe(1);
    expect(m.said.join("")).toContain("already exists");
  });

  it("refuses --route main with a deployment trigger, by flags and by prompt", async () => {
    const a = io();
    expect(
      await ciSetup(
        ["--ci", "--trigger", "Production", "--route", "main"],
        a.io,
      ),
    ).toBe(1);
    const b = io({
      ask: { trigger: async () => "Production", route: async () => "main" },
    });
    expect(await ciSetup(["--ci"], b.io)).toBe(1);
    for (const m of [a, b]) {
      expect(m.said.join("")).toContain("not a branch");
      expect(m.said.join("")).toContain("--route pr");
      expect(m.wrote).toEqual([]);
    }
  });

  it("writes the default branch it read, and says it assumed main when it cannot read one", async () => {
    const a = io({ branch: "master" });
    expect(await ciSetup(flags, a.io)).toBe(0);
    expect(a.wrote[0]?.[1]).toContain("branches: [master]");
    expect(a.said.join("")).not.toContain("assum");
    const b = io({ branch: null });
    expect(await ciSetup(flags, b.io)).toBe(0);
    expect(b.wrote[0]?.[1]).toContain("branches: [main]");
    expect(b.said.join("\n")).toContain(
      "Could not read origin's default branch",
    );
  });
});
