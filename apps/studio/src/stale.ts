import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

// A port of `staleBuild` from the extension's browser launcher (archived)
// (ruling R7: the .mjs is never imported). CLAUDE.md's "Rebuilding the
// extension is not reloading it": a studio serving pages older than the
// source it is being checked against proves nothing about that source.

/** The checkout-relative folder the studio build writes (Task 11; since
 *  2026-10-20 the pages build in `apps/studio`, not `apps/extension`). */
const CHECKOUT_PAGES = join("apps", "studio", ".output", "pages");
/** What the studio pages are built from, under `apps/studio`. */
const SOURCE_DIRS = [
  "pages/src",
  "pages/entrypoints",
  "pages/assets",
  "pages/public",
] as const;
/** Skipped inside a source dir, as the launcher's `newest` skips them. */
const SKIPPED = new Set(["node_modules", "dist", ".output", ".wxt", "test"]);

/** Newest mtime under `dir`, skipping build output, dependencies and tests. */
function newest(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    latest = Math.max(
      latest,
      entry.isDirectory() ? newest(path) : statSync(path).mtimeMs,
    );
  }
  return latest;
}

/**
 * `apps/studio` when `pagesDir` is a checkout's
 * `apps/studio/.output/pages`, else null: the packaged pages
 * (`dist/studio`) are not checked (spec §8, "A stale bundle in a dev
 * checkout").
 */
export function checkoutAppOf(pagesDir: string): string | null {
  const dir = resolve(pagesDir);
  if (!dir.endsWith(sep + CHECKOUT_PAGES)) return null;
  const app = dirname(dirname(dir));
  return existsSync(join(app, "package.json")) ? app : null;
}

/**
 * Refuses `output` (one file the build writes) when it is missing or older
 * than the newest file under `sources`. A source dir that does not exist adds
 * nothing (`public/` may be absent); one that exists and will not read is
 * said, since a check that could not look is not a fresh build.
 */
export function staleBuild(o: {
  output: string;
  sources: readonly string[];
}): { ok: true } | { ok: false; reason: string } {
  let built: number;
  try {
    built = statSync(o.output).mtimeMs;
  } catch {
    return {
      ok: false,
      reason: `no build at ${o.output} — run \`pnpm -r build\` first.`,
    };
  }
  let edited = 0;
  for (const dir of o.sources) {
    if (!existsSync(dir)) continue;
    try {
      edited = Math.max(edited, newest(dir));
    } catch (error) {
      return {
        ok: false,
        reason: `${dir} could not be read to check the build against it (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
  }
  if (edited > built) {
    return {
      ok: false,
      reason: `${o.output} is older than the source (built ${new Date(built).toLocaleTimeString()}, last edit ${new Date(edited).toLocaleTimeString()}) — run \`pnpm -r build\` first.`,
    };
  }
  return { ok: true };
}

/** The file the studio build writes last-ish and names its sha in. */
export const BUILD_STAMP = "studio-build.json";

/**
 * The stale-bundle guard for `pagesDir`: `{ ok: true, checked: false }`
 * outside a checkout, the staleness verdict inside one.
 */
export function checkPagesFresh(
  pagesDir: string,
): { ok: true; checked: boolean } | { ok: false; reason: string } {
  const app = checkoutAppOf(pagesDir);
  if (app === null) return { ok: true, checked: false };
  const verdict = staleBuild({
    output: join(pagesDir, BUILD_STAMP),
    sources: SOURCE_DIRS.map((d) => join(app, d)),
  });
  return verdict.ok ? { ok: true, checked: true } : verdict;
}
