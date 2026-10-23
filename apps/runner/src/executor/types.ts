import type { Op, Outcome } from "@demoman/agent-bridge";
import type { RenderTarget } from "@demoman/compositor";
import type { Page } from "playwright";
import type { launch } from "../launch.js";
import type { WorkWindow } from "./browser.js";
import type { GhRun } from "./gh.js";

export interface ExecutorOptions {
  /** `demomanHome()`: takes under `<home>/takes`, kits at `<home>/kits.json`. */
  home: string;
  /** Whether the browser has no window. The published package and
   *  `demoman-mcp` run headless unless started with `--headed` (author's
   *  ruling 2026-10-20: a window in front of the developer is in the way). */
  headless: boolean;
  /** Headless only: launch on the display a visible window would have used
   *  (`readDisplay`: `DEMOMAN_DISPLAY` from `env`, else macOS), so motion
   *  films at its scale and `screen` is its size. The MCP server turns it on
   *  for every headless server, its bin tests included — they pin
   *  `DEMOMAN_DISPLAY` so a Mac and CI see one display. The runner's own
   *  lanes leave it off and measure the fixed headless viewport. */
  standInDisplay?: boolean;
  /** Tests point this at a missing file to reach `browserMissing`. */
  executablePath?: string;
  /** The one command that installs this build's Chromium, named by
   *  `browserMissing`. The published package passes `npx demoman@<v> setup`;
   *  absent, the runner's own advice. */
  installCommand?: string;
  /** The command `signedOut` names, followed by the start URL. The
   *  published package passes `npx demoman@<v> signin`; absent,
   *  `DEFAULT_SIGNIN_COMMAND`. */
  signinCommand?: string;
  /** Named when a take was written by a newer Demoman; absent, no fix is
   *  named. */
  updateCommand?: string;
  /** Where `.demoman/accounts.json` is looked for when a call names no
   *  `project`: the MCP server's working directory. Default `process.cwd()`. */
  projectDir?: string;
  /** Where `DEMOMAN_SECRET_*` are read: `process.env` in production. */
  env?: NodeJS.ProcessEnv;
  /** One line to stderr. Never stdout: stdout belongs to MCP. */
  log: (line: string) => void;
  /** Tests only: stands in for the browser launch, so a test can hold it
   *  pending. Production never sets it. */
  launchFn?: typeof launch;
  /** Tests and the window probe only; production uses DEFAULT_WORK_WINDOW. */
  workWindow?: WorkWindow;
  /** Where exports are saved; `~/Downloads` when absent, as the extension's. */
  outDir?: string;
  /** Tests only. */
  onWorkPage?: (page: Page) => void;
  /** Tests only: the widest MP4 tier an export may use, so a lane can
   *  render landscape in software at 1080p where the keyframes back 4K.
   *  Production never sets it; the keyframes decide. */
  mp4MaxTier?: RenderTarget;
  /** Tests only: how `attach` runs gh. Production uses `defaultGhRun`, with
   *  `env`. */
  ghRun?: GhRun;
  /** Tests only: a shorter `GH_CHECK_TIMEOUT_MS`. */
  ghCheckTimeoutMs?: number;
}

export interface LocalExecutor {
  request(
    op: Op,
    args: Record<string, unknown>,
    onProgress?: (value: unknown) => void,
  ): Promise<Outcome>;
  /** The browser's own version string once launched, else null. */
  browser(): string | null;
  close(): Promise<void>;
}
