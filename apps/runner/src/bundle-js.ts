import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOptions } from "esbuild";

/**
 * `apps/runner` itself, whether this module is running from `src/` under
 * vite-node or from `dist/` as the shipped CLI.
 *
 * It is what esbuild is given as `absWorkingDir`, and that is the whole
 * reason this constant exists: it makes every `@demoman/*` specifier in an
 * in-page entry resolve through `apps/runner/node_modules` to the packages'
 * `dist` — the same `exports` map the node half reads. One resolution for
 * both halves of the port is not an optimisation; it is the only thing that
 * keeps `REPLAY_TARGETS` byte-identical across it, and one side parks under
 * that name while the other looks it up. See `vitest.config.ts`'s header for
 * why this lane deliberately has no `src` alias.
 */
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The four in-page entries, by the file name a prebuilt bundle carries. */
export const PAGE_ENTRIES = [
  "resolve-entry",
  "executor-entry",
  "render-entry",
  "mux-entry",
] as const;
export type PageEntry = (typeof PAGE_ENTRIES)[number];

/** Where an entry's built JS sits in `apps/runner/dist` — what the package
 *  build prebuilds from. `../dist/` is `dist` from both `src/` and `dist/`. */
export function pageEntryPath(name: PageEntry): string {
  const folder = name === "executor-entry" ? "executor/" : "";
  return fileURLToPath(new URL(`../dist/${folder}${name}.js`, import.meta.url));
}

/** The one set of options every page bundle is built with, here and in the
 *  package build, so a prebuilt bundle is the bundle this file would make. */
export function pageBuildOptions(entryPath: string): BuildOptions {
  return {
    absWorkingDir: APP_ROOT,
    bundle: true,
    entryPoints: [entryPath],
    format: "iife",
    // The runner drives the Chromium that Playwright pins, so nothing here
    // needs transpiling further back than that. Kept explicit so a bundle
    // that starts failing in the page names a version to check.
    target: "chrome120",
    platform: "browser",
    write: false,
  };
}

/** Set by the published package (launch B), which ships each page bundle
 *  prebuilt and no esbuild. Null: build with esbuild, as the repo does. */
let prebuiltDir: string | null = null;
export function usePrebuiltPages(dir: string | null): void {
  prebuiltDir = dir;
}

async function readPrebuilt(dir: string, entryPath: string): Promise<string> {
  const name = basename(entryPath).replace(/\.(ts|js)$/, "");
  if (!(PAGE_ENTRIES as readonly string[]).includes(name)) {
    throw new Error(
      `${basename(entryPath)} has no prebuilt page bundle; this install ships ${PAGE_ENTRIES.join(", ")}`,
    );
  }
  const file = join(dir, `${name}.js`);
  // readFile's own ENOENT names the path.
  const text = await readFile(file, "utf8");
  if (text === "") throw new Error(`the prebuilt page bundle ${file} is empty`);
  return text;
}

/**
 * esbuild-bundles an in-page entry to a self-contained IIFE.
 *
 * In-process (`import { build }`) rather than shelling out to the esbuild
 * binary: the runner already depends on esbuild, a child process costs a
 * node start per call, and a failed spawn reports through a channel
 * (`stderr`, an exit code) the caller would have to reconstruct an error
 * from. `build` rejects with esbuild's own formatted message instead.
 *
 * Shared with the mux and render entries a later task adds — hence the
 * `entryPath` parameter rather than a hard-coded one.
 */
export async function bundleEntry(entryPath: string): Promise<string> {
  if (prebuiltDir !== null) return readPrebuilt(prebuiltDir, entryPath);
  // Imported here, not at the top: the published package has no esbuild,
  // and never reaches this line.
  const { build } = await import("esbuild");
  const result = await build(pageBuildOptions(entryPath));
  const text = result.outputFiles?.[0]?.text;
  if (text === undefined || text === "") {
    // esbuild rejects on a build error, so reaching here means it reported
    // success and produced nothing — a state no caller can act on and that
    // would otherwise arrive as an init script that silently installs
    // nothing. Name the entry, because that is the only thing that varies.
    throw new Error(
      `esbuild produced no output for ${entryPath} (it reported no error)`,
    );
  }
  return text;
}
