// apps/cli/src/setup.ts
//
// `npx demoman setup` (launch B, spec §2; launch E): the browser, then each
// coding agent it finds — Claude Code, Codex, Cursor — wired with Demoman's
// tools pre-approved, then a warm npx cache. Pure over SetupDeps, so every
// failure path is tested; setup-deps.ts supplies the real commands. A failed
// browser stops everything; a failed agent stops only itself, and makes the
// exit 1. Each agent says its own result, and no failure reads as success.
import { parseArgs } from "node:util";
import {
  EXPORT_QUALITY_LABELS,
  EXPORT_QUALITY_VALUES,
  type ExportQuality,
  isExportQuality,
  isPullRequestsValue,
  PULL_REQUESTS_DEFAULT,
  PULL_REQUESTS_LABELS,
  PULL_REQUESTS_VALUES,
  type PullRequestsValue,
} from "@demoman/run-core";
import type { UserSettings } from "@demoman/runner/studio";
import type { SettingKey } from "@demoman/studio";
import {
  addAllowRules,
  CODEX_APPROVAL_TABLE,
  codexApproval,
  cursorEntry,
  cursorServer,
  type Edit,
  isOurSkill,
  marketplaceAutoUpdate,
  opencodeDir,
  opencodeEntry,
  opencodeServer,
} from "./configs.js";
import {
  MARKETPLACE_NAME,
  MARKETPLACE_SOURCE,
  PACKAGE_NAME,
  PLUGIN_ID,
} from "./names.js";

export interface Ran {
  status: number | null;
  /** The signal that ended it, when one did (Ctrl+C, a kill). */
  signal?: string | null;
  stdout: string;
  stderr: string;
  /** The command is not on the PATH. */
  notFound?: boolean;
  /** It could not be started for another reason. */
  error?: string;
}

export interface SetupDeps {
  platform: string;
  nodeVersion: string;
  version: string;
  /** Output captured: for claude's JSON answers. */
  run(command: string, args: string[]): Ran;
  /** Output shown: the Chromium download, so its progress is visible. */
  runVisible(command: string, args: string[]): Ran;
  chromiumInstalled(): boolean;
  chromiumInstall: { command: string; args: string[] };
  /** The user's home folder. */
  home: string;
  /** Codex's folder: $CODEX_HOME, else ~/.codex. */
  codexHome: string;
  /** setup's environment, which the agents it starts usually share. */
  env: Record<string, string | undefined>;
  /** The folder of the node running setup, which holds its npx. */
  nodeBin: string;
  /** Claude Code's settings.json and user config (.claude.json), under
   *  $CLAUDE_CONFIG_DIR when it is set, and the machine's managed settings,
   *  which setup only reads. */
  claude: { settings: string; config: string; managed: string };
  /** The record-demo skill shipped beside demoman.mjs, or why this install
   *  could not read it. */
  skill: { text: string } | { error: string };
  exists(path: string): boolean;
  readText(
    path: string,
  ): { text: string } | { missing: true } | { error: string };
  /** Through a symlink, keeping the file's mode; a new file is 0600. */
  writeText(path: string, text: string): { ok: true } | { error: string };
  say(line: string): void;
  /** Asks every question at once; null when there is no terminal to ask
   *  in, and then nothing is asked. */
  ask: ((q: Questions) => Promise<Answers | "cancelled">) | null;
  /** The Studio's settings file: read as the runner reads it, written
   *  with the Studio's own write. */
  settings: {
    read(): Promise<UserSettings>;
    write(
      key: SettingKey,
      value: string,
    ): Promise<{ replaced?: string } | { reason: string; detail: string }>;
  };
}

/** A present key is a question to ask; its value is what is preselected. */
export interface Questions {
  /** The agents setup found, all preselected. */
  agents?: AgentName[];
  quality?: ExportQuality;
  pullRequests?: PullRequestsValue;
}
/** The same keys, answered. */
export type Answers = Questions;

const MIN_NODE = 20;
const failed = (r: Ran): boolean =>
  r.notFound === true || r.error !== undefined || r.status !== 0;
/** The first thing the command said, else how it ended. */
const why = (r: Ran): string =>
  r.error ??
  `${r.stderr}\n${r.stdout}`
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "") ??
  (typeof r.signal === "string"
    ? `stopped by ${r.signal}`
    : `exit ${r.status}`);

/** Single-quoted for a POSIX shell when it holds anything but a plain path. */
const shellQuoted = (s: string): string =>
  /^[\w./~-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

/** Setup installs at user scope; the list has one row per scope. A row
 *  with no scope comes from a Claude Code that does not list scopes. */
const userRow = (
  list: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined =>
  list.find(
    (p) => p.id === PLUGIN_ID && (p.scope === undefined || p.scope === "user"),
  );

export function platformRefusal(
  platform: string,
  nodeVersion: string,
): string | null {
  if (platform !== "darwin") {
    return `this build is for macOS, and this machine is ${platform}`;
  }
  const major = Number(/^v?(\d+)/.exec(nodeVersion)?.[1]);
  if (!(major >= MIN_NODE)) {
    return `Demoman needs Node ${MIN_NODE} or later, and this is Node ${nodeVersion.replace(/^v/, "")}`;
  }
  return null;
}

function parseList(r: Ran): Array<Record<string, unknown>> | string {
  try {
    const v = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(v)) return "it is not a list";
    return v as Array<Record<string, unknown>>;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function browser(d: SetupDeps): boolean {
  if (d.chromiumInstalled()) {
    d.say("browser: Chromium is already installed");
    return true;
  }
  d.say("browser: downloading Chromium (about 190 MB)…");
  const again = `run \`npx ${PACKAGE_NAME}@${d.version} setup\` again`;
  const r = d.runVisible(d.chromiumInstall.command, d.chromiumInstall.args);
  if (failed(r)) {
    d.say(
      `browser: the download failed (${why(r)}). Nothing else was set up; ${again} once that is fixed.`,
    );
    return false;
  }
  if (!d.chromiumInstalled()) {
    d.say(
      `browser: the download said it finished, but Chromium is still not there. ${again}; if it says this twice, the download is being cut short.`,
    );
    return false;
  }
  d.say("browser: Chromium installed");
  return true;
}

export type AgentName = "Claude Code" | "Codex" | "Cursor" | "OpenCode";
/** wired: Demoman works and its tools run without asking. partial: it
 *  works, with a limit said beside the fix — its tools will ask, or one of
 *  the agent's surfaces (Cursor's CLI beside its app) cannot use it.
 *  failed: the agent cannot see or run Demoman. absent: not installed.
 *  skipped: left as it was, because it was not chosen. */
export type AgentState = "wired" | "partial" | "failed" | "absent" | "skipped";
export interface AgentResult {
  agent: AgentName;
  state: AgentState;
}
type Wire = (d: SetupDeps) => AgentResult;

/** Each agent's word on the command line, in the order setup wires them. */
const AGENT_FLAGS: ReadonlyArray<[string, AgentName]> = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
];

/** Answers given on the command line: each one is a question not asked. */
export interface SetupFlags {
  /** Ask nothing, as without a terminal: for an agent's pseudo-terminal. */
  yes?: boolean;
  agents?: AgentName[];
  quality?: ExportQuality;
  pullRequests?: PullRequestsValue;
}

/** setup's arguments, or why they cannot be used, before anything runs. */
export function parseSetupArgs(
  args: string[],
): SetupFlags | { refused: string } {
  let values: {
    yes?: boolean;
    agents?: string;
    quality?: string;
    "pull-requests"?: string;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        yes: { type: "boolean" },
        agents: { type: "string" },
        quality: { type: "string" },
        "pull-requests": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
  const flags: SetupFlags = values.yes === true ? { yes: true } : {};
  if (values.agents !== undefined) {
    const words = values.agents.split(",").map((w) => w.trim());
    const unknown = words.find(
      (w) => !AGENT_FLAGS.some(([flag]) => flag === w),
    );
    if (unknown !== undefined) {
      return {
        refused: `--agents takes ${AGENT_FLAGS.map(([flag]) => flag).join(", ")}, comma-separated; got "${unknown}"`,
      };
    }
    flags.agents = AGENT_FLAGS.filter(([flag]) => words.includes(flag)).map(
      ([, name]) => name,
    );
  }
  const quality = values.quality;
  if (quality !== undefined) {
    if (!isExportQuality(quality)) {
      return {
        refused: `--quality must be ${EXPORT_QUALITY_VALUES.join(", ")}; got "${quality}"`,
      };
    }
    flags.quality = quality;
  }
  const pr = values["pull-requests"];
  if (pr !== undefined) {
    if (!isPullRequestsValue(pr)) {
      return {
        refused: `--pull-requests must be ${PULL_REQUESTS_VALUES.join(", ")}; got "${pr}"`,
      };
    }
    flags.pullRequests = pr;
  }
  return flags;
}

/** Every tool of the plugin's server (code.claude.com/docs/en/permissions:
 *  a plugin's server takes the plugin-scoped name). */
export const CLAUDE_ALLOW_RULE = "mcp__plugin_demoman_demoman__*";

/** Applies edit to the file at path, writing only a change. null when the
 *  file now says what setup wants; else why it does not. */
function edited(
  d: SetupDeps,
  path: string,
  edit: (text: string | null) => Edit,
): string | null {
  const file = d.readText(path);
  if ("error" in file) return `${path} could not be read: ${file.error}`;
  const out = edit("text" in file ? file.text : null);
  if ("refused" in out) return `${path} was left alone: ${out.refused}`;
  if (!out.changed) return null;
  const wrote = d.writeText(path, out.text);
  return "error" in wrote
    ? `${path} could not be written: ${wrote.error}`
    : null;
}

function claudeCode(d: SetupDeps): AgentResult {
  const result = (state: AgentState): AgentResult => ({
    agent: "Claude Code",
    state,
  });
  const claude = (args: string[]) => d.run("claude", args);
  const markets = claude(["plugin", "marketplace", "list", "--json"]);
  if (markets.notFound) {
    d.say(
      "Claude Code: the `claude` command is not on this shell's PATH, so nothing was registered. In Claude Code, run:\n\n" +
        `  /plugin marketplace add ${MARKETPLACE_SOURCE}\n  /plugin install ${PLUGIN_ID}\n`,
    );
    return result("absent");
  }
  if (failed(markets)) {
    d.say(
      // An old Claude Code may reject the word, the flag, or the count.
      /unknown (command|option)|too many arguments/i.test(why(markets))
        ? `Claude Code: this Claude Code has no \`claude plugin\` command; update Claude Code, then run \`npx ${PACKAGE_NAME}@${d.version} setup\` again (${why(markets)})`
        : `Claude Code: \`claude plugin marketplace list --json\` failed (${why(markets)})`,
    );
    return result("failed");
  }
  const marketList = parseList(markets);
  if (typeof marketList === "string") {
    d.say(`Claude Code: could not read its marketplace list (${marketList})`);
    return result("failed");
  }
  const step = (args: string[]): boolean => {
    const r = claude(args);
    if (failed(r)) {
      d.say(`Claude Code: \`claude ${args.join(" ")}\` failed (${why(r)})`);
      return false;
    }
    return true;
  };
  const hasMarket = marketList.some((m) => m.name === MARKETPLACE_NAME);
  if (
    !step(
      hasMarket
        ? ["plugin", "marketplace", "update", MARKETPLACE_NAME]
        : ["plugin", "marketplace", "add", MARKETPLACE_SOURCE],
    )
  ) {
    return result("failed");
  }

  const listPlugins = (): Array<Record<string, unknown>> | null => {
    const r = claude(["plugin", "list", "--json"]);
    if (failed(r)) {
      d.say(`Claude Code: \`claude plugin list --json\` failed (${why(r)})`);
      return null;
    }
    const list = parseList(r);
    if (typeof list === "string") {
      d.say(`Claude Code: could not read its plugin list (${list})`);
      return null;
    }
    return list;
  };
  const before = listPlugins();
  if (before === null) return result("failed");
  const had = userRow(before) !== undefined;
  if (
    !step(
      had ? ["plugin", "update", PLUGIN_ID] : ["plugin", "install", PLUGIN_ID],
    )
  ) {
    return result("failed");
  }

  const after = listPlugins();
  if (after === null) return result("failed");
  const plugin = userRow(after);
  if (plugin === undefined) {
    d.say(
      `Claude Code: the install reported success, but \`claude plugin list\` does not list ${PLUGIN_ID}`,
    );
    return result("failed");
  }
  if (plugin.version !== d.version) {
    d.say(
      `Claude Code: the plugin pins Demoman ${String(plugin.version)}, and this setup is ${d.version}. Run \`npx ${PACKAGE_NAME}@latest setup\`; if it says this again, the plugin has not been released for this version yet.`,
    );
    return result("failed");
  }
  if (plugin.enabled === false) {
    d.say(
      `Claude Code: the plugin is installed but disabled — run \`claude plugin enable ${PLUGIN_ID}\``,
    );
    return result("failed");
  }
  const settings = claudeSettings(
    d,
    hasMarket ? marketList.find((m) => m.name === MARKETPLACE_NAME) : undefined,
  );
  const stale = settings.updates === null ? updatesOff(d, settings.text) : null;
  const path = d.claude.settings;
  const allowFix = `add "${CLAUDE_ALLOW_RULE}" to permissions.allow`;
  const updateFix = `set "autoUpdate": true on extraKnownMarketplaces.${MARKETPLACE_NAME}`;
  const limits: string[] = [];
  if (settings.allow !== null && settings.allow === settings.updates) {
    // One cause for both (the file is unreadable, say): said once.
    limits.push(
      `its tools will ask before they run and it will not update itself (${settings.allow}). To fix both, ${allowFix} and ${updateFix} in ${path}`,
    );
  } else {
    if (settings.allow !== null) {
      limits.push(
        `its tools will ask before they run (${settings.allow}). To stop that, ${allowFix} in ${path}`,
      );
    }
    if (settings.updates !== null) {
      limits.push(
        `it will not update itself (${settings.updates}. To turn that on, ${updateFix} in ${path})`,
      );
    }
  }
  if (stale !== null) limits.push(`it will not update itself (${stale})`);
  const updates = settings.updates === null && stale === null;
  const installed = `Claude Code: the demoman plugin is installed (${d.version})${updates ? " and updates itself" : ""}`;
  const asks = settings.allow === null ? "; its tools run without asking" : "";
  d.say(
    limits.length === 0
      ? `${installed}${asks}`
      : `${installed}${asks}, but ${limits.join("; and ")}`,
  );
  duplicates(d);
  return result(limits.length === 0 ? "wired" : "partial");
}

/** Both of setup's edits to Claude Code's settings.json, in one read and
 *  one write: the allow rule, then the marketplace's autoUpdate
 *  (marketplaceAutoUpdate). Each answers null when the file now says it,
 *  else why not; a cause the whole file shares is the same text in both.
 *  `text` is the file as it now stands, for updatesOff to read. */
function claudeSettings(
  d: SetupDeps,
  listed: unknown,
): { allow: string | null; updates: string | null; text: string | null } {
  const path = d.claude.settings;
  const file = d.readText(path);
  if ("error" in file) {
    const why = `${path} could not be read: ${file.error}`;
    return { allow: why, updates: why, text: null };
  }
  const before = "text" in file ? file.text : null;
  const allowEdit = addAllowRules(before, [CLAUDE_ALLOW_RULE]);
  const afterAllow = "text" in allowEdit ? allowEdit.text : before;
  const updateEdit = marketplaceAutoUpdate(afterAllow, listed);
  const after = "text" in updateEdit ? updateEdit.text : afterAllow;
  let allow =
    "refused" in allowEdit
      ? `${path} was left alone: ${allowEdit.refused}`
      : null;
  let updates =
    "refused" in updateEdit
      ? `${path} was left alone: ${updateEdit.refused}`
      : null;
  if (after === null || after === before)
    return { allow, updates, text: after };
  const wrote = d.writeText(path, after);
  if ("error" in wrote) {
    const why = `${path} could not be written: ${wrote.error}`;
    if ("changed" in allowEdit && allowEdit.changed) allow = why;
    if ("changed" in updateEdit && updateEdit.changed) updates = why;
    return { allow, updates, text: before };
  }
  return { allow, updates, text: after };
}

/** Claude Code's own switches that stop every plugin update, unless
 *  FORCE_AUTOUPDATE_PLUGINS is set too (code.claude.com/docs/en/plugins/loading). */
const UPDATES_OFF = [
  "DISABLE_UPDATES",
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;
/** As an env value is read: "1", "true", "yes" or "on" — and a JSON 1 or
 *  true, which a settings file's env block may hold instead of a string. */
const truthy = (v: unknown): boolean =>
  v === true ||
  v === 1 ||
  (typeof v === "string" && /^(1|true|yes|on)$/i.test(v.trim()));

/** The env block of a settings file's text: {} when it has none. */
function envBlock(text: string | null): Record<string, unknown> | string {
  if (text === null) return {};
  try {
    const env = (JSON.parse(text) as { env?: unknown }).env;
    return typeof env === "object" && env !== null && !Array.isArray(env)
      ? (env as Record<string, unknown>)
      : {};
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A switch that stops the updates setup just turned on: in managed
 *  settings, the user's settings.json or this shell, the later winning as
 *  Claude Code layers them. null when there is none; else which, where,
 *  and what overrides it. */
function updatesOff(d: SetupDeps, userText: string | null): string | null {
  const managed = d.readText(d.claude.managed);
  if ("error" in managed) {
    return `whether ${d.claude.managed} stops plugin updates is unknown: it could not be read (${managed.error})`;
  }
  const sources: Array<[string, Record<string, unknown> | string]> = [
    ["this shell", d.env],
    [`the env block of ${d.claude.settings}`, envBlock(userText)],
    [
      `the env block of ${d.claude.managed}`,
      envBlock("text" in managed ? managed.text : null),
    ],
  ];
  for (const [where, env] of sources) {
    if (typeof env === "string") {
      return `whether ${where} stops plugin updates is unknown: it is not JSON (${env})`;
    }
  }
  const layers = sources as Array<[string, Record<string, unknown>]>;
  const merged = Object.assign({}, ...layers.map(([, env]) => env)) as Record<
    string,
    unknown
  >;
  if (truthy(merged.FORCE_AUTOUPDATE_PLUGINS)) return null;
  const off = UPDATES_OFF.find((name) => truthy(merged[name]));
  if (off === undefined) return null;
  const where =
    [...layers].reverse().find(([, env]) => truthy(env[off]))?.[0] ??
    "this shell";
  return `${off} is set in ${where}, which stops Claude Code's plugin updates. To update plugins anyway, set FORCE_AUTOUPDATE_PLUGINS=1 beside it`;
}

/** A demoman server registered some other way would offer the same tools
 *  twice. Said, with the command that removes it; never removed here. */
function duplicates(d: SetupDeps): void {
  const file = d.readText(d.claude.config);
  if ("missing" in file) return;
  if ("error" in file) {
    d.say(`Claude Code: duplicates were not checked (${file.error})`);
    return;
  }
  let config: {
    mcpServers?: Record<string, unknown>;
    projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
  };
  try {
    config = JSON.parse(file.text);
  } catch (error) {
    d.say(
      `Claude Code: duplicates were not checked (${d.claude.config} is not JSON: ${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }
  const describe = (e: unknown): string => {
    const entry = e as { command?: string; args?: unknown; url?: string };
    if (typeof entry.url === "string") return entry.url;
    return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
      .filter((p) => p !== undefined)
      .join(" ");
  };
  const user = config.mcpServers?.demoman;
  if (user !== undefined) {
    d.say(
      `Claude Code also runs a demoman server for every project ("${describe(user)}"). With the plugin it would offer the same tools twice. Remove it with:\n\n  claude mcp remove demoman --scope user\n`,
    );
  }
  for (const [project, value] of Object.entries(config.projects ?? {})) {
    const local = value?.mcpServers?.demoman;
    if (local !== undefined) {
      d.say(
        `Claude Code also runs a demoman server in ${project} ("${describe(local)}"). Remove it with:\n\n  cd ${shellQuoted(project)} && claude mcp remove demoman --scope local\n`,
      );
    }
  }
}

export async function setup(
  d: SetupDeps,
  flags: SetupFlags = {},
): Promise<number> {
  try {
    return await steps(d, flags);
  } catch (error) {
    // A throw from a real command's adapter: said in setup's own words,
    // not as a stack trace, and never as Done.
    d.say(
      `Demoman setup stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

/** The first Codex proven against the plugin route (launch E, Task 1). */
const CODEX_MIN = [0, 163, 0] as const;

function parseJson(r: Ran): unknown | { unreadable: string } {
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch (error) {
    return {
      unreadable: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Codex installs our marketplace repo as a plugin, the way Claude Code
 *  does (`.claude-plugin/`, `.mcp.json`, `skills/`), so the plugin pins
 *  the version; setup then pre-approves its server in config.toml. */
const codex: Wire = (d) => {
  const result = (state: AgentState): AgentResult => ({
    agent: "Codex",
    state,
  });
  const config = `${d.codexHome}/config.toml`;
  const again = `run \`npx ${PACKAGE_NAME}@${d.version} setup\` again`;
  const version = d.run("codex", ["--version"]);
  if (version.notFound) {
    d.say("Codex: not installed");
    return result("absent");
  }
  if (failed(version)) {
    d.say(
      `Codex: \`codex --version\` failed (${why(version)}); fix that, then ${again}`,
    );
    return result("failed");
  }
  if (older(version.stdout, CODEX_MIN)) {
    d.say(
      `Codex: this is Codex ${versionIn(version.stdout)}, and Demoman needs ${CODEX_MIN.join(".")} or later for \`codex plugin\` — update Codex, then ${again}`,
    );
    return result("failed");
  }
  const codexStep = (args: string[]): Ran | null => {
    const r = d.run("codex", args);
    if (failed(r)) {
      d.say(`Codex: \`codex ${args.join(" ")}\` failed (${why(r)})`);
      return null;
    }
    return r;
  };
  const add = codexStep([
    "plugin",
    "marketplace",
    "add",
    MARKETPLACE_SOURCE,
    "--json",
  ]);
  if (add === null) return result("failed");
  const added = parseJson(add) as {
    marketplaceName?: unknown;
    alreadyAdded?: unknown;
    unreadable?: string;
  };
  if (added?.marketplaceName !== MARKETPLACE_NAME) {
    d.say(
      `Codex: \`codex plugin marketplace add\` answered ${added?.unreadable === undefined ? `marketplace ${JSON.stringify(added?.marketplaceName)}` : `something setup could not read (${added.unreadable})`}, not "${MARKETPLACE_NAME}"`,
    );
    return result("failed");
  }
  if (
    added.alreadyAdded === true &&
    codexStep([
      "plugin",
      "marketplace",
      "upgrade",
      MARKETPLACE_NAME,
      "--json",
    ]) === null
  ) {
    return result("failed");
  }
  if (codexStep(["plugin", "add", PLUGIN_ID, "--json"]) === null) {
    return result("failed");
  }
  const list = codexStep(["plugin", "list", "--json"]);
  if (list === null) return result("failed");
  const listed = parseJson(list) as {
    installed?: Array<Record<string, unknown>>;
    unreadable?: string;
  };
  if (listed?.unreadable !== undefined || !Array.isArray(listed?.installed)) {
    d.say(
      `Codex: could not read its plugin list (${listed?.unreadable ?? "it has no installed list"})`,
    );
    return result("failed");
  }
  const plugin = listed.installed.find((p) => p.pluginId === PLUGIN_ID);
  if (plugin === undefined) {
    d.say(
      `Codex: the install reported success, but \`codex plugin list\` does not list ${PLUGIN_ID}`,
    );
    return result("failed");
  }
  if (plugin.version !== d.version) {
    d.say(
      `Codex: the plugin pins Demoman ${String(plugin.version)}, and this setup is ${d.version}. Run \`npx ${PACKAGE_NAME}@latest setup\`; if it says this again, the plugin has not been released for this version yet.`,
    );
    return result("failed");
  }
  if (plugin.enabled === false) {
    d.say(
      `Codex: the plugin is installed but disabled — set enabled = true under [plugins."${PLUGIN_ID}"] in ${config}`,
    );
    return result("failed");
  }
  const installed = `Codex: the demoman plugin is installed (${d.version})`;
  const refused = edited(d, config, codexApproval);
  if (refused === null) {
    d.say(`${installed}; its tools run without asking`);
    return result("wired");
  }
  d.say(
    `${installed}, but its tools will ask before they run (${refused}). To stop that, add this to ${config}:\n\n${CODEX_APPROVAL_TABLE}\n`,
  );
  return result("partial");
};
/** Where the Cursor app may be installed. */
const cursorApps = (d: SetupDeps): string[] => [
  "/Applications/Cursor.app",
  `${d.home}/Applications/Cursor.app`,
];
/** The commands that may be Cursor's agent CLI. */
const cursorClis = (d: SetupDeps): string[] => [
  "agent",
  `${d.home}/.local/bin/agent`,
  "cursor-agent",
];

/** The agents on this machine, found without changing anything: the
 *  ones setup offers to connect. */
export function foundAgents(d: SetupDeps): AgentName[] {
  const there = (command: string) => !d.run(command, ["--version"]).notFound;
  return [
    ...(there("claude") ? (["Claude Code"] as const) : []),
    ...(there("codex") ? (["Codex"] as const) : []),
    ...(cursorApps(d).some((p) => d.exists(p)) || cursorClis(d).some(there)
      ? (["Cursor"] as const)
      : []),
    ...(there("opencode") ? (["OpenCode"] as const) : []),
  ];
}

/** Every tool of the demoman server, in the CLI's permission syntax
 *  (cursor.com/docs/cli/reference/permissions documents the wildcard). */
export const CURSOR_ALLOW_RULE = "Mcp(demoman:*)";

/** Cursor cannot install a plugin from a shell, so setup writes its global
 *  mcp.json (read by the app and the `agent` CLI alike) and copies the
 *  skill; then pre-approves the server where a file allows it. */
const cursor: Wire = (d) => {
  const result = (state: AgentState): AgentResult => ({
    agent: "Cursor",
    state,
  });
  const again = `run \`npx ${PACKAGE_NAME}@${d.version} setup\` again`;
  const app = cursorApps(d).some((p) => d.exists(p));
  // `agent` is a generic name: only one that answers with Cursor's dated
  // version is Cursor's. The other two are usually Cursor's, so one that is
  // there but does not answer is said, not taken for absence; it fails
  // Cursor only when there is no app to wire instead.
  let cli: string | null = null;
  let odd: string | null = null;
  for (const c of cursorClis(d)) {
    const r = d.run(c, ["--version"]);
    if (r.notFound) continue;
    if (!failed(r) && /^\d{4}\.\d{2}\.\d{2}/.test(r.stdout.trim())) {
      cli = c;
      break;
    }
    if (c !== "agent" && odd === null) {
      odd = `\`${c} --version\` did not answer as Cursor's agent CLI (${failed(r) ? why(r) : `it said "${r.stdout.trim()}"`})`;
    }
  }
  if (cli === null && odd !== null) {
    d.say(
      app
        ? `Cursor: ${odd}; if it is Cursor's, fix or update it, then ${again}. The app is set up below.`
        : `Cursor: ${odd}; fix or update it, then ${again}`,
    );
    if (!app) return result("failed");
  }
  if (!app && cli === null) {
    d.say("Cursor: not installed");
    return result("absent");
  }
  if (!canWriteEntry(d, "Cursor", again)) return result("failed");

  const mcpPath = `${d.home}/.cursor/mcp.json`;
  const entry = cursorEntry(d.nodeBin);
  const pasteIn = `add this under "mcpServers" in ${mcpPath}, then ${again}:\n\n"demoman": ${JSON.stringify(entry, null, 2)}\n`;
  const file = d.readText(mcpPath);
  if ("error" in file) {
    d.say(`Cursor: ${mcpPath} could not be read (${file.error}); ${pasteIn}`);
    return result("failed");
  }
  const edit = cursorServer("text" in file ? file.text : null, entry);
  if ("foreign" in edit) {
    d.say(
      `Cursor: ~/.cursor/mcp.json already has a "demoman" server that setup did not write (${edit.foreign}), so it was left alone — remove that entry, then ${again}`,
    );
    return result("failed");
  }
  if ("refused" in edit) {
    d.say(`Cursor: ${mcpPath} was left alone: ${edit.refused}; ${pasteIn}`);
    return result("failed");
  }
  if (edit.changed) {
    const wrote = d.writeText(mcpPath, edit.text);
    if ("error" in wrote) {
      d.say(
        `Cursor: ${mcpPath} could not be written (${wrote.error}); ${pasteIn}`,
      );
      return result("failed");
    }
  }

  // The skill is what sends the agent to `recipe` here: whether Cursor
  // shows the model the server's instructions is unknown (spec §1).
  if (
    !placeSkill(
      d,
      "Cursor",
      "~/.cursor/skills/record-demo",
      `${d.home}/.cursor/skills/record-demo/SKILL.md`,
      again,
    )
  ) {
    return result("failed");
  }

  const reasons: string[] = [];
  if (cli !== null) {
    // Without it the agent CLI never starts the server (Task 1 findings).
    const enable = d.run(cli, ["mcp", "enable", "demoman"]);
    if (failed(enable)) {
      const cannot = `\`${cli} mcp enable demoman\` failed (${why(enable)}), so the agent CLI cannot use Demoman — run it yourself`;
      if (!app) {
        d.say(`Cursor: ${cannot}`);
        return result("failed");
      }
      reasons.push(cannot);
    }
    const refused = edited(d, `${d.home}/.cursor/cli-config.json`, (text) =>
      addAllowRules(text, [CURSOR_ALLOW_RULE]),
    );
    if (refused !== null) {
      reasons.push(
        `the agent CLI's tools will ask (${refused}); add "${CURSOR_ALLOW_RULE}" to permissions.allow in ~/.cursor/cli-config.json`,
      );
    }
  }
  if (app) {
    reasons.push(
      "in the Cursor app its tools may ask once each, because the app keeps its allow-list where setup cannot write it",
    );
  }
  const connected = "Cursor: Demoman is connected and updates itself";
  if (reasons.length === 0) {
    d.say(`${connected}; its tools run without asking`);
    return result("wired");
  }
  d.say(`${connected}, but ${reasons.join("; ")}`);
  return result("partial");
};

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;
/** The version an agent's --version printed, else what it printed. */
const versionIn = (stdout: string): string =>
  VERSION_RE.exec(stdout)?.[0] ?? `"${stdout.trim()}"`;
/** Older than min, or no version in it at all. */
function older(stdout: string, min: readonly number[]): boolean {
  const said = VERSION_RE.exec(stdout);
  if (said === null) return true;
  /** major.minor.patch as one comparable number. */
  const rank = ([a = 0, b = 0, c = 0]: readonly number[]): number =>
    a * 1e6 + b * 1e3 + c;
  return rank(said.slice(1, 4).map(Number)) < rank(min);
}

/** For an agent whose entry setup writes (Cursor, OpenCode): this
 *  install's skill to copy, and an npx beside the Node running setup, which
 *  the entry names. Says why not, and answers false. */
function canWriteEntry(d: SetupDeps, agent: AgentName, again: string): boolean {
  if ("error" in d.skill) {
    d.say(
      `${agent}: this install's record-demo skill could not be read (${d.skill.error}); reinstall Demoman, then ${again}`,
    );
    return false;
  }
  // Without it the agent could never start Demoman, whatever the file says.
  const npx = `${d.nodeBin}/npx`;
  if (!d.exists(npx)) {
    d.say(
      `${agent}: there is no npx beside the Node running setup (${npx}), so an entry naming it could not start — run setup with a Node that has npx`,
    );
    return false;
  }
  return true;
}

/** Copies this install's record-demo skill to path, over Demoman's own
 *  older copy and never over someone else's skill. Says why not, and
 *  answers false. */
function placeSkill(
  d: SetupDeps,
  agent: AgentName,
  folder: string,
  path: string,
  again: string,
): boolean {
  if ("error" in d.skill) return false;
  const skill = d.readText(path);
  if ("error" in skill) {
    d.say(`${agent}: ${path} could not be read (${skill.error})`);
    return false;
  }
  if ("text" in skill && !isOurSkill(skill.text)) {
    d.say(
      `${agent}: ${folder} already holds a skill that is not Demoman's, so it was left alone — rename that folder, then ${again}`,
    );
    return false;
  }
  if ("text" in skill && skill.text === d.skill.text) return true;
  const wrote = d.writeText(path, d.skill.text);
  if ("error" in wrote) {
    d.say(
      `${agent}: the record-demo skill could not be written (${wrote.error})`,
    );
    return false;
  }
  return true;
}

/** mcp.servers, the form OpenCode 2 reads first, came with 2.0. */
const OPENCODE_MIN = [2, 0, 0] as const;

/** OpenCode has no plugin layer either: setup writes its opencode.json and
 *  copies the skill. Its tools run without asking by default, so there is
 *  nothing to pre-approve. */
const opencode: Wire = (d) => {
  const result = (state: AgentState): AgentResult => ({
    agent: "OpenCode",
    state,
  });
  const again = `run \`npx ${PACKAGE_NAME}@${d.version} setup\` again`;
  const version = d.run("opencode", ["--version"]);
  if (version.notFound) {
    d.say("OpenCode: not installed");
    return result("absent");
  }
  if (failed(version)) {
    d.say(
      `OpenCode: \`opencode --version\` failed (${why(version)}); fix that, then ${again}`,
    );
    return result("failed");
  }
  if (older(version.stdout, OPENCODE_MIN)) {
    d.say(
      `OpenCode: this is OpenCode ${versionIn(version.stdout)}, and Demoman needs ${OPENCODE_MIN.join(".")} or later — update OpenCode, then ${again}`,
    );
    return result("failed");
  }
  if (!canWriteEntry(d, "OpenCode", again)) return result("failed");

  const dir = opencodeDir(d.home, d.env);
  const config = `${dir}/opencode.json`;
  const entry = opencodeEntry(d.nodeBin);
  const pasteIn = (file: string) =>
    `add this under "mcp" → "servers" in ${file}, then ${again}:\n\n"demoman": ${JSON.stringify(entry, null, 2)}\n`;
  const jsonc = `${dir}/opencode.jsonc`;
  if (d.exists(jsonc)) {
    d.say(
      `OpenCode: ${jsonc} may hold comments an edit would lose, so it was left alone; ${pasteIn(jsonc)}`,
    );
    return result("failed");
  }
  const file = d.readText(config);
  if ("error" in file) {
    d.say(
      `OpenCode: ${config} could not be read (${file.error}); ${pasteIn(config)}`,
    );
    return result("failed");
  }
  const edit = opencodeServer("text" in file ? file.text : null, entry);
  if ("foreign" in edit) {
    d.say(
      `OpenCode: ${config} already has a "demoman" server that setup did not write (${edit.foreign}), so it was left alone — remove that entry, then ${again}`,
    );
    return result("failed");
  }
  if ("refused" in edit) {
    d.say(
      `OpenCode: ${config} was left alone: ${edit.refused}; ${pasteIn(config)}`,
    );
    return result("failed");
  }
  if (edit.changed) {
    const wrote = d.writeText(config, edit.text);
    if ("error" in wrote) {
      d.say(
        `OpenCode: ${config} could not be written (${wrote.error}); ${pasteIn(config)}`,
      );
      return result("failed");
    }
  }
  if (
    !placeSkill(
      d,
      "OpenCode",
      `${dir}/skills/record-demo`,
      `${dir}/skills/record-demo/SKILL.md`,
      again,
    )
  ) {
    return result("failed");
  }
  d.say("OpenCode: Demoman is connected and updates itself");
  return result("wired");
};

/** "A", "A and B", "A, B and C". */
const listed = (names: string[]): string =>
  names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

async function steps(given: SetupDeps, flags: SetupFlags): Promise<number> {
  const d: SetupDeps = flags.yes === true ? { ...given, ask: null } : given;
  const refusal = platformRefusal(d.platform, d.nodeVersion);
  if (refusal !== null) {
    d.say(`Demoman setup stopped: ${refusal}.`);
    return 1;
  }
  d.say(`Demoman ${d.version} setup`);
  // Every question before any change, so a cancel changes nothing.
  const questions: Questions = {};
  const found =
    d.ask !== null && flags.agents === undefined ? foundAgents(d) : [];
  if (found.length > 0) questions.agents = found;
  // Read only when something may change them, so a run with no terminal
  // and no flag is today's run.
  const wantsSettings =
    d.ask !== null ||
    flags.quality !== undefined ||
    flags.pullRequests !== undefined;
  let preselected: {
    quality?: ExportQuality;
    pullRequests?: PullRequestsValue;
  } = {};
  if (wantsSettings) {
    const read = await d.settings.read();
    if (read.unreadable !== undefined) d.say(`settings: ${read.unreadable}`);
    preselected = {
      quality: read.exportQuality,
      pullRequests: read.pullRequests ?? PULL_REQUESTS_DEFAULT,
    };
    if (d.ask !== null && flags.quality === undefined) {
      questions.quality = preselected.quality;
    }
    if (d.ask !== null && flags.pullRequests === undefined) {
      questions.pullRequests = preselected.pullRequests;
    }
  }
  let answers: Answers = {};
  if (d.ask !== null && Object.keys(questions).length > 0) {
    const got = await d.ask(questions);
    if (got === "cancelled") {
      d.say("Setup cancelled; nothing was changed.");
      return 1;
    }
    answers = got;
  }
  const chosen = flags.agents ?? answers.agents;
  // Not chosen: an agent left off --agents, or one offered and unticked.
  // One never offered is wired as today, to say it is not installed.
  const skip = (agent: AgentName): boolean =>
    chosen !== undefined &&
    !chosen.includes(agent) &&
    (flags.agents !== undefined || found.includes(agent));

  if (!browser(d)) return 1;
  const wires: Array<[AgentName, Wire]> = [
    ["Claude Code", claudeCode],
    ["Codex", codex],
    ["Cursor", cursor],
    ["OpenCode", opencode],
  ];
  const results = wires.map(([agent, wire]): AgentResult => {
    if (!skip(agent)) {
      const r = wire(d);
      // Named in --agents: not installed is a failure, not a pass.
      return r.state === "absent" && flags.agents?.includes(agent)
        ? { agent, state: "failed" }
        : r;
    }
    d.say(`${agent}: not connected (not chosen)`);
    return { agent, state: "skipped" };
  });
  const settingsFailed = await saveSettings(d, preselected, {
    quality: flags.quality ?? answers.quality,
    pullRequests: flags.pullRequests ?? answers.pullRequests,
  });
  const usable = results
    .filter((r) => r.state === "wired" || r.state === "partial")
    .map((r) => r.agent);
  const failed = results
    .filter((r) => r.state === "failed")
    .map((r) => r.agent);
  const notDone = [
    ...(failed.length > 0 ? [`${listed(failed)} could not be set up`] : []),
    ...settingsFailed,
  ];
  if (notDone.length > 0) {
    if (usable.length > 0) warmStart(d, usable);
    d.say(
      `\nNot done: ${notDone.join(", and ")} (above).${usable.length > 0 ? ` Restart ${listed(usable)} to use Demoman there.` : ""}`,
    );
    return 1;
  }
  if (
    usable.length === 0 &&
    failed.length === 0 &&
    results.some((r) => r.state === "skipped")
  ) {
    d.say(
      `\nDone. No agent was connected; run \`npx ${PACKAGE_NAME}@${d.version} setup\` again to connect one.`,
    );
    return 0;
  }
  if (usable.length === 0 && failed.length === 0) {
    d.say(
      `\nNo coding agent was found. Demoman works with Claude Code, Codex and Cursor: install one and run \`npx ${PACKAGE_NAME}@${d.version} setup\` again, or connect another MCP client with the block in the README (https://www.npmjs.com/package/${PACKAGE_NAME}).`,
    );
    return 1;
  }
  if (usable.length > 0) warmStart(d, usable);
  d.say(
    `\nDone. Restart ${listed(usable)}, then in your app's repo ask for a demo, for example: "make a demo of the feature we just built".`,
  );
  d.say(
    `If your app needs a login, sign in once with \`npx ${PACKAGE_NAME} signin <url>\`.`,
  );
  return 0;
}

/** Writes each answer that differs from what was preselected, saying each
 *  write. Answers what went wrong, for the closing line: a refused write,
 *  or a write that replaced the file and lost its other settings. */
async function saveSettings(
  d: SetupDeps,
  preselected: { quality?: ExportQuality; pullRequests?: PullRequestsValue },
  answered: { quality?: ExportQuality; pullRequests?: PullRequestsValue },
): Promise<string[]> {
  const changes: Array<[SettingKey, string, string]> = [];
  if (
    answered.quality !== undefined &&
    answered.quality !== preselected.quality
  ) {
    changes.push([
      "exportQuality",
      answered.quality,
      `export quality is now ${EXPORT_QUALITY_LABELS[answered.quality]}`,
    ]);
  }
  if (
    answered.pullRequests !== undefined &&
    answered.pullRequests !== preselected.pullRequests
  ) {
    changes.push([
      "pullRequests",
      answered.pullRequests,
      `pull requests is now ${PULL_REQUESTS_LABELS[answered.pullRequests]}`,
    ]);
  }
  const failed = new Set<string>();
  for (const [key, value, said] of changes) {
    const wrote = await d.settings.write(key, value);
    if ("reason" in wrote) {
      d.say(`settings: ${wrote.detail}`);
      failed.add("a setting was not saved");
      continue;
    }
    d.say(`settings: ${said}`);
    if (wrote.replaced !== undefined) {
      d.say(`settings: ${wrote.replaced}`);
      failed.add("the settings file was replaced");
    }
  }
  return [...failed];
}

/** The agents whose entry setup writes runs `demoman@latest`. */
const ON_LATEST: readonly AgentName[] = ["Cursor", "OpenCode"];

/** Fills npx's cache for each spec a connected agent starts, each on its
 *  own: the plugins' pinned version (Claude Code, Codex), and `@latest`
 *  for the entries setup writes, which npx caches apart from it. That
 *  answer is the version they will run, said when it is not this setup's. */
function warmStart(d: SetupDeps, usable: AgentName[]): void {
  const onLatest = usable.filter((a) => ON_LATEST.includes(a));
  const specs = [
    ...(usable.some((a) => !ON_LATEST.includes(a)) ? [d.version] : []),
    ...(onLatest.length > 0 ? ["latest"] : []),
  ];
  const cold: string[] = [];
  for (const spec of specs) {
    const warm = d.run("npx", ["-y", `${PACKAGE_NAME}@${spec}`, "--version"]);
    const answer = warm.stdout.trim();
    const pinned = spec === d.version;
    if (
      failed(warm) ||
      (pinned ? answer !== d.version : !/^\d+\.\d+\.\d+\S*$/.test(answer))
    ) {
      cold.push(
        `${PACKAGE_NAME}@${spec}: ${failed(warm) ? why(warm) : `it answered "${answer}"`}`,
      );
    } else if (!pinned && answer !== d.version) {
      d.say(
        `${listed(onLatest)}: ${onLatest.length > 1 ? "they run" : "it runs"} Demoman ${answer}, the newest release on npm, and this setup is ${d.version}. A version published under npm's next tag alone does not reach ${onLatest.length > 1 ? "them" : onLatest[0]}.`,
      );
    }
  }
  d.say(
    cold.length === 0
      ? "warm start: done"
      : `warm start: skipped (${cold.join("; ")}); the first demo downloads Demoman as the agent starts it, which can take a minute`,
  );
}
