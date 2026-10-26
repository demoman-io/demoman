import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { messageOf } from "./report.js";

export type PlaywrightVersion =
  | { ok: true; version: string }
  | { ok: false; why: string };

/**
 * The version of the Playwright this process launches Chromium with: the
 * same `playwright` the runner's own `import` resolves, read off its
 * package.json.
 */
export function loadedPlaywrightVersion(): PlaywrightVersion {
  try {
    const { version } = createRequire(import.meta.url)(
      "playwright/package.json",
    ) as { version?: unknown };
    if (typeof version !== "string" || version === "") {
      return {
        ok: false,
        why: "playwright/package.json carries no version",
      };
    }
    return { ok: true, version };
  } catch (error) {
    return { ok: false, why: messageOf(error) };
  }
}

/**
 * How to install the Chromium this process's Playwright launches, as a
 * clause that follows "run" or stands as its own sentence.
 *
 * Pinned, never a bare `npx playwright install chromium`: outside this repo
 * that fetches npm's latest Playwright, which installs ITS Chromium revision
 * (measured 2026-10-14: 1.64.0 installs chromium-1248) while the loaded one
 * (1.62.1) looks for chromium-1234. The next call then failed the same way
 * with the same advice (launch prep defect 1). Nor `pnpm exec`, which works
 * only inside this repo.
 *
 * Who reads it (review of d4e0c94b, 2026-10-14): not the published package,
 * which passes `npx demoman@<v> setup` as the executor's `installCommand`
 * and so never shows this. It reaches the repo's own builds and the
 * runner's pipeline CLI. Not `--no-shell` as setup installs it: the
 * pipeline launches headless (`launch.ts`), which is the headless shell.
 */
export function chromiumInstallCommand(
  playwright: PlaywrightVersion = loadedPlaywrightVersion(),
): { ok: true; command: string } | { ok: false; detail: string } {
  if (playwright.ok) {
    return {
      ok: true,
      command: `npx playwright@${playwright.version} install chromium`,
    };
  }
  // No version, no command: an unpinned one is the advice that loops.
  return {
    ok: false,
    detail: `Demoman could not read which Playwright it runs (${playwright.why}), so it cannot name the install command for its Chromium`,
  };
}

/** The CLI of the playwright-core this process's Playwright loads: the one
 *  setup downloads Chromium with and installs its libraries with, so both
 *  are the revision a launch looks for. */
export function playwrightCliPath():
  | { ok: true; cli: string }
  | { ok: false; why: string } {
  try {
    const pw = createRequire(import.meta.url).resolve(
      "playwright/package.json",
    );
    const core = createRequire(pw).resolve("playwright-core/package.json");
    const cli = join(dirname(core), "cli.js");
    if (!existsSync(cli)) {
      return {
        ok: false,
        why: `this install's Playwright has no CLI at ${cli}`,
      };
    }
    return { ok: true, cli };
  } catch (error) {
    return { ok: false, why: messageOf(error) };
  }
}

/**
 * Playwright's `install-deps chromium` (Linux system libraries, as root),
 * run by this node through the CLI of the playwright-core this process
 * loads. Absolute paths: `sudo` resets PATH, and an nvm, fnm or volta `npx`
 * is not on root's. One command, which setup runs as root and a failed
 * launch names.
 */
export function chromiumDepsCommand():
  | { ok: true; command: string; args: string[] }
  | { ok: false; why: string } {
  const found = playwrightCliPath();
  if (!found.ok) return found;
  return {
    ok: true,
    command: process.execPath,
    args: [found.cli, "install-deps", "chromium"],
  };
}
