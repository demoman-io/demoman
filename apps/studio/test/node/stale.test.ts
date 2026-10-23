import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutAppOf, checkPagesFresh } from "../../src/stale.js";

// The stale-pages guard for a checkout (CLAUDE.md, "Rebuilding … is not
// reloading it"): since 2026-10-20 the pages are built from
// `apps/studio/pages/` into `apps/studio/.output/pages/`, and a guard still
// watching the extension's old folder would call every build fresh.

let root = "";

afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = "";
});

/** A checkout whose pages were built `stampAgeMs` after their newest source
 *  (negative: before it). Returns the built pages folder. */
async function checkout(stampAgeMs: number): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "studio-stale-"));
  const app = join(root, "apps", "studio");
  const pagesDir = join(app, ".output", "pages");
  await mkdir(join(app, "pages", "src"), { recursive: true });
  await mkdir(pagesDir, { recursive: true });
  await writeFile(join(app, "package.json"), "{}\n");
  const source = join(app, "pages", "src", "x.ts");
  await writeFile(source, "export {};\n");
  await writeFile(join(pagesDir, "studio-build.json"), "{}\n");
  const now = Date.now() / 1000;
  await utimes(source, now, now);
  const stamp = now + stampAgeMs / 1000;
  await utimes(join(pagesDir, "studio-build.json"), stamp, stamp);
  return pagesDir;
}

describe("the checkout's stale-pages guard", () => {
  it("finds the checkout from apps/studio/.output/pages", async () => {
    const pagesDir = await checkout(60_000);
    expect(checkoutAppOf(pagesDir)).toBe(join(root, "apps", "studio"));
  });

  it("calls the checkout's pages stale after a page source changes", async () => {
    const pagesDir = await checkout(-60_000);
    // Premise: this is a checkout the guard checks, not a packaged install.
    expect(checkoutAppOf(pagesDir)).not.toBeNull();
    const verdict = checkPagesFresh(pagesDir);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(
      /older than the source/,
    );
  });

  it("calls them fresh when they were built after the source", async () => {
    const pagesDir = await checkout(60_000);
    expect(checkPagesFresh(pagesDir)).toEqual({ ok: true, checked: true });
  });
});
