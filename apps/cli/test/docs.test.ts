import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Text-only guards over apps/docs. Nothing here imports apps/cli/src.
const docs = (p: string) => new URL(`../../docs/${p}`, import.meta.url);
const brand = (p: string) => new URL(`../../../brand/${p}`, import.meta.url);

type NavNode = string | { group?: string; pages?: NavNode[] };
type DocsJson = {
  logo: { light: string; dark: string; href?: string };
  favicon: string;
  colors: { primary: string; light: string; dark: string };
  navigation: { groups?: { group: string; pages: NavNode[] }[] };
};

const readDocs = (p: string): string => readFileSync(docs(p), "utf8");
const docsJson = (): DocsJson => JSON.parse(readDocs("docs.json")) as DocsJson;

const allPages = (): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(docs(dir), { withFileTypes: true }).flatMap((e) => {
      const rel = dir === "" ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory())
        return e.name.startsWith(".") || e.name === "node_modules"
          ? []
          : walk(rel);
      return rel.endsWith(".mdx") ? [rel.slice(0, -".mdx".length)] : [];
    });
  return walk("").sort();
};

const flatten = (node: unknown): string[] => {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (node && typeof node === "object")
    return Object.values(node).flatMap(flatten);
  return [];
};
// Every string slug anywhere under navigation, group names excluded.
const navPages = (): string[] => {
  const slugs = (node: NavNode): string[] =>
    typeof node === "string"
      ? [node]
      : (node.pages ?? []).flatMap((n) => slugs(n));
  return (docsJson().navigation.groups ?? []).flatMap((g) => slugs(g));
};
const groups = (j: DocsJson) => j.navigation.groups ?? [];

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
};

describe("apps/docs navigation", () => {
  it("names every page that exists, and only those", () => {
    // the sidebar of 2026-10-19: conventional groups, short noun titles
    expect(allPages().length).toBeGreaterThanOrEqual(15);
    expect(flatten(docsJson().navigation).length).toBeGreaterThan(0);
    expect(new Set(navPages())).toEqual(new Set(allPages()));
  });
  it("has the six groups of the sidebar, in order, CLI before Studio", () => {
    expect(groups(docsJson()).map((g) => g.group)).toEqual([
      "Getting started",
      "Guides",
      "CLI",
      "Studio",
      "Security & privacy",
      "Resources",
    ]);
  });
  it("connects agents on one page, after the Quickstart", () => {
    expect(groups(docsJson())[0]?.pages).toEqual([
      "index",
      "quickstart",
      "agents",
    ]);
  });
  it("titles each page with a short label: at most four words, no question", () => {
    for (const p of allPages()) {
      const title = /^title: "([^"]+)"$/m.exec(readDocs(`${p}.mdx`))?.[1];
      expect(title, p).toBeDefined();
      expect(title?.split(" ").length, `${p}: ${title}`).toBeLessThanOrEqual(4);
      expect(title, p).not.toMatch(/^(What|How|Why|Where)\b|\?/);
    }
  });
});

describe("no Mintlify starter left", () => {
  it("links nowhere on mintlify.com but its schema", () => {
    const raw = readDocs("docs.json").replace(/"\$schema":\s*"[^"]+"/, "");
    expect(raw).not.toMatch(/mintlify\.com/);
    expect(raw).not.toMatch(/app\.mintlify|Dashboard/);
  });
  it("carries no starter page text", () => {
    expect(allPages().length).toBeGreaterThan(0);
    for (const p of allPages()) {
      expect(readDocs(`${p}.mdx`), p).not.toMatch(
        /support@mintlify\.com|Welcome to your project|mintlify\.com\/docs/,
      );
    }
  });
});

describe("brand copies", () => {
  // The logos are the wordmark, as demoman.io's header sets it:
  // brand/wordmark.svg's outlines, filled with each theme's ink.
  it.each([
    ["logo/light.svg", "#0a0a0a"],
    ["logo/dark.svg", "#f4f4f5"],
  ])("%s is the wordmark, filled %s", (copy, fill) => {
    const wordmark = readFileSync(brand("wordmark.svg"), "utf8");
    const d = wordmark.match(/<path fill="currentColor" d="([^"]+)"/)?.[1];
    // The premise: the outlines were found, all seven letters' worth.
    expect(d?.match(/Z/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    const logo = readDocs(copy);
    expect(logo).toContain(`<path fill="${fill}" d="${d}"/>`);
    expect(logo.match(/viewBox="[^"]+"/)?.[0]).toBe(
      wordmark.match(/viewBox="[^"]+"/)?.[0],
    );
  });
  it("docs.json points at those copies", () => {
    expect(docsJson().logo).toMatchObject({
      light: "/logo/light.svg",
      dark: "/logo/dark.svg",
    });
    expect(docsJson().favicon).toBe("/favicon.png");
  });
});

describe("palette", () => {
  it("light-mode accent clears AA on white, dark-mode accent on the site's #0a0a0a", () => {
    const c = docsJson().colors;
    expect(contrast(c.primary, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.light, "#0a0a0a")).toBeGreaterThanOrEqual(4.5);
    expect(c.light.toLowerCase()).toBe("#cdeb45");
  });
});

const VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

// Read as text: main.ts runs the CLI on import.
const usageCommands = (): Set<string> => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const usage = /const USAGE = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
  const words = [...usage.matchAll(/^\s+(?:npx )?demoman ([^\s<[]+)/gm)].map(
    (m) => m[1] as string,
  );
  return new Set(words);
};
const siteCommands = (): Array<{ page: string; command: string }> =>
  allPages().flatMap((page) =>
    [
      ...readDocs(`${page}.mdx`).matchAll(
        /npx (?:-y )?demoman(?:@\S+)? ([^\s`"']+)/g,
      ),
    ].map((m) => ({ page, command: m[1] as string })),
  );

describe("version pins", () => {
  const pins = (page: string) =>
    readDocs(`${page}.mdx`).match(/demoman@[^\s"',`/)\]]+/g) ?? [];
  // Every block an agent runs updates itself (the author's ruling,
  // 2026-10-19): npx re-resolves @latest on each start. Only the License
  // page names a version, the files of the one it describes.
  it("every MCP block on the site runs demoman@latest, and the agents page has a block per agent", () => {
    const blocks = allPages()
      .filter((p) => p !== "resources/license")
      .flatMap(pins);
    expect(blocks.length).toBeGreaterThan(0);
    expect(new Set(blocks)).toEqual(new Set(["demoman@latest"]));
    const connect = readDocs("agents.mdx");
    // OpenCode, Pi, Kimi Code, Hermes, DeepSeek dsh, Other
    expect(connect.match(/demoman@/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });
  it("the License page links this version's files", () => {
    const license = pins("resources/license");
    expect(license.length).toBe(2);
    expect(new Set(license)).toEqual(new Set([`demoman@${VERSION}`]));
  });
});

describe("the paste-in blocks moved, not lost", () => {
  it("gives each agent setup does not reach a tab, and the skill once", () => {
    const connect = readDocs("agents.mdx");
    for (const a of [
      "OpenCode",
      "Pi",
      "Kimi Code",
      "Hermes",
      "DeepSeek dsh",
      "Other",
    ])
      expect(connect, a).toContain(`<Tab title="${a}">`);
    expect(connect).toContain(`"args": ["-y", "demoman@latest", "mcp"]`);
    const skill =
      "https://raw.githubusercontent.com/demoman-io/plugins/main/skills/record-demo/SKILL.md";
    expect(connect.split(skill).length - 1).toBe(1);
    expect(connect).toContain("expected to work, not yet run");
  });
  it("gives each agent setup connects a row, and says the shared steps once", () => {
    const connect = readDocs("agents.mdx");
    for (const [agent, adds] of [
      ["Claude Code", "the Demoman plugin"],
      ["Codex", "the Demoman plugin"],
      ["Cursor", "`~/.cursor/mcp.json`"],
    ] as const)
      expect(connect, agent).toMatch(
        new RegExp(
          `^\\| ${agent} \\| [^\\n]*${adds.replace(/[.*+?^${}()|[\]\\`~/]/g, "\\$&")}`,
          "m",
        ),
      );
    for (const once of ["updates itself in each agent", "run without asking"])
      expect(connect.split(once).length - 1, once).toBe(1);
  });
});

describe("the README's new shape", () => {
  const readme = () =>
    readFileSync(new URL("../README.md", import.meta.url), "utf8");
  it("links to the docs and keeps the generic block, on @latest", () => {
    expect(readme()).toContain("https://demoman.io/docs");
    expect(readme()).toContain(`"args": ["-y", "demoman@latest", "mcp"]`);
    // Exactly one: the generic block. A pasted second block is a second.
    expect(readme().match(/demoman@[^\s"',`/)\]]+/g)).toEqual([
      "demoman@latest",
    ]);
  });
  it("deep-links only to pages the docs navigation names", () => {
    // The npm README is frozen per version: a renamed slug 404s for good.
    const links = [
      ...readme().matchAll(/https:\/\/demoman\.io\/docs\/([^\s)#?"']+)/g),
    ].map((m) => (m[1] as string).replace(/\/+$/, ""));
    expect(links.length).toBeGreaterThanOrEqual(3);
    const nav = new Set(navPages());
    for (const slug of links) expect(nav, slug).toContain(slug);
  });
  it("carries no paste-in block", () => {
    for (const a of ["OpenCode", "Pi", "Kimi Code", "Hermes", "DeepSeek"])
      expect(readme(), a).not.toContain(`**${a}`);
    expect(readme()).not.toContain("raw.githubusercontent.com");
  });
});

describe("commands", () => {
  it("USAGE is read as text and lists the commands the docs may use", () => {
    expect([...usageCommands()].sort()).toEqual(
      ["--version", "mcp", "setup", "signin", "studio"].sort(),
    );
  });
  it("every npx demoman command on the site is one USAGE lists", () => {
    const seen = siteCommands();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    // The Quickstart's own setup step, not only the agents pages'.
    expect(
      seen.filter((s) => s.page === "quickstart").map((s) => s.command),
    ).toContain("setup");
    for (const { page, command } of seen)
      expect(usageCommands(), `${page}: ${command}`).toContain(command);
  });
});

describe("agentic only", () => {
  it("no page shows script syntax", () => {
    expect(allPages().length).toBeGreaterThan(0);
    for (const p of allPages())
      expect(readDocs(`${p}.mdx`), p).not.toMatch(
        /scriptVersion|"steps"\s*:|look\.canvas|\{secret:/,
      );
  });
});

describe("apps behind a login", () => {
  it("carries signin, demo accounts and the CI secret pair", () => {
    const t = readDocs("guides/authentication.mdx");
    for (const s of [
      "npx demoman signin https://",
      "npx demoman signin --account",
      ".demoman/accounts.json",
      ".demoman/secrets.env",
      "DEMOMAN_SECRET_",
      "_ORIGIN",
      "Codex does",
      "never asks for your own password",
    ])
      expect(t, s).toContain(s);
  });
});

describe("the CLI's commands page", () => {
  const page = () => readDocs("cli/commands.mdx");
  it("has a heading for every command USAGE lists", () => {
    const commands = [...usageCommands()];
    expect(commands.length).toBeGreaterThanOrEqual(5);
    // A flag heading is in code: Mintlify turns a bare "--" into a dash.
    for (const c of commands)
      expect(page(), c).toMatch(
        new RegExp(c.startsWith("-") ? `^## \`${c}\`$` : `^## ${c}$`, "m"),
      );
  });
  // Every flag the CLI parses, read from its source. --serve is left out:
  // it is how the studio starts its own server, never typed by a person.
  it("names every flag the CLI parses", () => {
    const src = (f: string) =>
      readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const flags = new Set([
      ...[
        ...src("main.ts").matchAll(
          /^\s+"?([a-z-]+)"?: \{ type: "(?:boolean|string)" \}/gm,
        ),
      ].map((m) => `--${m[1]}`),
      ...[...src("studio-args.ts").matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]),
    ]);
    flags.delete("--serve");
    // The premise: mcp's two flags, signin's three, and studio's --stop.
    expect(flags.size).toBeGreaterThanOrEqual(6);
    for (const f of flags) expect(page(), f).toContain(`\`${f}`);
  });
});

describe("the pull requests page", () => {
  const page = () => readDocs("guides/pull-requests.mdx");
  it("names the three settings, the repo file and its key", () => {
    for (const v of ["Off", "Ask", "Attach"])
      expect(page(), v).toMatch(new RegExp(`^\\| ${v} \\|`, "m"));
    expect(page()).toContain(".demoman/config.json");
    expect(page()).toContain('"pullRequests": "attach"');
    expect(page()).toContain("Settings → Pull requests");
  });
  // Red if the page says Ask writes `No demo:` too: the recipe keeps that
  // line to Attach (author, 2026-10-22).
  it("keeps the No demo: line to Attach", () => {
    expect(page()).toMatch(
      /With\s+Attach, a pull request without a video gets one line/,
    );
    expect(page()).toMatch(
      /With Ask,[^.]*adds nothing to a pull request without a video/,
    );
  });
  it("asks for the gh version attach checks for", () => {
    const gh = readFileSync(
      new URL("../../runner/src/executor/gh.ts", import.meta.url),
      "utf8",
    );
    const min = /MIN_GH_VERSION = \[(\d+), (\d+), (\d+)\]/.exec(gh);
    // The premise: the constant was found where attach reads it.
    expect(min).not.toBeNull();
    expect(page()).toContain(`\`gh\` ${min?.slice(1).join(".")} or later`);
  });
});

describe("studio and export", () => {
  it("the studio overview names the open and stop commands", () => {
    const t = readDocs("studio/overview.mdx");
    expect(t).toContain("npx demoman studio");
    expect(t).toContain("npx demoman studio --stop");
  });
  it("the exporting page names where files land and the formats", () => {
    const t = readDocs("guides/export.mdx");
    for (const s of ["~/Downloads", "--out-dir", "9:16", "GIF"])
      expect(t, s).toContain(s);
    expect(t).toContain(`"demoman@latest", "mcp", "--out-dir"`);
    expect(t).not.toContain("/agents/");
  });
});

// Its claims are checked against the disclosure in the author's internal repo
// (internal/site/test/product-docs.test.mjs): the disclosure is not public.
describe("the trust page", () => {
  it("names no source file", () => {
    expect(readDocs("security/data.mdx")).not.toMatch(
      /\b(src|apps|packages)\/|\.ts\b/,
    );
  });
});

describe("help", () => {
  it("the changelog has an entry labelled exactly this release", () => {
    // The label, not a substring: 0.2.0 is inside "0.2.0-rc.7".
    expect(readDocs("resources/changelog.mdx")).toContain(`label="${VERSION}"`);
  });
  it("privacy links out to demoman.io/privacy", () => {
    expect(readDocs("security/privacy.mdx")).toContain(
      "https://demoman.io/privacy",
    );
  });
});
