import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  addAllowRules,
  CODEX_APPROVAL_TABLE,
  codexApproval,
  cursorEntry,
  cursorServer,
  type Edit,
  isOurSkill,
  marketplaceAutoUpdate,
  NPX_PREFIX,
  opencodeEntry,
  opencodeServer,
} from "../src/configs.js";

const text = (e: Edit | { foreign: string }): string => {
  if (!("text" in e))
    throw new Error(`expected an edit, got ${JSON.stringify(e)}`);
  return e.text;
};
const approval = (toml: string): unknown =>
  (
    parse(toml) as {
      plugins?: Record<
        string,
        { mcp_servers?: Record<string, Record<string, unknown>> }
      >;
    }
  ).plugins?.["demoman@demoman"]?.mcp_servers?.demoman
    ?.default_tools_approval_mode;

describe("codexApproval", () => {
  it("appends the table to an absent, an empty and a populated file", () => {
    expect(text(codexApproval(null))).toBe(`${CODEX_APPROVAL_TABLE}\n`);
    expect(text(codexApproval(""))).toBe(`${CODEX_APPROVAL_TABLE}\n`);
    const original = 'model = "o5"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const out = text(codexApproval(original));
    expect(out.startsWith(original)).toBe(true);
    expect(approval(out)).toBe("approve");
    expect(parse(out)).toMatchObject({
      model: "o5",
      mcp_servers: { other: { command: "other" } },
    });
  });

  it("keeps comments and layout byte-identical outside the table", () => {
    const before = [
      "# my codex config",
      'model = "o5"   # the fast one',
      "",
      '[plugins."demoman@demoman".mcp_servers.demoman]',
      "# asked every time, for now",
      'default_tools_approval_mode = "prompt"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    const out = text(codexApproval(before));
    const a = before.split("\n");
    const b = out.split("\n");
    expect(b.length).toBe(a.length);
    const changed = a.flatMap((line, i) => (line === b[i] ? [] : [i]));
    expect(changed).toEqual([5]);
    expect(b[5]).toBe('default_tools_approval_mode = "approve"');
  });

  it("inserts the key into an existing table that lacks it", () => {
    const before =
      '[plugins."demoman@demoman".mcp_servers.demoman]\nenabled = true\n\n[other]\nx = 1\n';
    const out = text(codexApproval(before));
    expect(approval(out)).toBe("approve");
    expect(out).toContain("[other]\nx = 1\n");
    expect(
      out.match(/\[plugins\."demoman@demoman"\.mcp_servers\.demoman\]/g),
    ).toHaveLength(1);
  });

  it("is idempotent", () => {
    const once = text(codexApproval('model = "o5"\n'));
    expect(codexApproval(once)).toEqual({ text: once, changed: false });
  });

  // Appending the table beside either form would define it twice, and
  // Codex refuses to start on a config it cannot load (Task 1 findings).
  it("refuses a table it would duplicate", () => {
    for (const before of [
      '[plugins."demoman@demoman"]\nmcp_servers.demoman.default_tools_approval_mode = "prompt"\n',
      'plugins = { "demoman@demoman" = { enabled = true } }\n',
    ]) {
      const out = codexApproval(before);
      expect(out, before).toHaveProperty("refused");
    }
  });

  it("keeps CRLF and a missing final newline", () => {
    const out = text(codexApproval("a = 1\r\nb = 2"));
    expect(out.startsWith("a = 1\r\nb = 2\r\n")).toBe(true);
    expect(out).toContain(
      '\r\n[plugins."demoman@demoman".mcp_servers.demoman]\r\ndefault_tools_approval_mode = "approve"\r\n',
    );
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    expect(approval(out)).toBe("approve");
  });

  it("refuses unparseable TOML, quoting the parser", () => {
    const out = codexApproval("a = ");
    expect(out).toHaveProperty("refused");
    expect((out as { refused: string }).refused).toMatch(
      /line 1|invalid|unexpected/i,
    );
  });
});

describe("addAllowRules", () => {
  it("adds missing rules, keeps the rest, and is idempotent", () => {
    const before = JSON.stringify({
      permissions: { allow: ["Bash(ls)"], deny: ["X"] },
      model: "m",
    });
    const once = addAllowRules(before, ["R1", "R2"]);
    expect(once).toMatchObject({ changed: true });
    expect(JSON.parse(text(once))).toEqual({
      permissions: { allow: ["Bash(ls)", "R1", "R2"], deny: ["X"] },
      model: "m",
    });
    expect(text(once).endsWith("}\n")).toBe(true);
    expect(addAllowRules(text(once), ["R1", "R2"])).toEqual({
      text: text(once),
      changed: false,
    });
  });

  it("creates the file and the list when they are absent", () => {
    expect(JSON.parse(text(addAllowRules(null, ["R1"])))).toEqual({
      permissions: { allow: ["R1"] },
    });
    expect(JSON.parse(text(addAllowRules('{"a":1}', ["R1"])))).toEqual({
      a: 1,
      permissions: { allow: ["R1"] },
    });
  });

  it("treats a file's own `refused` key as data", () => {
    expect(JSON.parse(text(addAllowRules('{"refused":"x"}', ["R"])))).toEqual({
      refused: "x",
      permissions: { allow: ["R"] },
    });
  });

  it("refuses non-JSON and a non-array allow", () => {
    expect(addAllowRules("{ // hi\n}", ["R"])).toHaveProperty("refused");
    expect(addAllowRules("[]", ["R"])).toHaveProperty("refused");
    expect(
      addAllowRules('{"permissions":{"allow":"Bash(ls)"}}', ["R"]),
    ).toHaveProperty("refused");
    expect(
      addAllowRules('{"permissions":{"allow":[1]}}', ["R"]),
    ).toHaveProperty("refused");
  });
});

describe("marketplaceAutoUpdate", () => {
  const ours = { source: "github", repo: "demoman-io/plugins" };

  it("turns updates on for the entry `marketplace add` wrote, keeping the rest, and is idempotent", () => {
    const before = JSON.stringify({
      extraKnownMarketplaces: {
        demoman: { source: ours },
        cloudflare: { source: { source: "github", repo: "cloudflare/skills" } },
      },
      theme: "dark",
    });
    const once = marketplaceAutoUpdate(before);
    expect(once).toMatchObject({ changed: true });
    expect(JSON.parse(text(once))).toEqual({
      extraKnownMarketplaces: {
        demoman: { source: ours, autoUpdate: true },
        cloudflare: { source: { source: "github", repo: "cloudflare/skills" } },
      },
      theme: "dark",
    });
    expect(marketplaceAutoUpdate(text(once))).toEqual({
      text: text(once),
      changed: false,
    });
  });

  // A Claude Code whose `marketplace add` writes no declaration still reads
  // one setup writes, with the same source the add was given.
  it("declares the marketplace when the file or the entry is absent", () => {
    const declared = { demoman: { source: ours, autoUpdate: true } };
    expect(JSON.parse(text(marketplaceAutoUpdate(null)))).toEqual({
      extraKnownMarketplaces: declared,
    });
    expect(JSON.parse(text(marketplaceAutoUpdate('{"a":1}')))).toEqual({
      a: 1,
      extraKnownMarketplaces: declared,
    });
  });

  it("knows its own repo by a git URL and by any letter case", () => {
    for (const source of [
      { source: "github", repo: "Demoman-IO/plugins" },
      { source: "git", url: "https://github.com/demoman-io/plugins.git" },
      { source: "url", url: "git@github.com:demoman-io/plugins" },
    ]) {
      const out = marketplaceAutoUpdate(
        JSON.stringify({ extraKnownMarketplaces: { demoman: { source } } }),
      );
      expect(
        JSON.parse(text(out)).extraKnownMarketplaces.demoman,
        source.repo ?? source.url,
      ).toEqual({
        source,
        autoUpdate: true,
      });
    }
  });

  // /code-review: anchored only at the end, a mirror's path counted as ours.
  it("does not take a URL that only ends in its repo for its own", () => {
    for (const url of [
      "https://git.corp.example/mirrors/github.com/demoman-io/plugins",
      "https://notgithub.com/demoman-io/plugins",
      "https://github.com/demoman-io/plugins-fork",
    ]) {
      const out = marketplaceAutoUpdate(
        JSON.stringify({
          extraKnownMarketplaces: {
            demoman: { source: { source: "git", url } },
          },
        }),
      );
      expect(out, url).toHaveProperty("refused");
    }
    // The positive control beside it: the same shape, on github.com.
    expect(
      marketplaceAutoUpdate(
        JSON.stringify({
          extraKnownMarketplaces: {
            demoman: {
              source: {
                source: "git",
                url: "ssh://git@github.com/demoman-io/plugins.git",
              },
            },
          },
        }),
      ),
    ).toMatchObject({ changed: true });
  });

  // /code-review: with no settings entry, the declaration setup writes must
  // not re-point a marketplace Claude Code already has from another source.
  it("declares nothing over a listed marketplace of another source", () => {
    const dev = {
      name: "demoman",
      source: "directory",
      path: "/Users/x/Code/demoman/apps/cli/plugin-out",
      installLocation: "/Users/x/.claude/plugins/marketplaces/demoman",
    };
    expect(marketplaceAutoUpdate('{"a":1}', dev)).toEqual({
      refused:
        'Claude Code\'s demoman marketplace is another one ({"source":"directory","path":"/Users/x/Code/demoman/apps/cli/plugin-out"})',
    });
    const listed = {
      name: "demoman",
      source: "github",
      repo: "demoman-io/plugins",
    };
    expect(JSON.parse(text(marketplaceAutoUpdate('{"a":1}', listed)))).toEqual({
      a: 1,
      extraKnownMarketplaces: { demoman: { source: ours, autoUpdate: true } },
    });
    // A settings entry of our own outranks an odd row: that is the declaration.
    expect(
      marketplaceAutoUpdate(
        JSON.stringify({
          extraKnownMarketplaces: { demoman: { source: ours } },
        }),
        dev,
      ),
    ).toMatchObject({ changed: true });
  });

  // A false in settings.json was typed by someone: /plugin's toggle writes
  // known_marketplaces.json instead (code.claude.com/docs/en/plugins/loading).
  it("leaves the user's own false alone, and says so", () => {
    const off = JSON.stringify({
      extraKnownMarketplaces: { demoman: { source: ours, autoUpdate: false } },
    });
    expect(marketplaceAutoUpdate(off)).toEqual({
      refused:
        "autoUpdate is false on its extraKnownMarketplaces.demoman entry",
    });
  });

  it("leaves another marketplace named demoman alone, naming its source", () => {
    const dev = JSON.stringify({
      extraKnownMarketplaces: {
        demoman: {
          source: {
            source: "directory",
            path: "/Users/x/Code/demoman/apps/cli/plugin-out",
          },
        },
      },
    });
    expect(marketplaceAutoUpdate(dev)).toEqual({
      refused:
        'its extraKnownMarketplaces.demoman entry is another marketplace ({"source":"directory","path":"/Users/x/Code/demoman/apps/cli/plugin-out"})',
    });
  });

  it("refuses non-JSON and a non-object extraKnownMarketplaces or entry", () => {
    expect(marketplaceAutoUpdate("{,}")).toHaveProperty("refused");
    expect(
      marketplaceAutoUpdate('{"extraKnownMarketplaces":[]}'),
    ).toHaveProperty("refused");
    expect(
      marketplaceAutoUpdate('{"extraKnownMarketplaces":{"demoman":"x"}}'),
    ).toHaveProperty("refused");
  });
});

/** The entry setup wrote before Cursor updated itself: pinned to a
 *  version, with no DEMOMAN_CLIENT. */
const pinned = (bin: string, version: string) => ({
  type: "stdio" as const,
  command: `${bin}/npx`,
  args: ["-y", `demoman@${version}`, "mcp"],
  env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
});

describe("NPX_PREFIX", () => {
  it("points npm at home when no shell expands it", () => {
    // As the entries start it: argv straight to npm. Red with a bare "~",
    // which npm reads as <cwd>/~, a folder a repo can commit.
    const repo = mkdtempSync(join(tmpdir(), "demoman-prefix-"));
    const prefix = execFileSync("npm", [...NPX_PREFIX, "prefix"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(prefix).toBe(homedir());
  });
});

describe("cursorServer", () => {
  const entry = cursorEntry("/opt/node/bin");

  it("cursorEntry runs the newest demoman through an absolute npx with its node on PATH", () => {
    expect(cursorEntry("/opt/node/bin")).toEqual({
      type: "stdio",
      command: "/opt/node/bin/npx",
      // Red without NPX_PREFIX: the folder Cursor starts in chooses what
      // npx runs, through its node_modules or .npmrc (audit run 1).
      args: ["--prefix", "~/", "-y", "demoman@latest", "mcp"],
      env: {
        PATH: "/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        DEMOMAN_CLIENT: "cursor",
      },
    });
  });

  it("adds demoman beside other servers, keeping them", () => {
    const other = { command: "uvx", args: ["other"] };
    const out = cursorServer(JSON.stringify({ mcpServers: { other } }), entry);
    expect(out).toMatchObject({ changed: true });
    expect(JSON.parse(text(out))).toEqual({
      mcpServers: { other, demoman: entry },
    });
    expect(JSON.parse(text(cursorServer(null, entry)))).toEqual({
      mcpServers: { demoman: entry },
    });
  });

  it("rewrites its own older, pinned entry", () => {
    const old = pinned("/opt/node/bin", "0.2.0-rc.4");
    const out = cursorServer(
      JSON.stringify({ mcpServers: { demoman: old } }),
      entry,
    );
    expect(out).toMatchObject({ changed: true });
    expect(JSON.parse(text(out)).mcpServers.demoman).toEqual(entry);
    expect(cursorServer(text(out), entry)).toEqual({
      text: text(out),
      changed: false,
    });
  });

  // The README says to run setup after every update; a rewrite must not
  // cost the user a secret they added to the entry (/code-review).
  it("keeps the user's own env and fields when it rewrites its entry", () => {
    const old = {
      ...pinned("/old/bin", "0.2.0-rc.4"),
      env: { PATH: "/old/bin", DEMOMAN_SECRET_SELLER_PASSWORD: "s3cret" },
      timeout: 120,
    };
    const out = cursorServer(
      JSON.stringify({ mcpServers: { demoman: old } }),
      entry,
    );
    expect(out).toMatchObject({ changed: true });
    expect(JSON.parse(text(out)).mcpServers.demoman).toEqual({
      ...entry,
      env: { ...entry.env, DEMOMAN_SECRET_SELLER_PASSWORD: "s3cret" },
      timeout: 120,
    });
    expect(cursorServer(text(out), entry)).toEqual({
      text: text(out),
      changed: false,
    });
  });

  it("recognises the README block as its own", () => {
    const readme = {
      command: "npx",
      args: ["-y", "demoman@0.2.0-rc.4", "mcp"],
    };
    const out = cursorServer(
      JSON.stringify({ mcpServers: { demoman: readme } }),
      entry,
    );
    expect(JSON.parse(text(out)).mcpServers.demoman).toEqual(entry);
  });

  it("reports a foreign demoman entry and leaves it", () => {
    const dev = {
      command: "node",
      args: ["/Users/x/Code/demoman/apps/mcp/dist/index.js"],
    };
    expect(
      cursorServer(JSON.stringify({ mcpServers: { demoman: dev } }), entry),
    ).toEqual({ foreign: "node /Users/x/Code/demoman/apps/mcp/dist/index.js" });
  });

  // The user's own way to run the published package is theirs, not setup's.
  it("reports a demoman entry run by something other than npx", () => {
    const bunx = { command: "bunx", args: ["demoman@0.2.0", "mcp"] };
    expect(
      cursorServer(JSON.stringify({ mcpServers: { demoman: bunx } }), entry),
    ).toEqual({ foreign: "bunx demoman@0.2.0 mcp" });
  });

  it("refuses non-JSON and a non-object mcpServers", () => {
    expect(cursorServer("{,}", entry)).toHaveProperty("refused");
    expect(cursorServer('{"mcpServers":[]}', entry)).toHaveProperty("refused");
  });
});

describe("isOurSkill", () => {
  it("knows the shipped skill, and nothing else", () => {
    const shipped = readFileSync(
      new URL("../plugin/skills/record-demo/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(isOurSkill(shipped)).toBe(true);
    expect(
      isOurSkill("---\nname: record-demo\ndescription: x\n---\nUse OBS."),
    ).toBe(false);
    expect(isOurSkill("")).toBe(false);
  });
});

describe("opencodeServer", () => {
  const entry = opencodeEntry("/opt/node/bin");
  // The README's paste-in block and the author's own hand-written entry:
  // OpenCode's older flat form, pinned.
  const flat = (version: string) => ({
    type: "local",
    command: ["npx", "-y", `demoman@${version}`, "mcp"],
    enabled: true,
  });

  it("opencodeEntry runs the newest demoman through an absolute npx with its node on PATH", () => {
    expect(entry).toEqual({
      type: "local",
      command: [
        "/opt/node/bin/npx",
        "--prefix",
        "~/",
        "-y",
        "demoman@latest",
        "mcp",
      ],
      environment: {
        PATH: "/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        DEMOMAN_CLIENT: "opencode",
      },
    });
  });

  it("adds demoman under mcp.servers, keeping every other key and server in either form", () => {
    const pencil = { type: "local", command: ["pencil"], enabled: true };
    const other = { type: "local", command: ["other"] };
    const file = {
      $schema: "https://opencode.ai/config.json",
      model: "x/y",
      mcp: { pencil, servers: { other } },
    };
    const out = opencodeServer(JSON.stringify(file), entry);
    expect(out).toMatchObject({ changed: true });
    expect(JSON.parse(text(out))).toEqual({
      ...file,
      mcp: { pencil, servers: { other, demoman: entry } },
    });
    expect(JSON.parse(text(opencodeServer(null, entry)))).toEqual({
      mcp: { servers: { demoman: entry } },
    });
  });

  // A flat entry would sit shadowed beside the new one (OpenCode 2.0.32
  // runs mcp.servers' when both name demoman), so its own is moved.
  it("moves its own flat, pinned entry to mcp.servers, and then has nothing to do", () => {
    const out = opencodeServer(
      JSON.stringify({ mcp: { demoman: flat("0.2.0-rc.6") } }),
      entry,
    );
    expect(JSON.parse(text(out))).toEqual({
      mcp: { servers: { demoman: entry } },
    });
    expect(opencodeServer(text(out), entry)).toEqual({
      text: text(out),
      changed: false,
    });
  });

  it("keeps what the user added to its entry, setup's fields winning", () => {
    const mine = {
      ...entry,
      timeout: { startup: 20000 },
      environment: { DEMOMAN_NO_UPDATE_CHECK: "1", PATH: "/elsewhere" },
    };
    const out = opencodeServer(
      JSON.stringify({ mcp: { servers: { demoman: mine } } }),
      entry,
    );
    expect(JSON.parse(text(out)).mcp.servers.demoman).toEqual({
      ...entry,
      timeout: { startup: 20000 },
      environment: { DEMOMAN_NO_UPDATE_CHECK: "1", ...entry.environment },
    });
  });

  it("leaves another server named demoman alone, in either form", () => {
    const dev = {
      type: "local",
      command: ["node", "/src/demoman/dist/index.js"],
    };
    for (const file of [
      { mcp: { servers: { demoman: dev } } },
      { mcp: { demoman: dev } },
    ]) {
      expect(
        opencodeServer(JSON.stringify(file), entry),
        JSON.stringify(file),
      ).toEqual({
        foreign: "node /src/demoman/dist/index.js",
      });
    }
  });

  it("refuses a file it cannot read as a JSON object, and an mcp or servers that is not one", () => {
    for (const [file, why] of [
      ['{ // comments\n "mcp": {} }', "it is not JSON"],
      ["[]", "it is JSON, but not an object"],
      ['{"mcp": []}', "its mcp is not an object"],
      ['{"mcp": {"servers": 1}}', "its mcp.servers is not an object"],
    ] as const) {
      const out = opencodeServer(file, entry);
      expect(out, file).toHaveProperty("refused");
      expect((out as { refused: string }).refused, file).toContain(why);
    }
  });
});
