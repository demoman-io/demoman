// `demoman setup --ci`: the GitHub Actions workflow that records the repo's
// flows again after each successful deployment, each published release, once
// a day, or on each merge to main, and delivers what changed with
// `demoman refresh --deliver`.

import { parseArgs } from "node:util";
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

export function ciWorkflow(o: CiOptions): string {
  const deployment =
    typeof o.trigger === "string" ? null : o.trigger.deployment;
  const kind = typeof o.trigger === "string" ? o.trigger : "deployment";
  // Only a push can be Demoman's own commit; the other triggers have no loop.
  const guarded = kind === "push" || kind === "deployment";
  // The name goes inside a single-quoted expression string.
  if (deployment !== null && !/^[\w .-]+$/.test(deployment)) {
    throw new Error(
      `the deployment environment "${deployment}" has characters other than letters, digits, spaces, "_", "." and "-"; write the workflow's condition by hand`,
    );
  }
  const branch = o.branch ?? "main";
  if (!/^[\w./-]+$/.test(branch)) {
    throw new Error(
      `the branch "${branch}" has characters a workflow cannot take here`,
    );
  }
  if (deployment !== null && o.route === "main") {
    throw new Error(DEPLOYMENT_MAIN);
  }
  if (kind === "release" && o.route === "main") throw new Error(RELEASE_MAIN);
  const npx = `npx --prefix ~/ -y ${PACKAGE_NAME}@${o.version}`;
  const on = {
    push: `  push:\n    branches: [${branch}]`,
    release: "  release:\n    types: [published]",
    daily: '  schedule:\n    - cron: "17 6 * * *"',
    deployment: "  deployment_status:",
  }[kind];
  const guard =
    kind === "push"
      ? expr(
          "!contains(github.event.head_commit.message, '[skip demoman]') && github.actor != 'github-actions[bot]'",
        )
      : kind === "deployment"
        ? `github.event.deployment_status.state == 'success' && github.event.deployment.environment == '${deployment}'`
        : null;
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
  const start =
    deployment === null
      ? skipCond === null
        ? `      # Start your app here and wait for it, for example:
      # - name: Start your app
      #   run: npm ci && npm run build && (npm start &) && npx wait-on http://localhost:3000
`
        : `      # Start your app here and wait for it, for example (keep the \`if\`):
      # - name: Start your app
      #   if: ${expr(skipCond)}
      #   run: npm ci && npm run build && (npm start &) && npx wait-on http://localhost:3000
`
      : "";
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
  const outDir =
    o.artifact === true ? " --out-dir demoman-out --previous demoman-out" : "";
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
        run: |
          if ${npx} refresh --check${o.artifact === true ? " --previous demoman-out" : ""}; then
            echo "skip=false" >> "$GITHUB_OUTPUT"
          else
            code=$?
            [ "$code" -eq 3 ] || exit "$code"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            echo "Every repo flow was recorded at this commit; nothing to refresh."
          fi
`;
  const script = GUARD_SCRIPT.split("\n")
    .map((l) => `          ${l}`)
    .join("\n");
  return `name: Demoman
on:
${on}
permissions:
  contents: write
  pull-requests: write${o.artifact === true ? "\n  actions: read" : ""}
concurrency:
  group: demoman-refresh
  cancel-in-progress: false
jobs:
  refresh:
${guard === null ? "" : `    if: ${guard}\n`}    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
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
${start}${kind === "daily" ? "" : fetch}      - name: Refresh the repo's flows${ifRun}
        run: ${npx} refresh --deliver ${o.route}${baseUrl}${outDir}
        env:
          GH_TOKEN: ${expr("github.token")}${baseUrlEnv}
          # One pair per demo account: NAME is what a kept script's { secret: NAME }
          # names, and _ORIGIN is the one site it may be typed on (without it the
          # run refuses the secret).
          # DEMOMAN_SECRET_SELLER: ${expr("secrets.DEMOMAN_SECRET_SELLER")}
          # DEMOMAN_SECRET_SELLER_ORIGIN: https://app.example.com
${
  o.artifact === true
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

/** What `setup --ci` still needs from the person, by route and trigger. */
export function ciNotes(o: CiOptions): string[] {
  return [
    ...(o.route === "pr"
      ? [
          'Turn on "Allow GitHub Actions to create and approve pull requests" in the repository\'s Settings > Actions > General; GitHub refuses the pull request while it is off.',
        ]
      : []),
    ...(typeof o.trigger === "string"
      ? [
          `Fill in the "Start your app" step in ${CI_WORKFLOW_PATH}: refresh records the app at its base URL, so it must be running.`,
        ]
      : []),
    "Add each demo account's DEMOMAN_SECRET_<NAME> to the repository secrets and to the workflow's env, with DEMOMAN_SECRET_<NAME>_ORIGIN naming the one site it may be typed on; the run refuses a secret without it.",
  ];
}

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
  for (const n of ciNotes(o)) io.say(`- ${n}`);
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
