// The detached process openStudio spawns in open.test.ts: runServe from the
// built dist with a window that is not a browser. argv[2] is the home.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = new URL("../../dist/", import.meta.url);
const { runServe } = await import(new URL("serve.js", dist).href);
const { pagePathFor } = await import(new URL("paths.js", dist).href);

const home = process.argv[2];
const version = process.argv[3] ?? "0.0.0-test";
const pagesDir = join(home, "stub-pages");
mkdirSync(pagesDir, { recursive: true });
for (const f of ["index.html", "editor.html"]) {
  writeFileSync(join(pagesDir, f), "<!doctype html><title>x</title>");
}
void pathToFileURL;

await runServe({
  home,
  outDir: join(home, "out"),
  pagesDir,
  version,
  // stderr is the studio.log openStudio set up.
  log: (line) => process.stderr.write(`${line}\n`),
  createWindow: () => ({
    async open(t) {
      return { ok: true, path: pagePathFor(t.takeId) };
    },
    async workPage() {
      return { ok: false, reason: "windowDidNotOpen", detail: "fake" };
    },
    onAllClosed() {},
    async close() {},
  }),
});
