import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPLAY_TARGETS } from "@demoman/replay-engine";
import { afterAll, describe, expect, it } from "vitest";
import {
  WALLPAPERS,
  wallpaperFile,
} from "../../../packages/scene-schema/src/wallpapers.js";
import {
  binSource,
  NODE_ENGINES,
  NODE_FLOORS,
  NODE_NEEDED,
} from "../scripts/node-floor.mjs";
import { checkStudioPages, WALLPAPER_IDS } from "../scripts/studio-pages.mjs";

const at = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(at(p), "utf8");
const json = (p: string) => JSON.parse(read(p));
const PAGES = [
  "resolve-entry",
  "executor-entry",
  "render-entry",
  "mux-entry",
  "decode-probe-entry",
];
const inputsOf = (meta: { inputs: Record<string, unknown> }) =>
  Object.keys(meta.inputs);

describe("the node bundle", () => {
  const inputs = inputsOf(json("build-meta/node.json"));

  it("reaches apps/mcp and the runner (the fixture for the exclusions below)", () => {
    // Red if the metafile stops describing the bundle: every "not in"
    // below would pass against an empty list.
    expect(
      inputs.some((p) => /(^|\/)mcp\/dist\/serve-cli\.js$/.test(p)),
      inputs.join("\n"),
    ).toBe(true);
    expect(
      inputs.some((p) => /(^|\/)runner\/dist\/executor\/executor\.js$/.test(p)),
    ).toBe(true);
  });

  it("carries none of the extension bridge (step 5)", () => {
    const bridge = inputs.filter(
      (p) =>
        /(^|\/)mcp\/dist\/(hub|link|peer-link|peer-protocol|line|session|key)\.js$/.test(
          p,
        ) || /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?ws\//.test(p),
    );
    expect(bridge).toEqual([]);
  });

  it("carries neither the headless replay bin nor film:compare", () => {
    expect(
      inputs.filter((p) =>
        /(^|\/)runner\/dist\/(cli|pipeline)\.js$|(^|\/)runner\/dist\/compare\//.test(
          p,
        ),
      ),
    ).toEqual([]);
  });
});

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  engines?: { node?: string };
};

/**
 * Every package the bundle's dependencies bring, each from the folder node
 * resolves it to: the direct ones from the workspace that installed them (as
 * build.mjs pins them), the rest up from their dependent's real folder.
 */
function dependencyTree(direct: string[]): Manifest[] {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const workspaces = ["apps", "packages"].flatMap((g) =>
    readdirSync(join(repo, g)).map((w) => join(repo, g, w)),
  );
  const locate = (name: string, from: string[]): string => {
    for (const start of from) {
      for (let dir = start; ; dir = dirname(dir)) {
        const at = join(dir, "node_modules", name);
        if (existsSync(join(at, "package.json"))) return realpathSync(at);
        if (dirname(dir) === dir) break;
      }
    }
    throw new Error(`${name} is not installed where node would find it`);
  };
  const seen = new Map<string, Manifest>();
  const walk = (name: string, from: string[]) => {
    const dir = locate(name, from);
    if (seen.has(dir)) return;
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as Manifest;
    seen.set(dir, manifest);
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      walk(dep, [dir]);
    }
  };
  for (const name of direct) walk(name, workspaces);
  return [...seen.values()];
}

/**
 * Whether `version` satisfies an npm engines range: `||` of space-separated
 * comparators (`>=`, `>`, `<=`, `<`, `^`, `~`, `=`, bare, `*`/`x`). Anything
 * else throws, so a shape it cannot read is said rather than passed.
 */
function satisfies(version: string, range: string): boolean {
  const num = (v: string) => {
    const parts = v.split(".");
    return [0, 1, 2].map((i) => {
      const p = parts[i];
      return p === undefined || p === "x" || p === "*" ? 0 : Number(p);
    });
  };
  const cmp = (a: number[], b: number[]) =>
    (a[0] as number) - (b[0] as number) ||
    (a[1] as number) - (b[1] as number) ||
    (a[2] as number) - (b[2] as number);
  const v = num(version);
  return range.split("||").some((part) =>
    part
      .trim()
      .replace(/([<>=^~]+)\s+/g, "$1")
      .split(/\s+/)
      .every((c) => {
        if (c === "" || c === "*" || c === "x") return true;
        const m = /^(>=|<=|>|<|\^|~|=)?v?(\d+(?:\.(?:\d+|x|\*)){0,2})$/.exec(c);
        if (m === null)
          throw new Error(`an engines range I cannot read: ${range}`);
        const op = m[1] ?? "=";
        const at = num(m[2] as string);
        const d = cmp(v, at);
        if (op === ">=") return d >= 0;
        if (op === ">") return d > 0;
        if (op === "<=") return d <= 0;
        if (op === "<") return d < 0;
        if (op === "^") return d >= 0 && v[0] === at[0];
        if (op === "~") return d >= 0 && v[0] === at[0] && v[1] === at[1];
        return d === 0;
      }),
  );
}

describe("pkg/package.json", () => {
  const built = json("pkg/package.json");
  const deps: Record<string, string> = built.dependencies;

  it("pins every dependency exactly, to the version installed here", () => {
    const runner = createRequire(
      new URL("../../runner/package.json", import.meta.url),
    );
    expect(deps.playwright).toBe(runner("playwright/package.json").version);
    for (const [name, v] of Object.entries(deps)) {
      expect(v, name).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    }
  });

  it("lists exactly what the bundle leaves external, and never esbuild", () => {
    const { external } = json("build-meta/deps.json");
    expect(Object.keys(deps).sort()).toEqual(
      external.filter((n: string) => n !== "esbuild"),
    );
    expect(deps).not.toHaveProperty("esbuild");
    expect(deps).not.toHaveProperty("ws");
  });

  it("is demoman, FSL-1.1-ALv2, Node 20.12+, with the bin", () => {
    expect(built).toMatchObject({
      name: "demoman",
      license: "FSL-1.1-ALv2",
      engines: { node: NODE_ENGINES },
      bin: { demoman: "dist/demoman.mjs" },
    });
  });

  // DEM-121: @clack/prompts needs Node 20.12 and the package said 20, so on
  // 20.0-20.11 every command died while loading, before any check of ours.
  it("runs on no Node that a dependency, direct or not, refuses", () => {
    const floors = NODE_FLOORS.map(([major, minor]) => `${major}.${minor}.0`);
    const tree = dependencyTree(Object.keys(deps));
    const ranges = tree.flatMap((m) =>
      typeof m.engines?.node === "string" ? [[m.name, m.engines.node]] : [],
    );
    // The premises: the walk reached past the direct dependencies, and
    // clack's floor is among what it read.
    expect(tree.map((m) => m.name)).toContain("@clack/core");
    expect(tree.length).toBeGreaterThan(Object.keys(deps).length * 3);
    expect(Object.fromEntries(ranges)).toHaveProperty("@clack/prompts");
    // And the reader says no where it should: 21.6 is below clack's 20.12.
    expect(satisfies("21.6.0", NODE_ENGINES)).toBe(false);
    expect(satisfies("20.11.1", ">= 20.12.0")).toBe(false);
    expect(
      ranges.flatMap(([name, range]) =>
        floors
          .filter((f) => !satisfies(f, range as string))
          .map((f) => `${name} ${range} refuses ${f}`),
      ),
    ).toEqual([]);
  });

  // npm's page links "Repository" and "Issues" from these.
  it("names the public repo, the package's folder in it, and its issues", () => {
    expect(built).toMatchObject({
      repository: {
        type: "git",
        url: "git+https://github.com/demoman-io/demoman.git",
        directory: "apps/cli",
      },
      bugs: { url: "https://github.com/demoman-io/demoman/issues" },
    });
  });
});

describe("the page bundles", () => {
  it("are all there, and agree with the node half on REPLAY_TARGETS", () => {
    const literal = JSON.stringify(REPLAY_TARGETS);
    expect(read("pkg/dist/cli.mjs")).toContain(literal);
    const carrying = PAGES.filter((n) =>
      read(`pkg/dist/page/${n}.js`).includes(literal),
    );
    expect(
      carrying.length,
      "no page bundle parks under REPLAY_TARGETS",
    ).toBeGreaterThan(0);
  });
});

it("ships apps/mcp's recipe verbatim", () => {
  expect(read("pkg/dist/recipe.md")).toBe(
    readFileSync(new URL("../../mcp/recipe.md", import.meta.url), "utf8"),
  );
});

// Setup copies this into Cursor's skills folder (launch E): it reads it
// beside cli.mjs, so it has to be packed. Red: drop build.mjs's step 3c.
it("ships the record-demo skill beside the recipe, and packs it", () => {
  expect(read("pkg/dist/skills/record-demo/SKILL.md")).toBe(
    read("plugin/skills/record-demo/SKILL.md"),
  );
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(new URL("../pkg", import.meta.url)),
    encoding: "utf8",
  });
  const [{ files }] = JSON.parse(out) as [{ files: Array<{ path: string }> }];
  expect(files.map((f) => f.path)).toContain(
    "dist/skills/record-demo/SKILL.md",
  );
});

// `demoman studio --serve` serves `<dir of cli.mjs>/studio`
// (src/main.ts), and refuses to start without its library.html. Red: drop
// build.mjs's step 3b.
it("ships the Studio's pages where studio --serve looks for them, and packs them", () => {
  for (const page of ["library.html", "editor.html", "settings.html"]) {
    expect(read(`pkg/dist/studio/${page}`)).toBe(
      readFileSync(
        new URL(`../../studio/.output/pages/${page}`, import.meta.url),
        "utf8",
      ),
    );
  }
  const stamp = JSON.parse(read("pkg/dist/studio/studio-build.json"));
  expect(typeof stamp.sha).toBe("string");
  // Built for this version (final review I3): the page compares it with the
  // running studio's, and build.mjs refuses a mismatch.
  expect(stamp.version).toBe(json("package.json").version);
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(new URL("../pkg", import.meta.url)),
    encoding: "utf8",
  });
  const [{ files }] = JSON.parse(out) as [{ files: Array<{ path: string }> }];
  const paths = files.map((f) => f.path);
  expect(paths).toContain("dist/studio/library.html");
  expect(paths).toContain("dist/studio/editor.html");
  expect(paths).toContain("dist/studio/settings.html");
  expect(paths).toContain("dist/studio/studio-build.json");
  for (const w of WALLPAPERS) {
    for (const shape of ["landscape", "portrait", "thumb"] as const) {
      expect(paths).toContain(
        `dist/studio/wallpapers/${wallpaperFile(w.id, shape)}`,
      );
    }
  }
  expect(
    paths.some((p) => /^dist\/studio\/assets\/editor-.*\.js$/.test(p)),
  ).toBe(true);
  expect(paths.some((p) => p.startsWith("dist/studio/fonts/"))).toBe(true);
});

// The npm package page: npm packs a README whatever `files` lists.
it("ships the package README and packs it", () => {
  expect(read("pkg/README.md")).toBe(
    readFileSync(new URL("../README.md", import.meta.url), "utf8"),
  );
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(new URL("../pkg", import.meta.url)),
    encoding: "utf8",
  });
  const [{ files }] = JSON.parse(out) as [{ files: Array<{ path: string }> }];
  expect(files.map((f) => f.path)).toContain("README.md");
});

// Measured 2026-10-14: tarball 654,511 B, unpacked 3,460,108 B, 9 files
// (render-entry 1.84 MB and mux-entry 1.04 MB are mostly mediabunny).
// Measured 2026-10-16 with the studio's pages in dist/studio (launch D2):
// 1,100,194 B, unpacked 4,752,377 B, 34 files — the pages' shared chunk
// carries mediabunny a third time, for the editor's preview.
// Measured 2026-10-27 with refresh's decode page (decode-probe-entry, its
// own copy of mediabunny's demuxer): 1,403,516 B, unpacked 6,028,731 B, 37
// files; 1,249,382 B without it.
// 25% headroom; red when something like compositor's 21 MB of fixtures
// rides in.
// Measured 2026-10-28 with the built-in wallpapers (the studio pages'
// public/wallpapers, 30 WebP files, 20,107,026 B, already compressed):
// 21,041,235 B, unpacked 26,191,809 B, 67 files. Their bytes are read from
// disk and added to the ceiling, so retuning them does not move it and
// everything else keeps the headroom it had.
const MAX_TARBALL_BYTES = 1_755_000;
const wallpapers = fileURLToPath(
  new URL("../../studio/pages/public/wallpapers/", import.meta.url),
);
it("packs under its size ceiling", () => {
  const wallpaperBytes = readdirSync(wallpapers).reduce(
    (sum, f) => sum + statSync(join(wallpapers, f)).size,
    0,
  );
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(new URL("../pkg", import.meta.url)),
    encoding: "utf8",
  });
  const [{ size }] = JSON.parse(out);
  expect(size).toBeLessThan(MAX_TARBALL_BYTES + wallpaperBytes);
});

// Final review I3: build.mjs step 3b packed whatever was in
// the built pages folder. `checkStudioPages` is what it now runs
// first; red (each made and watched): drop the version comparison, and the
// two version cases pass the pages; drop the `staleBuild` call, and the
// stale case does.
describe("checkStudioPages (build.mjs step 3b)", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  /** A pages folder stamped `stamp` at `builtAt`, beside a pages source
   *  whose newest file is from `editedAt` (seconds since the epoch). */
  function fixture(o: {
    stamp: Record<string, unknown>;
    builtAt: number;
    editedAt: number;
  }) {
    const root = mkdtempSync(join(tmpdir(), "cli-studio-pages-"));
    made.push(root);
    const pagesDir = join(root, "pages");
    const pagesSourceDir = join(root, "pages-source");
    mkdirSync(pagesDir);
    mkdirSync(join(pagesSourceDir, "src"), { recursive: true });
    writeFileSync(join(pagesDir, "library.html"), "<p>library</p>");
    writeFileSync(join(pagesDir, "editor.html"), "<p>editor</p>");
    writeFileSync(join(pagesDir, "settings.html"), "<p>settings</p>");
    mkdirSync(join(pagesDir, "wallpapers"));
    for (const w of WALLPAPERS) {
      for (const shape of ["landscape", "portrait", "thumb"] as const) {
        writeFileSync(
          join(pagesDir, "wallpapers", wallpaperFile(w.id, shape)),
          "x",
        );
      }
    }
    const stampPath = join(pagesDir, "studio-build.json");
    writeFileSync(stampPath, JSON.stringify(o.stamp));
    const source = join(pagesSourceDir, "src", "a.ts");
    writeFileSync(source, "export {};\n");
    utimesSync(stampPath, o.builtAt, o.builtAt);
    utimesSync(source, o.editedAt, o.editedAt);
    // Premise: the mtimes are what the case says they are.
    expect(Math.round(statSync(stampPath).mtimeMs / 1000)).toBe(o.builtAt);
    expect(Math.round(statSync(source).mtimeMs / 1000)).toBe(o.editedAt);
    return { pagesDir, pagesSourceDir };
  }

  it("passes pages built for this version, after the last edit", () => {
    const dirs = fixture({
      stamp: { sha: "abc", version: "1.2.3" },
      builtAt: 2_000_000,
      editedAt: 1_000_000,
    });
    expect(checkStudioPages({ ...dirs, version: "1.2.3" })).toEqual({
      ok: true,
    });
  });

  it("refuses pages built for another version, naming both", () => {
    const dirs = fixture({
      stamp: { sha: "abc", version: "1.2.2" },
      builtAt: 2_000_000,
      editedAt: 1_000_000,
    });
    const verdict = checkStudioPages({ ...dirs, version: "1.2.3" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toMatch(
      /^the Studio's pages were built for demoman 1\.2\.2, not 1\.2\.3 .* run `pnpm -r build`$/,
    );
  });

  it("refuses a stamp that names no version", () => {
    const dirs = fixture({
      stamp: { sha: "abc" },
      builtAt: 2_000_000,
      editedAt: 1_000_000,
    });
    const verdict = checkStudioPages({ ...dirs, version: "1.2.3" });
    expect(verdict.ok ? "" : verdict.reason).toContain(
      "built for demoman of no stated version, not 1.2.3",
    );
  });

  it("refuses pages older than the newest source file", () => {
    const dirs = fixture({
      stamp: { sha: "abc", version: "1.2.3" },
      builtAt: 1_000_000,
      editedAt: 2_000_000,
    });
    const verdict = checkStudioPages({ ...dirs, version: "1.2.3" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toMatch(
      /^the Studio's pages: .*studio-build\.json is older than the source .* run `pnpm -r build` first\.$/,
    );
  });

  it("refuses a folder missing the settings page, and names it", () => {
    const dirs = fixture({
      stamp: { sha: "abc", version: "1.2.3" },
      builtAt: 2_000_000,
      editedAt: 1_000_000,
    });
    rmSync(join(dirs.pagesDir, "settings.html"));
    const verdict = checkStudioPages({ ...dirs, version: "1.2.3" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toContain("settings.html");
  });

  it("refuses a folder missing a page", () => {
    const dirs = fixture({
      stamp: { sha: "abc", version: "1.2.3" },
      builtAt: 2_000_000,
      editedAt: 1_000_000,
    });
    rmSync(join(dirs.pagesDir, "editor.html"));
    const verdict = checkStudioPages({ ...dirs, version: "1.2.3" });
    expect(verdict.ok ? "" : verdict.reason).toContain(
      "the Studio's pages are not built (no ",
    );
  });

  it("refuses a folder missing a wallpaper file, and names it", () => {
    const dirs = fixture({
      stamp: { sha: "abc", version: "1.2.3" },
      builtAt: 2_000_000,
      editedAt: 1_000_000,
    });
    const file = join(dirs.pagesDir, "wallpapers", "vivid-1-landscape.webp");
    expect(existsSync(file)).toBe(true);
    rmSync(file);
    const verdict = checkStudioPages({ ...dirs, version: "1.2.3" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toContain(
      "vivid-1-landscape.webp",
    );
  });

  it("knows the same ids as scene-schema's WALLPAPERS", () => {
    expect(WALLPAPER_IDS).toEqual(WALLPAPERS.map((w) => w.id));
  });
});

// DEM-121: an import a Node lacks fails while the bundle links, before any
// line of it runs, so the bin checks Node before it loads the bundle. A
// preload stands in for the old Node; a stand-in cli.mjs beside a copy of the
// bin says whether the bin loaded it.
describe("the bin", () => {
  const dir = mkdtempSync(join(tmpdir(), "demoman-bin-"));
  writeFileSync(join(dir, "demoman.mjs"), read("pkg/dist/demoman.mjs"));
  writeFileSync(join(dir, "cli.mjs"), 'console.log("cli.mjs loaded");\n');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const asNode = (version: string) => {
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"${version}"})`,
        join(dir, "demoman.mjs"),
      ],
      { encoding: "utf8" },
    );
    return { status: r.status, said: `${r.stdout}${r.stderr}` };
  };

  it("is the one build.mjs writes from node-floor.mjs", () => {
    expect(read("pkg/dist/demoman.mjs")).toBe(binSource("./cli.mjs"));
  });

  it("refuses a Node below its line's floor, in words, and loads nothing", () => {
    for (const version of ["18.19.0", "20.11.1", "21.6.2"]) {
      expect(asNode(version)).toEqual({
        status: 1,
        said: `${NODE_NEEDED}, and this is Node ${version}.\n`,
      });
    }
  });

  it("loads the bundle on each floor and above", () => {
    for (const version of ["20.12.0", "21.7.0", "22.0.0", "24.10.0"]) {
      expect(asNode(version), version).toEqual({
        status: 0,
        said: "cli.mjs loaded\n",
      });
    }
  });
});
