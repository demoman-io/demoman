// `demoman setup --ci`: the GitHub Actions workflow that records the repo's
// flows again after each successful deployment, each published release, once
// a day, or on each merge to main, and delivers what changed with
// `demoman refresh --deliver`.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { APP_FILE, type AppSpec, parseApp } from "@demoman/run-core";
import type { AppProposal } from "@demoman/runner/package";
import { SETUP_BRANCH } from "./ci-pr.js";
import { envFileNames, type SecretValues } from "./ci-secrets.js";
import {
  applyCiSetup,
  type CiChoices,
  type CiDeps,
  type CiPlan,
  type CiStop,
  planCiSetup,
  planLines,
  redact,
  type TriggerOffer,
  triggerOffers,
} from "./ci-setup.js";
import { COMMIT_SUBJECT } from "./deliver.js";
import { PACKAGE_NAME } from "./names.js";

export interface CiOptions {
  version: string;
  trigger: "push" | "release" | "daily" | { deployment: string };
  route: "pr" | "main";
  /** The branch a push trigger watches; `main` when not given. */
  branch?: string;
  /** Write the files flows to demoman-out and upload it as an artifact. */
  artifact?: boolean;
  /** How the app starts (.demoman/app.json); null when the repo has none. */
  app: AppSpec | null;
  /** Secret names the workflow passes through: bare account names (each
   *  gives DEMOMAN_SECRET_N and its _ORIGIN) and the app's full env names. */
  secrets: { accounts: string[]; app: string[] };
}

export const CI_WORKFLOW_PATH = ".github/workflows/demoman.yml";

/** A GitHub expression, written without a template-looking literal. */
export const expr = (e: string): string => `\${{ ${e} }}`;

/** The loop guard's script: it reads the triggering commit's message from
 *  $SHA. The refresh pull request's merge commit reads "Merge pull request
 *  #N from <owner>/demoman/refresh"; its squash merge, "Refresh demo videos
 *  (#N)" with or without the PR's description; both routes' commits carry
 *  the marker. */
export const GUARD_SCRIPT = `msg=$(git log -1 --format=%B "$SHA")
if printf '%s' "$msg" | grep -qE '\\[skip demoman\\]|/demoman/refresh|^${COMMIT_SUBJECT} \\(#[0-9]+\\)$'; then
  echo "skip=true" >> "$GITHUB_OUTPUT"
  echo "Skipping: this commit is Demoman's own refresh, and refreshing on it would loop."
fi`;

export const RELEASE_MAIN =
  "--route main cannot go with a release trigger: the released commit is a tag, not a branch, so the refresh cannot commit on main from it. Use --route pr there, or a daily or push trigger.";

export const FORK_REFUSAL =
  "Secrets are not given to pull requests from forks, so this check cannot sign in or start the app; a maintainer can run it from a branch in this repository.";

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Every env name the workflow passes through: each account's value and the
 *  one origin it may be typed on, then the app's own. */
function secretNames(o: CiOptions): string[] {
  return [
    ...o.secrets.accounts.flatMap((n) => [
      `DEMOMAN_SECRET_${n}`,
      `DEMOMAN_SECRET_${n}_ORIGIN`,
    ]),
    ...o.secrets.app,
  ];
}

function shapeOf(o: CiOptions) {
  const deployment =
    typeof o.trigger === "string" ? null : o.trigger.deployment;
  const kind = typeof o.trigger === "string" ? o.trigger : "deployment";
  return {
    deployment,
    kind,
    // Only a push can be Demoman's own commit; the other triggers have no loop.
    guarded: kind === "push" || kind === "deployment",
    branch: o.branch ?? "main",
  } as const;
}

/** The app's services as a job's `services:` block; every value is a quoted
 *  scalar, so nothing in app.json can add a key or an expression. */
function servicesBlock(app: AppSpec | null): string {
  const entries = Object.entries(app?.services ?? {});
  if (entries.length === 0) return "";
  const q = (v: string): string => {
    if (v.includes("${{")) {
      throw new Error(
        `.demoman/app.json has "\${{" in a service value; a workflow would evaluate it, so write the service by hand`,
      );
    }
    return JSON.stringify(v);
  };
  const out = entries.map(([name, svc]) => {
    const env = Object.entries(svc.env);
    return [
      `      ${q(name)}:`,
      `        image: ${q(svc.image)}`,
      ...(svc.ports.length > 0
        ? ["        ports:", ...svc.ports.map((p) => `          - ${q(p)}`)]
        : []),
      ...(env.length > 0
        ? ["        env:", ...env.map(([k, v]) => `          ${q(k)}: ${q(v)}`)]
        : []),
      ...(svc.options === null ? [] : [`        options: ${q(svc.options)}`]),
    ].join("\n");
  });
  return `    services:\n${out.join("\n")}\n`;
}

export function ciWorkflow(o: CiOptions): string {
  const { deployment, kind } = shapeOf(o);
  for (const n of secretNames(o)) {
    if (!SECRET_NAME.test(n) || n.startsWith("GITHUB_")) {
      throw new Error(
        `the secret name "${n}" is not A-Z, 0-9 and _, or starts with GITHUB_; a workflow cannot pass it through`,
      );
    }
  }
  // The name goes inside a single-quoted expression string.
  if (deployment !== null && !/^[\w .-]+$/.test(deployment)) {
    throw new Error(
      `the deployment environment "${deployment}" has characters other than letters, digits, spaces, "_", "." and "-"; write the workflow's condition by hand`,
    );
  }
  const { branch } = shapeOf(o);
  if (!/^[\w./-]+$/.test(branch)) {
    throw new Error(
      `the branch "${branch}" has characters a workflow cannot take here`,
    );
  }
  if (deployment !== null && o.route === "main") {
    throw new Error(DEPLOYMENT_MAIN);
  }
  if (kind === "release" && o.route === "main") throw new Error(RELEASE_MAIN);
  const on = {
    push: `  push:\n    branches: [${branch}]`,
    release: "  release:\n    types: [published]",
    daily: '  schedule:\n    - cron: "17 6 * * *"',
    deployment: "  deployment_status:",
  }[kind];
  const guard =
    kind === "push"
      ? "!contains(github.event.head_commit.message, '[skip demoman]') && github.actor != 'github-actions[bot]'"
      : kind === "deployment"
        ? `github.event.deployment_status.state == 'success' && github.event.deployment.environment == '${deployment}'`
        : null;
  const refreshIf = expr(
    `github.event_name != 'pull_request'${guard === null ? "" : ` && (${guard})`}`,
  );
  const services = servicesBlock(o.app);
  return `name: Demoman
on:
${on}
  pull_request:
    paths: [".github/workflows/demoman.yml", ".demoman/**"]
jobs:
  refresh:
    if: ${refreshIf}
    runs-on: ubuntu-24.04
    permissions:
      contents: write
      pull-requests: write${o.artifact === true || kind === "daily" ? "\n      actions: read" : ""}
    concurrency:
      group: demoman-refresh
      cancel-in-progress: false
${services}    steps:
${refreshSteps(o, {
  deliver: true,
  outDir:
    o.artifact === true ? " --out-dir demoman-out --previous demoman-out" : "",
})}  check:
    if: ${expr("github.event_name == 'pull_request'")}
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    concurrency:
      group: demoman-check-${expr("github.ref")}
      cancel-in-progress: true
${services}    steps:
${refreshSteps(o, { deliver: false, outDir: " --out-dir demoman-check" })}      - name: Gather the files a commit flow would write
        if: always()
        run: |
          [ -f demoman-check/demoman-refresh.json ] || exit 0
          mkdir -p demoman-check/repo
          jq -r '.videos[] | select(.deliver == "commit") | .files[].path' demoman-check/demoman-refresh.json | xargs -r -I{} cp --parents {} demoman-check/repo/
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: demoman-check
          path: demoman-check
`;
}

/** The steps both jobs share. `deliver` is the refresh job; without it these
 *  are the self-check's steps, which run on the setup pull request and
 *  deliver nothing. */
function refreshSteps(
  o: CiOptions,
  { deliver, outDir }: { deliver: boolean; outDir: string },
): string {
  const shape = shapeOf(o);
  // The check is none of the triggers: no loop guard, no deployment, no skip.
  const kind: string = deliver ? shape.kind : "check";
  const deployment = deliver ? shape.deployment : null;
  const guarded = deliver && shape.guarded;
  const branch = shape.branch;
  const npx = `npx --prefix ~/ -y ${PACKAGE_NAME}@${o.version}`;
  const sha = expr(
    deployment === null ? "github.sha" : "github.event.deployment.sha",
  );
  const ref =
    kind === "deployment"
      ? `\n          ref: ${expr("github.event.deployment.sha")}`
      : kind === "release"
        ? `\n          ref: ${expr("github.event.release.tag_name")}`
        : "";
  // Whether a later step runs: null when nothing before it can skip the job.
  // The daily run's check (`refresh --check`) skips what follows it when
  // every flow was recorded at this commit.
  const skipCond = guarded
    ? "steps.guard.outputs.skip != 'true'"
    : kind === "daily"
      ? "steps.fresh.outputs.skip != 'true'"
      : null;
  const ifRun = skipCond === null ? "" : `\n        if: ${expr(skipCond)}`;
  // Steps before the daily check run whatever it answers.
  const ifEarly = kind === "daily" ? "" : ifRun;
  // The URL is set by whoever may post deployment statuses: it reaches the
  // shell through env, never interpolated into the run line. A deployment
  // that names none stops the step with that said, not a usage error.
  const baseUrl =
    deployment === null
      ? ""
      : ` --base-url "\${DEMOMAN_BASE_URL:?the deployment named no environment_url, so there is no deployed app to record}"`;
  const baseUrlEnv =
    deployment === null
      ? ""
      : `\n          DEMOMAN_BASE_URL: ${expr("github.event.deployment_status.environment_url")}`;
  // The artifact is cumulative: the last one is downloaded into demoman-out
  // and refresh compares against it in place, so an unchanged flow's receipt
  // and video stay for the next run. A missing folder is refresh's "nothing
  // to compare against", said in its note.
  // This workflow's own runs on its own trigger, in this repository: a
  // fork's pull request or another workflow can upload an artifact of the
  // same name, which must never stand in for what was delivered.
  const fetch =
    deliver && o.artifact === true
      ? `      - name: Fetch the last run's videos${ifEarly}
        env:
          GH_TOKEN: ${expr("github.token")}
          EVENT: ${{ push: "push", release: "release", daily: "schedule", deployment: "deployment_status" }[kind]}
          BRANCH: "${kind === "push" || kind === "daily" ? branch : ""}"
          ENVIRONMENT: "${deployment ?? ""}"
        run: |
          wf=\${GITHUB_WORKFLOW_REF%%@*}
          export WF=\${wf#"$GITHUB_REPOSITORY"/}
          # Only this workflow's own runs on its own event (and branch), from this
          # repository, newest first: never a fork's or another workflow's artifact.
          id=""
          said=""
          if ! runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/\${WF##*/}/runs?event=$EVENT&status=completed&per_page=50\${BRANCH:+&branch=$BRANCH}" --jq '[.workflow_runs[] | select(((.path // "") | startswith($ENV.WF)) and .event == $ENV.EVENT and (($ENV.BRANCH // "") == "" or .head_branch == $ENV.BRANCH) and .head_repository.id == .repository.id)] | sort_by(.created_at) | reverse | .[] | "\\(.id) \\(.head_sha)"'); then
            said="::warning::This workflow's earlier runs could not be listed"
          else
            while read -r r sha <&3; do
              [ -n "$r" ] || continue
              if [ -n "$ENVIRONMENT" ]; then
                # A fork's preview deployment runs this workflow too: only a
                # commit deployed to this environment counts.
                if ! d=$(gh api -X GET "repos/$GITHUB_REPOSITORY/deployments" -f sha="$sha" -f environment="$ENVIRONMENT" --jq length); then
                  said="::warning::The deployments of run $r's commit could not be listed"
                  break
                fi
                [ "$d" -gt 0 ] || continue
              else
                # A tag named like the branch matches it too: the commit must be on it.
                git merge-base --is-ancestor "$sha" HEAD 2>/dev/null || continue
              fi
              if ! n=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$r/artifacts?name=demoman-videos" --jq '[.artifacts[] | select(.name == "demoman-videos" and .expired == false)] | length'); then
                said="::warning::Run $r's artifacts could not be listed"
                break
              fi
              if [ "$n" -gt 0 ]; then
                id=$r
                break
              fi
            done 3<<< "$runs"
          fi
          if [ -n "$said" ]; then
            echo "$said, so every files flow is compared with nothing."
          elif [ -z "$id" ]; then
            echo "None of this workflow's newest 50 runs here has a demoman-videos artifact, so every files flow is compared with nothing."
          elif ! gh run download "$id" --repo "$GITHUB_REPOSITORY" --name demoman-videos --dir demoman-out; then
            rm -rf demoman-out
            echo "::warning::Run $id's demoman-videos artifact could not be downloaded, so every files flow is compared with nothing."
          fi
`
      : "";
  // Exit 3 is refresh --check's "nothing new"; any other failure stops the job.
  const freshStep = `      - name: Anything new since the last refresh?
        id: fresh
        env:
          GH_TOKEN: ${expr("github.token")}
        run: |
          wf=\${GITHUB_WORKFLOW_REF%%@*}
          export WF=\${wf#"$GITHUB_REPOSITORY"/}
          # The commit this workflow's last successful scheduled run refreshed
          # at: it recorded or confirmed every flow there.
          since=""
          if s=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/\${WF##*/}/runs?event=schedule&status=success&per_page=20" --jq '[.workflow_runs[] | select(((.path // "") | startswith($ENV.WF)) and .head_repository.id == .repository.id)] | .[0].head_sha // ""'); then
            if [ -n "$s" ] && git merge-base --is-ancestor "$s" HEAD 2>/dev/null; then
              since="--since $s"
            fi
          else
            echo "::warning::This workflow's earlier runs could not be listed, so each flow is judged by its receipt."
          fi
          # $since is unquoted on purpose: empty, or two words.
          if ${npx} refresh --check${o.artifact === true ? " --previous demoman-out" : ""} $since; then
            echo "skip=false" >> "$GITHUB_OUTPUT"
          else
            code=$?
            [ "$code" -eq 3 ] || exit "$code"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            echo "Nothing but the refresh's own files changed since each repo flow was last recorded or refreshed; nothing to refresh."
          fi
`;
  const script = GUARD_SCRIPT.split("\n")
    .map((l) => `          ${l}`)
    .join("\n");
  const secretEnv = secretNames(o)
    .map((n) => `\n          ${n}: ${expr(`secrets.${n}`)}`)
    .join("");
  const forkStep =
    secretNames(o).length === 0
      ? ""
      : `      - name: Secrets on a fork's pull request
        if: ${expr("github.event.pull_request.head.repo.full_name != github.repository")}
        run: |
          echo "::error::${FORK_REFUSAL}"
          exit 1
`;
  return `      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # A committed video in LFS is compared, not replaced as a pointer.
          lfs: true${ref}
${
  guarded
    ? `      - name: Skip Demoman's own commits
        id: guard
        env:
          SHA: ${sha}
        run: |
${script}
`
    : ""
}      - uses: actions/setup-node@v4${ifEarly}
        with:
          node-version: 22
${kind === "daily" ? `${fetch}${freshStep}` : ""}      - uses: actions/cache@v4${ifRun}
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${o.version}
      - name: Install Chromium${ifRun}
        run: ${npx} setup --browser-only
      - name: Install fonts${ifRun}
        run: sudo apt-get update && sudo apt-get install -y fonts-noto-core fonts-noto-color-emoji
${kind === "daily" ? "" : fetch}${deliver ? "" : forkStep}      - name: Refresh the repo's flows${ifRun}
        run: ${npx} refresh${deliver ? ` --deliver ${o.route}` : ""}${baseUrl}${outDir}
        env:
          GH_TOKEN: ${expr("github.token")}${baseUrlEnv}${secretEnv}
${
  deliver && o.artifact === true
    ? `      - uses: actions/upload-artifact@v4
        if: ${expr(skipCond === null ? "always()" : `always() && ${skipCond}`)}
        with:
          name: demoman-videos
          path: demoman-out
`
    : ""
}`;
}

export const DEPLOYMENT_MAIN =
  "--route main cannot go with a deployment trigger: the deployed commit is not a branch, so the refresh cannot commit on main from it. Use --route pr there, or a push trigger.";

/** The terminal's questions; null (or false from confirm) is a cancel. */
export type CiAsk = {
  /** Only the offered triggers, the default chosen first. */
  trigger(offers: TriggerOffer[]): Promise<CiOptions["trigger"] | null>;
  route(branch: string): Promise<"pr" | "main" | null>;
  appHole(field: string, why: string): Promise<string | null>;
  /** Typed unseen. */
  secret(name: string, why: string): Promise<string | null>;
  /** Which of `names` to take from the file. */
  envFile(path: string, names: string[]): Promise<string[] | null>;
  confirm(lines: string[]): Promise<boolean>;
};

export interface CiIo {
  /** Null when there is no terminal to ask in. */
  ask: CiAsk | null;
  /** The repository's root, or why there is none. */
  root(): Promise<{ root: string } | { none: string }>;
  /** Everything the plan reads and does, `gh` bound to the root. */
  deps(root: string): Omit<CiDeps, "log" | "signal">;
  /** Paths are relative to the root. */
  exists(path: string): boolean;
  /** Ctrl-C while the check runs (R3); answers what restores it. */
  onInterrupt(stop: () => void): () => void;
  say(line: string): void;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `setup --ci [--trigger …] [--route pr|main] [--artifact] [--yes]
 *  [--env-file <path>] [--replace-secret <NAME>]…`: read and propose, ask the
 *  holes and missing values, check, show the plan, one confirmation, apply,
 *  watch. Returns the exit code. */
export async function ciSetup(args: string[], io: CiIo): Promise<number> {
  const stop = (why: string): number => {
    io.say(`Demoman setup stopped: ${why}`);
    return 1;
  };
  const cancelled = (): number => {
    io.say("Setup cancelled; nothing was written.");
    return 1;
  };
  const said = (s: CiStop): number => {
    if (s.reason === "checkStopped") {
      io.say(`Demoman setup ${s.detail}.`);
      return 1;
    }
    stop(s.detail);
    for (const l of (s.tail ?? "").split("\n")) if (l !== "") io.say(`  ${l}`);
    return 1;
  };
  let flags: {
    ci?: boolean;
    trigger?: string;
    route?: string;
    artifact?: boolean;
    yes?: boolean;
    "env-file"?: string;
    "replace-secret"?: string[];
  };
  try {
    ({ values: flags } = parseArgs({
      args,
      options: {
        ci: { type: "boolean" },
        trigger: { type: "string" },
        route: { type: "string" },
        artifact: { type: "boolean" },
        yes: { type: "boolean" },
        "env-file": { type: "string" },
        "replace-secret": { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return stop(`${messageOf(error)}.`);
  }
  const { route } = flags;
  if (route !== undefined && route !== "pr" && route !== "main")
    return stop(`--route is pr or main; got "${route}".`);
  const ask = flags.yes === true ? null : io.ask;
  const given = flags.trigger === undefined ? null : triggerOf(flags.trigger);
  if (ask === null && flags.yes !== true) {
    const missing = [
      ...(given === null ? ["--trigger release|daily|push|<environment>"] : []),
      // Release and deployment triggers deliver by pull request only.
      ...(route === undefined && (given === null || mainCan(given))
        ? ["--route pr|main"]
        : []),
    ];
    return stop(
      `with no terminal to ask in, nothing was read or written: pass --yes to apply the plan with the defaults${missing.length > 0 ? `, and ${missing.join(" and ")} to choose otherwise` : ""}.`,
    );
  }
  const where = await io.root();
  if ("none" in where)
    return stop(
      `${where.none} — run setup --ci inside the repo the workflow is for.`,
    );
  const { root } = where;

  // Never said: every line the check or this door says is redacted by it.
  const values: SecretValues = new Map();
  const deps: CiDeps = {
    ...io.deps(root),
    log: (l) => io.say(redact(l, values)),
  };
  const choices: CiChoices = {
    ...(given === null ? {} : { trigger: given }),
    ...(route === undefined ? {} : { route }),
    ...(flags.artifact === true ? { artifact: true } : {}),
    ...(flags["replace-secret"] === undefined
      ? {}
      : { replaceSecrets: flags["replace-secret"] }),
  };

  // The trigger and route, asked from what the repo has on GitHub.
  if (
    ask !== null &&
    (choices.trigger === undefined || choices.route === undefined)
  ) {
    const facts = await deps.readGithub(root);
    // A repo setup cannot go on with is said by the plan, before any question.
    if (
      !("reason" in facts) &&
      !facts.workflowOnDefault &&
      facts.setupBranch === null
    ) {
      if (choices.trigger === undefined) {
        const offers = triggerOffers(facts);
        const t = await ask.trigger(
          route === "main" ? offers.filter((o) => mainCan(o.trigger)) : offers,
        );
        if (t === null) return cancelled();
        choices.trigger = t;
      }
      if (choices.route === undefined && mainCan(choices.trigger)) {
        const r = await ask.route(facts.defaultBranch);
        if (r === null) return cancelled();
        choices.route = r;
      }
    }
  }

  // Plan; a hole or a missing value is asked once, then planned again.
  const handled = new Set<string>();
  let plan: CiPlan | CiStop;
  for (;;) {
    const abort = new AbortController();
    const restore = io.onInterrupt(() => abort.abort());
    try {
      plan = await planCiSetup(
        root,
        choices,
        { ...deps, signal: abort.signal },
        values,
      );
    } finally {
      restore();
    }
    // Only the check stops on the signal; a Ctrl-C anywhere else in the
    // pass still ends setup here, before any further question.
    if (
      abort.signal.aborted &&
      !("reason" in plan && plan.reason === "checkStopped")
    )
      return cancelled();
    if (!("reason" in plan)) break;
    if (handled.has(plan.reason)) return said(plan);
    handled.add(plan.reason);
    if (plan.reason === "appHoles" && plan.proposal !== undefined) {
      if (ask === null)
        return stop(
          `${plan.detail}; write them in ${APP_FILE}, then run setup again.`,
        );
      const filled = await fillHoles(plan.proposal, ask);
      if (filled === null) return cancelled();
      if ("refused" in filled) return stop(filled.refused);
      choices.app = filled.app;
      choices.appBy = "person";
    } else if (plan.reason === "secretMissing" && plan.secrets !== undefined) {
      let missing = plan.secrets;
      const path =
        flags["env-file"] ??
        (ask !== null && io.exists(".env") ? join(root, ".env") : undefined);
      let chosen: string[] = [];
      if (path !== undefined) {
        let names: string[];
        try {
          names = await envFileNames(path, missing);
        } catch (error) {
          return stop(
            `could not read ${path} (${messageOf(error)}); check the path, then run setup again.`,
          );
        }
        const picked =
          names.length === 0 || ask === null
            ? names
            : await ask.envFile(path, names);
        if (picked === null) return cancelled();
        chosen = picked;
        if (chosen.length > 0) choices.envFile = { path, names: chosen };
        missing = missing.filter((m) => !chosen.includes(m.name));
      }
      if (ask === null) {
        if (chosen.length === 0) return said(plan);
      } else {
        for (const m of missing) {
          const v = await ask.secret(m.name, m.why);
          if (v === null) return cancelled();
          values.set(m.name, v);
        }
      }
    } else return said(plan);
  }

  const uses = plan.secrets.map((x) => x.name);
  const unknown = (choices.replaceSecrets ?? []).filter(
    (n) => !uses.includes(n),
  );
  if (unknown.length > 0)
    return stop(
      `--replace-secret ${unknown.join(", ")} names no secret this setup uses (it uses ${uses.join(", ") || "none"}); nothing was written. Fix the name, then run setup again.`,
    );

  // One confirmation, after the check (Decision 1).
  const lines = planLines(plan);
  if (ask === null) for (const l of lines) io.say(l);
  else if (!(await ask.confirm(lines))) return cancelled();

  const done = await applyCiSetup(plan, deps, values);
  if ("reason" in done) return said(done);
  if ("opened" in done.pr)
    io.say(`Opened the setup pull request: ${done.pr.opened.url}`);
  const w = done.watched;
  if (w === null || "unknown" in w) {
    io.say(
      `Whether the setup run passed is unknown: ${w === null ? "it was not watched" : w.unknown.why}`,
    );
    return 1;
  }
  if ("passed" in w) {
    io.say(`The setup run passed: ${w.passed.runUrl}`);
    io.say(`Its videos: ${w.passed.artifactUrl}`);
    return 0;
  }
  if ("cancelled" in w) {
    io.say(
      `The setup run was cancelled: ${w.cancelled.runUrl}; re-run it there.`,
    );
    return 1;
  }
  const f = w.failed;
  io.say(`The setup run failed on its "${f.step}" step: ${f.runUrl}`);
  for (const l of f.tail.split("\n")) if (l !== "") io.say(`  ${l}`);
  if (f.failedRuns !== null)
    io.say(
      f.gaveUp
        ? `${f.failedRuns} setup runs have failed on ${SETUP_BRANCH}, the most setup tries: fix the step above in the pull request yourself, or close it and run setup again.`
        : `${f.failedRuns} of 3 setup runs have failed: fix the step above and push to ${SETUP_BRANCH} to run it again.`,
    );
  else if (f.note === undefined)
    io.say("How many setup runs have failed is unknown.");
  if (f.note !== undefined) io.say(f.note);
  return 1;
}

/** Each hole in the proposed app.json, asked; null is a cancel. */
async function fillHoles(
  p: AppProposal,
  ask: CiAsk,
): Promise<{ app: AppSpec } | { refused: string } | null> {
  const draft: Record<string, unknown> & { env: Record<string, string> } =
    structuredClone(p.draft);
  for (const h of p.holes) {
    const env = /^env\.(.+)$/.exec(h.field)?.[1];
    if (h.field !== "start" && h.field !== "url" && env === undefined)
      return {
        refused: `${h.field}: ${h.why}; fix it, or write ${APP_FILE}, then run setup again.`,
      };
    const got = await ask.appHole(h.field, h.why);
    if (got === null) return null;
    if (env === undefined) draft[h.field] = got;
    else draft.env[env] = got;
  }
  const parsed = parseApp(JSON.stringify(draft), APP_FILE);
  return parsed.ok
    ? { app: parsed.app }
    : {
        refused: `${parsed.detail}; run setup again and answer it, or write ${APP_FILE}.`,
      };
}

/** Whether `--route main` can go with the trigger. */
const mainCan = (t: CiOptions["trigger"]): boolean =>
  t === "push" || t === "daily";

/** A `--trigger` value: the three words are triggers,
 *  `deployment:<name>` an environment of any name, and any other word an
 *  environment as before. */
function triggerOf(given: string): CiOptions["trigger"] {
  if (given === "push" || given === "release" || given === "daily")
    return given;
  return {
    deployment: given.startsWith("deployment:") ? given.slice(11) : given,
  };
}
