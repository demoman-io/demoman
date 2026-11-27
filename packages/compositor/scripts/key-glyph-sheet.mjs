#!/usr/bin/env node
/**
 * The keycap glyph sheet: each vendored Lucide outline in
 * `src/render/key-glyphs.ts`, from the BUILT `dist`, beside Lucide's own SVG
 * from `lucide-static@LUCIDE_VERSION`, both at 96px and Lucide's stroke. A
 * row whose two columns differ is a wrong path. ⌦ is shown mirrored in both
 * columns, as the compositor mirrors it.
 *
 *   pnpm --filter @demoman/compositor build
 *   node packages/compositor/scripts/key-glyph-sheet.mjs [out-dir]
 *
 * Packs the package from the registry into a temp dir (`npm pack` runs no
 * install scripts), writes the sheet and screenshots it with Playwright's
 * Chromium. Prints the HTML and PNG paths. The out dir defaults to the
 * package's gitignored `.fixtures/key-glyph-sheet`.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = join(import.meta.dirname, "..");
const built = join(root, "dist", "render", "key-glyphs.js");
if (!existsSync(built)) {
  console.error(
    `key-glyph-sheet: ${built} is missing; build first (pnpm --filter @demoman/compositor build)`,
  );
  process.exit(1);
}
const { KEY_GLYPHS, LUCIDE_VERSION } = await import(pathToFileURL(built).href);
const out = resolve(
  process.argv[2] ?? join(root, ".fixtures", "key-glyph-sheet"),
);
mkdirSync(out, { recursive: true });

const pack = mkdtempSync(join(tmpdir(), "lucide-static-"));
let lucide;
try {
  const tgz = execFileSync(
    "npm",
    ["pack", `lucide-static@${LUCIDE_VERSION}`, "--silent"],
    { cwd: pack, encoding: "utf8" },
  ).trim();
  execFileSync("tar", ["xzf", tgz], { cwd: pack });
  lucide = Object.fromEntries(
    Object.values(KEY_GLYPHS).map((g) => [
      g.lucide,
      readFileSync(join(pack, "package", "icons", `${g.lucide}.svg`), "utf8"),
    ]),
  );
} finally {
  rmSync(pack, { recursive: true, force: true });
}

const STROKE =
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const theirs = (svg) =>
  svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\swidth="24"/, ' width="96"')
    .replace(/\sheight="24"/, ' height="96"');
const ours = (paths) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" ${STROKE}>${paths
    .map((d) => `<path d="${d}"/>`)
    .join("")}</svg>`;

const rows = Object.entries(KEY_GLYPHS)
  .map(([name, g]) => {
    const flip = g.mirrored ? ' class="flip"' : "";
    return `<tr><th>${name}<small>lucide ${g.lucide}${g.mirrored ? ", mirrored" : ""}</small></th><td${flip}>${theirs(lucide[g.lucide])}</td><td${flip}>${ours(g.paths)}</td></tr>`;
  })
  .join("\n");

const html = `<!doctype html><meta charset="utf-8"><title>Key glyph sheet</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;background:#fff;color:#18181b}
table{border-collapse:collapse}th,td{border:1px solid #e4e4e7;padding:10px 18px;text-align:left}
th small{display:block;font-weight:400;color:#71717a}
td svg{display:block}.flip svg{transform:scaleX(-1)}
</style>
<h1>Keycap glyphs: lucide-static@${LUCIDE_VERSION} against ours (dist)</h1>
<table><tr><th>glyph</th><th>Lucide's own</th><th>Ours</th></tr>
${rows}
</table>`;

const htmlPath = join(out, "key-glyph-sheet.html");
const pngPath = join(out, "key-glyph-sheet.png");
writeFileSync(htmlPath, html);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(htmlPath).href);
  await page.screenshot({ path: pngPath, fullPage: true });
} finally {
  await browser.close();
}
console.log(`html: ${htmlPath}`);
console.log(`png: ${pngPath}`);
