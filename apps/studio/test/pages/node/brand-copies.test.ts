import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The studio's pages serve their own copies of the brand marks
 * (`pages/public/images/`), so the studio can leave this workspace without
 * reaching across it for an asset. `brand/` is the canonical copy. Copies
 * drift; this is what makes it loud. (Until 2026-10-20 the extension's
 * `icons.test.ts` held these same files, when they were the extension's.)
 */

const REPO = join(__dirname, "..", "..", "..", "..", "..");
const IMAGES = join(__dirname, "..", "..", "..", "pages", "public", "images");
const FILES = [
  "icon.svg",
  "logomark.svg",
  "lockup_light.svg",
  "lockup_dark.svg",
];

describe("the Studio's brand copies", () => {
  it.each(FILES)("holds pages/public/images/%s to brand/", (file) => {
    const canonical = join(REPO, "brand", file);
    const copy = join(IMAGES, file);
    // If brand/ is gone the repo has been split, and the comparison must not
    // pass as though it ran.
    expect(
      existsSync(canonical),
      `${canonical} is missing, so nothing is holding ${file} to the ` +
        `canonical copy. If the repo has been split, compare against the ` +
        `published brand asset instead of deleting this test.`,
    ).toBe(true);
    expect(existsSync(copy), `${copy} is missing`).toBe(true);
    expect(readFileSync(copy)).toEqual(readFileSync(canonical));
  });
});

// The page bars draw the mark inline (`.logomark .figure`), by hand: its
// pieces (the folded mascot's ▶, ●, two legs and body) have to be
// brand/logomark.svg's.
describe("the Studio's inline mark", () => {
  const shapes = readFileSync(
    join(REPO, "brand", "logomark.svg"),
    "utf8",
  ).match(/<g fill="currentColor">([\s\S]*)<\/g>\s*<\/svg>/)?.[1];
  it.each(["library", "settings"])(
    "%s's page bar draws brand/logomark.svg's mark",
    (page) => {
      expect(
        shapes?.match(/<path |<circle |<rect /g)?.length,
        "premise: brand/logomark.svg's ▶, ●, two legs and body were read",
      ).toBe(5);
      const html = readFileSync(
        join(
          __dirname,
          "..",
          "..",
          "..",
          "pages",
          "entrypoints",
          page,
          "index.html",
        ),
        "utf8",
      );
      const inner = html.match(
        /<span class="figure" hidden><svg viewBox="0 0 199 199"[^>]*>([\s\S]*?)<\/svg>/,
      )?.[1];
      expect(inner, `${page}/index.html has no inline mark`).toBeDefined();
      expect(inner).toBe(shapes);
    },
  );
});
