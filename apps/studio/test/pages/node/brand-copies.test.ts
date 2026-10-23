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
