// apps/mcp/src/browser-flag.ts
//
// `--browser` after the extension was archived (2026-10-20, tag
// `archive/extension`): this server's scripts run in its own browser only.
// Both doors read it — `demoman-mcp` and the published `demoman mcp` — so an
// MCP registration written for the extension (`--browser extension`) is
// told what changed in the same words from either, rather than starting
// something it did not ask for or failing a parse with Node's
// "Unknown option".

export const RETIRED_EXTENSION =
  "--browser extension was retired: Demoman's Chrome extension is archived, and demoman-mcp runs scripts in its own browser only. Remove --browser from this server's registration.";

/** Null when `value` (the flag, if passed) is this server's one executor;
 *  else the sentence to refuse it with. */
export function browserFlagRefusal(value: string | undefined): string | null {
  if (value === undefined || value === "cli") return null;
  if (value === "extension") return RETIRED_EXTENSION;
  return `--browser takes only "cli" (the default), not "${value}"`;
}
