// apps/cli/scripts/studio-pages.mjs
//
// The check build.mjs makes before it packs the studio's pages (step 3b):
// they must have been built for this version of the CLI, and from the
// source as it is now. The staleness half is apps/studio's own `staleBuild`
// (the guard `studio --serve` runs in a checkout), so the two cannot drift.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { staleBuild } from "@demoman/studio";

/** What the studio pages are built from, under `apps/studio/pages` — the
 *  same folders apps/studio/src/stale.ts checks. */
export const STUDIO_SOURCE_DIRS = ["src", "entrypoints", "assets", "public"];
/** The files a packed studio cannot serve without. */
export const STUDIO_NEEDED = [
  "library.html",
  "editor.html",
  "settings.html",
  "studio-build.json",
];

/** The built-in wallpaper ids. A copy of `WALLPAPERS` in scene-schema: this
 *  file is plain .mjs and cli does not depend on that package; build.test.ts
 *  fails when the two disagree. */
export const WALLPAPER_IDS = [
  "vivid-1",
  "vivid-2",
  "vivid-3",
  "vivid-4",
  "vivid-5",
  "vivid-6",
  "light-1",
  "light-2",
  "dark-1",
  "dark-2",
];
const WALLPAPER_SHAPES = ["landscape", "portrait", "thumb"];

/**
 * `{ ok: true }`, or `{ ok: false, reason }` with the sentence build.mjs
 * stops on: a page missing, a stamp that will not read or names another
 * version, or pages older than the newest source file.
 */
export function checkStudioPages({ pagesDir, pagesSourceDir, version }) {
  for (const needed of STUDIO_NEEDED) {
    if (!existsSync(join(pagesDir, needed))) {
      return {
        ok: false,
        reason: `the Studio's pages are not built (no ${join(pagesDir, needed)}) — run \`pnpm -r build\`, which builds apps/studio's pages first`,
      };
    }
  }
  for (const id of WALLPAPER_IDS) {
    for (const shape of WALLPAPER_SHAPES) {
      const file = join("wallpapers", `${id}-${shape}.webp`);
      if (!existsSync(join(pagesDir, file))) {
        return {
          ok: false,
          reason: `the Studio's pages lack the wallpaper ${join(pagesDir, file)} — run \`pnpm -r build\`, which copies apps/studio/pages/public/wallpapers`,
        };
      }
    }
  }
  const stampPath = join(pagesDir, "studio-build.json");
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: `${stampPath} could not be read (${error instanceof Error ? error.message : String(error)}) — run \`pnpm -r build\``,
    };
  }
  if (stamp?.version !== version) {
    return {
      ok: false,
      reason: `the Studio's pages were built for demoman ${stamp?.version === undefined ? "of no stated version" : stamp.version}, not ${version} (${stampPath}) — run \`pnpm -r build\``,
    };
  }
  const fresh = staleBuild({
    output: stampPath,
    sources: STUDIO_SOURCE_DIRS.map((d) => join(pagesSourceDir, d)),
  });
  if (!fresh.ok) {
    return { ok: false, reason: `the Studio's pages: ${fresh.reason}` };
  }
  return { ok: true };
}
