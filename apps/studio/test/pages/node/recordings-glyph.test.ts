// apps/studio/test/pages/node/recordings-glyph.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { icon } from "../../../pages/src/shell/icons";

/**
 * The Recordings tab's glyph is written inline in each tabbed page's
 * markup, where nothing else checks it, and drawn from `icons.ts` on the
 * popup's button and the empty library. A hand-copied path is a shape no
 * other assertion tells apart from the right one, so this holds every
 * page's tab to the one glyph: Lucide `monitor-play` since 2026-10-06.
 */
const PAGES = ["library", "settings"];

const paths = (svg: Element): string[] =>
  [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d") ?? "");

describe("the Recordings glyph", () => {
  const want = paths(icon("monitorPlay"));

  it("is monitor-play, drawn as four strokes", () => {
    // The premise: the glyph exists and is the one with the stand, not
    // the camera it replaced.
    expect(want).toHaveLength(4);
    expect(want).toContain("M8 21h8");
  });

  for (const name of PAGES) {
    it(`is what the ${name} page's Recordings tab draws`, () => {
      const html = readFileSync(
        join(__dirname, `../../../pages/entrypoints/${name}/index.html`),
        "utf8",
      );
      const doc = new DOMParser().parseFromString(html, "text/html");
      const tab = doc.querySelector('[data-tab="library"] svg');
      expect(tab, `${name} has a Recordings tab with a glyph`).not.toBeNull();
      expect(paths(tab as Element)).toEqual(want);
      expect(tab?.querySelectorAll("rect, circle")).toHaveLength(0);
    });
  }
});
