import { describe, expect, it } from "vitest";
import { CODEX_APPROVAL_TABLE, cursorEntry } from "../src/configs.js";
import { type Ran, type SetupDeps, setup } from "../src/setup.js";

const OK = (stdout = ""): Ran => ({ status: 0, stdout, stderr: "" });
const FAIL = (stderr: string, status = 1): Ran => ({
  status,
  stdout: "",
  stderr,
});
const NOT_FOUND: Ran = { status: null, stdout: "", stderr: "", notFound: true };
const PLUGIN = (version: string, enabled = true) =>
  JSON.stringify([{ id: "demoman@demoman", version, enabled, scope: "user" }]);

const MANAGED = "/Library/Application Support/ClaudeCode/managed-settings.json";

const SKILL =
  "---\nname: record-demo\ndescription: x\n---\nDemoman's tools record demos.\n";

/** A machine where everything works; each case breaks one thing. */
function machine(
  over: Partial<SetupDeps> & { answers?: Record<string, Ran | Ran[]> } = {},
) {
  const lines: string[] = [];
  const calls: string[] = [];
  /** The file system setup reads and writes: absent until a case puts a
   *  file in it. */
  const files = new Map<string, string>([["/opt/node/bin/npx", ""]]);
  const writes: string[] = [];
  let chromium = false;
  const answers: Record<string, Ran | Ran[]> = {
    "claude plugin marketplace list --json": OK("[]"),
    "claude plugin marketplace add demoman-io/plugins": OK(),
    "claude plugin list --json": [OK("[]"), OK(PLUGIN("0.2.0"))],
    "claude plugin install demoman@demoman": OK(),
    "npx -y demoman@0.2.0 --version": OK("0.2.0\n"),
    "npx -y demoman@latest --version": OK("0.2.1\n"),
    "codex --version": NOT_FOUND,
    "agent --version": NOT_FOUND,
    "/Users/u/.local/bin/agent --version": NOT_FOUND,
    "cursor-agent --version": NOT_FOUND,
    ...over.answers,
  };
  const answer = (line: string): Ran => {
    calls.push(line);
    const a = answers[line];
    if (a === undefined) throw new Error(`unexpected command: ${line}`);
    if (!Array.isArray(a)) return a;
    return (a.length > 1 ? a.shift() : a[0]) as Ran;
  };
  const { answers: _answers, ...rest } = over;
  const d: SetupDeps = {
    platform: "darwin",
    nodeVersion: "v22.3.0",
    version: "0.2.0",
    run: (c, args) => answer([c, ...args].join(" ")),
    runVisible: (c, args) => {
      calls.push([c, ...args].join(" "));
      chromium = true;
      return OK();
    },
    chromiumInstalled: () => chromium,
    chromiumInstall: {
      command: "node",
      args: ["/pw/cli.js", "install", "chromium", "--no-shell"],
    },
    home: "/Users/u",
    codexHome: "/Users/u/.codex",
    env: {},
    nodeBin: "/opt/node/bin",
    claude: {
      settings: "/Users/u/.claude/settings.json",
      config: "/Users/u/.claude.json",
      managed: MANAGED,
    },
    skill: { text: SKILL },
    exists: (p) => files.has(p),
    readText: (p) => {
      const text = files.get(p);
      return text === undefined ? { missing: true } : { text };
    },
    writeText: (p, text) => {
      writes.push(p);
      files.set(p, text);
      return { ok: true };
    },
    say: (l) => void lines.push(l),
    ...rest,
  };
  return { d, lines, calls, files, writes, out: () => lines.join("\n") };
}

describe("setup", () => {
  it("installs Chromium and the plugin, warms the cache, and exits 0", () => {
    const m = machine();
    expect(setup(m.d)).toBe(0);
    expect(m.calls).toEqual([
      "node /pw/cli.js install chromium --no-shell",
      "claude plugin marketplace list --json",
      "claude plugin marketplace add demoman-io/plugins",
      "claude plugin list --json",
      "claude plugin install demoman@demoman",
      "claude plugin list --json",
      "codex --version",
      "agent --version",
      "/Users/u/.local/bin/agent --version",
      "cursor-agent --version",
      "npx -y demoman@0.2.0 --version",
    ]);
    expect(m.out()).toContain("browser: Chromium installed");
    expect(m.out()).toContain(
      "Claude Code: the demoman plugin is installed (0.2.0) and updates itself; its tools run without asking",
    );
    expect(m.out()).toContain("warm start: done");
    expect(m.out()).toContain("Restart Claude Code");
  });

  it("updates instead of adding when the marketplace and plugin are there", () => {
    const m = machine({
      chromiumInstalled: () => true,
      answers: {
        "claude plugin marketplace list --json": OK(
          JSON.stringify([{ name: "demoman" }]),
        ),
        "claude plugin marketplace update demoman": OK(),
        "claude plugin list --json": OK(PLUGIN("0.2.0")),
        "claude plugin update demoman@demoman": OK(),
      },
    });
    expect(setup(m.d)).toBe(0);
    expect(m.calls).toContain("claude plugin marketplace update demoman");
    expect(m.calls).toContain("claude plugin update demoman@demoman");
    expect(m.calls).not.toContain(
      "claude plugin marketplace add demoman-io/plugins",
    );
    expect(m.out()).toContain("browser: Chromium is already installed");
  });

  it("refuses Linux and old Node before doing anything", () => {
    const linux = machine({ platform: "linux" });
    expect(setup(linux.d)).toBe(1);
    expect(linux.calls).toEqual([]);
    expect(linux.out()).toContain(
      "this build is for macOS, and this machine is linux",
    );
    const old = machine({ nodeVersion: "v18.19.0" });
    expect(setup(old.d)).toBe(1);
    expect(old.calls).toEqual([]);
    expect(old.out()).toContain(
      "needs Node 20 or later, and this is Node 18.19.0",
    );
  });

  it("stops at a failed download, in Playwright's words, and registers nothing", () => {
    const m = machine({
      runVisible: () => FAIL("Error: getaddrinfo ENOTFOUND cdn.playwright.dev"),
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain(
      "browser: the download failed (Error: getaddrinfo ENOTFOUND cdn.playwright.dev)",
    );
    expect(m.calls.some((c) => c.startsWith("claude"))).toBe(false);
  });

  it("does not believe a download that left no Chromium behind", () => {
    const m = machine({
      runVisible: () => OK(),
      chromiumInstalled: () => false,
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain(
      "the download said it finished, but Chromium is still not there",
    );
    expect(m.calls.some((c) => c.startsWith("claude"))).toBe(false);
  });

  it("prints the /plugin commands and exits 1 when claude is not on the PATH", () => {
    const m = machine({
      answers: {
        "claude plugin marketplace list --json": {
          status: null,
          stdout: "",
          stderr: "",
          notFound: true,
        },
      },
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain("/plugin marketplace add demoman-io/plugins");
    expect(m.out()).toContain("/plugin install demoman@demoman");
    expect(m.out()).toContain("No coding agent was found");
  });

  // Review Focus 1.
  it("says to update Claude Code when it has no plugin command", () => {
    const m = machine({
      answers: {
        "claude plugin marketplace list --json": FAIL(
          "error: unknown command 'plugin'",
        ),
      },
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain(
      "this Claude Code has no `claude plugin` command; update Claude Code",
    );
  });

  // Review fix: Claude Code's root command takes a [prompt], so a version
  // without `plugin` (or without --json on it) may reject the flag instead
  // of the word. Either way the fix is the same.
  it.each([
    "error: unknown option '--json'",
    "error: too many arguments. Expected 1 argument but got 4.",
  ])("says to update Claude Code when it answers %s", (said) => {
    const m = machine({
      answers: { "claude plugin marketplace list --json": FAIL(said) },
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain(
      "this Claude Code has no `claude plugin` command; update Claude Code",
    );
  });

  // Review Focus 2.
  it("names the failed marketplace add and its words, after the browser line", () => {
    const m = machine({
      answers: {
        "claude plugin marketplace add demoman-io/plugins": FAIL(
          "fatal: unable to access 'https://github.com/demoman-io/plugins.git/': Could not resolve host: github.com",
        ),
      },
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain("browser: Chromium installed");
    expect(m.out()).toContain(
      "`claude plugin marketplace add demoman-io/plugins` failed (fatal: unable to access",
    );
    expect(m.calls).not.toContain("claude plugin install demoman@demoman");
  });

  it("refuses when the plugin it installed pins another version", () => {
    const m = machine({
      answers: {
        "claude plugin list --json": [OK("[]"), OK(PLUGIN("0.1.9"))],
      },
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain(
      "the plugin pins Demoman 0.1.9, and this setup is 0.2.0",
    );
  });

  it("refuses when the plugin is installed but disabled", () => {
    const m = machine({
      answers: {
        "claude plugin list --json": [OK("[]"), OK(PLUGIN("0.2.0", false))],
      },
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain("claude plugin enable demoman@demoman");
  });

  it("refuses when the install reported success but the plugin is not listed", () => {
    const m = machine({ answers: { "claude plugin list --json": OK("[]") } });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain("does not list demoman@demoman");
  });

  it("refuses a plugin list it cannot read", () => {
    const m = machine({
      answers: { "claude plugin list --json": OK("not json") },
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain("could not read its plugin list");
  });

  it("names a duplicate demoman server and the command that removes it, removing nothing", () => {
    const m = machine({
      readText: (p) =>
        p !== "/Users/u/.claude.json"
          ? { missing: true }
          : {
              text: JSON.stringify({
                mcpServers: {
                  demoman: {
                    command: "node",
                    args: ["/repo/apps/mcp/dist/index.js"],
                  },
                },
                projects: {
                  "/work/app": {
                    mcpServers: {
                      demoman: { command: "npx", args: ["demoman-mcp"] },
                    },
                  },
                },
              }),
            },
    });
    expect(setup(m.d)).toBe(0);
    expect(m.out()).toContain("node /repo/apps/mcp/dist/index.js");
    expect(m.out()).toContain("claude mcp remove demoman --scope user");
    expect(m.out()).toContain(
      "cd /work/app && claude mcp remove demoman --scope local",
    );
    expect(m.calls.some((c) => c.includes("mcp remove"))).toBe(false);
  });

  it("says an unreadable ~/.claude.json was not checked, and still succeeds", () => {
    const m = machine({
      readText: (p) =>
        p !== "/Users/u/.claude.json"
          ? { missing: true }
          : { error: "/Users/x/.claude.json: EACCES" },
    });
    expect(setup(m.d)).toBe(0);
    expect(m.out()).toContain(
      "duplicates were not checked (/Users/x/.claude.json: EACCES)",
    );
  });

  // Review fix: `claude plugin list --json` has one row per scope, and
  // setup installs at user scope; an older project-scope row listed first
  // must not decide the version check.
  it("checks the user-scope plugin row, not a project row listed first", () => {
    const rows = JSON.stringify([
      {
        id: "demoman@demoman",
        version: "0.1.9",
        enabled: true,
        scope: "project",
      },
      { id: "demoman@demoman", version: "0.2.0", enabled: true, scope: "user" },
    ]);
    const project = JSON.stringify([
      {
        id: "demoman@demoman",
        version: "0.1.9",
        enabled: true,
        scope: "project",
      },
    ]);
    const m = machine({
      answers: { "claude plugin list --json": [OK(project), OK(rows)] },
    });
    expect(setup(m.d)).toBe(0);
    // A project row alone is not this install: install, not update.
    expect(m.calls).toContain("claude plugin install demoman@demoman");
    expect(m.out()).toContain("the demoman plugin is installed (0.2.0)");
  });

  it("quotes a project path with a space in the command it hands over", () => {
    const m = machine({
      readText: (p) =>
        p !== "/Users/u/.claude.json"
          ? { missing: true }
          : {
              text: JSON.stringify({
                projects: {
                  "/Users/me/My Projects/app": {
                    mcpServers: {
                      demoman: { command: "npx", args: ["demoman-mcp"] },
                    },
                  },
                },
              }),
            },
    });
    expect(setup(m.d)).toBe(0);
    expect(m.out()).toContain(
      "cd '/Users/me/My Projects/app' && claude mcp remove demoman --scope local",
    );
  });

  it("names the signal that stopped a download, not 'exit null'", () => {
    const m = machine({
      runVisible: () => ({
        status: null,
        signal: "SIGINT",
        stdout: "",
        stderr: "",
      }),
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain("the download failed (stopped by SIGINT)");
    expect(m.out()).not.toContain("exit null");
  });

  it("says what threw and exits 1, instead of a stack trace", () => {
    const m = machine({
      chromiumInstalled: () => {
        throw new Error("no Chromium revision for mac-arm64");
      },
    });
    expect(setup(m.d)).toBe(1);
    expect(m.out()).toContain(
      "Demoman setup stopped: no Chromium revision for mac-arm64",
    );
  });

  it("says a failed warm start, and still succeeds", () => {
    const m = machine({
      answers: { "npx -y demoman@0.2.0 --version": FAIL("npm ERR! 404") },
    });
    expect(setup(m.d)).toBe(0);
    expect(m.out()).toContain(
      "warm start: skipped (demoman@0.2.0: npm ERR! 404)",
    );
    expect(m.out()).not.toContain("warm start: done");
  });

  // Launch E: the author ruled that Demoman's tools run without asking in
  // every agent, and that setup says so.
  it("pre-approves the plugin's tools in Claude Code's settings", () => {
    const m = machine();
    m.files.set(
      "/Users/u/.claude/settings.json",
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, theme: "dark" }),
    );
    expect(setup(m.d)).toBe(0);
    expect(
      JSON.parse(m.files.get("/Users/u/.claude/settings.json") ?? ""),
    ).toEqual({
      permissions: {
        allow: ["Bash(ls)", "mcp__plugin_demoman_demoman__*"],
      },
      theme: "dark",
      extraKnownMarketplaces: {
        demoman: {
          source: { source: "github", repo: "demoman-io/plugins" },
          autoUpdate: true,
        },
      },
    });
    expect(m.out()).toContain("its tools run without asking");
  });

  // Claude Code reads both files from CLAUDE_CONFIG_DIR when it is set; a
  // rule written to ~/.claude would leave every call asking (/code-review).
  it("writes the rule and checks duplicates where Claude Code reads them", () => {
    const m = machine({
      claude: {
        settings: "/Users/u/.claude-work/settings.json",
        config: "/Users/u/.claude-work/.claude.json",
        managed: MANAGED,
      },
    });
    m.files.set(
      "/Users/u/.claude-work/.claude.json",
      JSON.stringify({ mcpServers: { demoman: { command: "dev" } } }),
    );
    expect(setup(m.d)).toBe(0);
    expect(
      JSON.parse(m.files.get("/Users/u/.claude-work/settings.json") ?? ""),
    ).toEqual({
      permissions: { allow: ["mcp__plugin_demoman_demoman__*"] },
      extraKnownMarketplaces: {
        demoman: {
          source: { source: "github", repo: "demoman-io/plugins" },
          autoUpdate: true,
        },
      },
    });
    expect(m.files.has("/Users/u/.claude/settings.json")).toBe(false);
    expect(m.out()).toContain('a demoman server for every project ("dev")');
  });

  // Report before you forgive: the plugin works, so this is not a failure,
  // but a line that read like full success would hide the prompts to come.
  it("a settings.json it cannot parse leaves Claude Code partial, says so, and exits 0", () => {
    const m = machine();
    const broken = '{ "permissions": { "allow": [ } ';
    m.files.set("/Users/u/.claude/settings.json", broken);
    expect(setup(m.d)).toBe(0);
    expect(m.files.get("/Users/u/.claude/settings.json")).toBe(broken);
    expect(m.writes).not.toContain("/Users/u/.claude/settings.json");
    expect(m.out()).toContain(
      "Claude Code: the demoman plugin is installed (0.2.0), but its tools will ask before they run and it will not update itself (/Users/u/.claude/settings.json was left alone: it is not JSON (",
    );
    expect(m.out()).toContain(
      'To fix both, add "mcp__plugin_demoman_demoman__*" to permissions.allow and set "autoUpdate": true on extraKnownMarketplaces.demoman in /Users/u/.claude/settings.json',
    );
    // /code-review: one cause, said once, not once per edit.
    expect(m.out().split("it is not JSON").length - 1).toBe(1);
    expect(m.out()).not.toContain("its tools run without asking");
    expect(m.out()).not.toContain("updates itself");
    expect(m.out()).toContain("Restart Claude Code");
  });

  // Updates are the author's ruling of 2026-10-19: quiet, in every agent.
  // A third-party marketplace starts with them off in Claude Code.
  describe("Claude Code updates", () => {
    const SETTINGS = "/Users/u/.claude/settings.json";
    const OURS = { source: "github", repo: "demoman-io/plugins" };
    const settings = (m: ReturnType<typeof machine>) =>
      JSON.parse(m.files.get(SETTINGS) ?? "");

    it("turns them on for the entry `marketplace add` wrote", () => {
      const m = machine();
      m.files.set(
        SETTINGS,
        JSON.stringify({
          extraKnownMarketplaces: { demoman: { source: OURS } },
        }),
      );
      expect(setup(m.d)).toBe(0);
      expect(settings(m).extraKnownMarketplaces.demoman).toEqual({
        source: OURS,
        autoUpdate: true,
      });
      expect(m.out()).toContain(
        "Claude Code: the demoman plugin is installed (0.2.0) and updates itself; its tools run without asking",
      );
    });

    it("leaves the user's own false alone: partial, said, exit 0", () => {
      const m = machine();
      m.files.set(
        SETTINGS,
        JSON.stringify({
          extraKnownMarketplaces: {
            demoman: { source: OURS, autoUpdate: false },
          },
        }),
      );
      expect(setup(m.d)).toBe(0);
      expect(settings(m).extraKnownMarketplaces.demoman.autoUpdate).toBe(false);
      expect(m.out()).toContain(
        "Claude Code: the demoman plugin is installed (0.2.0); its tools run without asking, but it will not update itself (/Users/u/.claude/settings.json was left alone: autoUpdate is false on its extraKnownMarketplaces.demoman entry. To turn that on,",
      );
      expect(m.out()).not.toContain("updates itself;");
      expect(m.lines.at(-1)).toContain("Done. Restart Claude Code");
    });

    it("a settings.json it cannot write says what each edit lost", () => {
      const both = machine({ writeText: () => ({ error: "EACCES" }) });
      expect(setup(both.d)).toBe(0);
      expect(both.out()).toContain(
        "but its tools will ask before they run and it will not update itself (/Users/u/.claude/settings.json could not be written: EACCES). To fix both,",
      );
      expect(both.out()).not.toContain("updates itself");
      // The rule already there: only the update was lost to the write.
      const one = machine({ writeText: () => ({ error: "EACCES" }) });
      one.files.set(
        SETTINGS,
        JSON.stringify({
          permissions: { allow: ["mcp__plugin_demoman_demoman__*"] },
        }),
      );
      expect(setup(one.d)).toBe(0);
      expect(one.out()).toContain(
        "installed (0.2.0); its tools run without asking, but it will not update itself (/Users/u/.claude/settings.json could not be written: EACCES. To turn that on,",
      );
    });

    // /code-review: three reads and two writes of one file became one each.
    it("reads and writes settings.json once", () => {
      const m = machine();
      const reads: string[] = [];
      const read = m.d.readText;
      m.d.readText = (p) => {
        reads.push(p);
        return read(p);
      };
      expect(setup(m.d)).toBe(0);
      expect(reads.filter((p) => p === SETTINGS)).toHaveLength(1);
      expect(m.writes.filter((p) => p === SETTINGS)).toHaveLength(1);
      expect(settings(m)).toEqual({
        permissions: { allow: ["mcp__plugin_demoman_demoman__*"] },
        extraKnownMarketplaces: { demoman: { source: OURS, autoUpdate: true } },
      });
    });

    it("declares nothing over a demoman marketplace from another source", () => {
      const dir = {
        name: "demoman",
        source: "directory",
        path: "/Users/x/Code/demoman/apps/cli/plugin-out",
      };
      const m = machine({
        answers: {
          "claude plugin marketplace list --json": OK(JSON.stringify([dir])),
          "claude plugin marketplace update demoman": OK(),
        },
      });
      expect(setup(m.d)).toBe(0);
      expect(settings(m).extraKnownMarketplaces).toBeUndefined();
      expect(m.out()).toContain(
        'it will not update itself (/Users/u/.claude/settings.json was left alone: Claude Code\'s demoman marketplace is another one ({"source":"directory","path":"/Users/x/Code/demoman/apps/cli/plugin-out"})',
      );
    });

    it.each([
      ["DISABLE_AUTOUPDATER", "1"],
      ["DISABLE_UPDATES", "true"],
      ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
    ])("names %s in this shell, which stops the updates", (name, value) => {
      const m = machine({ env: { [name]: value } });
      expect(setup(m.d)).toBe(0);
      expect(settings(m).extraKnownMarketplaces.demoman.autoUpdate).toBe(true);
      expect(m.out()).toContain(
        `it will not update itself (${name} is set in this shell, which stops Claude Code's plugin updates. To update plugins anyway, set FORCE_AUTOUPDATE_PLUGINS=1 beside it)`,
      );
      expect(m.out()).not.toContain("updates itself");
    });

    it("names a switch in settings.json's env block, and a 0 is no switch", () => {
      const m = machine({ env: { DISABLE_UPDATES: "0" } });
      m.files.set(
        SETTINGS,
        JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }),
      );
      expect(setup(m.d)).toBe(0);
      expect(m.out()).toContain(
        "DISABLE_AUTOUPDATER is set in the env block of /Users/u/.claude/settings.json",
      );
      expect(m.out()).not.toContain("DISABLE_UPDATES");
    });

    // /code-review: a JSON 1 in an env block, and an admin's managed file.
    it("names a switch written as a number, and one in managed settings", () => {
      const number = machine();
      number.files.set(
        SETTINGS,
        JSON.stringify({ env: { DISABLE_AUTOUPDATER: 1 } }),
      );
      expect(setup(number.d)).toBe(0);
      expect(number.out()).toContain(
        "DISABLE_AUTOUPDATER is set in the env block of /Users/u/.claude/settings.json",
      );
      const managed = machine();
      managed.files.set(
        MANAGED,
        JSON.stringify({ env: { DISABLE_UPDATES: "1" } }),
      );
      expect(setup(managed.d)).toBe(0);
      expect(managed.out()).toContain(
        `it will not update itself (DISABLE_UPDATES is set in the env block of ${MANAGED}, which stops`,
      );
      expect(managed.out()).not.toContain("updates itself");
    });

    it("an unreadable managed settings file is said as unknown, not as on", () => {
      const m = machine();
      const read = m.d.readText;
      m.d.readText = (p) => (p === MANAGED ? { error: "EACCES" } : read(p));
      expect(setup(m.d)).toBe(0);
      expect(m.out()).toContain(
        `it will not update itself (whether ${MANAGED} stops plugin updates is unknown: it could not be read (EACCES))`,
      );
      expect(m.out()).not.toContain("updates itself");
    });

    it("FORCE_AUTOUPDATE_PLUGINS beside a switch keeps them on", () => {
      const m = machine({
        env: { DISABLE_AUTOUPDATER: "1", FORCE_AUTOUPDATE_PLUGINS: "1" },
      });
      expect(setup(m.d)).toBe(0);
      expect(m.out()).toContain("installed (0.2.0) and updates itself");
    });
  });

  it("one failed agent does not stop the next, and makes the exit 1", () => {
    const m = machine({
      answers: {
        "claude plugin install demoman@demoman": FAIL("boom"),
      },
    });
    expect(setup(m.d)).toBe(1);
    const out = m.out();
    expect(out.indexOf("Codex: not installed")).toBeGreaterThan(
      out.indexOf("`claude plugin install demoman@demoman` failed (boom)"),
    );
    expect(out).toContain("Cursor: not installed");
    expect(m.lines.at(-1)).toMatch(
      /^\nNot done: Claude Code could not be set up/,
    );
    expect(out).not.toContain("Done. Restart");
  });

  it("no agent at all exits 1 with the no-agent line, and skips the warm start", () => {
    const m = machine({
      answers: {
        "claude plugin marketplace list --json": {
          status: null,
          stdout: "",
          stderr: "",
          notFound: true,
        },
      },
    });
    expect(setup(m.d)).toBe(1);
    expect(m.lines.at(-1)).toContain(
      "No coding agent was found. Demoman works with Claude Code, Codex and Cursor",
    );
    expect(m.calls.some((c) => c.startsWith("npx"))).toBe(false);
    expect(m.out()).not.toContain("warm start");
  });

  describe("Codex", () => {
    const CODEX_LIST = (version: string, enabled = true) =>
      OK(
        JSON.stringify({
          installed: [
            {
              pluginId: "demoman@demoman",
              name: "demoman",
              marketplaceName: "demoman",
              version,
              installed: true,
              enabled,
            },
          ],
          available: [],
        }),
      );
    const ADDED = (alreadyAdded: boolean) =>
      OK(
        JSON.stringify({
          marketplaceName: "demoman",
          installedRoot: "/Users/u/.codex/.tmp/marketplaces/demoman",
          alreadyAdded,
        }),
      );
    const withCodex = (answers: Record<string, Ran | Ran[]> = {}) =>
      machine({
        answers: {
          "codex --version": OK("codex-cli 0.163.0\n"),
          "codex plugin marketplace add demoman-io/plugins --json":
            ADDED(false),
          "codex plugin add demoman@demoman --json": OK("{}"),
          "codex plugin list --json": CODEX_LIST("0.2.0"),
          ...answers,
        },
      });
    const CONFIG = "/Users/u/.codex/config.toml";

    it("wires Codex: marketplace, plugin, check, pre-approval", () => {
      const m = withCodex();
      m.files.set(CONFIG, 'model = "o5"\n');
      expect(setup(m.d)).toBe(0);
      expect(m.calls.filter((c) => c.startsWith("codex"))).toEqual([
        "codex --version",
        "codex plugin marketplace add demoman-io/plugins --json",
        "codex plugin add demoman@demoman --json",
        "codex plugin list --json",
      ]);
      expect(m.files.get(CONFIG)).toBe(
        `model = "o5"\n\n${CODEX_APPROVAL_TABLE}\n`,
      );
      expect(m.out()).toContain(
        "Codex: the demoman plugin is installed (0.2.0); its tools run without asking",
      );
      expect(m.lines.at(-1)).toContain("Restart Claude Code and Codex");
    });

    it("upgrades the marketplace when it was already added", () => {
      const m = withCodex({
        "codex plugin marketplace add demoman-io/plugins --json": ADDED(true),
        "codex plugin marketplace upgrade demoman --json": OK("{}"),
      });
      expect(setup(m.d)).toBe(0);
      expect(m.calls).toContain(
        "codex plugin marketplace upgrade demoman --json",
      );
    });

    it("refuses a Codex older than 0.163.0, naming both versions", () => {
      const m = withCodex({ "codex --version": OK("codex-cli 0.150.2\n") });
      expect(setup(m.d)).toBe(1);
      expect(m.out()).toContain(
        "Codex: this is Codex 0.150.2, and Demoman needs 0.163.0 or later",
      );
      expect(m.calls.some((c) => c.startsWith("codex plugin"))).toBe(false);
    });

    // A Codex that cannot answer is not an old one: telling the user to
    // update a current Codex hides the real cause (/code-review).
    it("names a failed `codex --version` instead of calling Codex old", () => {
      const m = withCodex({
        "codex --version": FAIL("Error loading config.toml: bad key"),
      });
      expect(setup(m.d)).toBe(1);
      expect(m.out()).toContain(
        "Codex: `codex --version` failed (Error loading config.toml: bad key)",
      );
      expect(m.out()).not.toContain("update Codex");
      expect(m.calls.some((c) => c.startsWith("codex plugin"))).toBe(false);
    });

    it("takes a newer Codex, major or minor", () => {
      for (const v of ["codex-cli 0.170.1\n", "codex-cli 1.0.0\n"]) {
        const m = withCodex({ "codex --version": OK(v) });
        expect(setup(m.d), v).toBe(0);
      }
    });

    it("does not believe an add that left no plugin in the list", () => {
      const m = withCodex({
        "codex plugin list --json": OK('{"installed":[],"available":[]}'),
      });
      expect(setup(m.d)).toBe(1);
      expect(m.out()).toContain(
        "Codex: the install reported success, but `codex plugin list` does not list demoman@demoman",
      );
      expect(m.files.has(CONFIG)).toBe(false);
    });

    it("a plugin at another version is failed, not wired", () => {
      const m = withCodex({ "codex plugin list --json": CODEX_LIST("0.1.9") });
      expect(setup(m.d)).toBe(1);
      expect(m.out()).toContain(
        "Codex: the plugin pins Demoman 0.1.9, and this setup is 0.2.0",
      );
      expect(m.out()).not.toContain("Codex: the demoman plugin is installed");
    });

    it("a disabled plugin is failed, with the fix", () => {
      const m = withCodex({
        "codex plugin list --json": CODEX_LIST("0.2.0", false),
      });
      expect(setup(m.d)).toBe(1);
      expect(m.out()).toContain("Codex: the plugin is installed but disabled");
    });

    it("names a failed marketplace add in Codex's words", () => {
      const m = withCodex({
        "codex plugin marketplace add demoman-io/plugins --json": FAIL(
          "Error: failed to clone https://github.com/demoman-io/plugins",
        ),
      });
      expect(setup(m.d)).toBe(1);
      expect(m.out()).toContain(
        "Codex: `codex plugin marketplace add demoman-io/plugins --json` failed (Error: failed to clone",
      );
    });

    it("an unparseable config.toml leaves Codex partial and prints the table", () => {
      const m = withCodex();
      m.files.set(CONFIG, "model = ");
      expect(setup(m.d)).toBe(0);
      expect(m.files.get(CONFIG)).toBe("model = ");
      expect(m.out()).toContain(
        "Codex: the demoman plugin is installed (0.2.0), but its tools will ask before they run (",
      );
      expect(m.out()).toContain(
        `add this to ${CONFIG}:\n\n${CODEX_APPROVAL_TABLE}`,
      );
    });

    it("honours CODEX_HOME", () => {
      const m = withCodex();
      const d = { ...m.d, codexHome: "/tmp/ch" };
      expect(setup(d)).toBe(0);
      expect(m.files.get("/tmp/ch/config.toml")).toBe(
        `${CODEX_APPROVAL_TABLE}\n`,
      );
    });

    it("Codex wired beside a failed Claude Code is named in the restart line", () => {
      const m = withCodex({
        "claude plugin install demoman@demoman": FAIL("boom"),
      });
      expect(setup(m.d)).toBe(1);
      expect(m.lines.at(-1)).toBe(
        "\nNot done: Claude Code could not be set up (above). Restart Codex to use Demoman there.",
      );
    });
  });

  describe("Cursor", () => {
    const MCP = "/Users/u/.cursor/mcp.json";
    const SKILL_FILE = "/Users/u/.cursor/skills/record-demo/SKILL.md";
    const CLI_CONFIG = "/Users/u/.cursor/cli-config.json";
    const APP = "/Applications/Cursor.app";
    const AGENT_VERSION = OK("2026.10.16-e3cb207\n");
    const withCli = (answers: Record<string, Ran | Ran[]> = {}) =>
      machine({
        answers: {
          "agent --version": AGENT_VERSION,
          "agent mcp enable demoman": OK("demoman approved\n"),
          ...answers,
        },
      });

    it("wires the Cursor CLI: entry, skill, enable, allow rule", () => {
      const m = withCli();
      m.files.set(
        CLI_CONFIG,
        JSON.stringify({
          permissions: { allow: ["Shell(ls)"], deny: [] },
          version: 1,
        }),
      );
      expect(setup(m.d)).toBe(0);
      expect(JSON.parse(m.files.get(MCP) ?? "")).toEqual({
        mcpServers: { demoman: cursorEntry("/opt/node/bin") },
      });
      expect(m.files.get(SKILL_FILE)).toBe(SKILL);
      expect(m.calls).toContain("agent mcp enable demoman");
      expect(JSON.parse(m.files.get(CLI_CONFIG) ?? "")).toEqual({
        permissions: { allow: ["Shell(ls)", "Mcp(demoman:*)"], deny: [] },
        version: 1,
      });
      expect(m.out()).toContain(
        "Cursor: Demoman is connected and updates itself; its tools run without asking",
      );
      expect(m.lines.at(-1)).toContain("Restart Claude Code and Cursor");
    });

    // npx caches demoman@latest apart from the pinned version the plugins
    // run, so warming one leaves Cursor's first start cold (measured 10.9 s).
    // /code-review: each spec on its own, and only the ones agents run.
    it("warms only @latest when Cursor is the only agent, and past a failure", () => {
      const only = withCli({
        "claude plugin marketplace list --json": NOT_FOUND,
      });
      expect(setup(only.d)).toBe(0);
      expect(only.calls.filter((c) => c.startsWith("npx"))).toEqual([
        "npx -y demoman@latest --version",
      ]);
      const pinnedFails = withCli({
        "npx -y demoman@0.2.0 --version": FAIL("npm ERR! 404"),
      });
      expect(setup(pinnedFails.d)).toBe(0);
      expect(pinnedFails.calls).toContain("npx -y demoman@latest --version");
      expect(pinnedFails.out()).toContain(
        "warm start: skipped (demoman@0.2.0: npm ERR! 404)",
      );
    });

    // /code-review: setup for a release under `next` alone leaves Cursor on
    // the older `latest`, and the answer that says so was in hand.
    it("says when Cursor will run another version than this setup", () => {
      const m = withCli({
        "npx -y demoman@latest --version": OK("0.1.9\n"),
      });
      expect(setup(m.d)).toBe(0);
      expect(m.out()).toContain(
        "Cursor: it runs Demoman 0.1.9, the newest release on npm, and this setup is 0.2.0.",
      );
      expect(m.out()).toContain("warm start: done");
      const same = withCli({
        "npx -y demoman@latest --version": OK("0.2.0\n"),
      });
      expect(setup(same.d)).toBe(0);
      expect(same.out()).not.toContain("Cursor: it runs Demoman");
    });

    it("warms Cursor's @latest beside the pinned version, and says a failure", () => {
      const ok = withCli();
      expect(setup(ok.d)).toBe(0);
      expect(ok.calls.filter((c) => c.startsWith("npx"))).toEqual([
        "npx -y demoman@0.2.0 --version",
        "npx -y demoman@latest --version",
      ]);
      expect(ok.out()).toContain("warm start: done");
      const cold = withCli({
        "npx -y demoman@latest --version": FAIL("npm ERR! network"),
      });
      expect(setup(cold.d)).toBe(0);
      expect(cold.out()).toContain(
        "warm start: skipped (demoman@latest: npm ERR! network)",
      );
      expect(cold.out()).not.toContain("warm start: done");
    });

    it("finds the agent CLI in ~/.local/bin when it is not on the PATH", () => {
      const m = machine({
        answers: {
          "/Users/u/.local/bin/agent --version": AGENT_VERSION,
          "/Users/u/.local/bin/agent mcp enable demoman": OK(),
        },
      });
      expect(setup(m.d)).toBe(0);
      expect(m.calls).toContain("/Users/u/.local/bin/agent mcp enable demoman");
    });

    // Final review: cursor-agent and ~/.local/bin/agent are Cursor's by
    // name, so one that does not answer is a failure to say, not absence.
    it.each([
      ["cursor-agent", "cursor-agent --version"],
      ["~/.local/bin/agent", "/Users/u/.local/bin/agent --version"],
    ])("a %s that fails --version is failed, not absent", (_, call) => {
      const m = machine({ answers: { [call]: FAIL("update required") } });
      expect(setup(m.d)).toBe(1);
      expect(m.out()).toContain(
        `Cursor: \`${call}\` did not answer as Cursor's agent CLI (update required)`,
      );
      expect(m.out()).not.toContain("Cursor: not installed");
    });

    // Another tool's ~/.local/bin/agent must not stop the app being wired
    // (/code-review, 2026-10-17): said, and the app still connected.
    it("a ~/.local/bin/agent that is not Cursor's is said, and the app is still wired", () => {
      const m = machine({
        answers: { "/Users/u/.local/bin/agent --version": OK("agent 0.4.1\n") },
      });
      m.files.set(APP, "");
      expect(setup(m.d)).toBe(0);
      expect(JSON.parse(m.files.get(MCP) ?? "").mcpServers.demoman).toEqual(
        cursorEntry("/opt/node/bin"),
      );
      expect(m.out()).toContain(
        'Cursor: `/Users/u/.local/bin/agent --version` did not answer as Cursor\'s agent CLI (it said "agent 0.4.1")',
      );
      expect(m.out()).toContain(
        "Cursor: Demoman is connected and updates itself, but",
      );
    });

    it("no npx beside the node running setup fails Cursor and writes nothing", () => {
      const m = withCli();
      m.files.delete("/opt/node/bin/npx");
      expect(setup(m.d)).toBe(1);
      expect(m.files.has(MCP)).toBe(false);
      expect(m.out()).toContain(
        "Cursor: there is no npx beside the Node running setup (/opt/node/bin/npx)",
      );
    });

    it("ignores an `agent` that is not Cursor's", () => {
      const m = machine({
        answers: { "agent --version": OK("agent 1.2.3\n") },
      });
      expect(setup(m.d)).toBe(0);
      expect(m.out()).toContain("Cursor: not installed");
      expect(m.files.has(MCP)).toBe(false);
    });

    // Task 1: the app keeps its MCP allow-list in a SQLite database, which
    // setup never writes; saying "without asking" there would be false.
    it("the app alone is partial, and says why", () => {
      const m = machine();
      m.files.set(APP, "");
      expect(setup(m.d)).toBe(0);
      expect(JSON.parse(m.files.get(MCP) ?? "").mcpServers.demoman).toEqual(
        cursorEntry("/opt/node/bin"),
      );
      expect(m.out()).toContain(
        "Cursor: Demoman is connected and updates itself, but in the Cursor app its tools may ask once each, because the app keeps its allow-list where setup cannot write it",
      );
      expect(m.out()).not.toContain(
        "Cursor: Demoman is connected and updates itself; its tools run without asking",
      );
    });

    it("a foreign demoman entry fails Cursor and leaves the file byte-identical", () => {
      const m = withCli();
      const dev = JSON.stringify({
        mcpServers: {
          demoman: { command: "node", args: ["/repo/apps/mcp/dist/index.js"] },
        },
      });
      m.files.set(MCP, dev);
      expect(setup(m.d)).toBe(1);
      expect(m.files.get(MCP)).toBe(dev);
      expect(m.out()).toContain(
        'Cursor: ~/.cursor/mcp.json already has a "demoman" server that setup did not write (node /repo/apps/mcp/dist/index.js), so it was left alone',
      );
      expect(m.calls).not.toContain("agent mcp enable demoman");
    });

    it("an unparseable mcp.json fails Cursor and prints the entry to paste", () => {
      const m = withCli();
      m.files.set(MCP, "{ nope");
      expect(setup(m.d)).toBe(1);
      expect(m.files.get(MCP)).toBe("{ nope");
      expect(m.out()).toContain('"demoman@latest"');
    });

    it("a foreign record-demo skill fails Cursor and is not overwritten", () => {
      const m = withCli();
      const theirs = "---\nname: record-demo\ndescription: x\n---\nUse OBS.\n";
      m.files.set(SKILL_FILE, theirs);
      expect(setup(m.d)).toBe(1);
      expect(m.files.get(SKILL_FILE)).toBe(theirs);
      expect(m.out()).toContain(
        "Cursor: ~/.cursor/skills/record-demo already holds a skill that is not Demoman's",
      );
    });

    it("replaces an older Demoman skill", () => {
      const m = withCli();
      m.files.set(
        SKILL_FILE,
        "---\nname: record-demo\n---\nOld Demoman words.\n",
      );
      expect(setup(m.d)).toBe(0);
      expect(m.files.get(SKILL_FILE)).toBe(SKILL);
    });

    // Without `mcp enable` the agent CLI never starts the server, so with no
    // app nothing can use Demoman: a failure, never "Done." (/code-review).
    it("a failed `agent mcp enable` with no app is failed, with the command to run", () => {
      const m = withCli({ "agent mcp enable demoman": FAIL("not logged in") });
      expect(setup(m.d)).toBe(1);
      expect(m.out()).toContain(
        "Cursor: `agent mcp enable demoman` failed (not logged in), so the agent CLI cannot use Demoman — run it yourself",
      );
      expect(m.out()).not.toContain("Cursor: Demoman is connected");
      expect(m.out()).not.toContain("Done.");
    });

    it("a failed `agent mcp enable` beside the app is partial, and says so", () => {
      const m = withCli({ "agent mcp enable demoman": FAIL("not logged in") });
      m.files.set(APP, "");
      expect(setup(m.d)).toBe(0);
      expect(m.out()).toContain(
        "Cursor: Demoman is connected and updates itself, but `agent mcp enable demoman` failed (not logged in), so the agent CLI cannot use Demoman — run it yourself",
      );
    });

    // Only Cursor uses the shipped skill: a broken install says so there
    // and stops nothing else (/code-review, 2026-10-17).
    it("a skill this install could not read fails Cursor alone", () => {
      const broken = { error: "/pkg/dist/skills/record-demo/SKILL.md: ENOENT" };
      const m = machine({
        skill: broken,
        answers: {
          "agent --version": AGENT_VERSION,
          "agent mcp enable demoman": OK(),
        },
      });
      expect(setup(m.d)).toBe(1);
      expect(m.out()).toContain(
        "Cursor: this install's record-demo skill could not be read (/pkg/dist/skills/record-demo/SKILL.md: ENOENT)",
      );
      expect(m.out()).toContain("its tools run without asking");
      expect(m.files.has(MCP)).toBe(false);
      expect(setup(machine({ skill: broken }).d)).toBe(0);
    });

    it("a second setup writes nothing", () => {
      const m = machine({
        answers: {
          "claude plugin list --json": OK(PLUGIN("0.2.0")),
          "claude plugin update demoman@demoman": OK(),
          "codex --version": OK("codex-cli 0.163.0\n"),
          "codex plugin marketplace add demoman-io/plugins --json": OK(
            JSON.stringify({ marketplaceName: "demoman", alreadyAdded: true }),
          ),
          "codex plugin marketplace upgrade demoman --json": OK("{}"),
          "codex plugin add demoman@demoman --json": OK("{}"),
          "codex plugin list --json": OK(
            JSON.stringify({
              installed: [
                {
                  pluginId: "demoman@demoman",
                  version: "0.2.0",
                  enabled: true,
                },
              ],
            }),
          ),
          "agent --version": AGENT_VERSION,
          "agent mcp enable demoman": OK(),
        },
      });
      m.files.set(APP, "");
      setup(m.d);
      expect(m.writes.length).toBeGreaterThanOrEqual(5);
      m.writes.length = 0;
      setup(m.d);
      expect(m.writes).toEqual([]);
    });
  });
});
