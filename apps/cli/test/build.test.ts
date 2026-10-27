import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPLAY_TARGETS } from "@demoman/replay-engine";
import { afterAll, describe, expect, it } from "vitest";
import { checkStudioPages } from "../scripts/studio-pages.mjs";

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

  it("is demoman, FSL-1.1-ALv2, Node 20+, with the bin", () => {
    expect(built).toMatchObject({
      name: "demoman",
      license: "FSL-1.1-ALv2",
      engines: { node: ">=20" },
      bin: { demoman: "dist/demoman.mjs" },
    });
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
    expect(read("pkg/dist/demoman.mjs")).toContain(literal);
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
// beside demoman.mjs, so it has to be packed. Red: drop build.mjs's step 3c.
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

// `demoman studio --serve` serves `<dir of demoman.mjs>/studio`
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
const MAX_TARBALL_BYTES = 1_755_000;
it("packs under its size ceiling", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(new URL("../pkg", import.meta.url)),
    encoding: "utf8",
  });
  const [{ size }] = JSON.parse(out);
  expect(size).toBeLessThan(MAX_TARBALL_BYTES);
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
});
