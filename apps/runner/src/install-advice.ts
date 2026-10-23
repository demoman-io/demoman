import { createRequire } from "node:module";
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
