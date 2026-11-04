// `demoman setup --ci`: the GitHub Actions workflow that records the repo's
// flows again after each successful deployment, each published release, once
// a day, or on each merge to main, and delivers what changed with
// `demoman refresh --deliver`.

import { parseArgs } from "node:util";
import type { AppSpec } from "@demoman/run-core";
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
    o.artifact === true
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

export interface CiIo {
  version: string;
  /** Null when there is no terminal to ask in. */
  ask: {
    trigger(): Promise<"push" | "release" | "daily" | string | null>;
    route(): Promise<"pr" | "main" | null>;
  } | null;
  /** The repository's root, or why there is none. */
  root(): Promise<{ root: string } | { none: string }>;
  /** origin's default branch, null when it cannot be read. */
  defaultBranch(): Promise<string | null>;
  /** Paths are relative to the root. */
  exists(path: string): boolean;
  write(path: string, text: string): void;
  say(line: string): void;
}

/** `setup --ci [--trigger release|daily|push|deployment:<environment>|<environment>] [--route pr|main] [--artifact]`: returns the exit code. */
export async function ciSetup(args: string[], io: CiIo): Promise<number> {
  const stop = (why: string): number => {
    io.say(`Demoman setup stopped: ${why}`);
    return 1;
  };
  let values: {
    ci?: boolean;
    trigger?: string;
    route?: string;
    artifact?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        ci: { type: "boolean" },
        trigger: { type: "string" },
        route: { type: "string" },
        artifact: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return stop(`${error instanceof Error ? error.message : String(error)}.`);
  }
  if (
    values.route !== undefined &&
    values.route !== "pr" &&
    values.route !== "main"
  ) {
    return stop(`--route is pr or main; got "${values.route}".`);
  }
  const asked = values.trigger === undefined ? null : triggerOf(values.trigger);
  const refusedMain = (t: CiOptions["trigger"]) =>
    t === "release"
      ? RELEASE_MAIN
      : typeof t === "object"
        ? DEPLOYMENT_MAIN
        : null;
  if (asked !== null && values.route === "main") {
    const why = refusedMain(asked);
    if (why !== null) return stop(why);
  }
  const where = await io.root();
  if ("none" in where) {
    return stop(
      `${where.none} — run setup --ci inside the repo the workflow is for.`,
    );
  }
  if (io.exists(CI_WORKFLOW_PATH)) {
    return stop(
      `${CI_WORKFLOW_PATH} already exists; delete it to write it again.`,
    );
  }
  const answered = asked === null ? ((await io.ask?.trigger()) ?? null) : null;
  const trigger = asked ?? (answered === null ? null : triggerOf(answered));
  const route =
    (values.route as "pr" | "main" | undefined) ??
    (await io.ask?.route()) ??
    null;
  if (trigger === null || route === null) {
    io.say(
      io.ask === null
        ? "Demoman setup stopped: with no terminal to ask in, pass --trigger release|daily|push|<environment> and --route pr|main."
        : "Setup cancelled; nothing was written.",
    );
    return 1;
  }
  const why = route === "main" ? refusedMain(trigger) : null;
  if (why !== null) return stop(why);
  // The branch a push or the daily schedule watches.
  const read =
    trigger === "push" || trigger === "daily" ? await io.defaultBranch() : null;
  const branch = read ?? "main";
  const o: CiOptions = {
    version: io.version,
    trigger,
    route,
    branch,
    app: null,
    secrets: { accounts: [], app: [] },
    ...(values.artifact === true ? { artifact: true } : {}),
  };
  let text: string;
  try {
    text = ciWorkflow(o);
  } catch (error) {
    return stop(`${error instanceof Error ? error.message : String(error)}.`);
  }
  try {
    io.write(CI_WORKFLOW_PATH, text);
  } catch (error) {
    return stop(
      `could not write ${CI_WORKFLOW_PATH} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  io.say(`Wrote ${CI_WORKFLOW_PATH} (at the repo root).`);
  if (trigger === "push" && read === null) {
    io.say(
      `- Could not read origin's default branch, so the workflow watches \`main\`; change \`branches: [main]\` in it if yours differs.`,
    );
  }
  return 0;
}

/** A `--trigger` value or a prompt's answer: the three words are triggers,
 *  `deployment:<name>` an environment of any name, and any other word an
 *  environment as before. */
function triggerOf(given: string): CiOptions["trigger"] {
  if (given === "push" || given === "release" || given === "daily")
    return given;
  return {
    deployment: given.startsWith("deployment:") ? given.slice(11) : given,
  };
}
