import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { setup } from "../src/setup.js";
import {
  claudePaths,
  readSkill,
  readTextFile,
  runCaptured,
  setupChromiumDownload,
  stableNodeBin,
  writeTextFile,
} from "../src/setup-deps.js";

/** Every folder a case makes, removed after the file: the npx-shaped one
 *  holds a symlink into this install's Playwright. */
const made: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// The real adapter's two failure shapes that the pure setup tests feed by
// hand: a command that never finishes, and one a signal ends.
describe("runCaptured", () => {
  it("stops a command that does not finish, and says which and after how long", () => {
    const started = Date.now();
    const r = runCaptured(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      300,
    );
    // The premise: it was stopped, not left to run its 30 s.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.error).toBe(
      `\`${process.execPath}\` had not finished after 0.3 s and was stopped`,
    );
  });

  it("carries the signal that ended a command", () => {
    const r = runCaptured(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);
    expect(r.status).toBeNull();
    expect(r.signal).toBe("SIGTERM");
    expect(r.error).toBeUndefined();
  });

  it("reaches setup's words as a stalled step, not a hang", async () => {
    const lines: string[] = [];
    const stalled = runCaptured(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      300,
    );
    const code = await setup({
      platform: "darwin",
      nodeVersion: "v22.3.0",
      version: "0.2.0",
      run: () => stalled,
      runVisible: () => ({ status: 0, stdout: "", stderr: "" }),
      chromiumInstalled: () => true,
      chromiumInstall: { command: "node", args: [] },
      home: "/Users/u",
      codexHome: "/Users/u/.codex",
      env: {},
      nodeBin: "/opt/node/bin",
      claude: {
        settings: "/Users/u/.claude/settings.json",
        config: "/Users/u/.claude.json",
        managed:
          "/Library/Application Support/ClaudeCode/managed-settings.json",
      },
      skill: { text: "---\nname: record-demo\n---\nDemoman" },
      exists: () => false,
      readText: () => ({ missing: true }),
      writeText: () => ({ ok: true }),
      say: (l) => void lines.push(l),
      ask: null,
      settings: {
        read: async () => ({ exportQuality: "high", pullRequests: null }),
        write: async () => ({}),
      },
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("had not finished after 0.3 s");
  });
});

// The config files setup edits are often managed elsewhere: a dotfiles repo
// links them, a user narrowed their mode. Each write keeps both.
describe("writeTextFile and readTextFile", () => {
  const dir = () => tempDir("demoman-setup-");
  const mode = (p: string) => statSync(p).mode & 0o777;

  it("creates parents, and a new file is 0600", () => {
    const p = join(dir(), "a", "b", "mcp.json");
    expect(writeTextFile(p, "{}\n")).toEqual({ ok: true });
    expect(readFileSync(p, "utf8")).toBe("{}\n");
    expect(mode(p)).toBe(0o600);
  });

  // 0640, not 0644: a plain write under the usual umask 022 makes 0644, so
  // that mode would pass with the mode handling removed (final review).
  it("keeps an existing file's mode", () => {
    const p = join(dir(), "settings.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o640);
    expect(writeTextFile(p, '{"a":1}\n')).toEqual({ ok: true });
    expect(mode(p)).toBe(0o640);
    expect(readFileSync(p, "utf8")).toBe('{"a":1}\n');
  });

  it("writeText follows a symlink", () => {
    const d = dir();
    mkdirSync(join(d, "real"));
    writeFileSync(join(d, "real", "b"), "old");
    symlinkSync(join(d, "real", "b"), join(d, "a"));
    expect(writeTextFile(join(d, "a"), "new")).toEqual({ ok: true });
    expect(lstatSync(join(d, "a")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(d, "real", "b"), "utf8")).toBe("new");
  });

  // A dotfiles repo whose file does not exist yet: the link is the user's
  // wiring, and must not be replaced by a plain file (final review).
  it("writes through a dangling symlink, keeping the link", () => {
    const d = dir();
    mkdirSync(join(d, "dots"));
    symlinkSync("dots/mcp.json", join(d, "mcp.json"));
    expect(readTextFile(join(d, "mcp.json"))).toEqual({ missing: true });
    expect(writeTextFile(join(d, "mcp.json"), "{}\n")).toEqual({ ok: true });
    expect(lstatSync(join(d, "mcp.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(d, "dots", "mcp.json"), "utf8")).toBe("{}\n");
  });

  it("leaves no temp file behind when the write fails", () => {
    const d = dir();
    mkdirSync(join(d, "x.json"));
    const r = writeTextFile(join(d, "x.json"), "{}");
    expect(r).toHaveProperty("error");
    expect(readdirSync(d)).toEqual(["x.json"]);
  });

  it("says which file it could not write", () => {
    const d = dir();
    writeFileSync(join(d, "file"), "");
    const r = writeTextFile(join(d, "file", "under-a-file.json"), "x");
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toContain(join(d, "file"));
  });

  it("readText answers missing for ENOENT and error with the path otherwise", () => {
    const d = dir();
    expect(readTextFile(join(d, "nope"))).toEqual({ missing: true });
    const r = readTextFile(d);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toContain(d);
    writeFileSync(join(d, "f"), "hi");
    expect(readTextFile(join(d, "f"))).toEqual({ text: "hi" });
  });
});

// Found on the author's machine (launch E, Task 8): process.execPath is the
// resolved /opt/homebrew/Cellar/node/24.2.0/bin/node, a folder
// `brew upgrade node` deletes, so Cursor's entry would break on the next
// upgrade. The PATH's npx that leads to the same node is the stable name.
describe("stableNodeBin", () => {
  // fnm puts a per-shell folder of links first on PATH, and removes it
  // when that shell's session is cleaned up (/code-review, 2026-10-17).
  it("skips fnm's per-shell folder for the node's own folder", () => {
    const install =
      "/Users/u/.local/share/fnm/node-versions/v22.3.0/installation/bin";
    const shell = "/Users/u/.local/state/fnm_multishells/123_456/bin";
    const fnm: Record<string, string> = {
      [`${shell}/npx`]: `${install}/../lib/node_modules/npm/bin/npx-cli.js`,
      [`${shell}/node`]: `${install}/node`,
    };
    const resolve = (p: string): string => {
      const to = fnm[p];
      if (to !== undefined) return to;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    };
    // The premise: the shell folder would otherwise match.
    expect(resolve(`${shell}/node`)).toBe(`${install}/node`);
    expect(stableNodeBin(`${install}/node`, `${shell}:/usr/bin`, resolve)).toBe(
      install,
    );
  });

  // As on the author's machine: each npx is a link into npm's package, and
  // node@18's node is another binary.
  const links: Record<string, string> = {
    "/opt/homebrew/bin/npx":
      "/opt/homebrew/Cellar/node/24.2.0/lib/node_modules/npm/bin/npx-cli.js",
    "/opt/homebrew/bin/node": "/opt/homebrew/Cellar/node/24.2.0/bin/node",
    "/opt/homebrew/opt/node@18/bin/npx":
      "/opt/homebrew/Cellar/node@18/18.20.4/lib/node_modules/npm/bin/npx-cli.js",
    "/opt/homebrew/opt/node@18/bin/node":
      "/opt/homebrew/Cellar/node@18/18.20.4/bin/node",
    "/usr/bin/node": "/usr/bin/node",
  };
  const realpath = (p: string): string => {
    const to = links[p];
    if (to !== undefined) return to;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  };
  const exec = "/opt/homebrew/Cellar/node/24.2.0/bin/node";

  it("takes the PATH folder whose npx leads to the running node", () => {
    expect(
      stableNodeBin(
        exec,
        "/Users/u/.npm/_npx/1/node_modules/.bin:/opt/homebrew/opt/node@18/bin:/opt/homebrew/bin:/usr/bin",
        realpath,
      ),
    ).toBe("/opt/homebrew/bin");
  });

  it("falls back to the running node's own folder", () => {
    expect(
      stableNodeBin(exec, "/usr/bin:/opt/homebrew/opt/node@18/bin", realpath),
    ).toBe("/opt/homebrew/Cellar/node/24.2.0/bin");
    expect(stableNodeBin("/n/bin/node", "", realpath)).toBe("/n/bin");
  });
});

// Claude Code reads both files from CLAUDE_CONFIG_DIR when it is set
// (/code-review, 2026-10-17); setup wrote ~/.claude regardless.
describe("claudePaths", () => {
  it("follows CLAUDE_CONFIG_DIR, else ~/.claude and ~/.claude.json", () => {
    expect(claudePaths("/Users/u", undefined)).toEqual({
      settings: "/Users/u/.claude/settings.json",
      config: "/Users/u/.claude.json",
      managed: "/Library/Application Support/ClaudeCode/managed-settings.json",
    });
    expect(claudePaths("/Users/u", "")).toEqual(
      claudePaths("/Users/u", undefined),
    );
    expect(claudePaths("/Users/u", "/Users/u/.claude-work")).toEqual({
      settings: "/Users/u/.claude-work/settings.json",
      config: "/Users/u/.claude-work/.claude.json",
      // An admin's file: CLAUDE_CONFIG_DIR does not move it.
      managed: "/Library/Application Support/ClaudeCode/managed-settings.json",
    });
  });
});

// A skill the install lacks is Cursor's problem alone: said there, never a
// throw that stops setup for every agent (/code-review, 2026-10-17).
describe("readSkill", () => {
  it("answers the text, or why it could not be read", () => {
    const dir = tempDir("demoman-skill-");
    expect(readSkill(dir)).toMatchObject({
      error: expect.stringContaining("SKILL.md"),
    });
    mkdirSync(join(dir, "skills", "record-demo"), { recursive: true });
    const file = join(dir, "skills", "record-demo", "SKILL.md");
    writeFileSync(file, "  \n");
    expect(readSkill(dir)).toEqual({ error: `${file} is empty` });
    writeFileSync(file, "---\nname: record-demo\n---\n");
    expect(readSkill(dir)).toEqual({ text: "---\nname: record-demo\n---\n" });
  });
});

// Against Playwright's own check, not a copy of it: its real CLI, reached
// through a folder named the way npx names its cache, with --dry-run so
// nothing downloads.
describe("setupChromiumDownload", () => {
  const WARNING = "running 'npx playwright install' without first";
  const npxCli = (): string => {
    const pw = createRequire(import.meta.url).resolve(
      "playwright/package.json",
    );
    const core = dirname(
      createRequire(pw).resolve("playwright-core/package.json"),
    );
    const modules = join(
      tempDir("demoman-pw-"),
      "_npx",
      "0d743610b29be38b",
      "node_modules",
    );
    mkdirSync(modules, { recursive: true });
    symlinkSync(core, join(modules, "playwright-core"));
    return join(modules, "playwright-core", "cli.js");
  };
  const dryRun = (command: string, args: string[]): string => {
    const r = runCaptured(command, [...args, "--dry-run"], 30_000);
    expect(r.status, r.stderr).toBe(0);
    return r.stdout + r.stderr;
  };

  it("runs the download without Playwright's npx warning", () => {
    const cli = npxCli();
    // The premise: run directly from an _npx folder, Playwright warns.
    const direct = dryRun(process.execPath, [
      cli,
      "install",
      "chromium",
      "--no-shell",
    ]);
    expect(direct).toContain(WARNING);

    const { command, args } = setupChromiumDownload(cli);
    const wrapped = dryRun(command, args);
    expect(wrapped).not.toContain(WARNING);
    // And the arguments still reached `install chromium`.
    expect(wrapped).toContain("Chrome for Testing");
    expect(wrapped).toContain("Install location:");
  });
});
