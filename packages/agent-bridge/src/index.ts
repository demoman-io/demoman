// packages/agent-bridge/src/index.ts
//
// What `demoman-mcp` (apps/mcp) and the runner's executor (apps/runner)
// share about a call: its op, its outcome, the agent that made it, and how
// long a tool waits for it. Until 2026-10-20 this was also the wire format
// between demoman-mcp and the Chrome extension's service worker (spec
// 2026-10-01-agent-bridge §2); that half was archived with the extension
// (tag `archive/extension`). Loaded from `dist` under raw node by apps/mcp:
// any relative import added here needs `.js`.

/** Every op an executor answers. */
export const OPS = [
  "status",
  "snapshot",
  "run",
  "report",
  "takes",
  "derive",
  "export",
  "attach",
] as const;
export type Op = (typeof OPS)[number];

/** Below the tightest client timeout Demoman claims: Cursor's `agent` CLI
 *  cuts tools/call at a hardcoded 60 s, ignores progress and has no setting
 *  (Cursor staff, 2026-10-02; launch E). Also below the MCP SDK client's
 *  60 s default. apps/mcp's tools.test pins it at 55 s or less. */
export const RUN_TOOL_CAP_MS = 50_000;

/** Who the agent says it is: the MCP client's own `clientInfo` (spec §5.4,
 *  amended 2026-10-03). Claude Code sends
 *  `{name: "claude-code", title: "Claude Code"}`. It rides in a request's
 *  `args` as `agent`, beside `callId`, so neither protocol changes: an older
 *  extension ignores it, and an older server's request simply has none.
 *  Self-reported, so it is a label for a person to read, never a credential;
 *  the code is still what they check. */
export interface AgentName {
  name: string;
  title?: string;
}
export const AGENT_ARG = "agent";
/** Longer than any client name seen, short enough that a squatter cannot
 *  write a paragraph into the prompt's heading. */
export const AGENT_NAME_MAX = 64;

/** What a person cannot see, or what reorders what they see: control
 *  characters, format characters (bidi overrides and isolates, zero-width
 *  spaces and joiners, the BOM) and line or paragraph separators. A name
 *  carrying them can read as a different name on the prompt, so they go
 *  before it is stored or shown. Homoglyphs (a Cyrillic "С" in "Сlaude")
 *  are not caught here; the code is the check for those. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** `text` as the prompt may show it: runs of whitespace made one space,
 *  everything UNSEEN removed, trimmed. Applied where a name is read
 *  (`agentOf`) and again where one is shown, for an entry stored before. */
export function cleanAgentText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(UNSEEN, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** The field cleaned, or null when nothing visible is left or it was over
 *  the cap to begin with. */
const agentField = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > AGENT_NAME_MAX) return null;
  const clean = cleanAgentText(v);
  return clean === "" ? null : clean;
};

/** `absent` when the request carries no `agent` (an older demoman-mcp);
 *  `malformed`, with why, when it carries one this side cannot show. */
export function agentOf(
  args: Record<string, unknown>,
):
  | { ok: true; agent: AgentName }
  | { ok: false; absent: true }
  | { ok: false; absent: false; why: string } {
  const value = args[AGENT_ARG];
  if (value === undefined) return { ok: false, absent: true };
  const v = value as { name?: unknown; title?: unknown } | null;
  const name = typeof v === "object" && v !== null ? agentField(v.name) : null;
  if (name === null) {
    return {
      ok: false,
      absent: false,
      why: `args.${AGENT_ARG}.name is not a string of at most ${AGENT_NAME_MAX} characters with one visible (${JSON.stringify(value)?.slice(0, 80)})`,
    };
  }
  const rawTitle = (v as { title?: unknown }).title;
  if (rawTitle === undefined) return { ok: true, agent: { name } };
  const title = agentField(rawTitle);
  if (title === null) {
    return {
      ok: false,
      absent: false,
      why: `args.${AGENT_ARG}.title is not a string of at most ${AGENT_NAME_MAX} characters with one visible (${JSON.stringify(rawTitle)?.slice(0, 80)})`,
    };
  }
  return { ok: true, agent: { name, title } };
}

/** An answer's outcome without its envelope: what a handler returns before
 *  the request id is attached. */
export type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; detail: string };

export function failure(reason: string, detail: string): Outcome {
  return { ok: false, reason, detail };
}
