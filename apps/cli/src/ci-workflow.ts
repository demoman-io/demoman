// `demoman setup --ci`: the GitHub Actions workflow that films the kept
// videos again on each merge to main (or each successful deployment) and
// delivers what changed with `demoman refresh --deliver`.

import { parseArgs } from "node:util";
import { PACKAGE_NAME } from "./names.js";

export interface CiOptions {
  version: string;
  trigger: "push" | { deployment: string };
  route: "pr" | "main";
  /** The branch a push trigger watches; `main` when not given. */
  branch?: string;
}

export const CI_WORKFLOW_PATH = ".github/workflows/demoman.yml";

/** A GitHub expression, written without a template-looking literal. */
export const expr = (e: string): string => `\${{ ${e} }}`;

/** The loop guard's script: it reads the triggering commit's message from
 *  $SHA. The refresh pull request's merge commit reads "Merge pull request
 *  #N from <owner>/demoman/refresh"; both routes' commits carry the marker. */
export const GUARD_SCRIPT = `msg=$(git log -1 --format=%B "$SHA")
if printf '%s' "$msg" | grep -qE '\\[skip demoman\\]|/demoman/refresh'; then
  echo "skip=true" >> "$GITHUB_OUTPUT"
  echo "Skipping: this commit is Demoman's own refresh, and filming it again would loop."
fi`;

export function ciWorkflow(o: CiOptions): string {
  const deployment = o.trigger === "push" ? null : o.trigger.deployment;
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
  const npx = `npx --prefix ~/ -y ${PACKAGE_NAME}@${o.version}`;
  const on =
    deployment === null
      ? `  push:\n    branches: [${branch}]`
      : "  deployment_status:";
  const guard =
    deployment === null
      ? expr(
          "!contains(github.event.head_commit.message, '[skip demoman]') && github.actor != 'github-actions[bot]'",
        )
      : `github.event.deployment_status.state == 'success' && github.event.deployment.environment == '${deployment}'`;
  const sha = expr(
    deployment === null ? "github.sha" : "github.event.deployment.sha",
  );
  const ref =
    deployment === null
      ? ""
      : `\n          ref: ${expr("github.event.deployment.sha")}`;
  const start =
    deployment === null
      ? `      # Start your app here and wait for it, for example (keep the \`if\`):
      # - name: Start your app
      #   if: ${expr("steps.guard.outputs.skip != 'true'")}
      #   run: npm ci && npm run build && (npm start &) && npx wait-on http://localhost:3000
`
      : "";
  const baseUrl =
    deployment === null
      ? ""
      : ` --base-url ${expr("github.event.deployment_status.environment_url")}`;
  const run = expr("steps.guard.outputs.skip != 'true'");
  const script = GUARD_SCRIPT.split("\n")
    .map((l) => `          ${l}`)
    .join("\n");
  return `name: Demoman
on:
${on}
permissions:
  contents: write
  pull-requests: write
concurrency:
  group: demoman-refresh
  cancel-in-progress: false
jobs:
  refresh:
    if: ${guard}
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0${ref}
      - name: Skip Demoman's own commits
        id: guard
        env:
          SHA: ${sha}
        run: |
${script}
      - uses: actions/setup-node@v4
        if: ${run}
        with:
          node-version: 22
      - uses: actions/cache@v4
        if: ${run}
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${o.version}
      - name: Install Chromium
        if: ${run}
        run: ${npx} setup --browser-only
      - name: Install fonts
        if: ${run}
        run: sudo apt-get update && sudo apt-get install -y fonts-noto-core fonts-noto-color-emoji
${start}      - name: Refresh the kept videos
        if: ${run}
        run: ${npx} refresh --deliver ${o.route}${baseUrl}
        env:
          GH_TOKEN: ${expr("github.token")}
          # One pair per demo account: NAME is what a kept script's { secret: NAME }
          # names, and _ORIGIN is the one site it may be typed on (without it the
          # run refuses the secret).
          # DEMOMAN_SECRET_SELLER: ${expr("secrets.DEMOMAN_SECRET_SELLER")}
          # DEMOMAN_SECRET_SELLER_ORIGIN: https://app.example.com
`;
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
    ...(o.trigger === "push"
      ? [
          `Fill in the "Start your app" step in ${CI_WORKFLOW_PATH}: refresh films the app at its base URL, so it must be running.`,
        ]
      : []),
    "Add each demo account's DEMOMAN_SECRET_<NAME> to the repository secrets and to the workflow's env, with DEMOMAN_SECRET_<NAME>_ORIGIN naming the one site it may be typed on; the run refuses a secret without it.",
  ];
}

export interface CiIo {
  version: string;
  /** Null when there is no terminal to ask in. */
  ask: {
    trigger(): Promise<"push" | string | null>;
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

/** `setup --ci [--trigger push|<environment>] [--route pr|main]`: returns the exit code. */
export async function ciSetup(args: string[], io: CiIo): Promise<number> {
  const stop = (why: string): number => {
    io.say(`Demoman setup stopped: ${why}`);
    return 1;
  };
  let values: { ci?: boolean; trigger?: string; route?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        ci: { type: "boolean" },
        trigger: { type: "string" },
        route: { type: "string" },
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
  if (
    values.trigger !== undefined &&
    values.trigger !== "push" &&
    values.route === "main"
  ) {
    return stop(DEPLOYMENT_MAIN);
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
  const trigger = values.trigger ?? (await io.ask?.trigger()) ?? null;
  const route =
    (values.route as "pr" | "main" | undefined) ??
    (await io.ask?.route()) ??
    null;
  if (trigger === null || route === null) {
    io.say(
      io.ask === null
        ? "Demoman setup stopped: with no terminal to ask in, pass --trigger push|<environment> and --route pr|main."
        : "Setup cancelled; nothing was written.",
    );
    return 1;
  }
  if (trigger !== "push" && route === "main") return stop(DEPLOYMENT_MAIN);
  const read = trigger === "push" ? await io.defaultBranch() : null;
  const branch = read ?? "main";
  const o: CiOptions = {
    version: io.version,
    trigger: trigger === "push" ? "push" : { deployment: trigger },
    route,
    branch,
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
