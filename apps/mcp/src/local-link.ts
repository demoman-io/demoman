// apps/mcp/src/local-link.ts
import type { Op, Outcome } from "@demoman/agent-bridge";
import type { LocalExecutor } from "@demoman/runner/package";

/** What the tools hold: the executor's one call, and the browser it has
 *  launched. (Until 2026-10-20 the extension's socket, through the port
 *  hub's line, was the other kind.) */
export interface Link {
  request(
    op: Op,
    args: Record<string, unknown>,
    onProgress?: (value: unknown) => void,
  ): Promise<Outcome>;
  /** The browser this server runs scripts in, or null before its first
   *  launch: "nothing to name yet", which `status` passes on as
   *  `browser: null`, never a placeholder name. */
  connected(): { browser: string } | null;
}

/** The slice of `@demoman/runner`'s `LocalExecutor` this server reads. */
export type ExecutorLike = Pick<LocalExecutor, "request" | "browser" | "close">;

/** The CLI executor as the tools' `Link`: no socket, no hub, no queue; one
 *  demoman-mcp owns its own browser. */
export function localLink(executor: ExecutorLike): Link {
  return {
    request: (op, args, onProgress) => executor.request(op, args, onProgress),
    connected: () => {
      const version = executor.browser();
      return version === null
        ? null
        : { browser: `Chromium ${version} (demoman-mcp's own)` };
    },
  };
}
