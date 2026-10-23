import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../src/version.js";

// `demoman-mcp`, spawned the way an MCP host spawns it. (bin.test.ts, about
// the extension path's port, was archived with it on 2026-10-20.)
// and key.
const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every server here is headless, which stands in for the computer's display:
 *  pinned, so this Mac and the ubuntu runner film the same screen. */
const DEMOMAN_DISPLAY = "1280x800@2";

describe("--browser cli", () => {
  it("saves exports where --out-dir says, resolved against its working directory", async () => {
    // realpath: macOS tmpdir is /var -> /private/var, and the process
    // resolves its cwd to the real one.
    const cwd = realpathSync(freshDir("demoman-cwd-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "--browser", "cli", "--out-dir", "films"],
      cwd,
      env: {
        ...process.env,
        DEMOMAN_DISPLAY,
        DEMOMAN_HOME: freshDir("demoman-bin-"),
      } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const status = JSON.parse(
        (
          (await client.callTool({ name: "status", arguments: {} }))
            .content as Array<{ text: string }>
        )[0]?.text ?? "null",
      );
      expect(status.exportsTo).toBe(join(cwd, "films"));
    } finally {
      await client.close();
    }
  }, 30_000);

  it("answers status as the CLI, with no extension and no browser yet", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "--browser", "cli"],
      env: {
        ...process.env,
        DEMOMAN_DISPLAY,
        DEMOMAN_HOME: freshDir("demoman-bin-"),
      } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const status = JSON.parse(
        (
          (await client.callTool({ name: "status", arguments: {} }))
            .content as Array<{ text: string }>
        )[0]?.text ?? "null",
      );
      expect(status).toMatchObject({
        executor: "cli",
        allowAgentRuns: true,
        browserRunning: false,
        version: SERVER_VERSION,
        update: {
          current: SERVER_VERSION,
          check: expect.stringMatching(/^off: /),
        },
      });
      // Launch B: the bridge's fields describe nothing under the CLI.
      expect(status).not.toHaveProperty("code");
      expect(status).not.toHaveProperty("protocol");
      expect(status).not.toHaveProperty("server");
    } finally {
      await client.close();
    }
  }, 30_000);

  // Project A of cli-launch.md: the CLI is the default. Red if a server
  // started with no --browser serves the extension: an npm install's agent
  // would wait on an extension that is not there. The recipe it serves is
  // the CLI's.
  it("runs the CLI, and serves the CLI's recipe, when no --browser is given", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: {
        ...process.env,
        DEMOMAN_DISPLAY,
        DEMOMAN_HOME: freshDir("demoman-bin-"),
      } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const text = async (name: string) =>
        (
          (await client.callTool({ name, arguments: {} })).content as Array<{
            text: string;
          }>
        )[0]?.text ?? "";
      expect(JSON.parse(await text("status"))).toMatchObject({
        executor: "cli",
        browserRunning: false,
      });
      expect(await text("recipe")).toBe(
        readFileSync(
          fileURLToPath(new URL("../recipe.md", import.meta.url)),
          "utf8",
        ),
      );
    } finally {
      await client.close();
    }
  }, 30_000);

  it("states the version its package does", () => {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  // Final review 2026-10-12, Important 1. stdout is the JSON-RPC channel; a
  // snapshot of an address nothing answers makes run-core's snapshot say
  // "demoman snapshot: … did not load" through console.info, which under
  // node is stdout. Red without stdout-guard.ts: that line arrives raw
  // among the JSON (measured).
  it("writes nothing but JSON-RPC to stdout, even when a snapshot says why a page did not load", async () => {
    const child = spawn(process.execPath, [BIN, "--browser", "cli"], {
      env: {
        ...process.env,
        DEMOMAN_DISPLAY,
        DEMOMAN_HOME: freshDir("demoman-bin-"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const exited = new Promise<void>((r) => child.on("exit", () => r()));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "snapshot", arguments: { url: "http://127.0.0.1:9/" } },
      });
      // Waits on the answer itself, not a duration.
      const deadline = Date.now() + 60_000;
      while (!/"id":2\b/.test(stdout) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const lines = stdout.split("\n").filter((l) => l.trim() !== "");
      const answer = lines
        .map((l) => {
          try {
            return JSON.parse(l) as { id?: number; result?: unknown };
          } catch {
            return null;
          }
        })
        .find((m) => m?.id === 2);
      // The premise: the snapshot reached the page that did not load, so the
      // line this test is about was written somewhere.
      expect(JSON.stringify(answer), stderr).toContain("pageDidNotLoad");
      expect(stdout + stderr).toMatch(/demoman snapshot: .* did not load/);
      const notJson = lines.filter((l) => {
        try {
          JSON.parse(l);
          return false;
        } catch {
          return true;
        }
      });
      expect(notJson, "stdout carried lines that are not JSON-RPC").toEqual([]);
      // And it is not lost: it went to stderr, where a person reads it.
      expect(stderr).toMatch(/demoman snapshot: .* did not load/);
    } finally {
      child.stdin.end();
      await exited;
    }
  }, 90_000);

  it("refuses an unknown --browser value and says which value exists", () => {
    const out = spawnSync(process.execPath, [BIN, "--browser", "firefox"], {
      encoding: "utf8",
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(
      '--browser takes only "cli" (the default), not "firefox"',
    );
  });

  // An MCP registration written for the archived extension (2026-10-20):
  // said by name, never started as something else.
  it("refuses --browser extension, naming the retirement", () => {
    const out = spawnSync(process.execPath, [BIN, "--browser", "extension"], {
      encoding: "utf8",
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(
      "--browser extension was retired: Demoman's Chrome extension is archived",
    );
  });

  it("refuses --headed with --headless, and still starts on --headless alone", () => {
    const both = spawnSync(process.execPath, [BIN, "--headed", "--headless"], {
      encoding: "utf8",
    });
    expect(both.status).toBe(2);
    expect(both.stderr).toContain(
      "--headed and --headless ask for opposite things; pass one",
    );
    // --headless is the default now; a setup that still passes it must not
    // stop at the parse (the retirement refusal answers past it).
    const old = spawnSync(
      process.execPath,
      [BIN, "--browser", "extension", "--headless"],
      { encoding: "utf8" },
    );
    expect(old.stderr).not.toContain("Unknown option");
    expect(old.stderr).toContain("--browser extension was retired");
  });

  // Red if the stdin-close handler stops closing the executor. Chromium is a
  // grandchild of the server and, once the server dies, is reparented away
  // from it, so a ps walk from the server's pid would find nothing either
  // way. The server runs with its own TMPDIR instead: Playwright puts the
  // browser's throwaway profile under it, so any process whose command line
  // names that directory is this test's browser, before and after.
  it("closes the CLI's browser when stdin closes", async () => {
    const html = readFileSync(
      new URL(
        "../../../packages/compositor/scripts/fixture-app.html",
        import.meta.url,
      ),
    );
    const page = createServer((_, res) => {
      res.setHeader("content-type", "text/html");
      res.end(html);
    });
    await new Promise<void>((r) => page.listen(0, "127.0.0.1", () => r()));
    const port = (page.address() as { port: number }).port;
    const scratch = freshDir("demoman-bin-tmp-");
    const marker = scratch.slice(scratch.lastIndexOf("/") + 1);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "--browser", "cli"],
      env: {
        ...process.env,
        DEMOMAN_DISPLAY,
        DEMOMAN_HOME: freshDir("demoman-bin-"),
        TMPDIR: scratch,
      } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    const browserProcesses = (): string[] =>
      spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
        .stdout.split("\n")
        .filter((l) => l.includes(marker));
    try {
      await client.callTool({
        name: "snapshot",
        arguments: { url: `http://127.0.0.1:${port}/` },
      });
      // The premise: the snapshot launched browser processes under this server.
      expect(
        browserProcesses(),
        "no browser process names the server's TMPDIR",
      ).not.toEqual([]);
      // Close stdin and nothing else. `client.close()` would also send
      // SIGTERM after 2 s, and Playwright's own signal handler then closes
      // the browser — the test would pass with the server's stdin handler
      // deleted (measured). The SDK keeps the child private; this is the
      // handle it closes stdin through. Written against
      // @modelcontextprotocol/sdk 1.31.0 (StdioClientTransport._process).
      const child = (
        transport as unknown as {
          _process?: { stdin?: { end(): void } | null };
        }
      )._process;
      expect(child?.stdin, "the transport has no child to close").toBeTruthy();
      child?.stdin?.end();
      const deadline = Date.now() + 15_000;
      while (browserProcesses().length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(
        browserProcesses().map((l) => l.slice(0, 120)),
        "browser processes outlived the server's stdin",
      ).toEqual([]);
    } finally {
      page.close();
    }
  }, 90_000);
});
