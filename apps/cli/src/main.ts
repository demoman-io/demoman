// apps/cli/src/main.ts
//
// The `demoman` bin of the published package (launch B): `demoman mcp`
// serves the CLI executor on stdio; `demoman setup` installs Chromium and
// the Claude Code plugin; `demoman --version`. Bundled by
// scripts/build.mjs into pkg/dist/demoman.mjs, beside page/ and recipe.md.
//
// First, before anything that could print: console.log/info/debug to stderr.
import "@demoman/mcp/stdout-guard";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  browserFlagRefusal,
  demomanHome,
  headlessFrom,
  serveCli,
} from "@demoman/mcp/serve-cli";
import { createUpdateCheck } from "@demoman/mcp/update-check";
import {
  createLocalExecutor,
  fullChromiumPath,
  PAGE_ENTRIES,
  signin,
  signinAccount,
  usePrebuiltPages,
} from "@demoman/runner/package";
import { openStudio, runServe, stopStudio } from "@demoman/studio";
import { refreshCursorSkill } from "./cursor-skill.js";
import { PACKAGE_NAME } from "./names.js";
import { setup } from "./setup.js";
import {
  readSkill,
  readTextFile,
  realSetupDeps,
  writeTextFile,
} from "./setup-deps.js";
import { parseStudioArgs } from "./studio-args.js";
import { VERSION } from "./version.js";

const log = (line: string): void => {
  process.stderr.write(`demoman: ${line}\n`);
};
const REINSTALL = `reinstall with \`npx ${PACKAGE_NAME}@${VERSION} setup\``;
/** Every in-page bundle must be in `pages`: say which are missing and exit
 *  1, else point the runner at them (no esbuild in an install). */
function requirePageBundles(pages: string, say: (line: string) => void): void {
  const missing = PAGE_ENTRIES.filter(
    (n) => !existsSync(join(pages, `${n}.js`)),
  );
  if (missing.length > 0) {
    say(
      `this install is missing ${missing.map((n) => join(pages, `${n}.js`)).join(", ")} — ${REINSTALL}`,
    );
    process.exit(1);
  }
  usePrebuiltPages(pages);
}
const USAGE = `demoman ${VERSION}

  npx demoman setup          install the browser and connect your coding agents
  npx demoman signin <url>   sign in to your app once, so agents can record behind the login
  npx demoman signin --account <name> [--site <origin>] [--project <dir>]
                             sign in as a demo account from .demoman/accounts.json (CI, or a check)
  npx demoman studio [take]  open the studio, to look over and edit takes and export them
  npx demoman studio --stop  close the studio
  demoman mcp [--headed]     serve Demoman's tools on stdio (your agent runs this);
                             --headed shows the browser while it records
  demoman --version
`;

async function mcp(args: string[]): Promise<void> {
  let values: {
    browser?: string;
    headed?: boolean;
    headless?: boolean;
    "out-dir"?: string;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        // Accepted so a registration written for the archived extension
        // (`--browser extension`) is refused by name, as demoman-mcp does,
        // rather than by Node's "Unknown option".
        browser: { type: "string" },
        headed: { type: "boolean" },
        // Accepted though it is the default (`headlessFrom`).
        headless: { type: "boolean" },
        "out-dir": { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const refusal = browserFlagRefusal(values.browser);
  if (refusal !== null) {
    log(refusal);
    process.exit(2);
  }
  const mode = headlessFrom(values);
  if (!mode.ok) {
    log(mode.error);
    process.exit(2);
  }
  const here = fileURLToPath(new URL(".", import.meta.url));
  // Refuse at start, naming the file: a missing page bundle would otherwise
  // answer windowDidNotOpen on every call.
  const pages = join(here, "page");
  requirePageBundles(pages, (line) => log(line));
  let recipe: string;
  try {
    recipe = readFileSync(join(here, "recipe.md"), "utf8");
    if (recipe.trim() === "") {
      throw new Error(`${join(here, "recipe.md")} is empty`);
    }
  } catch (error) {
    log(
      `the recipe could not be read (${error instanceof Error ? error.message : String(error)}) — ${REINSTALL}`,
    );
    process.exit(1);
  }
  const skill = refreshCursorSkill({
    env: process.env,
    home: homedir(),
    skill: readSkill(here),
    readText: readTextFile,
    writeText: writeTextFile,
  });
  if (skill !== null) log(skill);
  await serveCli({
    createLocalExecutor,
    recipe,
    version: VERSION,
    headless: mode.headless,
    // Setup installs the full Chromium only (`--no-shell`); headless, with
    // no executable named, Playwright looks for the headless shell instead,
    // and every call would answer browserMissing while status said the
    // browser was installed. Name the one setup installs, in either mode —
    // the runner's own answer, which `demoman-mcp` names too.
    executablePath: fullChromiumPath(),
    ...(values["out-dir"] === undefined
      ? {}
      : { outDir: resolve(values["out-dir"]) }),
    installCommand: `npx ${PACKAGE_NAME}@${VERSION} setup`,
    signinCommand: `npx ${PACKAGE_NAME}@${VERSION} signin`,
    updateCommand: `npx ${PACKAGE_NAME}@latest setup`,
    updateCheck: createUpdateCheck({
      name: PACKAGE_NAME,
      current: VERSION,
      home: demomanHome(),
      log,
    }),
    studio: (a) => openStudio({ home: demomanHome(), ...a, ...STUDIO_SPAWN }),
    log,
  });
}

/** The version and the bin re-invoked as `studio --serve`, which is what
 *  `openStudio` detaches. */
const STUDIO_SPAWN = {
  version: VERSION,
  serve: {
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), "studio", "--serve"],
  },
};

async function studio(args: string[]): Promise<void> {
  const parsed = parseStudioArgs(args);
  if (parsed.kind === "error") {
    process.stderr.write(`demoman: ${parsed.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const home = demomanHome();
  if (parsed.kind === "stop") {
    const { stopped, cutShort, why } = await stopStudio({ home });
    if (!stopped && why !== undefined) {
      // Could not tell is not "nothing running": say what was found.
      process.stderr.write(`demoman: the studio was not stopped: ${why}\n`);
      process.exit(1);
    }
    process.stdout.write(
      stopped
        ? `Stopped the studio.${cutShort > 0 ? " An export was cut short." : ""}\n`
        : "No studio is running.\n",
    );
    process.exit(0);
  }
  if (parsed.kind === "open") {
    const answer = await openStudio({
      home,
      ...(parsed.takeId === undefined ? {} : { takeId: parsed.takeId }),
      ...STUDIO_SPAWN,
    });
    if ("outcome" in answer) {
      // The link works once, for about a minute: say so rather than imply
      // it can be bookmarked.
      process.stdout.write(
        `${answer.note === undefined ? "" : `${answer.note}\n`}Opened the studio. This link works once, for a minute: ${answer.url}\n`,
      );
      process.exit(0);
    }
    process.stderr.write(`demoman: ${answer.detail}\n`);
    process.exit(1);
  }
  // --serve: the detached process openStudio started. Its stderr is
  // ~/.demoman/studio.log.
  const here = fileURLToPath(new URL(".", import.meta.url));
  requirePageBundles(join(here, "page"), (line) => log(line));
  const pagesDir = join(here, "studio");
  if (!existsSync(join(pagesDir, "library.html"))) {
    log(
      `this install is missing ${join(pagesDir, "library.html")} — ${REINSTALL}`,
    );
    process.exit(1);
  }
  await runServe({
    home,
    outDir: join(homedir(), "Downloads"),
    pagesDir,
    version: VERSION,
    executablePath: fullChromiumPath(),
    log,
  });
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "mcp":
    await mcp(rest);
    break;
  case "studio":
    await studio(rest);
    break;
  case "setup": {
    let deps: ReturnType<typeof realSetupDeps>;
    try {
      deps = realSetupDeps(
        VERSION,
        fileURLToPath(new URL(".", import.meta.url)),
      );
    } catch (error) {
      process.stdout.write(
        `Demoman setup stopped: ${error instanceof Error ? error.message : String(error)} — ${REINSTALL}.\n`,
      );
      process.exit(1);
    }
    process.exit(setup(deps));
    break;
  }
  case "signin": {
    // `--account seller` or `--account=seller`, as parseArgs takes both.
    if (rest.some((a) => a === "--account" || a.startsWith("--account="))) {
      let values: { account?: string; site?: string; project?: string };
      let positionals: string[];
      try {
        ({ values, positionals } = parseArgs({
          args: rest,
          options: {
            account: { type: "string" },
            site: { type: "string" },
            project: { type: "string" },
          },
          allowPositionals: true,
          strict: true,
        }));
      } catch (error) {
        process.stderr.write(
          `demoman: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
        );
        process.exit(2);
      }
      if (
        values.account === undefined ||
        values.account === "" ||
        positionals.length > 0
      ) {
        process.stderr.write(
          `demoman: signin --account takes one account name\n\n${USAGE}`,
        );
        process.exit(2);
      }
      // The account's sign-in steps run through the replay, which needs the
      // page bundles; the install ships them prebuilt, never esbuild.
      requirePageBundles(
        join(fileURLToPath(new URL(".", import.meta.url)), "page"),
        (line) => process.stderr.write(`demoman signin: ${line}\n`),
      );
      const code = await signinAccount(values.account, {
        home: demomanHome(),
        projectDir: resolve(values.project ?? process.cwd()),
        ...(values.site === undefined ? {} : { site: values.site }),
        env: process.env,
        out: (line) => process.stdout.write(`${line}\n`),
        executablePath: fullChromiumPath(),
        installCommand: `npx ${PACKAGE_NAME}@${VERSION} setup`,
      });
      process.exit(code);
    }
    const [url, ...extra] = rest;
    if (url === undefined || extra.length > 0) {
      process.stderr.write(`demoman: signin takes one URL\n\n${USAGE}`);
      process.exit(2);
    }
    const code = await signin(url, {
      home: demomanHome(),
      out: (line) => process.stdout.write(`${line}\n`),
      enter: () => {
        const rl = createInterface({ input: process.stdin });
        let ended = false;
        return {
          done: new Promise<void>((resolve) => {
            rl.once("line", () => resolve());
            // EOF or a non-TTY: Enter can never come. Resolve nothing, and
            // say what to do instead.
            rl.once("close", () => {
              if (!ended) {
                process.stdout.write(
                  "demoman signin: stdin is closed, so Enter cannot be read here — close the browser window when you have signed in\n",
                );
              }
            });
          }),
          cancel: () => {
            ended = true;
            rl.close();
          },
        };
      },
      executablePath: fullChromiumPath(),
      installCommand: `npx ${PACKAGE_NAME}@${VERSION} setup`,
    });
    process.exit(code);
    break;
  }
  case "--version":
  case "-v":
    process.stdout.write(`${VERSION}\n`);
    break;
  case undefined:
  case "--help":
  case "-h":
    process.stdout.write(USAGE);
    break;
  default:
    process.stderr.write(`demoman: unknown command "${command}"\n\n${USAGE}`);
    process.exit(2);
}
