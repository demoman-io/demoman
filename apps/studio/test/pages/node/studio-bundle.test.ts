import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Which side of `#platform` the pages' build carries (spec 2026-10-15 §5):
 * the alias picks it at build time, and only the bundle can say whether the
 * pick held.
 *
 * - The studio's pages (`pages/vite.config.ts`) reach nothing of Chrome's:
 *   no `chrome.` and no `indexedDB` in any emitted script. A page that did
 *   would throw on the studio's plain Chrome tab, or read an empty store
 *   and say "no frames yet" over frames that are on disk.
 *
 * Until 2026-10-20 the extension's `wxt build` was checked here too, for
 * the other side; it was archived with the extension (tag
 * `archive/extension`).
 */

const ROOT = join(__dirname, "..", "..", "..", "pages");
const VITE = join(ROOT, "..", "node_modules", ".bin", "vite");

interface Emitted {
  name: string;
  text: string;
}

function emitted(dir: string, ext: string): Emitted[] {
  const files: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(ext)) files.push(path);
    }
  };
  walk(dir);
  return files.map((f) => ({
    name: f.slice(dir.length + 1),
    text: readFileSync(f, "utf8"),
  }));
}

/** Each hit named by file and a window around it: a minified chunk is one
 *  line, and CI cannot be reproduced, so the failure says where to look. */
function hits(files: Emitted[], token: string): string[] {
  return files
    .filter((f) => f.text.includes(token))
    .map((f) => {
      const at = f.text.indexOf(token);
      return `${token} in ${f.name} @${at}: …${f.text.slice(Math.max(0, at - 60), at + 60)}…`;
    });
}

const made: string[] = [];
let studioDir = "";
let studioJs: Emitted[] = [];
let studioHtml: Emitted[] = [];

describe("the pages' build carries the HTTP side of #platform", () => {
  beforeAll(() => {
    const parent = mkdtempSync(join(tmpdir(), "demoman-studio-pages-"));
    made.push(parent);
    studioDir = join(parent, "studio");
    execFileSync(VITE, ["build", "-c", "vite.config.ts"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, STUDIO_OUT_DIR: studioDir },
    });
    studioJs = emitted(studioDir, ".js");
    studioHtml = emitted(studioDir, ".html");
    // One vite build (~1 s here); the CI runner is ~5x slower on this kind
    // of work.
  }, 240_000);

  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  it("writes the pages the Studio serves, under the names it serves them by", () => {
    expect(studioHtml.map((f) => f.name).sort()).toEqual([
      "editor.html",
      "library.html",
      "settings.html",
    ]);
    const stamp = JSON.parse(
      readFileSync(join(studioDir, "studio-build.json"), "utf8"),
    ) as { sha?: unknown; builtAt?: unknown };
    expect(typeof stamp.sha).toBe("string");
    expect(Number.isNaN(Date.parse(String(stamp.builtAt)))).toBe(false);
    expect(existsSync(join(studioDir, "fonts"))).toBe(true);
  });

  it("is the HTTP side (premise for the next case)", () => {
    // Asserting the fixture, per CLAUDE.md: a walk that found nothing, or a
    // build of the wrong side, would make "is absent" pass unread.
    expect(studioJs.length).toBeGreaterThan(1);
    expect(hits(studioJs, "X-Demoman-Studio").length).toBeGreaterThan(0);
  });

  // Premise for the grep below: the Settings page's own scripts are among
  // the ones it reads. A settings page that loaded no script, or one the
  // walk missed, would let "no chrome." pass over code never read. Red:
  // import "../../src/adapters/kv" in entrypoints/settings/main.ts.
  it("loads scripts for settings.html that the grep below reads", () => {
    const page = studioHtml.find((f) => f.name === "settings.html");
    expect(page, "settings.html in the Studio output").toBeDefined();
    const srcs = [
      ...(page?.text ?? "").matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g),
    ].map((m) => (m[1] ?? "").replace(/^\//, ""));
    expect(
      srcs.length,
      `scripts in settings.html: ${page?.text}`,
    ).toBeGreaterThan(0);
    const read = new Set(studioJs.map((f) => f.name));
    for (const src of srcs) {
      expect(read.has(src), `${src} among ${[...read].join(", ")}`).toBe(true);
    }
    const sheets = [
      ...(page?.text ?? "").matchAll(
        /<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g,
      ),
    ].map((m) => m[1] ?? "");
    expect(
      sheets.some((s) => /settings-inline-/.test(s)),
      `settings.html links its moved stylesheet: ${sheets.join(", ")}`,
    ).toBe(true);
    for (const s of sheets) {
      expect(existsSync(join(studioDir, s.replace(/^\//, ""))), s).toBe(true);
    }
  });

  it("reaches nothing of Chrome's from the Studio's pages", () => {
    const found = [
      ...hits(studioJs, "chrome."),
      ...hits(studioJs, "indexedDB"),
    ];
    expect(found.join("\n"), "Chrome in the Studio's pages").toBe("");
  });

  // Archive, Task 9 (2026-10-20): what only the extension's platform members
  // drew — share and hosting, the account menu, the take notice the
  // extension's Stop left, the `?fixture=` door — is not in the studio's
  // pages at all, rather than present and switched off. A control the
  // studio can never fill is code nobody can reach; one a later edit
  // switched back on would be a dead control on screen. (Settings'
  // extension sections, Agents and sites, the library's storage panel and
  // "Download again" are a recorded follow-up, not cut yet.)
  it("carries none of the extension-only surfaces", () => {
    // Premise: the walk reads the editor's own code, so "absent" is read.
    expect(hits(studioJs, "data-export-start").length).toBeGreaterThan(0);
    const found = [
      "data-share",
      "data-account",
      "Brand kit not applied",
      "Could not seed fixture",
    ].flatMap((token) => hits(studioJs, token));
    expect(found.join("\n"), "extension-only surfaces in the pages").toBe("");
  });

  // The studio serves every page under `default-src 'self'` (spec §4.1),
  // which refuses inline styles: left in, the pages' own rules never apply.
  it("leaves no inline style or script in the Studio's pages", () => {
    for (const page of studioHtml) {
      expect(page.text, page.name).not.toMatch(/<style\b/i);
      expect(page.text, page.name).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    }
  });

  // Ruling R19: zod's `Function("")` probe is refused by the studio's CSP
  // and logged as a violation on every load; the prelude sets jitless
  // first. Checked as running in headless Chromium in the Task 12 report;
  // this pins that the build still puts it in. Red: drop `studioPrelude()`
  // from the config's plugins.
  it("sets zod jitless in the Studio's pages", () => {
    expect(studioJs.some((f) => /jitless:\s*(!0|true)\}/.test(f.text))).toBe(
      true,
    );
  });
});
