// apps/studio/test/pages/node/theme-tokens.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every shell stylesheet carries its dark tokens TWICE: once under
 * `@media (prefers-color-scheme: dark)` for the system theme, and once
 * under `:root[data-theme="dark"]` for the author's explicit choice. CSS
 * has no way to say "this block, under either condition" that Chrome 116
 * understands (`light-dark()` arrived in 123), so the copy is deliberate —
 * and a copy is exactly what drifts. This reads both blocks out of each
 * shipped stylesheet and asserts they declare the same tokens with the
 * same values, so a token changed in one place goes red here rather than
 * painting one theme in the toggle and another under the system.
 */

const ROOT = join(__dirname, "..", "..", "..", "pages");

/** `atLeast` guards the fixture: an empty map on either side would compare
 *  equal to an empty map and pass while asserting nothing. The shell owns
 *  the palette (30 dark tokens on 2026-09-14); the editor keeps only its
 *  own — the stage well and glow, the two beds, three lanes with their
 *  inks, and (since Task 3, 2026-09-21) the format chip's arrow, whose
 *  stroke is baked into a data URI and so cannot read `--secondary-ink`
 *  directly — eleven, since it started linking the shell that day. */
const SHEETS: { name: string; path: string; atLeast: number }[] = [
  { name: "the shell", path: join(ROOT, "assets", "shell.css"), atLeast: 25 },
  {
    name: "the editor",
    path: join(ROOT, "entrypoints", "editor", "index.html"),
    atLeast: 10,
  },
];

/** The declarations of the first `{ ... }` after `selector`, as a map.
 *  Comments are stripped before splitting on `;` — this file's own
 *  comments run to prose and land a bare `;` mid-sentence often enough
 *  (`--seam`'s and `--rail-w`'s own, above) that leaving them in shifts
 *  every declaration after one, corrupting rather than merely dropping
 *  values. Filtered out below only because the shifted fragments rarely
 *  start with `--`; a comment that happened to hold a bare `--name:`-shaped
 *  clause could still leak through, which is a reason to keep this narrow
 *  rather than a reason it was safe before. */
function block(css: string, selector: string): Map<string, string> {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no ${selector} block`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const line of body.split(";")) {
    const [name, ...rest] = line.split(":");
    const key = name?.trim();
    if (!key?.startsWith("--")) continue;
    out.set(key, rest.join(":").replace(/\s+/g, " ").trim());
  }
  return out;
}

describe.each(SHEETS)("$name's dark tokens", ({ path, atLeast }) => {
  it("declare the same values under the system query and the explicit choice", () => {
    const css = readFileSync(path, "utf8");
    const system = block(css, ':root:not([data-theme="light"])');
    const chosen = block(css, ':root[data-theme="dark"]');
    expect(system.size).toBeGreaterThanOrEqual(atLeast);
    expect(Object.fromEntries(chosen)).toEqual(Object.fromEntries(system));
  });

  it("keep the explicit-choice block OUTSIDE the media query", () => {
    // A `:root[data-theme="dark"]` block nested inside the media query
    // would apply only when the system is dark — the toggle would do
    // nothing on a light system, which is the case it exists for.
    const css = readFileSync(path, "utf8");
    const media = css.indexOf("@media (prefers-color-scheme: dark)");
    const mediaClose = (() => {
      let depth = 0;
      for (let i = css.indexOf("{", media); i < css.length; i += 1) {
        if (css[i] === "{") depth += 1;
        if (css[i] === "}") {
          depth -= 1;
          if (depth === 0) return i;
        }
      }
      throw new Error("unbalanced media block");
    })();
    const chosen = css.indexOf(':root[data-theme="dark"]');
    expect(chosen).toBeGreaterThan(-1);
    expect(chosen < media || chosen > mediaClose).toBe(true);
  });
});
