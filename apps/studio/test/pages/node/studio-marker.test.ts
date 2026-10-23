import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markStudioPage } from "../../../pages/vite.config";

// The studio build marks each of its pages (spec 2026-10-19 §7): the new
// look applies under `[data-studio]` and only the studio build writes it, so
// the extension's pages keep today's look. A page the build could not mark
// would render the old look in the studio without a word, so the marker
// refuses rather than pass it through.

// From `__dirname`, as manifest.slow.test.ts does: vite rewrites a
// `new URL(…, import.meta.url)` that names a folder or a template.
const ENTRYPOINTS = join(__dirname, "..", "..", "..", "pages", "entrypoints");
const page = (name: string): string =>
  readFileSync(join(ENTRYPOINTS, name, "index.html"), "utf8");

describe("markStudioPage", () => {
  it("marks <html> dark and links the studio sheet inside <head>", () => {
    const out = markStudioPage(
      '<html lang="en"><head><title>x</title></head><body></body></html>',
    );
    expect(out).toContain('<html lang="en" data-studio data-theme="dark">');
    const link = out.indexOf('href="../../assets/studio.css"');
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(out.indexOf("</head>"));
  });

  it("leaves one data-theme, and it is dark", () => {
    const out = markStudioPage(
      '<html lang="en" data-theme="light"><head></head><body></body></html>',
    );
    expect(out.match(/data-theme=/g)).toHaveLength(1);
    expect(out).toContain('data-theme="dark"');
  });

  it("refuses a page with no <html> tag", () => {
    expect(() => markStudioPage("<head></head><body></body>")).toThrow(
      /no <html> tag/,
    );
  });

  it("refuses a page with no </head>", () => {
    expect(() =>
      markStudioPage('<html lang="en"><body></body></html>'),
    ).toThrow(/no <\/head>/);
  });

  it("is never in the extension's own pages", () => {
    for (const name of ["editor", "library", "settings"]) {
      const html = page(name);
      // The premise: these are the pages the studio builds, with <html>.
      expect(html, name).toMatch(/<html\b/);
      expect(html, name).not.toContain("data-studio");
      expect(html, name).not.toContain("studio.css");
    }
  });
});
