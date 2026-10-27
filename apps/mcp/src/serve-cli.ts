// apps/mcp/src/serve-cli.ts
//
// demoman-mcp's server as a function, so the published `demoman` package
// (apps/cli) serves exactly what `demoman-mcp` serves.

import {
  type ExecutorOptions,
  visibleWindowRefusal,
} from "@demoman/runner/package";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { demomanHome } from "./home.js";
import { INSTRUCTIONS_CLI } from "./instructions.js";
import { type ExecutorLike, localLink } from "./local-link.js";
import { createSessionLinks } from "./session-links.js";
import { registerTools, type StudioToolAnswer } from "./tools.js";
import type { UpdateAnswer } from "./update-check.js";

export { browserFlagRefusal, RETIRED_EXTENSION } from "./browser-flag.js";
export { demomanHome };

/**
 * Whether the CLI's browser runs headless, from `--headed` / `--headless`:
 * headless unless `--headed` asks for the window (author's ruling 2026-10-20:
 * the window sat in front of the developer while their agent filmed).
 * `--headless` is the default and still accepted, since setups written when
 * it was an opt-in pass it. Both entry points (`demoman mcp`, `demoman-mcp`)
 * decide here, so the published package and the repo's server cannot drift.
 */
export function headlessFrom(
  flags: { headed?: boolean; headless?: boolean },
  host: { platform: string; env: NodeJS.ProcessEnv } = process,
): { ok: true; headless: boolean } | { ok: false; error: string } {
  if (flags.headed === true && flags.headless === true) {
    return {
      ok: false,
      error: "--headed and --headless ask for opposite things; pass one",
    };
  }
  const noWindow = visibleWindowRefusal(host.platform, host.env);
  if (flags.headed === true && noWindow !== null) {
    return {
      ok: false,
      error: `--headed: ${noWindow}; leave it off to film headless`,
    };
  }
  return { ok: true, headless: flags.headed !== true };
}

export interface ServeCliOptions {
  createLocalExecutor: (o: ExecutorOptions) => ExecutorLike;
  recipe: string;
  version: string;
  headless: boolean;
  /** The browser to launch; absent, Playwright's own choice for the mode. */
  executablePath?: string;
  outDir?: string;
  installCommand?: string;
  signinCommand?: string;
  updateCommand?: string;
  updateCheck: () => Promise<UpdateAnswer>;
  /** The `studio` tool's door (launch D2): the bin supplies it, so this
   *  package does not depend on the studio. */
  studio?: (args: { takeId?: string }) => Promise<StudioToolAnswer>;
  log: (line: string) => void;
}

export async function serveCli(o: ServeCliOptions): Promise<void> {
  const executor = o.createLocalExecutor({
    home: demomanHome(),
    headless: o.headless,
    // A headless run films as a visible window on this display would.
    ...(o.headless ? { standInDisplay: true } : {}),
    ...(o.executablePath === undefined
      ? {}
      : { executablePath: o.executablePath }),
    ...(o.outDir === undefined ? {} : { outDir: o.outDir }),
    ...(o.installCommand === undefined
      ? {}
      : { installCommand: o.installCommand }),
    ...(o.signinCommand === undefined
      ? {}
      : { signinCommand: o.signinCommand }),
    ...(o.updateCommand === undefined
      ? {}
      : { updateCommand: o.updateCommand }),
    log: o.log,
  });
  const server = new McpServer(
    { name: "demoman", title: "Demoman", version: o.version },
    { instructions: INSTRUCTIONS_CLI },
  );
  const links = createSessionLinks({
    ...(o.studio === undefined ? {} : { studio: o.studio }),
    log: o.log,
  });
  registerTools(server, localLink(executor), {
    recipe: o.recipe,
    version: o.version,
    updateCheck: o.updateCheck,
    ...(o.studio === undefined ? {} : { studio: o.studio }),
    links: links.linksFor,
  });
  await server.connect(new StdioServerTransport());

  // Same form as the extension path's handler in index.ts: both events, once.
  let stdinClosed = false;
  const handleStdinClose = async () => {
    if (stdinClosed) return;
    stdinClosed = true;
    o.log("the MCP host closed stdin; closing the browser and exiting");
    try {
      await executor.close();
    } catch (error) {
      o.log(
        `the browser did not close cleanly — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exit(0);
  };
  process.stdin.on("end", handleStdinClose);
  process.stdin.on("close", handleStdinClose);
}
