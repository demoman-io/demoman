// apps/mcp/src/annotations.ts
//
// The MCP hints each tool carries (launch E spec §2). Clients decide
// approval from them: Codex's default mode prompts for any tool that does
// not declare itself read-only or closed-world and non-destructive, since an
// unset hint counts as true. Each claim here is checked against what the
// tool does: export picks a free file name (run-core's save.ts uniquifies),
// and derive reads a take without writing anything.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type ToolName =
  | "recipe"
  | "status"
  | "takes"
  | "derive"
  | "report"
  | "snapshot"
  | "run"
  | "export"
  | "attach"
  | "studio";

const READ_ONLY: ToolAnnotations = { readOnlyHint: true };
/** Opens real pages and reads them. */
const OPENS_PAGES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

export const TOOL_ANNOTATIONS: {
  readonly [name in ToolName]: ToolAnnotations;
} = {
  recipe: READ_ONLY,
  status: READ_ONLY,
  takes: READ_ONLY,
  derive: READ_ONLY,
  report: READ_ONLY,
  snapshot: OPENS_PAGES,
  /** Clicks and types in the app, which may be signed in to a real
   *  account: a script can press Delete. */
  run: { ...OPENS_PAGES, destructiveHint: true },
  /** Writes a new file under a free name; never overwrites one. */
  export: { readOnlyHint: false, destructiveHint: false },
  /** Posts a video to a pull request under the user's GitHub account,
   *  which cannot be taken back from here. */
  attach: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  /** Opens the studio's window. */
  studio: { readOnlyHint: false, destructiveHint: false },
};
