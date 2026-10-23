// apps/cli/scripts/build.mjs
//
// Builds the published `demoman` package into apps/cli/pkg (launch B):
//   dist/demoman.mjs   the node half: apps/mcp's CLI path + the runner, one file
//   dist/page/*.js     the four in-page bundles, prebuilt, so no esbuild ships
//   dist/recipe.md     apps/mcp/recipe.md
//   dist/skills/       the record-demo skill, which setup gives Cursor
//   dist/studio/       the studio's pages (apps/studio's pages build)
//   package.json       generated: dependencies are exactly what the bundle
//                      leaves external, pinned to the versions installed here
// and esbuild's metafiles into apps/cli/build-meta for the build tests.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAGE_ENTRIES,
  pageBuildOptions,
  pageEntryPath,
} from "@demoman/runner/package";
import { build } from "esbuild";
import { checkStudioPages } from "./studio-pages.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "../..");
const pkg = join(app, "pkg");
const meta = join(app, "build-meta");
const say = (text) => console.info(`[demoman] cli build: ${text}`);

/** Workspaces whose node_modules may hold a dependency the bundle imports. */
const WORKSPACES = [
  "apps/cli",
  "apps/mcp",
  "apps/runner",
  "apps/studio",
  "packages/agent-bridge",
  "packages/compositor",
  "packages/replay-engine",
  "packages/resolver",
  "packages/run-core",
  "packages/scene-schema",
];
/** Reached only by bundle-js's esbuild path, which usePrebuiltPages skips;
 *  the packed-install test proves the install runs without it. */
const NEVER_SHIPPED = new Set(["esbuild"]);

const packageOf = (specifier) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

/** The workspace folder holding `name`, or a throw naming it. */
function installedDir(name) {
  for (const ws of WORKSPACES) {
    const dir = join(repo, ws, "node_modules", name);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error(
    `the bundle imports ${name}, which no workspace has installed`,
  );
}
const manifestOf = (dir) =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

rmSync(pkg, { recursive: true, force: true });
rmSync(meta, { recursive: true, force: true });
mkdirSync(join(pkg, "dist", "page"), { recursive: true });
mkdirSync(meta, { recursive: true });
const { version } = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));

// 1. The node half. Every bare specifier outside @demoman/* stays external.
const thirdPartyExternal = {
  name: "third-party-external",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith("@demoman/") || isBuiltin(args.path)
        ? undefined
        : { path: args.path, external: true },
    );
  },
};
const node = await build({
  absWorkingDir: app,
  entryPoints: [join(app, "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: join(pkg, "dist", "demoman.mjs"),
  banner: { js: "#!/usr/bin/env node" },
  plugins: [thirdPartyExternal],
  metafile: true,
  logLevel: "warning",
});
writeFileSync(join(meta, "node.json"), JSON.stringify(node.metafile));
chmodSync(join(pkg, "dist", "demoman.mjs"), 0o755);

const external = new Set();
for (const out of Object.values(node.metafile.outputs)) {
  for (const imp of out.imports) {
    if (imp.external && !isBuiltin(imp.path)) {
      external.add(packageOf(imp.path));
    }
  }
}
const dependencies = Object.fromEntries(
  [...external]
    .filter((n) => !NEVER_SHIPPED.has(n))
    .sort()
    .map((n) => [n, manifestOf(installedDir(n)).version]),
);
writeFileSync(
  join(meta, "deps.json"),
  JSON.stringify({ external: [...external].sort(), dependencies }),
);

// 2. The page half, with the runner's own options.
for (const name of PAGE_ENTRIES) {
  const result = await build({
    ...pageBuildOptions(pageEntryPath(name)),
    metafile: true,
  });
  const text = result.outputFiles?.[0]?.text;
  if (!text) throw new Error(`esbuild produced no output for ${name}`);
  writeFileSync(join(pkg, "dist", "page", `${name}.js`), text);
  writeFileSync(
    join(meta, `page-${name}.json`),
    JSON.stringify(result.metafile),
  );
}

// 3. The recipe.
cpSync(join(repo, "apps", "mcp", "recipe.md"), join(pkg, "dist", "recipe.md"));

// 3c. The record-demo skill, which setup copies into Cursor's skills folder
//     (launch E); the plugin carries its own copy (step 7).
mkdirSync(join(pkg, "dist", "skills", "record-demo"), { recursive: true });
cpSync(
  join(app, "plugin", "skills", "record-demo", "SKILL.md"),
  join(pkg, "dist", "skills", "record-demo", "SKILL.md"),
);

// 3b. The studio's pages: the editor, library and Settings apps/studio
//     builds with `#platform` on the HTTP side (pages/vite.config.ts, part
//     of its `build`, which runs first: @demoman/studio is a dependency
//     here). `demoman studio --serve` serves them from
//     `<dir of demoman.mjs>/studio`. Its list of bundled node_modules
//     (written beside the folder) feeds THIRD_PARTY_NOTICES below.
//     They must be built for this version and from the source as it is now
//     (`checkStudioPages`): a stale or mismatched set would ship pages the
//     packaged studio never checks again.
const studioPages = join(repo, "apps", "studio", ".output", "pages");
const pagesChecked = checkStudioPages({
  pagesDir: studioPages,
  pagesSourceDir: join(repo, "apps", "studio", "pages"),
  version,
});
if (!pagesChecked.ok) throw new Error(pagesChecked.reason);
cpSync(studioPages, join(pkg, "dist", "studio"), { recursive: true });
const studioModules = JSON.parse(
  readFileSync(`${studioPages}-modules.json`, "utf8"),
);
writeFileSync(join(meta, "studio-modules.json"), JSON.stringify(studioModules));
say(`copied the Studio's pages from ${studioPages}`);

// 4. package.json.
writeFileSync(
  join(pkg, "package.json"),
  `${JSON.stringify(
    {
      name: "demoman",
      version,
      description:
        "Polished demo videos of web apps, made by your coding agent.",
      license: "FSL-1.1-ALv2",
      homepage: "https://demoman.io",
      repository: {
        type: "git",
        url: "git+https://github.com/demoman-io/demoman.git",
        directory: "apps/cli",
      },
      bugs: { url: "https://github.com/demoman-io/demoman/issues" },
      type: "module",
      bin: { demoman: "dist/demoman.mjs" },
      files: ["dist", "LICENSE", "THIRD_PARTY_NOTICES"],
      engines: { node: ">=20" },
      dependencies,
    },
    null,
    2,
  )}\n`,
);
say(
  `wrote ${pkg} (demoman ${version}; ${Object.keys(dependencies).length} dependencies)`,
);

// 5. LICENSE: the package is FSL-1.1-ALv2 as a whole (author, 2026-10-14).
cpSync(join(repo, "packages", "compositor", "LICENSE"), join(pkg, "LICENSE"));
// npm ships a README whatever `files` says; this one is the package page.
cpSync(join(app, "README.md"), join(pkg, "README.md"));

// 6. THIRD_PARTY_NOTICES: every node_modules package esbuild bundled (read
//    from the metafiles, resolved against each build's working directory),
//    with its license text; then the installed dependencies. A package with
//    no license file stops the build rather than ship a notice without it.
const LICENSE_FILES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "license",
  "LICENCE",
  "LICENSE-MIT",
];
function bundledPackage(workDir, input) {
  const all = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)];
  const last = all.at(-1);
  if (last === undefined || last[1] === ".pnpm") return null;
  const dir = resolve(workDir, input.slice(0, last.index + last[0].length - 1));
  return { name: last[1], dir };
}
function licenseOf(manifest, name) {
  const license = manifest.license;
  if (typeof license !== "string" || license === "") {
    throw new Error(`${name} ${manifest.version} names no license`);
  }
  return license;
}
function describeBundled(dir, name) {
  const manifest = manifestOf(dir);
  const file = LICENSE_FILES.map((f) => join(dir, f)).find((f) =>
    existsSync(f),
  );
  if (file === undefined) {
    throw new Error(
      `${name} ${manifest.version} is bundled but ships no license file in ${dir}`,
    );
  }
  return {
    name,
    version: manifest.version,
    license: licenseOf(manifest, name),
    text: readFileSync(file, "utf8").trim(),
  };
}
const bundled = new Map();
const builds = [
  { workDir: app, metafile: node.metafile },
  ...PAGE_ENTRIES.map((n) => ({
    workDir: pageBuildOptions(pageEntryPath(n)).absWorkingDir,
    metafile: JSON.parse(readFileSync(join(meta, `page-${n}.json`), "utf8")),
  })),
];
for (const { workDir, metafile } of builds) {
  for (const input of Object.keys(metafile.inputs)) {
    const found = bundledPackage(workDir, input);
    if (found !== null && !bundled.has(found.name)) {
      bundled.set(found.name, describeBundled(found.dir, found.name));
    }
  }
}
// The studio's pages: vite's module ids are absolute.
for (const id of studioModules) {
  const found = bundledPackage(repo, id);
  if (found !== null && !bundled.has(found.name)) {
    bundled.set(found.name, describeBundled(found.dir, found.name));
  }
}
const installed = Object.keys(dependencies).map((name) => {
  const manifest = manifestOf(installedDir(name));
  return {
    name,
    version: manifest.version,
    license: licenseOf(manifest, name),
  };
});
// The studio's hand-copied fonts and icons come from no package the scans
// above can see: their notices are written by hand, and a font that ships
// without one stops the build.
const handCopied = readFileSync(
  join(repo, "apps", "studio", "pages", "NOTICES"),
  "utf8",
).trim();
for (const font of readdirSync(
  join(repo, "apps", "studio", "pages", "public", "fonts"),
)) {
  if (!handCopied.includes(`fonts/${font}:`)) {
    throw new Error(
      `apps/studio/pages/NOTICES names no fonts/${font}, which ships in dist/studio`,
    );
  }
}
const sections = [...bundled.values()]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(
    (p) =>
      `== ${p.name} ${p.version} (${p.license}) ==\nSource: https://www.npmjs.com/package/${p.name}/v/${p.version}\n\n${p.text}\n`,
  );
writeFileSync(
  join(pkg, "THIRD_PARTY_NOTICES"),
  `demoman ${version} includes code from these packages, bundled into dist/:\n\n${sections.join("\n")}\n` +
    `${handCopied}\n\n` +
    "These packages are installed beside demoman as its dependencies, each under its own license:\n\n" +
    `${installed.map((p) => `- ${p.name} ${p.version} (${p.license})`).join("\n")}\n`,
);
writeFileSync(
  join(meta, "notices.json"),
  JSON.stringify({
    bundled: [...bundled.values()].map(({ text: _text, ...rest }) => rest),
    installed,
  }),
);
say(`wrote LICENSE and THIRD_PARTY_NOTICES (${bundled.size} bundled packages)`);

// 7. The plugin: the whole demoman-io/plugins repo, copied there at release
//    (the author's release steps, internal/RELEASING.md). Its MCP entry pins this exact version.
const plugin = join(app, "plugin-out");
rmSync(plugin, { recursive: true, force: true });
mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
cpSync(join(app, "plugin", "skills"), join(plugin, "skills"), {
  recursive: true,
});
cpSync(
  join(repo, "packages", "compositor", "LICENSE"),
  join(plugin, "LICENSE"),
);
const about = "Polished demo videos of web apps, made by your coding agent.";
const owner = {
  name: "Demoman",
  email: "support@demoman.io",
  url: "https://demoman.io",
};
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
writeJson(join(plugin, ".mcp.json"), {
  mcpServers: {
    demoman: { command: "npx", args: ["-y", `demoman@${version}`, "mcp"] },
  },
});
writeJson(join(plugin, ".claude-plugin", "plugin.json"), {
  name: "demoman",
  description: about,
  version,
  mcpServers: "./.mcp.json",
  author: owner,
  homepage: "https://demoman.io",
  license: "FSL-1.1-ALv2",
});
writeJson(join(plugin, ".claude-plugin", "marketplace.json"), {
  $schema: "https://code.claude.com/schemas/marketplace.json",
  name: "demoman",
  description: about,
  owner,
  plugins: [
    {
      name: "demoman",
      source: "./",
      description: about,
      version,
      author: owner,
      homepage: "https://demoman.io",
      license: "FSL-1.1-ALv2",
    },
  ],
});
say(`wrote ${plugin}`);
