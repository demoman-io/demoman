#!/usr/bin/env node
// apps/mcp/src/index.ts
//
// `demoman-mcp`: serves MCP on stdio. stdout is the MCP channel, so every
// human-readable line goes to stderr.
//
// It runs scripts in the CLI executor's own browser (spec 2026-10-12): no
// port, no key, no extension. Until 2026-10-20 `--browser extension` served
// the same tools through the Chrome extension instead; the extension was
// archived (tag `archive/extension`) and the flag is refused by name
// (`browser-flag.ts`).
//
// First, before anything that could print: console.log/info/debug to stderr.
import "./stdout-guard.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLocalExecutor, fullChromiumPath } from "@demoman/runner/package";
import { browserFlagRefusal } from "./browser-flag.js";
import { readRecipe } from "./recipe.js";
import { headlessFrom, serveCli } from "./serve-cli.js";
import { SERVER_VERSION } from "./version.js";

const log = (line: string): void => {
  process.stderr.write(`demoman-mcp: ${line}\n`);
};

const parsed = (() => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        // Accepted so a registration written for the extension is refused
        // by name rather than by the parse (`browserFlagRefusal`).
        browser: { type: "string" },
        // The browser is headless unless this asks for its window (author's
        // ruling 2026-10-20).
        headed: { type: "boolean" },
        // Accepted though it is the default (`headlessFrom`).
        headless: { type: "boolean" },
        "out-dir": { type: "string" },
      },
      strict: true,
    });
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
})();
const refusal = browserFlagRefusal(parsed.values.browser);
if (refusal !== null) {
  log(refusal);
  process.exit(2);
}
const browserMode = headlessFrom(parsed.values);
if (!browserMode.ok) {
  log(browserMode.error);
  process.exit(2);
}

let recipe: string;
try {
  recipe = readRecipe();
} catch (error) {
  log(
    `the recipe could not be read (${error instanceof Error ? error.message : String(error)}) — this demoman-mcp is incomplete; rebuild or reinstall it`,
  );
  process.exit(1);
}

await serveCli({
  createLocalExecutor,
  recipe,
  version: SERVER_VERSION,
  headless: browserMode.headless,
  // A development build runs from the repo: the studio pages' own copy.
  wallpapersDir: fileURLToPath(
    new URL("../../studio/pages/public/wallpapers", import.meta.url),
  ),
  // The Chromium the published package launches (apps/cli): headless would
  // otherwise get Playwright's software-drawn shell.
  executablePath: fullChromiumPath(),
  ...(parsed.values["out-dir"] === undefined
    ? {}
    : { outDir: resolve(parsed.values["out-dir"]) }),
  // A development build is not an npm install: no `latest` describes it, so
  // its status says the check is off and why.
  updateCheck: async () => ({
    current: SERVER_VERSION,
    check: "off: a development build of demoman-mcp; npm installs check",
  }),
  log,
});
