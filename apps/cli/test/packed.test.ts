import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, symlink, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, installPacked, text } from "./packed-install.js";

// Measured 2026-10-14 on an M-series Mac with a warm npm cache: pack +
// install ~3 s, the whole file 6.3 s. A cold cache downloads Playwright,
// mediabunny, zod and the MCP SDK (~45 MB): allow minutes, not seconds, and
// CI's ~5x (fff4505).
const INSTALL_MS = 300_000;
const REPO_BIN = fileURLToPath(
  new URL("../../mcp/dist/index.js", import.meta.url),
);
const VERSION = JSON.parse(
  readFileSync(new URL("../pkg/package.json", import.meta.url), "utf8"),
).version as string;

let packed: Awaited<ReturnType<typeof installPacked>>;
let home: string;
beforeAll(async () => {
  packed = await installPacked();
  home = await mkdtemp(join(tmpdir(), "demoman-packed-home-"));
}, INSTALL_MS);
afterAll(async () => {
  await packed?.cleanup();
  await rm(home, { recursive: true, force: true });
});
const env = () => ({ DEMOMAN_HOME: home, DEMOMAN_NO_UPDATE_CHECK: "1" });

const PAGE =
  "<!doctype html><meta charset=utf-8><title>packed</title><button>Place order</button>";
/** Serves PAGE on loopback for one snapshot, and answers its text. */
async function snapshotFrom(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const server = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.end(PAGE);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  const c = await connect(process.execPath, [packed.bin, ...args], {
    ...env(),
    ...extraEnv,
  });
  try {
    return text(
      await c.callTool({
        name: "snapshot",
        arguments: { url: `http://127.0.0.1:${port}/` },
      }),
    );
  } finally {
    await c.close();
    server.close();
  }
}
async function statusFrom(
  args: string[],
  extraEnv: Record<string, string>,
): Promise<Record<string, unknown>> {
  const c = await connect(process.execPath, [packed.bin, ...args], {
    ...env(),
    ...extraEnv,
  });
  try {
    return JSON.parse(
      text(await c.callTool({ name: "status", arguments: {} })),
    );
  } finally {
    await c.close();
  }
}

/** This machine's chromium-NNNN folder: the one browser setup downloads
 *  (`install chromium --no-shell`), without the headless shell beside it. */
function fullChromiumDir(): string {
  const { chromium } = createRequire(
    new URL("../../runner/package.json", import.meta.url),
  )("playwright") as { chromium: { executablePath(): string } };
  let dir = chromium.executablePath();
  while (!/^chromium-\d+$/.test(basename(dir))) {
    const up = dirname(dir);
    if (up === dir)
      throw new Error("no chromium-NNNN folder above the executable");
    dir = up;
  }
  return dir;
}

describe("the packed install", () => {
  it("installed the bin, and no esbuild", () => {
    // The control: the install happened and the bin is there.
    expect(existsSync(packed.bin)).toBe(true);
    expect(existsSync(join(packed.dir, "node_modules", "esbuild"))).toBe(false);
  });

  // An MCP registration written for the archived extension (2026-10-20)
  // passes `--browser extension`: refused by name, where the parse used to
  // answer Node's "Unknown option '--browser'". `--browser cli` still starts.
  it("refuses demoman mcp --browser extension by name, and takes --browser cli", () => {
    const old = spawnSync(
      process.execPath,
      [packed.bin, "mcp", "--browser", "extension"],
      { encoding: "utf8", env: { ...process.env, ...env() } },
    );
    expect(old.status).toBe(2);
    expect(old.stderr).toContain(
      "--browser extension was retired: Demoman's Chrome extension is archived",
    );
    // Stdin closed at once: the server starts, then exits on the closed
    // host, past the parse.
    const cli = spawnSync(
      process.execPath,
      [packed.bin, "mcp", "--browser", "cli"],
      {
        encoding: "utf8",
        input: "",
        env: { ...process.env, ...env() },
      },
    );
    expect(cli.stderr).not.toContain("Unknown option");
    expect(cli.stderr).not.toContain("--browser");
    expect(cli.status).toBe(0);
  });

  it("answers --version", () => {
    const out = execFileSync(process.execPath, [packed.bin, "--version"], {
      encoding: "utf8",
    });
    expect(out.trim()).toBe(VERSION);
  });

  it("serves the same tools, instructions and recipe as the repo's CLI server", async () => {
    const a = await connect(
      process.execPath,
      [packed.bin, "mcp", "--headless"],
      env(),
    );
    const b = await connect(process.execPath, [REPO_BIN, "--headless"], env());
    try {
      const names = async (c: typeof a) =>
        (await c.listTools()).tools.map((t) => t.name).sort();
      const tools = await names(a);
      expect(tools.length).toBeGreaterThan(5);
      // The one tool the bin adds (launch D2): the dev demoman-mcp has no
      // studio to open, so it lists none.
      expect(tools).toEqual([...(await names(b)), "studio"].sort());
      expect(a.getInstructions()).toBe(b.getInstructions());
      const recipe = text(await a.callTool({ name: "recipe", arguments: {} }));
      expect(recipe.length).toBeGreaterThan(1000);
      expect(recipe).toBe(
        text(await b.callTool({ name: "recipe", arguments: {} })),
      );
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it("answers status with its own version and no bridge fields", async () => {
    const c = await connect(
      process.execPath,
      [packed.bin, "mcp", "--headless"],
      env(),
    );
    try {
      const status = JSON.parse(
        text(await c.callTool({ name: "status", arguments: {} })),
      );
      expect(status).toMatchObject({
        executor: "cli",
        version: VERSION,
        browserInstalled: true,
        update: { current: VERSION, check: "off: DEMOMAN_NO_UPDATE_CHECK=1" },
      });
      for (const gone of ["code", "protocol", "server"]) {
        expect(status, gone).not.toHaveProperty(gone);
      }
    } finally {
      await c.close();
    }
  }, 60_000);

  it("snapshots a page with its prebuilt page bundles", async () => {
    const got = await snapshotFrom(["mcp", "--headless"]);
    expect(got, got).toContain("Place order");
  }, 120_000);

  // Review fix: setup installs `chromium --no-shell`, and a headless launch
  // with no executable looked for the headless shell setup never fetched —
  // browserMissing, "run setup", "already installed", round again — while
  // status said the browser was installed.
  it("films headless from the one Chromium setup installs", async () => {
    const cache = await mkdtemp(join(tmpdir(), "demoman-pw-full-only-"));
    try {
      await symlink(
        fullChromiumDir(),
        join(cache, basename(fullChromiumDir())),
      );
      const only = { PLAYWRIGHT_BROWSERS_PATH: cache };
      // The fixture: this cache holds the full Chromium and no shell.
      expect(
        (await readdir(cache)).filter((n) => n.includes("headless_shell")),
      ).toEqual([]);
      const status = await statusFrom(["mcp", "--headless"], only);
      expect(status.browserInstalled).toBe(true);
      const got = await snapshotFrom(["mcp", "--headless"], only);
      expect(got, got).toContain("Place order");
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  }, 120_000);

  // Review fix: the package's own fix command reaches the refusal through
  // main → serveCli → executor → session, in the installed copy.
  it("says Chromium is missing and names its own setup command", async () => {
    const empty = await mkdtemp(join(tmpdir(), "demoman-pw-empty-"));
    try {
      const none = { PLAYWRIGHT_BROWSERS_PATH: empty };
      const status = await statusFrom(["mcp", "--headless"], none);
      expect(status.browserInstalled).toBe(false);
      const got = await snapshotFrom(["mcp", "--headless"], none);
      expect(got).toContain('"browserMissing"');
      expect(got).toContain(`npx --prefix ~ demoman@${VERSION} setup`);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  }, 120_000);

  // The real SetupDeps, with no side effects: Chromium is already installed
  // on any machine that runs this lane, and with `claude` off the PATH setup
  // stops before it would touch Claude Code's configuration. The PATH is a
  // folder holding only node — node's own bin folder is not enough, since
  // a Homebrew or nvm global install puts `claude` right beside it.
  it("runs setup's real commands, says claude and codex are missing, and writes only under its HOME", async () => {
    const bin = await mkdtemp(join(tmpdir(), "demoman-path-"));
    // Launch E: setup now writes agents' config files under HOME, and finds
    // Cursor by /Applications/Cursor.app, which no PATH can hide. A
    // throwaway HOME keeps this case off the developer's own ~/.cursor (on
    // 2026-10-17 it wrote there before HOME was set); the real Chromium
    // cache keeps "already installed" true.
    const home = await mkdtemp(join(tmpdir(), "demoman-home-"));
    try {
      await symlink(process.execPath, join(bin, "node"));
      // CLAUDE_CONFIG_DIR and CODEX_HOME would point setup's writes past
      // HOME, at the developer's own folders.
      const { CLAUDE_CONFIG_DIR: _c, CODEX_HOME: _x, ...outer } = process.env;
      const env = {
        ...outer,
        PATH: bin,
        HOME: home,
        PLAYWRIGHT_BROWSERS_PATH: dirname(fullChromiumDir()),
      };
      // The premise: on this PATH neither `claude` nor `codex` can be found,
      // so this case can never run real setup against the developer's own.
      for (const agent of ["claude", "codex", "agent", "cursor-agent"]) {
        const probe = spawnSync(agent, ["--version"], { env });
        expect(
          (probe.error as NodeJS.ErrnoException | undefined)?.code,
          agent,
        ).toBe("ENOENT");
      }
      const r = spawnSync(process.execPath, [packed.bin, "setup"], {
        encoding: "utf8",
        env,
      });
      if (process.platform !== "darwin") {
        // CI runs on Linux, where setup refuses before any command: the real
        // adapter still loads, and the refusal is the answer (review fix).
        expect(r.stdout, r.stderr).toContain(
          `Demoman setup stopped: this build is for macOS, and this machine is ${process.platform}.`,
        );
        expect(r.status).toBe(1);
        return;
      }
      expect(r.stdout, r.stderr).not.toContain("setup stopped");
      expect(r.stdout, r.stderr).toContain(
        "browser: Chromium is already installed",
      );
      expect(r.stdout).toContain("/plugin install demoman@demoman");
      expect(r.stdout).toContain("Codex: not installed");
      if (existsSync("/Applications/Cursor.app")) {
        // The app is found whatever the PATH: setup wires it under HOME,
        // and says the app may still ask.
        expect(r.stdout).toContain("Cursor: Demoman is connected");
        expect(r.stdout).toContain("in the Cursor app its tools may ask");
        expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
        expect(
          existsSync(
            join(home, ".cursor", "skills", "record-demo", "SKILL.md"),
          ),
        ).toBe(true);
        expect(r.status).toBe(0);
      } else {
        expect(r.stdout).toContain("Cursor: not installed");
        expect(r.stdout).toContain("No coding agent was found");
        expect(r.status).toBe(1);
      }
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("signin --account with no name prints usage and exits 2", () => {
    const r = spawnSync(process.execPath, [packed.bin, "signin", "--account"], {
      encoding: "utf8",
      env: { ...process.env, ...env() },
    });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain("npx demoman signin --account <name>");
  });

  it("signin --account refuses an argument it does not know, with usage", () => {
    const r = spawnSync(
      process.execPath,
      [packed.bin, "signin", "--account", "seller", "--bogus"],
      { encoding: "utf8", env: { ...process.env, ...env() } },
    );
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain("--bogus");
    expect(r.stderr).toContain("npx demoman signin --account <name>");
  });

  it("signin --account=name takes the account path, as --account name does (review 2026-10-16)", async () => {
    const empty = await mkdtemp(join(tmpdir(), "demoman-no-accounts-"));
    try {
      const r = spawnSync(
        process.execPath,
        [packed.bin, "signin", "--account=seller", `--project=${empty}`],
        { encoding: "utf8", env: { ...process.env, ...env() } },
      );
      // The account path looked for accounts.json; the URL path would have
      // taken "--account=seller" for the URL.
      expect(r.stdout + r.stderr).toContain(
        `no .demoman/accounts.json found from ${empty}`,
      );
      expect(r.status, r.stdout + r.stderr).toBe(2);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  // Review Focus 5. Last: it deletes a file from the shared install.
  it("refuses to start when a page bundle is missing, naming it", async () => {
    const file = join(dirname(packed.bin), "page", "mux-entry.js");
    await unlink(file);
    const r = spawnSync(process.execPath, [packed.bin, "mcp", "--headless"], {
      encoding: "utf8",
      env: { ...process.env, ...env() },
      input: "",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(file);
    expect(r.stderr).toContain("reinstall with `npx demoman@");
  });
});
