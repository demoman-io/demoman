// Fails when two files under apps/ or packages/ import each other at
// runtime, or a package imports an app (DEM-200).
//   node scripts/no-cycles.mjs
// An edge is an import that survives compilation: each file goes through
// TypeScript's own transpile (isolatedModules, as tsconfig.base.json sets),
// which drops type-only imports and imports used only as types, so a cycle
// of types alone is allowed. A dynamic `import()` loads late and cannot be
// a load-time cycle, so it is not an edge.
// Packages that import each other by name (`@demoman/x`) are a cycle too.
// It must not pass by seeing nothing: it fails when it reads fewer than
// MIN_MODULES files or follows fewer than MIN_IMPORTS imports, or when a
// relative import resolves to no file.
// Last line: `no-cycles: N modules, M runtime imports, no cycles` or the
// cycles and violations it found.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 1,142 modules and 2,913 runtime imports on 2026-11-24, after DEM-199:
 *  far fewer of either means the walk went blind (a skipped folder, a path
 *  that matched SKIP, a transpile that kept nothing). About 95% of each. */
export const MIN_MODULES = 1080;
export const MIN_IMPORTS = 2750;
const SKIP = new Set(["node_modules", "dist", ".output", "pkg", "plugin-out", ".worktrees", ".claude", "internal", "test-failures", "__screenshots__"]);
const APPS = ["cli", "mcp", "runner", "studio"];

/** A module this walks: TypeScript or plain ES JavaScript, not a declaration. */
const MODULE = /\.(ts|tsx|mts|js|mjs)$/;

/** Every module under `dir`, but declarations and SKIP folders. */
function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (MODULE.test(e.name) && !/\.d\.m?ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Each workspace package's name and folder, from its package.json. */
function workspacePackages(root) {
  const out = new Map();
  for (const group of ["apps", "packages"]) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const pkg = join(dir, e.name, "package.json");
      if (e.isDirectory() && existsSync(pkg)) out.set(JSON.parse(readFileSync(pkg, "utf8")).name, join(dir, e.name));
    }
  }
  return out;
}

/** The static import and export-from specifiers left after transpiling. */
export function runtimeSpecifiers(text, fileName) {
  const js = ts.transpileModule(text, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
      jsx: ts.JsxEmit.Preserve,
    },
  }).outputText;
  const sf = ts.createSourceFile(`${fileName}.js`, js, ts.ScriptTarget.ES2022);
  const specs = [];
  for (const s of sf.statements)
    if ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier))
      specs.push(s.moduleSpecifier.text);
  return specs;
}

/** The file a relative specifier names (`./a.js` is `a.ts`), or null. */
function resolveRelative(from, spec) {
  const base = resolve(dirname(from), spec);
  const stem = base.replace(/\.(m?js|jsx)$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(base, "index.ts")])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** Strongly connected components of size > 1, or a file importing itself. */
export function cycles(graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const on = new Set();
  const found = [];
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        on.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || (graph.get(v) ?? new Set()).has(v)) found.push(scc.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return found;
}

/** Reads `root`'s apps/ and packages/, answers what it saw and every
 *  problem it found. `min`: fewer modules than this is a walk gone blind. */
export function check({ root = ROOT, min = MIN_MODULES, minImports = MIN_IMPORTS } = {}) {
  const roots = ["apps", "packages"].map((d) => join(root, d));
  const files = roots.flatMap((r) => (existsSync(r) ? sources(r) : []));
  const graph = new Map();
  /** Package to the packages it imports by name: a cycle between two
   *  packages goes through their names, never through a relative path. */
  const packages = workspacePackages(root);
  const pkgGraph = new Map([...packages.keys()].map((n) => [n, new Set()]));
  const packageOf = (file) => [...packages].find(([, dir]) => file.startsWith(`${dir}/`))?.[0];
  const problems = [];
  let edges = 0;
  const rel = (p) => relative(root, p);
  for (const f of files) {
    const out = new Set();
    const own = packageOf(f);
    for (const spec of runtimeSpecifiers(readFileSync(f, "utf8"), f)) {
      const inPackages = rel(f).startsWith("packages/");
      if (inPackages && APPS.some((a) => spec === `@demoman/${a}` || spec.startsWith(`@demoman/${a}/`)))
        problems.push(`${rel(f)} imports ${spec}: a package never imports an app`);
      const named = [...packages.keys()].find((n) => spec === n || spec.startsWith(`${n}/`));
      if (named !== undefined && own !== undefined && named !== own) pkgGraph.get(own).add(named);
      if (!spec.startsWith(".")) continue;
      // Into a folder the walk skips (a build's dist/, say): outside the
      // source, so neither an edge nor a missing file.
      // Measured from the root: a checkout may itself sit under a skipped name
      // (a worktree in .claude/worktrees), and then every import read as one.
      if (rel(resolve(dirname(f), spec)).split("/").some((seg) => SKIP.has(seg))) continue;
      const to = resolveRelative(f, spec);
      if (to === null) {
        // Assets a bundler loads (`?raw`, .css, .html, .json) are not modules here.
        if (!/\.(css|html|json|svg|png|woff2?)(\?.*)?$|\?raw$/.test(spec)) problems.push(`${rel(f)}: ${spec} resolves to no file`);
        continue;
      }
      if (inPackages && rel(to).startsWith("apps/")) problems.push(`${rel(f)} imports ${rel(to)}: a package never imports an app`);
      if (!MODULE.test(to)) continue;
      out.add(to);
      edges++;
    }
    graph.set(f, out);
  }
  if (files.length < min)
    problems.push(`read only ${files.length} modules, under ${min}: the walk missed the source, so "no cycles" would mean nothing`);
  if (edges < minImports)
    problems.push(`found only ${edges} runtime imports, under ${minImports}: the walk read the files but followed no imports, so "no cycles" would mean nothing`);
  for (const c of cycles(graph)) problems.push(`runtime cycle: ${c.map(rel).join(" ↔ ")}`);
  for (const c of cycles(pkgGraph)) problems.push(`package cycle: ${c.join(" ↔ ")}`);
  return { modules: files.length, edges, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = check();
  for (const p of r.problems) console.log(`  ${p}`);
  console.log(
    r.problems.length === 0
      ? `no-cycles: ${r.modules} modules, ${r.edges} runtime imports, no cycles`
      : `no-cycles: ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"} in ${r.modules} modules`,
  );
  process.exit(r.problems.length === 0 ? 0 : 1);
}
