// apps/cli/src/configs.ts
//
// The edits setup makes to agents' own config files (launch E spec §1).
// Pure over the file's text, so every refusal is tested. Each edit touches
// only Demoman's own entries, keeps everything else, and refuses — with a
// reason the caller prints beside the block to paste by hand — a file it
// cannot read, rather than overwriting it.
import { basename } from "node:path";
import { ASKS_EACH_TIME, type ToolName } from "@demoman/mcp/annotations";
import { parse } from "smol-toml";
import {
  MARKETPLACE_NAME,
  MARKETPLACE_SOURCE,
  PACKAGE_NAME,
  PLUGIN_ID,
} from "./names.js";

/** The new text, and whether it differs; or why the file was left alone.
 *  A null input text means the file does not exist. */
export type Edit = { text: string; changed: boolean } | { refused: string };

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const CODEX_SERVER = '[plugins."demoman@demoman".mcp_servers.demoman]';
const codexTool = (tool: string): string =>
  `[plugins."demoman@demoman".mcp_servers.demoman.tools.${tool}]`;
/** Each table setup keeps in Codex's config.toml, the key it sets there and
 *  that key's value: the plugin's server approved, then each tool of
 *  ASKS_EACH_TIME set to asking when `asks` holds it, else approved (a
 *  plugin's server table takes `tools.<tool>.approval_mode`, launch E
 *  spec). Codex validates the values, and refuses to start on a bad one
 *  (Task 1 findings; "prompt" checked against codex-cli 0.166). */
const codexTables = (asks: readonly ToolName[]) => [
  {
    header: CODEX_SERVER,
    key: "default_tools_approval_mode",
    value: "approve",
  },
  ...ASKS_EACH_TIME.map((tool) => ({
    header: codexTool(tool),
    key: "approval_mode",
    value: asks.includes(tool) ? "prompt" : "approve",
  })),
];
const codexLine = (t: { key: string; value: string }): string =>
  `${t.key} = "${t.value}"`;
/** What setup writes to Codex's config.toml, as one block to paste. */
export const codexApprovalTable = (asks: readonly ToolName[]): string =>
  codexTables(asks)
    .map((t) => `${t.header}\n${codexLine(t)}`)
    .join("\n\n");
/** The block when every tool of ASKS_EACH_TIME asks. */
export const CODEX_APPROVAL_TABLE = codexApprovalTable(ASKS_EACH_TIME);

type CodexServer = {
  default_tools_approval_mode?: unknown;
  tools?: Record<string, { approval_mode?: unknown }>;
};
const serverIn = (toml: string): CodexServer | undefined =>
  (
    parse(toml) as {
      plugins?: Record<string, { mcp_servers?: Record<string, CodexServer> }>;
    }
  ).plugins?.["demoman@demoman"]?.mcp_servers?.demoman;

/** Whether the parsed file says what codexTables(asks) says. */
function codexSays(toml: string, asks: readonly ToolName[]): boolean {
  const server = serverIn(toml);
  return (
    server?.default_tools_approval_mode === "approve" &&
    ASKS_EACH_TIME.every(
      (tool) =>
        server.tools?.[tool]?.approval_mode ===
        (asks.includes(tool) ? "prompt" : "approve"),
    )
  );
}

/** A line without its trailing comment. Neither form setup looks for holds
 *  a `#` inside a string. */
const bare = (line: string): string => line.replace(/\s*#.*$/, "").trim();

export function codexApproval(
  text: string | null,
  asks: readonly ToolName[] = ASKS_EACH_TIME,
): Edit {
  const src = text ?? "";
  try {
    parse(src);
  } catch (error) {
    return { refused: `it is not TOML Codex can read (${message(error)})` };
  }
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  let out = src;
  for (const t of codexTables(asks)) {
    const lines = out.split(eol);
    const header = lines.findIndex((l) => bare(l) === t.header);
    if (header >= 0) {
      let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
      if (end < 0) end = lines.length;
      const keyAt = new RegExp(`^\\s*${t.key}\\s*=`);
      const key = lines.findIndex(
        (l, i) => i > header && i < end && keyAt.test(l),
      );
      if (key >= 0) lines[key] = codexLine(t);
      else lines.splice(header + 1, 0, codexLine(t));
      out = lines.join(eol);
    } else {
      const table = `${t.header}${eol}${codexLine(t)}${eol}`;
      out =
        out === ""
          ? table
          : `${out}${out.endsWith(eol) ? "" : eol}${eol}${table}`;
    }
  }
  let says: boolean;
  try {
    says = codexSays(out, asks);
  } catch (error) {
    return {
      refused: `it already sets demoman@demoman's plugin table in a form setup cannot extend (${message(error)})`,
    };
  }
  if (!says) {
    return {
      refused:
        "it already sets demoman@demoman's plugin table in a form setup cannot extend",
    };
  }
  return { text: out, changed: out !== text };
}

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const serialise = (v: JsonObject): string => `${JSON.stringify(v, null, 2)}\n`;

function readObject(
  text: string | null,
): { obj: JsonObject } | { refused: string } {
  if (text === null) return { obj: {} };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (error) {
    return { refused: `it is not JSON (${message(error)})` };
  }
  if (!isObject(v)) return { refused: "it is JSON, but not an object" };
  return { obj: v };
}

/** Takes each `drop` rule out of permissions.allow and permissions.ask,
 *  then adds each missing rule to its list: Claude Code's
 *  settings.json and Cursor's cli-config.json share the shape. One list it
 *  cannot read refuses the whole edit, so an allow is never written without
 *  the asks beside it. */
export function addPermissionRules(
  text: string | null,
  rules: { allow: string[]; ask?: string[]; drop?: string[] },
): Edit {
  const read = readObject(text);
  if ("refused" in read) return read;
  const { obj } = read;
  const permissions = obj.permissions ?? {};
  if (!isObject(permissions)) {
    return { refused: "its permissions is not an object" };
  }
  let changed = false;
  for (const [list, add] of [
    ["allow", rules.allow],
    ["ask", rules.ask ?? []],
  ] as const) {
    const had = permissions[list] ?? [];
    if (!Array.isArray(had) || !had.every((r) => typeof r === "string")) {
      return { refused: `its permissions.${list} is not a list of rules` };
    }
    const kept = had.filter((r) => !(rules.drop ?? []).includes(r));
    const missing = add.filter((r) => !kept.includes(r));
    if (missing.length === 0 && kept.length === had.length) continue;
    permissions[list] = [...kept, ...missing];
    changed = true;
  }
  if (!changed && text !== null) return { text, changed: false };
  obj.permissions = permissions;
  return { text: serialise(obj), changed: true };
}

/** github.com's demoman-io/plugins, over https or ssh, and nothing that
 *  only ends in those words (a mirror's path, another host's name). */
const OUR_GIT_URL = new RegExp(
  `^(?:https?://|ssh://)?(?:[\\w.-]+@)?(?:www\\.)?github\\.com[/:]${MARKETPLACE_SOURCE}(?:\\.git)?/?$`,
  "i",
);

/** The demoman-io/plugins repo, however a source names it: `github` with a
 *  repo, or a git URL. Takes a settings entry's `source` and a row of
 *  `claude plugin marketplace list --json` alike: both carry these keys. */
const isOurMarketplaceSource = (s: unknown): boolean => {
  if (!isObject(s)) return false;
  if (s.source === "github" && typeof s.repo === "string") {
    return s.repo.toLowerCase() === MARKETPLACE_SOURCE;
  }
  return typeof s.url === "string" && OUR_GIT_URL.test(s.url);
};

/** Turns on Claude Code's background updates for Demoman's marketplace:
 *  `autoUpdate` on its extraKnownMarketplaces entry, the setting that
 *  outranks /plugin's toggle, since a third-party marketplace starts with
 *  them off (code.claude.com/docs/en/plugins/loading). A false there is the
 *  user's own, and an entry of another source is another marketplace named
 *  demoman (a dev checkout, say): both are left alone, and said. With no
 *  entry, `listed` (the marketplace list's demoman row, when one was there
 *  before setup) must be ours too: a declaration setup wrote over another
 *  source would re-point it at GitHub. */
export function marketplaceAutoUpdate(
  text: string | null,
  listed?: unknown,
): Edit {
  const read = readObject(text);
  if ("refused" in read) return read;
  const { obj } = read;
  const markets = obj.extraKnownMarketplaces ?? {};
  if (!isObject(markets)) {
    return { refused: "its extraKnownMarketplaces is not an object" };
  }
  if (
    markets[MARKETPLACE_NAME] === undefined &&
    listed !== undefined &&
    !isOurMarketplaceSource(listed)
  ) {
    // The row's own name and cache folder say nothing about its source.
    const source = isObject(listed)
      ? Object.fromEntries(
          Object.entries(listed).filter(
            ([k]) => k !== "name" && k !== "installLocation",
          ),
        )
      : listed;
    return {
      refused: `Claude Code's demoman marketplace is another one (${JSON.stringify(source)})`,
    };
  }
  const existing = markets[MARKETPLACE_NAME] ?? {
    source: { source: "github", repo: MARKETPLACE_SOURCE },
  };
  if (!isObject(existing)) {
    return {
      refused: "its extraKnownMarketplaces.demoman entry is not an object",
    };
  }
  if (!isOurMarketplaceSource(existing.source)) {
    return {
      refused: `its extraKnownMarketplaces.demoman entry is another marketplace (${JSON.stringify(existing.source)})`,
    };
  }
  if (existing.autoUpdate === false) {
    return {
      refused:
        "autoUpdate is false on its extraKnownMarketplaces.demoman entry",
    };
  }
  if (existing.autoUpdate === true && text !== null) {
    return { text, changed: false };
  }
  markets[MARKETPLACE_NAME] = { ...existing, autoUpdate: true };
  obj.extraKnownMarketplaces = markets;
  return { text: serialise(obj), changed: true };
}

export interface CursorEntry {
  type: "stdio";
  command: string;
  args: string[];
  env: { PATH: string; DEMOMAN_CLIENT: "cursor" };
}

/** An absolute npx, so a Cursor launched from the Dock with a thin PATH
 *  finds it; that Node's folder on PATH, because npx starts with
 *  `#!/usr/bin/env node`. Running setup again repairs it after that Node is
 *  removed (spec §4). `@latest`, so Cursor updates itself: npx asks npm on
 *  every start, and installs a newer release over the one it cached
 *  (measured 2026-10-19 on npm 10 and 11; Cursor has no plugin updater). */
/** Before the package: npx reads no node_modules or .npmrc of the folder the
 *  agent was started in, a repo that could choose the code run as Demoman
 *  (audit run 1). `~/`, not `~`: started with no shell, npm expands `~/`
 *  and reads a bare `~` as a folder of that name (measured npm 11.3). */
export const NPX_PREFIX = ["--prefix", "~/"];

/** An entry's PATH: the npx it names is a node script, so that node first. */
const entryPath = (nodeBin: string): string =>
  `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`;

export function cursorEntry(nodeBin: string): CursorEntry {
  return {
    type: "stdio",
    command: `${nodeBin}/npx`,
    args: [...NPX_PREFIX, "-y", `${PACKAGE_NAME}@latest`, "mcp"],
    // DEMOMAN_CLIENT tells the server it is Cursor's, so it keeps
    // ~/.cursor/skills/record-demo current (agent-skill.ts).
    env: { PATH: entryPath(nodeBin), DEMOMAN_CLIENT: "cursor" },
  };
}

/** OpenCode's config folder, where opencode.json and skills/ live: under
 *  XDG_CONFIG_HOME when it is set, as OpenCode reads it. */
export const opencodeDir = (
  home: string,
  env: Record<string, string | undefined>,
): string => `${env.XDG_CONFIG_HOME || `${home}/.config`}/opencode`;

/** OpenCode's local server: the command and its arguments in one array. */
export interface OpencodeEntry {
  type: "local";
  command: string[];
  environment: { PATH: string; DEMOMAN_CLIENT: "opencode" };
}
export function opencodeEntry(nodeBin: string): OpencodeEntry {
  return {
    type: "local",
    command: [
      `${nodeBin}/npx`,
      ...NPX_PREFIX,
      "-y",
      `${PACKAGE_NAME}@latest`,
      "mcp",
    ],
    environment: { PATH: entryPath(nodeBin), DEMOMAN_CLIENT: "opencode" },
  };
}

/** setup's own command, of any version, or a paste-in block's:
 *  `demoman@<version> mcp` run through an npx. Every agent's entry is
 *  judged by this, whatever shape it keeps the command in. */
function isOurCommand(command: unknown, args: unknown): boolean {
  return (
    typeof command === "string" &&
    basename(command) === "npx" &&
    Array.isArray(args) &&
    args.filter((a) => typeof a === "string" && /^demoman@\S+$/.test(a))
      .length === 1 &&
    args.at(-1) === "mcp"
  );
}
const isOurCursorEntry = (e: unknown): boolean =>
  isObject(e) && isOurCommand(e.command, e.args);
const isOurOpencodeEntry = (e: unknown): boolean =>
  isObject(e) &&
  Array.isArray(e.command) &&
  isOurCommand(e.command[0], e.command.slice(1));

const describeEntry = (e: unknown): string => {
  if (!isObject(e)) return JSON.stringify(e);
  if (typeof e.url === "string") return e.url;
  if (Array.isArray(e.command)) return e.command.join(" ");
  return [e.command, ...(Array.isArray(e.args) ? e.args : [])]
    .filter((p) => p !== undefined)
    .join(" ");
};

/** Puts entry at mcpServers.demoman in Cursor's mcp.json, over setup's own
 *  older entry. Another server named demoman (a dev registration, say) is
 *  reported, never replaced. */
export function cursorServer(
  text: string | null,
  entry: CursorEntry,
): Edit | { foreign: string } {
  const read = readObject(text);
  if ("refused" in read) return read;
  const { obj } = read;
  const servers = obj.mcpServers ?? {};
  if (!isObject(servers)) return { refused: "its mcpServers is not an object" };
  const existing = servers.demoman;
  if (existing !== undefined && !isOurCursorEntry(existing)) {
    return { foreign: describeEntry(existing) };
  }
  // The user's own additions to setup's entry (a secret in env, say) stay;
  // setup's fields win where both say something.
  const next = isObject(existing)
    ? {
        ...existing,
        ...entry,
        env: { ...(isObject(existing.env) ? existing.env : {}), ...entry.env },
      }
    : entry;
  if (text !== null && JSON.stringify(existing) === JSON.stringify(next)) {
    return { text, changed: false };
  }
  servers.demoman = next;
  obj.mcpServers = servers;
  return { text: serialise(obj), changed: true };
}

/**
 * Puts entry at mcp.servers.demoman in OpenCode's opencode.json. OpenCode
 * 2.x still reads its older flat form (mcp.demoman), and runs mcp.servers'
 * when both name demoman, so setup's own flat entry is moved, not left
 * shadowed. Another server named demoman, in either form, is reported,
 * never replaced: writing beside it would shadow it.
 */
export function opencodeServer(
  text: string | null,
  entry: OpencodeEntry,
): Edit | { foreign: string } {
  const read = readObject(text);
  if ("refused" in read) return read;
  const { obj } = read;
  const mcp = obj.mcp ?? {};
  if (!isObject(mcp)) return { refused: "its mcp is not an object" };
  const servers = mcp.servers ?? {};
  if (!isObject(servers)) {
    return { refused: "its mcp.servers is not an object" };
  }
  for (const found of [servers.demoman, mcp.demoman]) {
    if (found !== undefined && !isOurOpencodeEntry(found)) {
      return { foreign: describeEntry(found) };
    }
  }
  const existing = servers.demoman;
  const next = isObject(existing)
    ? {
        ...existing,
        ...entry,
        environment: {
          ...(isObject(existing.environment) ? existing.environment : {}),
          ...entry.environment,
        },
      }
    : entry;
  if (
    text !== null &&
    mcp.demoman === undefined &&
    JSON.stringify(existing) === JSON.stringify(next)
  ) {
    return { text, changed: false };
  }
  delete mcp.demoman;
  servers.demoman = next;
  mcp.servers = servers;
  obj.mcp = mcp;
  return { text: serialise(obj), changed: true };
}

/** A record-demo skill that is Demoman's (any version), so setup may
 *  replace it; any other skill of that name is the user's. */
export function isOurSkill(text: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (m === null) return false;
  const [, front = "", body = ""] = m;
  return /^name:\s*record-demo\s*$/m.test(front) && body.includes("Demoman");
}

/** Whether an agent's own file says Demoman is connected there; why not
 *  known when the file cannot be read. An absent file says no. */
export type Connected = boolean | { unreadable: string };

function fromJson(
  text: string | null,
  says: (obj: JsonObject) => boolean,
): Connected {
  const read = readObject(text);
  return "refused" in read ? { unreadable: read.refused } : says(read.obj);
}

/** Claude Code lists an installed plugin under enabledPlugins, true or
 *  false: a disabled plugin is still connected, and setup says so. */
export const claudeConnected = (text: string | null): Connected =>
  fromJson(
    text,
    (o) => isObject(o.enabledPlugins) && PLUGIN_ID in o.enabledPlugins,
  );

/** Codex writes the installed plugin's own table with `enabled`. Setup's
 *  approval tables sit under that table too, so the key alone would count a
 *  plugin removed since as connected. */
export function codexConnected(text: string | null): Connected {
  try {
    const toml = parse(text ?? "") as {
      plugins?: Record<string, { enabled?: unknown }>;
    };
    return toml.plugins?.[PLUGIN_ID]?.enabled !== undefined;
  } catch (error) {
    return { unreadable: `it is not TOML Codex can read (${message(error)})` };
  }
}

export const cursorConnected = (text: string | null): Connected =>
  fromJson(
    text,
    (o) => isObject(o.mcpServers) && isOurCursorEntry(o.mcpServers.demoman),
  );

/** Either of OpenCode's forms (see opencodeServer). */
export const opencodeConnected = (text: string | null): Connected =>
  fromJson(
    text,
    (o) =>
      isObject(o.mcp) &&
      (isOurOpencodeEntry(o.mcp.demoman) ||
        (isObject(o.mcp.servers) && isOurOpencodeEntry(o.mcp.servers.demoman))),
  );

/** Setup's rule that makes OpenCode ask before one Demoman tool. OpenCode
 *  names an MCP tool `<server>_<tool>` (opencode.ai/docs/mcp-servers). */
export const opencodeAskRule = (tool: string) => ({
  action: `demoman_${tool}`,
  resource: "*",
  effect: "ask",
});

/**
 * OpenCode 2's `permissions`: an ordered list where the last matching rule
 * wins, read after each agent's built-in allow-everything rule (opencode
 * 2.0.32's `debug agents` lists setup's rules after it). Each tool of
 * `asks` gets setup's ask rule, appended; setup's own rule for a tool of
 * ASKS_EACH_TIME that no longer asks is removed, and nothing else is
 * touched. A rule of the person's own placed after these still wins.
 */
export function opencodeAsks(
  text: string | null,
  asks: readonly ToolName[],
): Edit {
  const read = readObject(text);
  if ("refused" in read) return read;
  const { obj } = read;
  if (obj.permission !== undefined) {
    return {
      refused:
        "it sets OpenCode's older \"permission\" form, and how OpenCode reads setup's rules beside it is untested",
    };
  }
  const had = obj.permissions ?? [];
  if (!Array.isArray(had)) return { refused: "its permissions is not a list" };
  const ours = (r: unknown, tool: string): boolean =>
    isObject(r) && JSON.stringify(r) === JSON.stringify(opencodeAskRule(tool));
  const kept = had.filter(
    (r) => !ASKS_EACH_TIME.some((t) => !asks.includes(t) && ours(r, t)),
  );
  const missing = asks
    .filter((t) => !kept.some((r) => ours(r, t)))
    .map(opencodeAskRule);
  if (missing.length === 0 && kept.length === had.length && text !== null) {
    return { text, changed: false };
  }
  obj.permissions = [...kept, ...missing];
  return { text: serialise(obj), changed: true };
}

/** One Demoman tool in Cursor's agent CLI permission syntax
 *  (cursor.com/docs/cli/reference/permissions). */
export const cursorRule = (tool: string): string => `Mcp(demoman:${tool})`;
