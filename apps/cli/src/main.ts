// apps/cli/src/main.ts
//
// The `demoman` bin of the published package (launch B): `demoman mcp`
// serves the CLI executor on stdio; `demoman setup` installs Chromium and
// the Claude Code plugin; `demoman --version`. Bundled by
// scripts/build.mjs into pkg/dist/demoman.mjs, beside page/ and recipe.md.
//
// First, before anything that could print: console.log/info/debug to stderr.
import "@demoman/mcp/stdout-guard";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
import { isExportQuality } from "@demoman/run-core";
import {
  createLocalExecutor,
  execGit,
  fullChromiumPath,
  joinFlow as joinFlowInto,
  type KeepAnswer,
  type KeepOutput,
  keepVideo,
  PAGE_ENTRIES,
  type RefreshResult,
  readRepo,
  refreshKept,
  removeRepoFlow,
  signin,
  signinAccount,
  usePrebuiltPages,
} from "@demoman/runner/package";
import {
  couldNotCheck,
  createBrowserSession,
  createLibrary,
  createVideoStore,
  postToolUseAnswer,
} from "@demoman/runner/studio";
import { openStudio, runServe, stopStudio } from "@demoman/studio";
import { refreshAgentSkill } from "./agent-skill.js";
import { ciSetup } from "./ci-workflow.js";
import { deliver } from "./deliver.js";
import { keepLines, removeLines } from "./keep-lines.js";
import { PACKAGE_NAME } from "./names.js";
import { parseRefreshArgs } from "./refresh-args.js";
import { refreshLines } from "./refresh-lines.js";
import { parseSetupArgs, setup } from "./setup.js";
import {
  ciPrompts,
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
/** The built-in wallpapers, shipped inside the studio pages, for every
 *  mode that can export (`ExportDeps.wallpapersDir`). */
const WALLPAPERS_DIR = fileURLToPath(
  new URL("./studio/wallpapers", import.meta.url),
);
const REINSTALL = `reinstall with \`npx --prefix ~/ ${PACKAGE_NAME}@${VERSION} setup\``;
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
    [--yes] [--agents claude,codex,cursor] [--quality share|high|full] [--pull-requests off|ask|attach]
  npx demoman setup --browser-only   install the browser alone and connect no agent (CI)
  npx demoman setup --ci [--trigger push|<environment>] [--route pr|main] [--artifact]
                             write .github/workflows/demoman.yml, which refreshes the repo's flows on each merge
  npx demoman signin <url>   sign in to your app once, so agents can record behind the login
  npx demoman signin --account <name> [--site <origin>] [--project <dir>]
                             sign in as a demo account from .demoman/accounts.json (CI, or a check)
  npx demoman studio [video] open the Studio, to look over and edit flows and export them
  npx demoman studio --stop  close the Studio
  npx demoman add <flow> --to <path>[:<aspect>] [--gif <path>[:<aspect>]] [--report <path>] [--quality share|high|full] [--deliver commit|files]
                             add a flow to the repo: its recipe in .demoman/flows/, its exports in the repo
                             (--deliver files writes the recipe alone; outputs are file names for --out-dir)
  npx demoman remove <flow>  take a flow out of the repo: its recipe and receipt go, its exports stay
  npx demoman join-flow <from> <into>
                             move a flow's videos into the repo flow that has its name, and remove the flow
  npx demoman refresh [<flow>…] [--base-url <origin>] [--deliver pr|main] [--out-dir <folder>] [--previous <folder>]
                             record the repo's flows again and replace the exports whose picture changed;
                             --deliver commits them on main, or opens a pull request (CI);
                             --out-dir writes the files flows and demoman-refresh.json there,
                             --previous is the folder the last --out-dir was kept in
  demoman mcp [--headed]     serve Demoman's tools on stdio (your agent runs this);
                             --headed shows the browser while it records
  demoman hook post-tool-use answer Claude Code's PostToolUse hook on stdin (the plugin runs this)
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
  const skill = refreshAgentSkill({
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
    // The studio pages ship them; this mode exports too.
    wallpapersDir: WALLPAPERS_DIR,
    // Setup installs the full Chromium only (`--no-shell`); headless, with
    // no executable named, Playwright looks for the headless shell instead,
    // and every call would answer browserMissing while status said the
    // browser was installed. Name the one setup installs, in either mode —
    // the runner's own answer, which `demoman-mcp` names too.
    executablePath: fullChromiumPath(),
    ...(values["out-dir"] === undefined
      ? {}
      : { outDir: resolve(values["out-dir"]) }),
    // --yes: an agent may run it in a pseudo-terminal, where a menu would
    // wait for an answer nobody gives.
    // The agent runs these in the repo it opened: `--prefix ~/` keeps that
    // repo's node_modules and .npmrc from choosing what runs (audit run 1).
    installCommand: `npx --prefix ~/ ${PACKAGE_NAME}@${VERSION} setup --yes`,
    signinCommand: `npx --prefix ~/ ${PACKAGE_NAME}@${VERSION} signin`,
    updateCommand: `npx --prefix ~/ ${PACKAGE_NAME}@latest setup --yes`,
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
      process.stderr.write(`demoman: the Studio was not stopped: ${why}\n`);
      process.exit(1);
    }
    process.stdout.write(
      stopped
        ? `Stopped the Studio.${cutShort > 0 ? " An export was cut short." : ""}\n`
        : "No Studio is running.\n",
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
      process.stdout.write(
        `${answer.note === undefined ? "" : `${answer.note}\n`}Opened the Studio.\n`,
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

/** `demoman add` (and its old name, `keep`): the flow's recipe and its
 *  outputs, in the repo the command runs in. Paths are the shell's,
 *  relative to the current folder. */
async function add(args: string[]): Promise<void> {
  const usage = (said: string): never => {
    process.stderr.write(`demoman: ${said}\n\n${USAGE}`);
    process.exit(2);
  };
  let values: {
    to?: string[];
    gif?: string[];
    report?: string;
    quality?: string;
    deliver?: string;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        to: { type: "string", multiple: true },
        gif: { type: "string", multiple: true },
        report: { type: "string" },
        quality: { type: "string" },
        deliver: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const [video, ...extra] = positionals;
  const asked = [
    ...(values.to ?? []).map((a) => ["mp4", a] as const),
    ...(values.gif ?? []).map((a) => ["gif", a] as const),
  ];
  if (video === undefined || extra.length > 0 || asked.length === 0) {
    return usage("add takes one flow and at least one --to or --gif");
  }
  // Share by default: every refresh commits these files again.
  const quality = values.quality ?? "share";
  if (!isExportQuality(quality)) {
    return usage(`--quality is share, high or full, not "${quality}"`);
  }
  const deliver = values.deliver ?? "commit";
  if (deliver !== "commit" && deliver !== "files") {
    return usage(`--deliver is commit or files, not "${deliver}"`);
  }
  const fail = (detail: string): never => {
    process.stderr.write(`demoman add: ${detail}\n`);
    process.exit(1);
  };
  const repo = await readRepo(process.cwd(), execGit);
  if (!repo.ok) {
    return fail(`${repo.none} — run add inside the repo the flow belongs to`);
  }
  const root = repo.repo.root;
  const inRoot = (p: string) => relative(root, resolve(p));
  const to: KeepOutput[] = asked.map(([fileType, arg]) => {
    const m = /^(.*):(auto|16:9|9:16)$/.exec(arg);
    return {
      // `files` outputs are names, not places: left as given.
      path: deliver === "files" ? (m?.[1] ?? arg) : inRoot(m?.[1] ?? arg),
      fileType,
      quality,
      ...(m?.[2] === undefined
        ? {}
        : { aspect: m[2] as NonNullable<KeepOutput["aspect"]> }),
    };
  });
  requirePageBundles(
    join(fileURLToPath(new URL(".", import.meta.url)), "page"),
    (line) => fail(line),
  );
  const home = demomanHome();
  const library = createLibrary(home);
  const videos = createVideoStore(home, library, { log });
  // Renders out of sight, as the Studio's exports do.
  const session = createBrowserSession({
    headless: true,
    executablePath: fullChromiumPath(),
    installCommand: `npx --prefix ~/ ${PACKAGE_NAME}@${VERSION} setup`,
    log,
  });
  let answer: KeepAnswer | { threw: string };
  try {
    answer = await keepVideo(
      {
        video,
        to,
        ...(values.report === undefined
          ? {}
          : {
              report:
                deliver === "files" ? values.report : inRoot(values.report),
            }),
        deliver,
        repoRoot: root,
      },
      {
        home,
        library,
        videos,
        git: execGit,
        log,
        export: {
          library,
          videos,
          session,
          door: "agent",
          home,
          wallpapersDir: WALLPAPERS_DIR,
          // Each output renders into a temp folder of keep's own.
          outDir: tmpdir(),
          log,
        },
      },
    );
  } catch (error) {
    answer = { threw: error instanceof Error ? error.message : String(error) };
  } finally {
    await session
      .close()
      .catch((error: unknown) =>
        log(`the browser would not close (${String(error)})`),
      );
  }
  if ("threw" in answer) return fail(answer.threw);
  if (!answer.ok) return fail(answer.detail);
  process.stdout.write(`${keepLines(answer).join("\n")}\n`);
  process.exit(0);
}

/** `demoman remove`: a flow out of the repo; its exports stay. */
async function remove(args: string[]): Promise<void> {
  const [flow, ...extra] = args;
  if (flow === undefined || flow.startsWith("-") || extra.length > 0) {
    process.stderr.write(`demoman: remove takes one flow\n\n${USAGE}`);
    process.exit(2);
  }
  const repo = await readRepo(process.cwd(), execGit);
  if (!repo.ok) {
    process.stderr.write(
      `demoman remove: ${repo.none} — run remove inside the repo the flow belongs to\n`,
    );
    process.exit(1);
  }
  const answer = await removeRepoFlow({ root: repo.repo.root, flow });
  const lines = removeLines(answer).join("\n");
  if (!answer.ok) {
    process.stderr.write(`demoman remove: ${lines}\n`);
    process.exit(1);
  }
  process.stdout.write(`${lines}\n`);
}

/** `demoman refresh`: every kept video in the repo (or those named) filmed
 *  again with no agent; an export is replaced only when its picture changed.
 *  Always into a library thrown away after; off CI (`CI` not "true") the
 *  user's own is read to say what it has that a kept file lacks. */
async function refresh(args: string[]): Promise<void> {
  const usage = (said: string): never => {
    process.stderr.write(`demoman: ${said}\n\n${USAGE}`);
    process.exit(2);
  };
  const parsed = parseRefreshArgs(args);
  if ("error" in parsed) return usage(parsed.error);
  const { only, route, baseUrl, outDir, previous } = parsed;
  const fail = (detail: string): never => {
    process.stderr.write(`demoman refresh: ${detail}\n`);
    process.exit(1);
  };
  const repo = await readRepo(process.cwd(), execGit);
  if (!repo.ok) {
    return fail(
      `${repo.none} — run refresh inside the repo the flows are kept in`,
    );
  }
  requirePageBundles(
    join(fileURLToPath(new URL(".", import.meta.url)), "page"),
    (line) => fail(line),
  );
  const install = `npx --prefix ~/ ${PACKAGE_NAME}@${VERSION} setup`;
  // Decodes the exports to compare them, out of sight.
  const session = createBrowserSession({
    headless: true,
    executablePath: fullChromiumPath(),
    installCommand: install,
    log,
  });
  let result: RefreshResult | { threw: string };
  try {
    const refreshHome = demomanHome();
    result = await refreshKept(
      {
        repoRoot: repo.repo.root,
        ...(only.length > 0 ? { only } : {}),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(outDir === undefined ? {} : { outDir }),
        ...(previous === undefined ? {} : { previous }),
        library: process.env.CI === "true" ? "throwaway" : "local",
      },
      {
        library: createLibrary(refreshHome),
        videos: createVideoStore(refreshHome, createLibrary(refreshHome), {
          log,
        }),
        executor: (o) =>
          createLocalExecutor({
            ...o,
            headless: true,
            wallpapersDir: WALLPAPERS_DIR,
            // Films at the kept scale, which DEMOMAN_DISPLAY names.
            standInDisplay: true,
            executablePath: fullChromiumPath(),
            installCommand: install,
            signinCommand: `npx --prefix ~/ ${PACKAGE_NAME}@${VERSION} signin`,
            log,
          }),
        session,
        env: process.env,
        log,
      },
    );
  } catch (error) {
    result = { threw: error instanceof Error ? error.message : String(error) };
  } finally {
    await session
      .close()
      .catch((error: unknown) =>
        log(`the browser would not close (${String(error)})`),
      );
  }
  if ("threw" in result) return fail(result.threw);
  const { lines, code } = refreshLines(result);
  for (const line of lines) process.stdout.write(`${line}\n`);
  // The finished flows are said first; the list's failure then fails the run.
  if (result.listError !== undefined) return fail(result.listError);
  if (route === undefined) process.exit(code);
  const {
    GITHUB_SERVER_URL: server,
    GITHUB_REPOSITORY: slug,
    GITHUB_RUN_ID: id,
  } = process.env;
  const delivered = await deliver(
    {
      route,
      repoRoot: repo.repo.root,
      result,
      named: only.length > 0,
      runUrl:
        server && slug && id ? `${server}/${slug}/actions/runs/${id}` : null,
    },
    {
      git: execGit,
      gh: (a) =>
        new Promise((done) => {
          execFile("gh", a, { cwd: repo.repo.root }, (err, stdout, stderr) =>
            done({
              code: err ? (typeof err.code === "number" ? err.code : 127) : 0,
              stdout,
              stderr:
                err && typeof err.code !== "number" ? String(err) : stderr,
            }),
          );
        }),
    },
  );
  process.stdout.write(
    `delivered: ${delivered.delivered}: ${delivered.detail}\n`,
  );
  process.exit(code === 0 && delivered.ok ? 0 : 1);
}

/** `demoman join-flow`: this library's flow `from` joins the kept flow `into`. */
async function joinFlow(args: string[]): Promise<void> {
  const [from, into, ...extra] = args;
  if (from === undefined || into === undefined || extra.length > 0) {
    process.stderr.write(
      `demoman: join-flow needs the flow to move and the flow to move it into\n\n${USAGE}`,
    );
    process.exit(2);
  }
  const home = demomanHome();
  const videos = createVideoStore(home, createLibrary(home), { log });
  let said: string;
  try {
    // An `into` this library lacks is read from the checkout's kept files.
    const repo = await readRepo(process.cwd(), execGit);
    const out = await joinFlowInto(
      videos,
      from,
      into,
      repo.ok
        ? { root: repo.repo.root, repo: { key: repo.repo.key } }
        : { none: repo.none },
    );
    if (out.ok) {
      process.stdout.write(
        `moved ${out.moved} video${out.moved === 1 ? "" : "s"} from ${from} into ${into}${out.adopted === null ? "" : `, the flow kept in ${out.adopted}`}\n`,
      );
      process.exit(0);
    }
    said = out.said;
  } catch (error) {
    // A merge that stopped partway says how many moved and what remains.
    said = error instanceof Error ? error.message : String(error);
  }
  process.stderr.write(`demoman: join-flow: ${said}\n`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "mcp":
    await mcp(rest);
    break;
  case "studio":
    await studio(rest);
    break;
  case "add":
  case "keep":
    await add(rest);
    break;
  case "remove":
    await remove(rest);
    break;
  case "refresh":
    await refresh(rest);
    break;
  case "join-flow":
    await joinFlow(rest);
    break;
  case "setup": {
    if (rest.includes("--ci")) {
      const tty = process.stdin.isTTY === true;
      let ciRoot = process.cwd();
      process.exit(
        await ciSetup(rest, {
          version: VERSION,
          ask: tty ? ciPrompts() : null,
          root: async () => {
            const r = await readRepo(process.cwd(), execGit);
            if (r.ok) ciRoot = r.repo.root;
            return r.ok ? { root: r.repo.root } : { none: r.none };
          },
          defaultBranch: async () => {
            try {
              const r = await execGit(
                ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
                process.cwd(),
              );
              const name = r.stdout.trim().replace(/^origin\//, "");
              return r.code === 0 && name !== "" ? name : null;
            } catch {
              return null; // git not running: the caller says it assumed main
            }
          },
          exists: (p) => existsSync(join(ciRoot, p)),
          write: (p, text) => {
            mkdirSync(dirname(join(ciRoot, p)), { recursive: true });
            writeFileSync(join(ciRoot, p), text);
          },
          say: (l) => process.stdout.write(`${l}\n`),
        }),
      );
    }
    const flags = parseSetupArgs(rest);
    if ("refused" in flags) {
      process.stdout.write(`Demoman setup stopped: ${flags.refused}.\n`);
      process.exit(1);
    }
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
    process.exit(await setup(deps, flags));
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
        installCommand: `npx --prefix ~/ ${PACKAGE_NAME}@${VERSION} setup`,
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
      installCommand: `npx --prefix ~/ ${PACKAGE_NAME}@${VERSION} setup`,
    });
    process.exit(code);
    break;
  }
  case "hook": {
    if (rest.length !== 1 || rest[0] !== "post-tool-use") {
      process.stderr.write(`demoman: hook takes post-tool-use\n\n${USAGE}`);
      process.exit(2);
    }
    // Always exit 0: a hook that fails is not shown to anyone, so every
    // failure is answered as the reminder's own text.
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const answer = await postToolUseAnswer(
        Buffer.concat(chunks).toString("utf8"),
        demomanHome(),
      );
      if (answer !== null) process.stdout.write(`${answer}\n`);
    } catch (error) {
      process.stdout.write(
        `${couldNotCheck(error instanceof Error ? error.message : String(error))}\n`,
      );
    }
    process.exit(0);
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
