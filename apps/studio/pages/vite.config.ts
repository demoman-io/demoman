import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * The studio's pages (spec 2026-10-15 §3, §5): the editor, the library and the Settings page (Brand kit only),
 * built a second time with `#platform` on `src/platform/http.ts` — the
 * studio's loopback HTTP API — instead of the extension's `chrome.ts`.
 * Picked here, at build time; nothing in the pages picks a side at run time.
 *
 * Writes `apps/studio/.output/pages/` (or `STUDIO_OUT_DIR`, for the bundle
 * test):
 * `library.html` (served at `/`), `editor.html`, `assets/`, the fonts and
 * images from `public/`, and `studio-build.json` naming the commit, which
 * the studio logs at start and whose mtime its stale-bundle guard compares
 * with the source (`apps/studio/src/stale.ts`). `apps/cli`'s build copies
 * the folder into the published package as `dist/studio/`.
 *
 * Moved here from `apps/extension/vite.studio.config.ts` on 2026-10-20,
 * when the extension was archived (tag `archive/extension`).
 *
 * `@demoman/*` resolve as the wxt build resolves them: through each
 * package's `exports` and its built `dist`, so `pnpm -r build` builds the
 * packages first.
 */

const app = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(
  app,
  process.env.STUDIO_OUT_DIR || join("..", ".output", "pages"),
);

/** The published package's version, which the page compares with the
 *  running studio's (`GET /api/ping`): a page from another bin says so. */
const cliVersion = (
  JSON.parse(
    readFileSync(resolve(app, "..", "..", "cli", "package.json"), "utf8"),
  ) as { version: string }
).version;

/** The commit the pages were built from, with `-dirty` for a tree that has
 *  edits on top; said, not guessed, when git cannot answer. */
function buildSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: app,
      encoding: "utf8",
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain", "--", "."], {
        cwd: app,
        encoding: "utf8",
      }).trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch (error) {
    return `unknown (git: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
  }
}

/**
 * Each `<style>` block moved into a stylesheet of its own, linked where the
 * block stood, so the cascade keeps its order. The studio serves every page
 * under `default-src 'self'` (spec §4.1), which refuses an inline style:
 * left inline, the editor's and the library's own rules would never apply.
 */
function withoutInlineStyles(page: string, html: string): string {
  return html.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
    (_block, css: string) => {
      const name = `assets/${page}-inline-${createHash("sha256").update(css).digest("hex").slice(0, 8)}.css`;
      writeFileSync(join(outDir, name), css);
      return `<link rel="stylesheet" href="/${name}">`;
    },
  );
}

/** The page each input becomes: served by name, not as `<page>/index.html`. */
const PAGES = {
  editor: "editor.html",
  library: "library.html",
  settings: "settings.html",
} as const;

/**
 * Moves each page's HTML to its served name, writes `studio-build.json`,
 * and records the bundled third-party packages for the CLI's
 * THIRD_PARTY_NOTICES (`studio-modules.json`, beside the folder rather than
 * in it, so it does not ship).
 */
function studioPages(): Plugin {
  const modules = new Set<string>();
  return {
    name: "demoman-studio-pages",
    apply: "build",
    generateBundle() {
      for (const id of this.getModuleIds()) {
        if (id.includes("/node_modules/")) modules.add(id);
      }
    },
    writeBundle() {
      for (const [page, served] of Object.entries(PAGES)) {
        const built = join(outDir, page, "index.html");
        if (!existsSync(built)) {
          throw new Error(`the studio build wrote no ${built}`);
        }
        writeFileSync(
          join(outDir, served),
          withoutInlineStyles(page, readFileSync(built, "utf8")),
        );
        rmSync(join(outDir, page), { recursive: true, force: true });
      }
      writeFileSync(
        join(outDir, "studio-build.json"),
        `${JSON.stringify(
          {
            sha: buildSha(),
            builtAt: new Date().toISOString(),
            version: cliVersion,
          },
          null,
          2,
        )}\n`,
      );
      mkdirSync(dirname(outDir), { recursive: true });
      writeFileSync(
        `${outDir}-modules.json`,
        `${JSON.stringify([...modules].sort(), null, 2)}\n`,
      );
    },
  };
}

const HTML_TAG = /<html\b([^>]*)>/i;

/**
 * Marks a studio page (spec 2026-10-19 §7): `data-studio` and
 * `data-theme="dark"` on `<html>`, and a link to `assets/studio.css`, the
 * sheet whose every rule sits under `[data-studio]`. Written into the HTML,
 * so the first paint is already the studio's; the extension's build never
 * runs this, so its pages keep today's look. A page with nowhere to put the
 * marker would render the old look in the studio without a word, so it is
 * refused instead.
 */
export function markStudioPage(html: string): string {
  if (!HTML_TAG.test(html)) {
    throw new Error("the studio page has no <html> tag to mark");
  }
  if (!/<\/head>/i.test(html)) {
    throw new Error("the studio page has no </head> to link its sheet before");
  }
  return html
    .replace(
      HTML_TAG,
      (_tag, attrs: string) =>
        `<html${attrs.replace(/\sdata-theme="[^"]*"/i, "")} data-studio data-theme="dark">`,
    )
    .replace(
      /<\/head>/i,
      '    <link rel="stylesheet" href="../../assets/studio.css" />\n  </head>',
    );
}

/** Applies `markStudioPage` before vite reads the page, so the linked sheet
 *  is bundled like any other. */
function studioMarker(): Plugin {
  return {
    name: "demoman-studio-marker",
    apply: "build",
    transformIndexHtml: { order: "pre", handler: markStudioPage },
  };
}

/** The studio's prelude (`src/platform/studio-prelude.ts`), imported ahead
 *  of everything else in each page's entry, so it runs before any module
 *  the page imports. The extension's build never sees it. */
function studioPrelude(): Plugin {
  const prelude = resolve(app, "src", "platform", "studio-prelude.ts");
  const entries = new Set(
    Object.keys(PAGES).map((page) =>
      resolve(app, "entrypoints", page, "main.ts"),
    ),
  );
  return {
    name: "demoman-studio-prelude",
    apply: "build",
    transform(code, id) {
      if (!entries.has(id.split("?")[0] ?? id)) return null;
      return { code: `import ${JSON.stringify(prelude)};\n${code}`, map: null };
    },
  };
}

export default defineConfig({
  root: resolve(app, "entrypoints"),
  base: "/",
  // The fonts (`/fonts/*.woff2`) and the images the pages name by
  // absolute path, as the extension serves them from its own root.
  publicDir: resolve(app, "public"),
  // Not `.env.*` from `entrypoints/`: the studio build reads nothing from
  // the environment but what `define` below names.
  envDir: false,
  resolve: {
    alias: {
      "#platform": resolve(app, "src", "platform", "http.ts"),
    },
  },
  define: {
    "import.meta.env.MODE": JSON.stringify("studio"),
    "import.meta.env.STUDIO_VERSION": JSON.stringify(cliVersion),
  },
  plugins: [studioMarker(), studioPrelude(), studioPages()],
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: true,
    // The pages are served from loopback to the studio's own Chrome for
    // Testing; the wxt build targets the same engine.
    target: "esnext",
    sourcemap: false,
    // mediabunny alone is past vite's 500 kB warning, as in the wxt build.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        editor: resolve(app, "entrypoints", "editor", "index.html"),
        library: resolve(app, "entrypoints", "library", "index.html"),
        settings: resolve(app, "entrypoints", "settings", "index.html"),
      },
    },
  },
});
