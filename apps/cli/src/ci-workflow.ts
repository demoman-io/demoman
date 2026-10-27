// `demoman setup --ci`: the GitHub Actions workflow that films the kept
// videos again on each merge to main (or each successful deployment) and
// delivers what changed with `demoman refresh --deliver`.

import { parseArgs } from "node:util";
import { PACKAGE_NAME } from "./names.js";

export interface CiOptions {
  version: string;
  trigger: "push" | { deployment: string };
  route: "pr" | "main";
}

export const CI_WORKFLOW_PATH = ".github/workflows/demoman.yml";

/** A GitHub expression, written without a template-looking literal. */
export const expr = (e: string): string => `\${{ ${e} }}`;

export function ciWorkflow(o: CiOptions): string {
  const deployment = o.trigger === "push" ? null : o.trigger.deployment;
  // The name goes inside a single-quoted expression string.
  if (deployment !== null && !/^[\w .-]+$/.test(deployment)) {
    throw new Error(
      `the deployment environment "${deployment}" has characters other than letters, digits, spaces, "_", "." and "-"; write the workflow's condition by hand`,
    );
  }
  const npx = `npx --prefix ~/ -y ${PACKAGE_NAME}@${o.version}`;
  const on =
    deployment === null
      ? "  push:\n    branches: [main]"
      : "  deployment_status:";
  const guard =
    deployment === null
      ? expr(
          "!contains(github.event.head_commit.message, '[skip demoman]') && github.actor != 'github-actions[bot]'",
        )
      : `github.event.deployment_status.state == 'success' && github.event.deployment.environment == '${deployment}'`;
  const ref =
    deployment === null
      ? ""
      : `\n          ref: ${expr("github.event.deployment.sha")}`;
  const start =
    deployment === null
      ? `      # Start your app here and wait for it, for example:
      # - name: Start your app
      #   run: npm ci && npm run build && (npm start &) && npx wait-on http://localhost:3000
`
      : "";
  const baseUrl =
    deployment === null
      ? ""
      : ` --base-url ${expr("github.event.deployment_status.environment_url")}`;
  return `name: Demoman
on:
${on}
permissions:
  contents: write
  pull-requests: write
jobs:
  refresh:
    if: ${guard}
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0${ref}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${o.version}
      - name: Install Chromium
        run: ${npx} setup --browser-only
      - name: Install fonts
        run: sudo apt-get update && sudo apt-get install -y fonts-noto-core fonts-noto-color-emoji
${start}      - name: Refresh the kept videos
        run: ${npx} refresh --deliver ${o.route}${baseUrl}
        env:
          GH_TOKEN: \${{ github.token }}
          # One line per demo account in .demoman/accounts.json:
          # DEMOMAN_SECRET_SELLER: \${{ secrets.DEMOMAN_SECRET_SELLER }}
`;
}

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
    "Add each demo account's DEMOMAN_SECRET_<NAME> to the repository secrets and to the workflow's env.",
  ];
}

export interface CiIo {
  version: string;
  /** Null when there is no terminal to ask in. */
  ask: {
    trigger(): Promise<"push" | string | null>;
    route(): Promise<"pr" | "main" | null>;
  } | null;
  exists(path: string): boolean;
  write(path: string, text: string): void;
  say(line: string): void;
}

/** `setup --ci [--trigger push|<environment>] [--route pr|main]`: returns the exit code. */
export async function ciSetup(args: string[], io: CiIo): Promise<number> {
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
    io.say(
      `Demoman setup stopped: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return 1;
  }
  if (
    values.route !== undefined &&
    values.route !== "pr" &&
    values.route !== "main"
  ) {
    io.say(
      `Demoman setup stopped: --route is pr or main; got "${values.route}".`,
    );
    return 1;
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
  const o: CiOptions = {
    version: io.version,
    trigger: trigger === "push" ? "push" : { deployment: trigger },
    route,
  };
  let text: string;
  try {
    text = ciWorkflow(o);
  } catch (error) {
    io.say(
      `Demoman setup stopped: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return 1;
  }
  if (io.exists(CI_WORKFLOW_PATH)) {
    io.say(
      `Demoman setup stopped: ${CI_WORKFLOW_PATH} already exists; delete it to write it again.`,
    );
    return 1;
  }
  try {
    io.write(CI_WORKFLOW_PATH, text);
  } catch (error) {
    io.say(
      `Demoman setup stopped: could not write ${CI_WORKFLOW_PATH} (${error instanceof Error ? error.message : String(error)}).`,
    );
    return 1;
  }
  io.say(`Wrote ${CI_WORKFLOW_PATH}.`);
  for (const n of ciNotes(o)) io.say(`- ${n}`);
  return 0;
}
