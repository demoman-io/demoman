// Shoots the docs as Mintlify draws them, and checks the painted result.
//   node scripts/docs-shots.mjs
// Starts `mint dev` in apps/docs, opens each page at desktop and phone width
// in light and dark, writes PNGs to apps/docs/.shots/, and prints one line
// per check. Last line: `docs:shots: N checks, K failures`; exit 1 on any.
// The browser is Playwright's (no keychain prompt), never a hand-launched one.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const require = createRequire(new URL("../apps/cli/package.json", import.meta.url));
const { chromium } = require("playwright");

const docsDir = new URL("../apps/docs/", import.meta.url).pathname;
const outDir = `${docsDir}.shots`;
const PAGES = ["index", "get-started/first-video", "get-started/add-to-repo", "reference/add", "studio/editing", "guides/phone-and-tablet", "concepts/refresh"];
const SIZES = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];
const THEMES = ["light", "dark"];

const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

let checks = 0;
let failures = 0;
const check = (ok, line) => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
};

const port = await freePort();
const base = `http://localhost:${port}`;
const server = spawn("npx", ["--yes", "mint@latest", "dev", "--port", String(port), "--no-open"], {
  cwd: docsDir,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const stop = () => server.kill("SIGTERM");
try {
  const deadline = Date.now() + 240_000;
  for (;;) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      // not answering yet: the deadline below says when that is a failure
    }
    if (server.exitCode !== null || Date.now() > deadline) {
      console.log(`FAIL mint dev did not answer at ${base}\n${serverLog.slice(-2000)}`);
      console.log("docs:shots: 0 checks, 1 failures");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ["--use-mock-keychain"] });
  for (const theme of THEMES)
    for (const size of SIZES) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        colorScheme: theme,
      });
      const page = await context.newPage();
      for (const slug of PAGES) {
        const where = `${slug} ${size.name} ${theme}`;
        await page.goto(`${base}/${slug === "index" ? "" : slug}`, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const m = await page.evaluate(() => {
          const family = (sel) => {
            const el = document.querySelector(sel);
            return el ? getComputedStyle(el).fontFamily : null;
          };
          return {
            manrope: document.fonts.check("16px Manrope"),
            body: family("#content-area p"),
            code: family("#content-area code"),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            steps: document.querySelectorAll(".dm-path li").length,
            current: document.querySelectorAll('.dm-path [aria-current="step"]').length,
            // The colour painted under a blank point at the window's right edge:
            // the first element there, top down, with an opaque background.
            bg: (() => {
              for (const el of document.elementsFromPoint(innerWidth - 3, innerHeight - 3)) {
                const c = getComputedStyle(el).backgroundColor;
                if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
              }
              return getComputedStyle(document.documentElement).backgroundColor;
            })(),
            dark: document.documentElement.classList.contains("dark"),
            // The navbar's "npx demoman setup" button: its fill, where shown.
            cta: (() => {
              const fill = document.querySelector("#topbar-cta-button .bg-primary-dark");
              return fill && fill.getClientRects().length ? getComputedStyle(fill).backgroundColor : null;
            })(),
          };
        });
        check(m.manrope && /^"?Manrope/.test(m.body ?? ""), `${where}: body text in Manrope (${m.body})`);
        if (m.code !== null) check(/^"?Geist Mono/.test(m.code), `${where}: code in Geist Mono (${m.code})`);
        check(m.overflow <= 0, `${where}: no sideways scroll (${m.overflow}px over)`);
        if (slug.startsWith("get-started/"))
          check(m.steps === 6 && m.current === 1, `${where}: strip has 6 steps, 1 current (${m.steps}, ${m.current})`);
        if (theme === "dark")
          check(m.dark && m.bg === "rgb(10, 10, 10)", `${where}: dark, on #0a0a0a (${m.bg}, dark class ${m.dark})`);
        else check(!m.dark && m.bg === "rgb(255, 255, 255)", `${where}: light, on white (${m.bg})`);
        if (m.cta !== null) check(m.cta !== m.bg, `${where}: navbar button stands off the page (${m.cta} on ${m.bg})`);
        const file = `${outDir}/${slug.replace(/\//g, "-")}-${size.name}-${theme}.png`;
        await page.screenshot({ path: file, fullPage: true });
      }
      await context.close();
    }
  await browser.close();
} finally {
  stop();
}
console.log(`docs:shots: ${checks} checks, ${failures} failures (PNGs in ${outDir})`);
process.exit(failures > 0 ? 1 : 0);
