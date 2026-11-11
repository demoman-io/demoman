import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changelogEntries } from "../../../scripts/changelog.mjs";
import { NODE_FLOORS } from "../scripts/node-floor.mjs";

// Text-only guards over apps/docs. Nothing here imports apps/cli/src.
const docs = (p: string) => new URL(`../../docs/${p}`, import.meta.url);
const brand = (p: string) => new URL(`../../../brand/${p}`, import.meta.url);

type NavNode = string | { group?: string; pages?: NavNode[] };
type DocsJson = {
  logo: { light: string; dark: string; href?: string };
  favicon: string;
  colors: { primary: string; light: string; dark: string };
  navigation: { groups?: { group: string; pages: NavNode[] }[] };
  redirects?: { source: string; destination: string }[];
};

// The setup path (spec 2026-11-08-docs-rework): Introduction, then six steps.
const GET_STARTED = [
  "index",
  "get-started/install",
  "get-started/connect",
  "get-started/first-video",
  "get-started/sign-in",
  "get-started/add-to-repo",
  "get-started/ci",
];
// Old slug → the page that now holds its content. README links and
// bookmarks still point at the old ones.
const MOVED: Array<[string, string]> = [
  ["quickstart", "get-started/install"],
  ["agents", "get-started/connect"],
  ["guides/authentication", "get-started/sign-in"],
  ["guides/repo-flows", "get-started/add-to-repo"],
  ["guides/keep-videos-current", "get-started/ci"],
  ["cli/commands", "reference/cli"],
];
// Every section anchor of the two old guides, read from their last versions
// (`git show 1fcda6ed:apps/docs/guides/repo-flows.mdx`,
// `git show 6f3c60d1^:apps/docs/guides/keep-videos-current.mdx`). Bookmarks
// and old links carry these; old-anchors.js sends each on (DEM-96).
const OLD_ANCHORS: Record<string, string[]> = {
  "guides/repo-flows": [
    "add-a-flow",
    "from-the-studio",
    "refresh",
    "commit-no-video",
    "run-it-in-ci",
    "demomanappjson",
    "pinned-dates",
    "the-self-check",
    "stops",
    "the-pull-request-route",
    "the-main-route",
    "no-loop",
  ],
  "guides/keep-videos-current": [
    "keep-a-flow",
    "refresh",
    "commit-no-video",
    "run-it-on-every-merge",
    "the-pull-request-route",
    "the-main-route",
    "no-loop",
  ],
};
/** Mintlify's heading anchor, as `mint dev` renders it (checked on every
 *  page, 2026-11-09): link targets and markup dropped, smart punctuation
 *  outside code (' to ’, -- to —, both kept), lowercase, ASCII punctuation
 *  but `-` and `_` removed, each space a dash, end dashes trimmed.
 *  shortcut: a repeated heading's suffix is not modelled; none repeats yet. */
const slugOf = (heading: string): string =>
  heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/`([^`]*)`|[^`]+/g, (part, code) =>
      code !== undefined
        ? code
        : part.replace(/'/g, "\u2019").replace(/--/g, "\u2014"),
    )
    .trim()
    .toLowerCase()
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, "")
    .replace(/\s/g, "-")
    .replace(/^-+|-+$/g, "");
const anchorCache = new Map<string, Set<string>>();
/** Every anchor a page answers to: its headings (outside code fences) and
 *  its explicit ids. */
const anchorsOf = (page: string): Set<string> => {
  const cached = anchorCache.get(page);
  if (cached) return cached;
  const src = readDocs(`${page}.mdx`).replace(/^```[\s\S]*?^```/gm, "");
  const found = new Set([
    ...[...src.matchAll(/^#{2,4} (.+)$/gm)].map((m) => slugOf(m[1] as string)),
    ...[...src.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] as string),
  ]);
  anchorCache.set(page, found);
  return found;
};
/** Where old-anchors.js sends a reader who arrives at `path` + `hash`: the
 *  path it replaces the location with, or null when it leaves them be. */
const oldAnchorLanding = (path: string, hash: string): string | null => {
  let to: string | null = null;
  const location = {
    pathname: path,
    hash,
    replace: (u: string) => {
      to = u;
    },
  };
  new Function("location", readDocs("old-anchors.js"))(location);
  return to;
};
// Only these pages may show a DemoScript's syntax.
const SCRIPT_PAGES = [
  "concepts/flows",
  "reference/demoscript",
  "reference/accounts-json",
];

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
  it("has the six groups of the sidebar, in order", () => {
    expect(groups(docsJson()).map((g) => g.group)).toEqual([
      "Get started",
      "Concepts",
      "Guides",
      "Reference",
      "Security & privacy",
      "Resources",
    ]);
  });
  it("walks a stranger from install to CI, in order", () => {
    expect(groups(docsJson())[0]?.pages).toEqual(GET_STARTED);
  });
  it("redirects every moved page to the one that holds its content", () => {
    const redirects = new Map(
      (docsJson().redirects ?? []).map((r) => [r.source, r.destination]),
    );
    const nav = new Set(navPages());
    for (const [from, to] of MOVED) {
      expect(redirects.get(`/${from}`), from).toBe(`/${to}`);
      expect(nav, to).toContain(to);
      expect(allPages(), from).not.toContain(from);
    }
  });
  it("sends each old guide section on to the section that holds it now", () => {
    const moved = new Map(MOVED);
    const nav = new Set(navPages());
    let sent = 0;
    let kept = 0;
    for (const [from, anchors] of Object.entries(OLD_ANCHORS)) {
      const dest = moved.get(from) as string;
      expect(dest, from).toBeDefined();
      for (const a of anchors) {
        const landing = oldAnchorLanding(`/docs/${dest}`, `#${a}`);
        if (anchorsOf(dest).has(a)) {
          // The destination has this section itself: nothing to send on.
          expect(landing, `/${from}#${a}`).toBeNull();
          kept += 1;
          continue;
        }
        expect(
          landing,
          `/${from}#${a} stays at the top of /${dest}`,
        ).not.toBeNull();
        const [path, anchor] = (landing as string).split("#");
        expect(path, `/${from}#${a}`).toMatch(/^\/docs\//);
        const page = (path as string).slice("/docs/".length);
        expect(nav, `/${from}#${a} → ${landing}`).toContain(page);
        if (anchor)
          expect(anchorsOf(page), `/${from}#${a} → ${landing}`).toContain(
            anchor,
          );
        sent += 1;
      }
    }
    // Premise: both branches ran, and the script fires only on old anchors.
    expect(sent).toBeGreaterThan(10);
    expect(kept).toBeGreaterThan(0);
    expect(oldAnchorLanding("/docs/get-started/ci", "#set-it-up")).toBeNull();
    expect(oldAnchorLanding("/docs/reference/cli", "#stops")).toBeNull();
    // `mint dev` serves the docs with no base path.
    expect(oldAnchorLanding("/get-started/add-to-repo", "#stops")).toBe(
      "/reference/refusals#setting-up-ci",
    );
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
  // The logos are demoman.io's header lockup: brand/logomark.svg's figure,
  // cropped as the site's header crops it, beside brand/wordmark.svg's
  // outlines, each filled with the theme's ink.
  it.each([
    ["logo/light.svg", "#0a0a0a"],
    ["logo/dark.svg", "#f4f4f5"],
  ])("%s is the figure beside the wordmark, filled %s", (copy, fill) => {
    const wordmark = readFileSync(brand("wordmark.svg"), "utf8");
    const d = wordmark.match(/<path fill="currentColor" d="([^"]+)"/)?.[1];
    const figure = readFileSync(brand("logomark.svg"), "utf8").match(
      /<g fill="currentColor">([\s\S]*)<\/g>\s*<\/svg>/,
    )?.[1];
    // The premise: the outlines were found, all seven letters' worth, and
    // the figure's head and three blocks.
    expect(d?.match(/Z/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(figure?.match(/<rect /g)?.length).toBe(3);
    const logo = readDocs(copy);
    expect(logo).toContain(`<path fill="${fill}" d="${d}"/>`);
    expect(logo).toContain(`<g fill="${fill}">${figure}</g>`);
    // The site header's crop of the figure, and the wordmark's own box.
    expect(logo).toContain('viewBox="258 120 96 302"');
    expect(logo).toContain(wordmark.match(/viewBox="[^"]+"/)?.[0]);
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
  // The site's tokens (internal/site/public/style.css), and dark ones derived
  // from them, in apps/docs/style.css.
  const tokens = (mode: "light" | "dark") => {
    const css = readDocs("style.css");
    const block =
      mode === "light"
        ? /:root\s*\{([^}]*)\}/.exec(css)?.[1]
        : /:root\.dark\s*\{([^}]*)\}/.exec(css)?.[1];
    return Object.fromEntries(
      [...(block ?? "").matchAll(/--dm-([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map(
        (m) => [m[1], (m[2] as string).toLowerCase()],
      ),
    ) as Record<string, string>;
  };
  it("is the site's monochrome: black on white, white on #0a0a0a", () => {
    const c = docsJson().colors;
    expect(c.primary.toLowerCase()).toBe("#0a0a0a");
    expect(contrast(c.primary, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.light, "#0a0a0a")).toBeGreaterThanOrEqual(4.5);
    expect(tokens("light").bg).toBe("#ffffff");
    expect(tokens("light").ink).toBe("#0a0a0a");
    expect(tokens("dark").bg).toBe("#0a0a0a");
  });
  it("every text token clears AA on its background, in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      const t = tokens(mode);
      // Premise: the block was read.
      expect(Object.keys(t).length, mode).toBeGreaterThanOrEqual(5);
      for (const k of ["ink", "ink-2", "ink-3"])
        expect(
          contrast(t[k] as string, t.bg as string),
          `${mode} ${k}`,
        ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("the setup strip", () => {
  it("each Get started step draws the strip at its own position", () => {
    GET_STARTED.slice(1).forEach((page, i) => {
      const t = readDocs(`${page}.mdx`);
      expect(t, page).toContain(
        'import { SetupPath } from "/snippets/setup-path.jsx";',
      );
      expect(t, page).toContain(`<SetupPath step={${i + 1}} />`);
    });
  });
  it("the strip names the six steps in order, linked relative to their own folder", () => {
    // The docs live under demoman.io/docs; a root-relative href in a snippet
    // is not rewritten to the base path, so the strip links ./<page>.
    const jsx = readDocs("snippets/setup-path.jsx");
    const pages = [...jsx.matchAll(/page: "([a-z-]+)"/g)].map(
      (m) => `get-started/${m[1]}`,
    );
    expect(pages).toEqual(GET_STARTED.slice(1));
    expect(jsx).toMatch(/href=\{`\.\/\$\{s\.page\}`\}/);
    expect(jsx).not.toMatch(/href[:=]\s*["{`]*\//);
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
    const connect = readDocs("get-started/connect.mdx");
    // Pi, Kimi Code, Hermes, DeepSeek dsh, Other
    expect(connect.match(/demoman@/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
  it("the License page links this version's files", () => {
    const license = pins("resources/license");
    expect(license.length).toBe(2);
    expect(new Set(license)).toEqual(new Set([`demoman@${VERSION}`]));
  });
});

describe("the paste-in blocks moved, not lost", () => {
  it("gives each agent setup does not reach a tab, and the skill once", () => {
    const connect = readDocs("get-started/connect.mdx");
    for (const a of ["Pi", "Kimi Code", "Hermes", "DeepSeek dsh", "Other"])
      expect(connect, a).toContain(`<Tab title="${a}">`);
    expect(connect).toContain(
      `"args": ["--prefix", "~/", "-y", "demoman@latest", "mcp"]`,
    );
    const skill =
      "https://raw.githubusercontent.com/demoman-io/plugins/main/skills/record-demo/SKILL.md";
    expect(connect.split(skill).length - 1).toBe(1);
    expect(connect).toContain("expected to work, not yet run");
  });
  it("gives each agent setup connects a row, and says the shared steps once", () => {
    const connect = readDocs("get-started/connect.mdx");
    for (const [agent, adds] of [
      ["Claude Code", "the Demoman plugin"],
      ["Codex", "the Demoman plugin"],
      ["Cursor", "`~/.cursor/mcp.json`"],
      ["OpenCode", "`~/.config/opencode/opencode.json`"],
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
    expect(readme()).toContain(
      `"args": ["--prefix", "~/", "-y", "demoman@latest", "mcp"]`,
    );
    // Exactly one: the generic block. A pasted second block is a second.
    expect(readme().match(/demoman@[^\s"',`/)\]]+/g)).toEqual([
      "demoman@latest",
    ]);
  });
  it("deep-links only to pages the docs navigation names", () => {
    // The npm README is frozen per version: a renamed slug 404s for good.
    // The repo's and the packed package's READMEs carry the same links.
    const all = ["../README.md", "../pkg/README.md", "../../../README.md"]
      .map((f) => readFileSync(new URL(f, import.meta.url), "utf8"))
      .join("\n");
    const links = [
      ...all.matchAll(/https:\/\/demoman\.io\/docs\/([^\s)#?"']+)/g),
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
      [
        "--version",
        "hook",
        "add",
        "join-flow",
        "mcp",
        "remove",
        "refresh",
        "setup",
        "signin",
        "studio",
      ].sort(),
    );
  });
  it("every npx demoman command on the site is one USAGE lists", () => {
    const seen = siteCommands();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    // The Install step's own setup command, not only the connect page's.
    expect(
      seen
        .filter((s) => s.page === "get-started/install")
        .map((s) => s.command),
    ).toContain("setup");
    // The changelog is history: a release may name a command since renamed
    // (0.8.1's keep is now add), and keep still runs as an alias.
    const history = seen.filter((s) => s.page === "resources/changelog");
    expect(history.map((s) => s.command)).toContain("keep");
    for (const { page, command } of seen) {
      if (page === "resources/changelog" && command === "keep") continue;
      expect(usageCommands(), `${page}: ${command}`).toContain(command);
    }
  });
});

describe("DemoScripts are shown, on their own pages", () => {
  it("only the DemoScript pages show script syntax, and both do", () => {
    const syntax = /scriptVersion|"steps"\s*:|look\.canvas|\{secret:/;
    expect(allPages().length).toBeGreaterThan(0);
    // Premise: both pages exist, or the loop below never reaches them.
    for (const p of SCRIPT_PAGES) expect(allPages(), p).toContain(p);
    for (const p of allPages())
      if (SCRIPT_PAGES.includes(p))
        expect(readDocs(`${p}.mdx`), p).toMatch(syntax);
      else expect(readDocs(`${p}.mdx`), p).not.toMatch(syntax);
  });
});

describe("apps behind a login", () => {
  it("carries signin, demo accounts and the CI secret pair", () => {
    const t = readDocs("get-started/sign-in.mdx");
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

describe("the CLI reference", () => {
  const page = () =>
    allPages()
      .filter((p) => p.startsWith("reference/"))
      .map((p) => readDocs(`${p}.mdx`))
      .join("\n");
  it("has a page per command USAGE lists, titled with it, and --version on the index", () => {
    const commands = [...usageCommands()].filter((c) => c !== "--version");
    expect(commands.length).toBeGreaterThanOrEqual(5);
    for (const c of commands)
      expect(readDocs(`reference/${c}.mdx`), c).toMatch(
        new RegExp(`^title: "${c}"$`, "m"),
      );
    // A flag heading is in code: Mintlify turns a bare "--" into a dash.
    expect(readDocs("reference/cli.mdx")).toMatch(/^## `--version`$/m);
  });
  // Every flag the CLI parses, read from its source. --serve is left out:
  // it is how the studio starts its own server, never typed by a person.
  it("names every flag the CLI parses", () => {
    const src = (f: string) =>
      readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const flags = new Set([
      ...["main.ts", "setup.ts"].flatMap((f) =>
        [
          ...src(f).matchAll(
            /^\s+"?([a-z-]+)"?: \{ type: "(?:boolean|string)"(?:, multiple: true)? \}/gm,
          ),
        ].map((m) => `--${m[1]}`),
      ),
      ...[...src("studio-args.ts").matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]),
    ]);
    flags.delete("--serve");
    // The premise: mcp's two flags, signin's three, studio's --stop,
    // setup's three, keep's three more (--to, --gif, --report) and
    // refresh's --base-url.
    expect(flags.size).toBeGreaterThanOrEqual(13);
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
  it("the Studio overview names the open and stop commands", () => {
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
  it("the changelog keeps every release and stays a summary", () => {
    const log = readDocs("resources/changelog.mdx");
    const entries = changelogEntries(log);
    const labels = entries.map((e) => e.label);
    // Premise: every entry the page opens was read whole, or the caps below skip it.
    expect(entries.length).toBe(log.match(/<Update\b/g)?.length);
    // Every release it listed on 2026-11-08, newest first; the site reads them.
    for (const v of [
      "0.9.2",
      "0.9.1",
      "0.9.0",
      "0.8.2",
      "0.8.1",
      "0.8.0",
      "0.7.3",
      "0.7.2",
      "0.7.1",
      "0.7.0",
      "0.2.0-rc.9",
      "0.2.0-rc.8",
      "0.2.0-rc.7",
      "0.2.0-rc.6",
      "0.2.0-rc.5",
      "0.2.0-rc.4",
      "0.2.0-rc.3",
      "0.2.0-rc.2",
      "0.2.0-rc.1",
    ])
      expect(labels, v).toContain(v);
    // Each entry is a summary, by its top-level bullets: three to five for a
    // release (an rc said one thing). The page grows with every release.
    for (const { label, body } of entries) {
      const bullets = body.match(/^ {0,2}- /gm)?.length ?? 0;
      const words = body.split(/\s+/).length;
      const min = label?.includes("-rc.") ? 1 : 3;
      expect(bullets, `${label}: ${bullets} bullets`).toBeGreaterThanOrEqual(
        min,
      );
      expect(bullets, `${label}: ${bullets} bullets`).toBeLessThanOrEqual(5);
      expect(words, `${label}: ${words} words`).toBeLessThanOrEqual(130);
    }
  });
  it("a shipped changelog entry keeps the words it shipped with", () => {
    const pins: Record<string, string> = JSON.parse(
      readFileSync(
        new URL("./changelog-shipped.json", import.meta.url),
        "utf8",
      ),
    );
    const entries = changelogEntries(readDocs("resources/changelog.mdx"));
    const bodies = new Map(entries.map((e) => [e.label, e.body]));
    // Premise: the releases up to 0.9.3 are pinned, or the loop checks nothing.
    expect(Object.keys(pins).length).toBeGreaterThanOrEqual(20);
    // pnpm release pins every entry but its own; only that one and a newer
    // entry being written may be unpinned.
    for (const { label } of entries.slice(1))
      if (label !== VERSION)
        expect(
          Object.keys(pins),
          `${label}: no pin (pnpm release adds it)`,
        ).toContain(label);
    for (const [label, body] of Object.entries(pins))
      expect(
        bodies.get(label),
        `${label} changed or was removed after it shipped`,
      ).toBe(body);
  });
  it("privacy links out to demoman.io/privacy", () => {
    expect(readDocs("security/privacy.mdx")).toContain(
      "https://demoman.io/privacy",
    );
  });
});

describe("the words for adding a flow", () => {
  // Every page and served text a person or an agent reads; the changelog
  // keeps the history that keep was the old name.
  const texts = (): Array<{ where: string; text: string }> => {
    const usage =
      /const USAGE = `([\s\S]*?)`;/.exec(
        readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"),
      )?.[1] ?? "";
    return [
      ...allPages()
        .filter((p) => p !== "resources/changelog")
        .map((p) => ({ where: `${p}.mdx`, text: readDocs(`${p}.mdx`) })),
      {
        where: "apps/mcp/recipe.md",
        text: readFileSync(
          new URL("../../mcp/recipe.md", import.meta.url),
          "utf8",
        ),
      },
      { where: "USAGE", text: usage },
    ];
  };

  it("no doc or served text says keep for adding a flow", () => {
    const all = texts();
    // Premise: the pages, the recipe and USAGE are all read.
    expect(all.map((t) => t.where)).toContain("get-started/add-to-repo.mdx");
    expect(all.find((t) => t.where === "USAGE")?.text).toContain("demoman add");
    expect(
      all.find((t) => t.where === "apps/mcp/recipe.md")?.text.length,
    ).toBeGreaterThan(1000);
    const hits = all.flatMap(({ where, text }) =>
      [
        ...text.matchAll(
          /demoman keep\b|(?<!~\/)\.demoman\/videos\b|\bkept (?:flow|file|video)s?\b/gi,
        ),
      ].map((m) => `${where}: ${m[0]}`),
    );
    expect(hits).toEqual([]);
  });

  it("USAGE calls the file in .demoman/flows/ a DemoScript", () => {
    const usage = texts().find((t) => t.where === "USAGE")?.text ?? "";
    expect(usage).toContain("its DemoScript in .demoman/flows/");
    expect(usage).toMatch(
      /remove a flow from the repo: its DemoScript and receipt go/,
    );
    expect(usage).not.toMatch(/\brecipe\b/);
  });
});

describe("the setup path", () => {
  const steps = GET_STARTED.slice(1);
  it("each step carries what a stranger needs at that step", () => {
    const need: Record<string, string[]> = {
      "get-started/install": [
        "npx demoman setup",
        `Node ${NODE_FLOORS[0]?.join(".")} or later`,
        "sudo",
      ],
      "get-started/sign-in": ["cannot be added to the repo"],
      "get-started/add-to-repo": [
        "npx demoman add",
        ".demoman/flows/",
        ".demoman/receipts/",
        "DemoScript",
        ".screens/",
        "Commit everything it wrote",
      ],
      "get-started/ci": [
        "npx demoman setup --ci",
        ".demoman/app.json",
        "--trigger",
        "--route",
      ],
    };
    for (const [page, strings] of Object.entries(need))
      for (const s of strings)
        expect(readDocs(`${page}.mdx`), `${page}: ${s}`).toContain(s);
  });
  it("each step ends on a card to the next, the last to Refresh", () => {
    const next = [...steps.slice(1), "concepts/refresh"];
    steps.forEach((page, i) => {
      const cards = [
        ...readDocs(`${page}.mdx`).matchAll(/<Card[^>]*href="\/([^"]+)"/g),
      ];
      expect(cards.at(-1)?.[1], page).toBe(next[i]);
    });
  });
  it("the Introduction leads with the premise and shows no example video", () => {
    const intro = readDocs("index.mdx");
    expect(intro).toContain("build artifact");
    expect(intro).toContain("DemoScript");
    expect(intro).not.toContain("<video");
  });
});

describe("links into the docs from the product", () => {
  it("every demoman.io/docs link in a message the product prints lands on a page", () => {
    const root = new URL("../../../", import.meta.url);
    const files = [
      "apps/cli/src",
      "apps/mcp/src",
      "apps/runner/src",
      "apps/studio/src",
    ].flatMap((d) =>
      (readdirSync(new URL(d, root), { recursive: true }) as string[])
        .filter((f) => f.endsWith(".ts"))
        .map((f) => `${d}/${f}`),
    );
    const links = files.flatMap((f) =>
      [
        ...readFileSync(new URL(f, root), "utf8").matchAll(
          /demoman\.io\/docs\/([a-z0-9/-]+)/g,
        ),
      ].map((m) => `${f}: ${m[1]}`),
    );
    // Premise: refresh's pinned-dates hint is one of them.
    expect(
      links.some((l) => l.startsWith("apps/runner/src/executor/refresh.ts")),
    ).toBe(true);
    const nav = new Set(navPages());
    for (const l of links) expect(nav, l).toContain(l.split(": ")[1]);
  });
});

describe("concepts and guides", () => {
  it("Flows and DemoScripts shows a real DemoScript the schema accepts", async () => {
    const page = readDocs("concepts/flows.mdx");
    const block = /```json\n([\s\S]*?)```/.exec(page)?.[1];
    expect(block, "a json block").toBeDefined();
    expect(block?.split("\n").length).toBeLessThanOrEqual(30);
    const file = JSON.parse(block ?? "") as {
      keptVersion: number;
      script: unknown;
    };
    expect(file.keptVersion).toBe(2);
    // apps/cli does not depend on the package; read its build (pnpm -r build).
    const { DemoScriptSchema } = (await import(
      new URL("../../../packages/scene-schema/dist/index.js", import.meta.url)
        .href
    )) as {
      DemoScriptSchema: {
        safeParse: (v: unknown) => { success: boolean; error?: unknown };
      };
    };
    const parsed = DemoScriptSchema.safeParse(file.script);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(page).toContain("your agent writes");
  });
  it("Refresh names how it delivers and what it compares", () => {
    const page = readDocs("concepts/refresh.mdx");
    for (const s of ["--deliver", ".demoman/receipts/", "picture changed"])
      expect(page, s).toContain(s);
  });
  it("no guide carries reference weight: each is at most 900 words", () => {
    const guides = navPages().filter(
      (p) => p.startsWith("guides/") || p.startsWith("studio/"),
    );
    expect(guides.length).toBeGreaterThanOrEqual(6);
    for (const p of guides) {
      const words = readDocs(`${p}.mdx`).split(/\s+/).length;
      expect(words, p).toBeLessThanOrEqual(900);
    }
  });
});

describe("links inside the docs", () => {
  it("every root-relative link names a page in the navigation", () => {
    const nav = new Set(navPages());
    const links = allPages().flatMap((p) =>
      [
        ...readDocs(`${p}.mdx`).matchAll(
          /(?:\]\(|href=")\/([a-z0-9/-]*)[#")]/g,
        ),
      ].map((m) => ({
        p,
        slug: (m[1] as string) === "" ? "index" : (m[1] as string),
      })),
    );
    // Premise: the pages link to each other at all.
    expect(links.length).toBeGreaterThan(30);
    for (const { p, slug } of links)
      expect(nav, `${p} → /${slug}`).toContain(slug);
  });
  it("every link to a #section names an anchor its page has", () => {
    const links = allPages().flatMap((p) =>
      [
        ...readDocs(`${p}.mdx`).matchAll(
          /(?:\]\(|href=")(\/[A-Za-z0-9/_-]*)?#([A-Za-z0-9_-]+)[")]/g,
        ),
      ].map((m) => ({
        p,
        slug: m[1] ? (m[1] === "/" ? "index" : m[1].slice(1)) : p,
        anchor: m[2] as string,
      })),
    );
    // Premise: the pages link to sections at all.
    expect(links.length).toBeGreaterThan(5);
    for (const { p, slug, anchor } of links)
      expect(anchorsOf(slug), `${p} → /${slug}#${anchor}`).toContain(anchor);
  });
});

describe("the reference pages", () => {
  it("lists only refusal reasons the product can send", () => {
    const root = new URL("../../../", import.meta.url);
    const source = [
      "apps/runner/src",
      "apps/cli/src",
      "apps/mcp/src",
      "packages",
    ]
      .flatMap((d) =>
        (readdirSync(new URL(d, root), { recursive: true }) as string[])
          .filter(
            (f) =>
              f.endsWith(".ts") &&
              !f.includes("node_modules") &&
              !f.includes("dist/"),
          )
          .map((f) => readFileSync(new URL(`${d}/${f}`, root), "utf8")),
      )
      .join("\n");
    const codes = new Set(
      [
        ...readDocs("reference/refusals.mdx").matchAll(
          /`([a-z]+[A-Z][A-Za-z]+)`/g,
        ),
      ].map((m) => m[1] as string),
    );
    // Premise: the page lists the reasons, not a handful.
    expect(codes.size).toBeGreaterThanOrEqual(15);
    for (const c of codes)
      expect(source, c).toMatch(new RegExp(`["'\`]${c}["'\`]`));
  });
  it("app.json has a row per field and the pinned dates section", () => {
    const page = readDocs("reference/app-json.mdx");
    for (const f of [
      "appVersion",
      "install",
      "start",
      "reset",
      "now",
      "url",
      "timeoutSeconds",
      "env",
      "secrets",
      "services",
    ])
      expect(page, f).toMatch(new RegExp(`^\\| \`${f}\` \\|`, "m"));
    expect(page).toMatch(/^## Pinned dates$/m);
  });
  it("environment names every variable the package reads", () => {
    const page = readDocs("reference/environment.mdx");
    for (const v of [
      "DEMOMAN_HOME",
      "DEMOMAN_NO_UPDATE_CHECK",
      "DEMOMAN_SECRET_",
    ])
      expect(page, v).toContain(v);
  });
});

describe("Studio stills", () => {
  // Copied from the studio shots lane by scripts/docs-studio-stills.mjs, so
  // they are redrawn each time that lane runs (RELEASING.md says when).
  const listed = (): string[] =>
    [
      ...readFileSync(
        new URL("../../../scripts/docs-studio-stills.mjs", import.meta.url),
        "utf8",
      ).matchAll(/^\s+"([a-z-]+\.png)":/gm),
    ].map((m) => m[1] as string);
  it("every still a page shows is in the copy list and on disk, and every listed one is shown", () => {
    const shown = new Set(
      allPages().flatMap((p) =>
        [
          ...readDocs(`${p}.mdx`).matchAll(/\/media\/studio\/([a-z-]+\.png)/g),
        ].map((m) => m[1] as string),
      ),
    );
    // Premise: the pages show stills at all.
    expect(shown.size).toBeGreaterThanOrEqual(5);
    expect(new Set(listed())).toEqual(shown);
    const onDisk = readdirSync(docs("media/studio"));
    for (const f of shown) expect(onDisk, f).toContain(f);
  });
});

describe("videos on the docs", () => {
  it("every video a page shows is on disk, with the DemoScript that recorded it", () => {
    const shown = allPages().flatMap((p) =>
      [...readDocs(`${p}.mdx`).matchAll(/src="\/media\/([a-z-]+)\.mp4"/g)].map(
        (m) => ({ p, name: m[1] as string }),
      ),
    );
    // Premise: Phone and tablet shows its example.
    expect(shown.map((s) => s.p)).toContain("guides/phone-and-tablet");
    const media = readdirSync(docs("media"));
    const scripts = readdirSync(docs("media/scripts"));
    for (const { p, name } of shown) {
      expect(media, `${p}: ${name}.mp4`).toContain(`${name}.mp4`);
      expect(scripts, `${p}: ${name}.json`).toContain(`${name}.json`);
    }
  });
});

describe("review fixes: what add refuses, and what it carries", () => {
  const keepSrc = () =>
    readFileSync(
      new URL("../../runner/src/executor/keep.ts", import.meta.url),
      "utf8",
    );
  it("Refusals names every reason add can give, and cannotRefilm for what it is", () => {
    const type =
      /export type KeepRefusal =([\s\S]*?);/.exec(keepSrc())?.[1] ?? "";
    const reasons = [...type.matchAll(/\|\s*"([a-zA-Z]+)"/g)].map(
      (m) => m[1] as string,
    );
    // Premise: the union was read, the two most common reasons among it.
    expect(reasons).toContain("notCarried");
    expect(reasons).toContain("unfilledHoles");
    const page = readDocs("reference/refusals.mdx");
    const section = page.slice(
      page.indexOf("## Adding a flow"),
      page.indexOf("## Setting up CI"),
    );
    for (const r of reasons) expect(section, r).toContain(`\`${r}\``);
    const row =
      section.split("\n").find((l) => l.startsWith("| `cannotRefilm`")) ?? "";
    expect(row).not.toMatch(/Studio edits|typed text/);
  });
  it("add-to-repo lists the edits add refuses, not a trim, and does not promise every reason", () => {
    const page = readDocs("get-started/add-to-repo.mdx");
    expect(page).not.toMatch(/a trim, a cut/);
    expect(page).toContain("a zoom you placed");
    expect(page).not.toContain("Every reason");
  });
  it("Flows and DemoScripts says a trim and a click's zoom are written into the DemoScript", () => {
    const page = readDocs("concepts/flows.mdx");
    expect(page).not.toContain("Edits change the video, not the DemoScript");
    expect(page).toContain("written into the DemoScript");
  });
});

describe("review fixes: environment and positioning", () => {
  it("Environment names every DEMOMAN_ variable the product reads", () => {
    const root = new URL("../../../", import.meta.url);
    const seen = new Set(
      [
        "apps/cli/src",
        "apps/runner/src",
        "apps/mcp/src",
        "apps/studio/src",
        "packages/run-core/src",
      ].flatMap((d) =>
        (readdirSync(new URL(d, root), { recursive: true }) as string[])
          .filter((f) => f.endsWith(".ts"))
          .flatMap((f) =>
            [
              ...readFileSync(new URL(`${d}/${f}`, root), "utf8").matchAll(
                /DEMOMAN_[A-Z_]*[A-Z]/g,
              ),
            ].map(
              // A demo account's secrets are one family, DEMOMAN_SECRET_<NAME>.
              (m) =>
                m[0].startsWith("DEMOMAN_SECRET_") ? "DEMOMAN_SECRET_" : m[0],
            ),
          ),
      ),
    );
    // DEMOMAN_CLIENT is written by setup into an agent's config, never set by a person.
    seen.delete("DEMOMAN_CLIENT");
    // DEMOMAN_BASE_URL lives inside the workflow setup --ci writes, passed to --base-url there.
    seen.delete("DEMOMAN_BASE_URL");
    // Premise: the walk found the ones the page always had, and DISPLAY.
    for (const v of [
      "DEMOMAN_HOME",
      "DEMOMAN_NO_UPDATE_CHECK",
      "DEMOMAN_DISPLAY",
    ])
      expect(seen, v).toContain(v);
    const page = readDocs("reference/environment.mdx");
    for (const v of seen) expect(page, v).toContain(v);
  });
  it("docs.json's description is the Introduction's, not the retired positioning", () => {
    const intro = /^description: "([^"]+)"$/m.exec(readDocs("index.mdx"))?.[1];
    expect(intro).toContain("CI pipeline");
    expect((docsJson() as unknown as { description: string }).description).toBe(
      intro,
    );
  });
});
