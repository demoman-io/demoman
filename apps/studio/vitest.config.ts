import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { slowExcludes, testWorkers } from "../../scripts/test-tier.mjs";
import { dragAcross } from "./test/pages/helpers/drag-command";
import { pressBetween } from "./test/pages/helpers/point-command";
import { pressDown, pressUp } from "./test/pages/helpers/press-command";

/**
 * Runs against the built `dist` of every workspace package it imports
 * (`packages/*`: run-core, studio-protocol, scene-schema and what they pull
 * in) and of `apps/runner` (`@demoman/runner/studio`), as the bin does under
 * node. `server.deps.external` matches both, so vite-node loads them with
 * node's own resolver and does not forgive an extensionless import or a CJS
 * interop that raw node would reject (CLAUDE.md, the `dist` section).
 * `pnpm -r test` does not build: run `pnpm test`, or build first.
 *
 * Two lanes, both run by `test`, as `apps/runner` runs its own
 * browser-launching tests in its one `test` (CI has Chrome for Testing):
 *
 * - `node`: fakes for the window and the render; fast.
 * - `browser`: node-driven Playwright, the real studio (`runServe`) with the
 *   real built pages (`apps/studio/.output/pages`) in a real Chrome for
 *   Testing window, exporting through the real queue. Its timeouts are set
 *   at each test, with the measured local number beside them.
 *
 * And two for the pages themselves (`pages/`), moved with them from
 * apps/extension on 2026-10-20:
 *
 * - `pages-node`: the editor, library and Settings modules under jsdom.
 * - `pages-browser`: vitest browser mode in Chromium, for what depends on
 *   layout, pixels or a real pointer (the three node-side commands below).
 *
 * Those two read the workspace packages from source, not `dist`: the pages
 * are bundled by vite, never loaded by node, so the `dist` hazards above do
 * not apply, and the source is what an edit changes. `#platform` is the
 * HTTP side, as `pages/vite.config.ts` gives the build.
 */
const external = [/\/packages\/[^/]+\/dist\//, /\/apps\/runner\/dist\//];

const src = (p: string): string =>
  fileURLToPath(new URL(`../../packages/${p}/src`, import.meta.url));

/** Subpath entries first and matched exactly, so a bare package alias does
 *  not shadow them. */
const pagesAlias = [
  {
    find: "#platform",
    replacement: fileURLToPath(
      new URL("./pages/src/platform/http.ts", import.meta.url),
    ),
  },
  { find: "@demoman/agent-bridge", replacement: src("agent-bridge") },
  {
    find: "@demoman/run-core/logo",
    replacement: `${src("run-core")}/logo.ts`,
  },
  {
    find: "@demoman/run-core/wallpaper",
    replacement: `${src("run-core")}/wallpaper.ts`,
  },
  {
    find: "@demoman/run-core/page",
    replacement: `${src("run-core")}/page.ts`,
  },
  {
    find: "@demoman/run-core/render",
    replacement: `${src("run-core")}/render/index.ts`,
  },
  { find: "@demoman/run-core", replacement: src("run-core") },
  {
    find: "@demoman/replay-engine/page",
    replacement: `${src("replay-engine")}/page.ts`,
  },
  { find: "@demoman/replay-engine", replacement: src("replay-engine") },
  { find: "@demoman/compositor", replacement: src("compositor") },
  { find: "@demoman/resolver", replacement: src("resolver") },
  { find: "@demoman/scene-schema", replacement: src("scene-schema") },
  { find: "@demoman/studio-protocol", replacement: src("studio-protocol") },
];

const here = fileURLToPath(new URL(".", import.meta.url));
const exclude = [...configDefaults.exclude, ...slowExcludes(here)];

export default defineConfig({
  test: {
    ...testWorkers("heavy"),
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/node/**/*.test.ts"],
          testTimeout: 20_000,
          server: { deps: { external } },
        },
      },
      {
        test: {
          name: "browser",
          environment: "node",
          include: ["test/browser/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          server: { deps: { external } },
        },
      },
      {
        resolve: { alias: pagesAlias },
        test: {
          name: "pages-node",
          environment: "jsdom",
          include: ["test/pages/node/**/*.test.ts"],
          exclude,
          // jsdom has no ResizeObserver, and the editor's `main.ts`
          // constructs one at module scope; see the file's own comment.
          setupFiles: ["./test/pages/helpers/jsdom-globals.ts"],
          // Four times vitest's default: the `editor-main-*` files each boot
          // the real `entrypoints/editor/main.ts`, and the first `import()`
          // in a file pays vite's transform of its whole graph (~425 ms
          // alone, past 5 s under a full parallel run, measured in
          // apps/extension where this lane came from).
          testTimeout: 20_000,
        },
      },
      {
        resolve: { alias: pagesAlias },
        // The fonts and images the pages name by absolute path (`/fonts/…`),
        // served from the lane's root as the build serves them.
        publicDir: fileURLToPath(new URL("./pages/public", import.meta.url)),
        test: {
          name: "pages-browser",
          include: ["test/pages/browser/**/*.test.ts"],
          exclude,
          // One file at a time. Files run in parallel share the tab's one
          // real mouse (`page.mouse`, which the commands below drive), so a
          // hover or drag in one file lands on whatever another file has
          // under the pointer. Measured 2026-10-20 after the move from
          // apps/extension: 22-34 of 633 failed in parallel, whatever the
          // worker count, and 0 failed with this set.
          fileParallelism: false,
          browser: {
            enabled: true,
            provider: "playwright",
            headless: true,
            instances: [{ browser: "chromium" }],
            // Node-side commands, for the one thing this lane cannot do
            // from inside the page: press a real mouse button and move it.
            // See `test/pages/helpers/drag-command.ts`.
            commands: { dragAcross, pressBetween, pressDown, pressUp },
          },
        },
      },
    ],
  },
});
