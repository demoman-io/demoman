// apps/cli/src/configs.ts
//
// The edits setup makes to agents' own config files (launch E spec §1).
// Pure over the file's text, so every refusal is tested. Each edit touches
// only Demoman's own entries, keeps everything else, and refuses — with a
// reason the caller prints beside the block to paste by hand — a file it
// cannot read, rather than overwriting it.
import { basename } from "node:path";
import { parse } from "smol-toml";
import { MARKETPLACE_NAME, MARKETPLACE_SOURCE, PACKAGE_NAME } from "./names.js";

/** The new text, and whether it differs; or why the file was left alone.
 *  A null input text means the file does not exist. */
export type Edit = { text: string; changed: boolean } | { refused: string };

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const CODEX_HEADER = '[plugins."demoman@demoman".mcp_servers.demoman]';
const CODEX_KEY = 'default_tools_approval_mode = "approve"';
/** Pre-approves the plugin's server in Codex's config.toml (Task 1
 *  findings: Codex validates the value, and refuses to start on a bad one). */
export const CODEX_APPROVAL_TABLE = `${CODEX_HEADER}\n${CODEX_KEY}`;

const approvalIn = (toml: string): unknown =>
  (
    parse(toml) as {
      plugins?: Record<
        string,
        { mcp_servers?: Record<string, Record<string, unknown>> }
      >;
    }
  ).plugins?.["demoman@demoman"]?.mcp_servers?.demoman
    ?.default_tools_approval_mode;

/** A line without its trailing comment. Neither form setup looks for holds
 *  a `#` inside a string. */
const bare = (line: string): string => line.replace(/\s*#.*$/, "").trim();

export function codexApproval(text: string | null): Edit {
  const src = text ?? "";
  try {
    parse(src);
  } catch (error) {
    return { refused: `it is not TOML Codex can read (${message(error)})` };
  }
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(eol);
  const header = lines.findIndex((l) => bare(l) === CODEX_HEADER);
  let out: string;
  if (header >= 0) {
    let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    const key = lines.findIndex(
      (l, i) =>
        i > header && i < end && /^\s*default_tools_approval_mode\s*=/.test(l),
    );
    if (key >= 0) lines[key] = CODEX_KEY;
    else lines.splice(header + 1, 0, CODEX_KEY);
    out = lines.join(eol);
  } else {
    const table = `${CODEX_APPROVAL_TABLE.replaceAll("\n", eol)}${eol}`;
    if (src === "") out = table;
    else out = `${src}${src.endsWith(eol) ? "" : eol}${eol}${table}`;
  }
  let value: unknown;
  try {
    value = approvalIn(out);
  } catch (error) {
    return {
      refused: `it already sets demoman@demoman's plugin table in a form setup cannot extend (${message(error)})`,
    };
  }
  if (value !== "approve") {
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

/** Adds each missing rule to permissions.allow: Claude Code's settings.json
 *  and Cursor's cli-config.json share the shape. */
export function addAllowRules(text: string | null, rules: string[]): Edit {
  const read = readObject(text);
  if ("refused" in read) return read;
  const { obj } = read;
  const permissions = obj.permissions ?? {};
  if (!isObject(permissions)) {
    return { refused: "its permissions is not an object" };
  }
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow) || !allow.every((r) => typeof r === "string")) {
    return { refused: "its permissions.allow is not a list of rules" };
  }
  const missing = rules.filter((r) => !allow.includes(r));
  if (missing.length === 0 && text !== null) {
    return { text, changed: false };
  }
  permissions.allow = [...allow, ...missing];
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
export function cursorEntry(nodeBin: string): CursorEntry {
  return {
    type: "stdio",
    command: `${nodeBin}/npx`,
    args: ["-y", `${PACKAGE_NAME}@latest`, "mcp"],
    // DEMOMAN_CLIENT tells the server it is Cursor's, so it keeps
    // ~/.cursor/skills/record-demo current (cursor-skill.ts).
    env: {
      PATH: `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      DEMOMAN_CLIENT: "cursor",
    },
  };
}

/** setup's own entry, of any version, or the README's paste-in block:
 *  `demoman@<version> mcp` run through an npx. */
function isOurCursorEntry(e: unknown): boolean {
  if (!isObject(e) || typeof e.command !== "string") return false;
  const args = e.args;
  return (
    basename(e.command) === "npx" &&
    Array.isArray(args) &&
    args.filter((a) => typeof a === "string" && /^demoman@\S+$/.test(a))
      .length === 1 &&
    args.at(-1) === "mcp"
  );
}

const describeEntry = (e: unknown): string => {
  if (!isObject(e)) return JSON.stringify(e);
  if (typeof e.url === "string") return e.url;
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

/** A record-demo skill that is Demoman's (any version), so setup may
 *  replace it; any other skill of that name is the user's. */
export function isOurSkill(text: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (m === null) return false;
  const [, front = "", body = ""] = m;
  return /^name:\s*record-demo\s*$/m.test(front) && body.includes("Demoman");
}
