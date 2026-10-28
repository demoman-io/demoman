// apps/cli/src/setup-deps.ts — the real commands behind setup.ts.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isCancel, multiselect, select, text } from "@clack/prompts";
import { demomanHome } from "@demoman/mcp/serve-cli";
import {
  EXPORT_QUALITY_LABELS,
  EXPORT_QUALITY_VALUES,
  type ExportQuality,
  PULL_REQUESTS_LABELS,
  PULL_REQUESTS_VALUES,
  type PullRequestsValue,
} from "@demoman/run-core";
import {
  chromiumDepsCommand,
  fullChromiumPath,
  launchFailure,
  playwrightCliPath,
} from "@demoman/runner/package";
import { readUserSettings } from "@demoman/runner/studio";
import { writeSetting } from "@demoman/studio";
import { chromium } from "playwright";
import type { CiIo } from "./ci-workflow.js";
import type { Answers, Questions, Ran, SetupDeps } from "./setup.js";

/** How long a captured command (claude's git clone of the marketplace, the
 *  warm-start npx download) may go without finishing. Past it, setup says
 *  which command stalled instead of hanging with no line. */
export const CAPTURED_TIMEOUT_MS = 180_000;

function ran(
  command: string,
  r: SpawnSyncReturns<string | Buffer>,
  timeoutMs?: number,
): Ran {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const error =
    code === "ETIMEDOUT" && timeoutMs !== undefined
      ? `\`${command}\` had not finished after ${timeoutMs / 1000} s and was stopped`
      : r.error?.message;
  return {
    status: r.status,
    signal: r.signal,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    ...(code === "ENOENT" ? { notFound: true } : {}),
    ...(error !== undefined && code !== "ENOENT" ? { error } : {}),
  };
}

/** A command whose output setup reads, stopped after timeoutMs. */
export function runCaptured(
  command: string,
  args: string[],
  timeoutMs = CAPTURED_TIMEOUT_MS,
): Ran {
  return ran(
    command,
    spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs }),
    timeoutMs,
  );
}

/** The runner's Playwright CLI (`playwrightCliPath`), the one the
 *  libraries are installed with too. Checked now, not at the download: a
 *  wrong path would otherwise surface only on a machine that has no
 *  Chromium yet. */
function playwrightCli(): string {
  const found = playwrightCliPath();
  if (!found.ok) throw new Error(found.why);
  return found.cli;
}

/** The runner's install-deps command; thrown when it cannot be named, as a
 *  wrong Playwright CLI path is (`playwrightCli`). */
function chromiumDeps(): { command: string; args: string[] } {
  const deps = chromiumDepsCommand();
  if (!deps.ok) throw new Error(deps.why);
  return { command: deps.command, args: deps.args };
}

/** The download, run as `playwright`. Playwright warns "you are running
 *  'npx playwright install' without first installing your project's
 *  dependencies" whenever the script path holds `_npx`, which it always
 *  does under `npx demoman setup` — whose dependencies are installed. */
export function setupChromiumDownload(cli: string): {
  command: string;
  args: string[];
} {
  return {
    command: process.execPath,
    args: [
      "-e",
      "const cli = process.argv[1]; process.argv[1] = 'playwright'; require(cli)",
      cli,
      "install",
      "chromium",
      "--no-shell",
    ],
  };
}

/** null when the runner's Chromium launches headless and closes; else
 *  what it said, read by the runner's `launchFailure`. */
export async function browserLaunches(): Promise<{
  missingLibraries: boolean;
  line: string;
} | null> {
  try {
    const b = await chromium.launch({
      executablePath: fullChromiumPath(),
      headless: true,
      timeout: 30_000,
    });
    await b.close();
    return null;
  } catch (error) {
    return launchFailure(
      error instanceof Error ? error.message : String(error),
    );
  }
}

const failure = (path: string, error: unknown): string =>
  `${path}: ${error instanceof Error ? error.message : String(error)}`;

export function readTextFile(
  path: string,
): { text: string } | { missing: true } | { error: string } {
  try {
    return { text: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { missing: true };
    }
    return { error: failure(path, error) };
  }
}

/** Writes beside the target and renames over it, so a cut-short write never
 *  leaves half a config. Through a symlink (dotfiles managers link these
 *  files), keeping the file's mode; a new file is 0600, since agents' config
 *  files can hold tokens. */
export function writeTextFile(
  path: string,
  text: string,
): { ok: true } | { error: string } {
  let temp: string | null = null;
  try {
    const target = linkTarget(path);
    const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
    mkdirSync(dirname(target), { recursive: true });
    temp = `${target}.demoman-${process.pid}.tmp`;
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
    return { ok: true };
  } catch (error) {
    // Never leave a stray file beside the user's config.
    if (temp !== null) rmSync(temp, { force: true });
    return { error: failure(path, error) };
  }
}

/** The file a write to path lands in: through every symlink, including one
 *  whose target does not exist yet (a dotfiles repo not yet filled in), so
 *  the link itself is never replaced by a plain file. */
function linkTarget(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  let at = path;
  for (let hops = 0; hops < 40; hops++) {
    let link: string;
    try {
      if (!lstatSync(at).isSymbolicLink()) return at;
      link = readlinkSync(at);
    } catch {
      return at;
    }
    at = isAbsolute(link) ? link : join(dirname(at), link);
  }
  return at;
}

/** The folder Cursor's entry names for npx and node. process.execPath is
 *  the resolved binary — under Homebrew a versioned Cellar folder that the
 *  next `brew upgrade node` deletes — so prefer the PATH folder holding an
 *  npx beside a node that resolves to this one, and fall back to the
 *  node's own folder. (npx itself is a link into npm's package, so it
 *  cannot be followed back to node's folder.) fnm's per-shell folder of
 *  links is skipped: fnm removes it with the shell's session. */
export function stableNodeBin(
  execPath: string,
  pathEnv: string,
  realpath: (p: string) => string,
): string {
  for (const dir of pathEnv.split(":")) {
    if (dir === "" || dir.includes("/fnm_multishells/")) continue;
    try {
      realpath(join(dir, "npx"));
      if (realpath(join(dir, "node")) === execPath) return dir;
    } catch {
      // No npx or node in this folder: the next one may hold them.
    }
  }
  return dirname(execPath);
}

/** The skill shipped beside demoman.mjs (scripts/build.mjs, step 3c), or
 *  why it could not be read: only Cursor needs it, so setup says so there. */
export function readSkill(
  distDir: string,
): { text: string } | { error: string } {
  const path = join(distDir, "skills", "record-demo", "SKILL.md");
  const read = readTextFile(path);
  if ("missing" in read) return { error: `${path} is missing` };
  if ("error" in read) return read;
  if (read.text.trim() === "") return { error: `${path} is empty` };
  return read;
}

/** macOS's managed settings, which an admin's env block may use to turn
 *  every update off (code.claude.com/docs/en/settings); Linux's are under
 *  /etc. */
export const CLAUDE_MANAGED_SETTINGS =
  "/Library/Application Support/ClaudeCode/managed-settings.json";
const CLAUDE_MANAGED_SETTINGS_LINUX = "/etc/claude-code/managed-settings.json";

/** Where Claude Code keeps its settings and its user config: under
 *  CLAUDE_CONFIG_DIR when that is set, else ~/.claude and ~/.claude.json. */
export function claudePaths(
  home: string,
  configDir: string | undefined,
  platform: string = process.platform,
): { settings: string; config: string; managed: string } {
  const managed =
    platform === "linux"
      ? CLAUDE_MANAGED_SETTINGS_LINUX
      : CLAUDE_MANAGED_SETTINGS;
  if (configDir === undefined || configDir === "") {
    return {
      settings: join(home, ".claude", "settings.json"),
      config: join(home, ".claude.json"),
      managed,
    };
  }
  return {
    settings: join(configDir, "settings.json"),
    config: join(configDir, ".claude.json"),
    managed,
  };
}

/** The line shown beside the highlighted choice: the bare labels are
 *  ambiguous on their own. */
export const SETUP_HINTS: Record<ExportQuality | PullRequestsValue, string> = {
  share: "Small enough for a chat or a pull request.",
  high: "1440p at 60 fps, about 30 MB for 30 seconds.",
  full: "The largest size the recording supports.",
  off: "Never attach a demo to a pull request.",
  ask: "Ask to attach a demo each time your agent creates a PR.",
  attach: "Always attach a demo whenever your agent creates a PR.",
};

/** Setup's questions as terminal menus, in order; any cancel cancels all. */
async function askInTerminal(q: Questions): Promise<Answers | "cancelled"> {
  const answers: Answers = {};
  if (q.agents !== undefined) {
    const got = await multiselect({
      message: "Connect Demoman to",
      options: q.agents.map((a) => ({ value: a, label: a })),
      initialValues: q.agents,
      required: false,
    });
    if (isCancel(got)) return "cancelled";
    answers.agents = got;
  }
  if (q.quality !== undefined) {
    const got = await select({
      message: "Export quality",
      options: EXPORT_QUALITY_VALUES.map((v) => ({
        value: v,
        label: EXPORT_QUALITY_LABELS[v],
        hint: SETUP_HINTS[v],
      })),
      initialValue: q.quality,
    });
    if (isCancel(got)) return "cancelled";
    answers.quality = got;
  }
  if (q.pullRequests !== undefined) {
    const got = await select({
      message: "Pull requests",
      options: PULL_REQUESTS_VALUES.map((v) => ({
        value: v,
        label: PULL_REQUESTS_LABELS[v],
        hint: SETUP_HINTS[v],
      })),
      initialValue: q.pullRequests,
    });
    if (isCancel(got)) return "cancelled";
    answers.pullRequests = got;
  }
  return answers;
}

export function realSetupDeps(
  version: string,
  distDir: string,
  io: {
    stdinTTY: boolean;
    stdoutTTY: boolean;
    env: Record<string, string | undefined>;
  } = {
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    env: process.env,
  },
): SetupDeps {
  const home = homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    isRoot: process.getuid?.() === 0,
    nodeVersion: process.version,
    version,
    run: (command, args) => runCaptured(command, args),
    // No timeout: a 190 MB download on a slow line is not a stall, and its
    // progress is on screen.
    runVisible: (command, args) =>
      ran(command, spawnSync(command, args, { stdio: "inherit" })),
    // The runner's path, which every launch uses (`fullChromiumPath`): one
    // answer to "is it installed" for setup and for the first run.
    chromiumInstalled: () => existsSync(fullChromiumPath()),
    chromiumInstall: setupChromiumDownload(playwrightCli()),
    chromiumDeps: chromiumDeps(),
    browserLaunches,
    home,
    codexHome: process.env.CODEX_HOME || join(home, ".codex"),
    env: process.env,
    claude: claudePaths(home, process.env.CLAUDE_CONFIG_DIR),
    nodeBin: stableNodeBin(
      realpathSync(process.execPath),
      process.env.PATH ?? "",
      realpathSync,
    ),
    skill: readSkill(distDir),
    exists: (path) => existsSync(path),
    readText: readTextFile,
    writeText: writeTextFile,
    say: (line) => void process.stdout.write(`${line}\n`),
    // An agent's shell, a pipe or CI: nobody can answer, so nothing is asked.
    ask:
      io.stdinTTY && io.stdoutTTY && io.env.CI === undefined
        ? askInTerminal
        : null,
    settings: {
      read: () => readUserSettings(demomanHome()),
      write: (key, value) => writeSetting(demomanHome(), key, value),
    },
  };
}

/** The two questions of `setup --ci`; null is a cancel. */
export function ciPrompts(): NonNullable<CiIo["ask"]> {
  return {
    trigger: async () => {
      const how = await select({
        message: "When should Demoman refresh the kept videos?",
        options: [
          { value: "push", label: "On each merge to main" },
          { value: "deployment", label: "After a successful deployment" },
        ],
      });
      if (isCancel(how)) return null;
      if (how === "push") return "push";
      const env = await text({ message: "The deployment environment's name" });
      return isCancel(env) || env.trim() === "" ? null : env.trim();
    },
    route: async () => {
      const route = await select({
        message: "How should the changed videos reach the repo?",
        options: [
          { value: "pr", label: "In a pull request" },
          { value: "main", label: "Committed straight to main" },
        ],
      });
      return isCancel(route) ? null : (route as "pr" | "main");
    },
  };
}
