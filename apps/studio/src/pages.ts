import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { PageServer } from "./server.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * The file each bare path stands for. `/favicon.ico` is the toolbar icon the
 * extension shows as these pages' favicon: the pages name none (the
 * manifest does, in the extension), so Chrome asks for /favicon.ico, and a
 * 404 there is a console error on every studio page load.
 */
const ALIASES: Record<string, string> = {
  "/": "/library.html",
  "/favicon.ico": "/icon/32.png",
};

function notFound(res: ServerResponse, pathname: string): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Not found: ${pathname}`);
}

/**
 * The built editor and library pages and their assets, from `dir`. A path
 * that resolves outside `dir` is not found, as is a folder. A page is served
 * as the build wrote it: the studio is dark only, and the build marks each
 * page `data-theme="dark"` (spec 2026-10-19 §6).
 */
export function createPageServer(o: { dir: string }): PageServer {
  const root = resolve(o.dir);
  return {
    async serve(req, res, page) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, {
          "Content-Type": "text/plain; charset=utf-8",
          Allow: "GET, HEAD",
        });
        res.end(`${req.method} is not served for pages`);
        return;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(page.pathname);
      } catch {
        // A malformed escape names no file; answered as one.
        notFound(res, page.pathname);
        return;
      }
      const wanted = ALIASES[decoded] ?? decoded;
      const file = resolve(root, `.${wanted}`);
      if (!file.startsWith(root + sep)) {
        notFound(res, page.pathname);
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
          notFound(res, page.pathname);
          return;
        }
        throw error;
      }
      const ext = extname(file).toLowerCase();
      const type = TYPES[ext] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": type,
        // A dev build changes under the same names: always revalidate. A
        // page is never kept: one
        // restored from the back/forward cache would come back with its
        // event stream closed (`http.ts` reloads it if Chrome keeps it
        // anyway), so it is not offered for keeping at all.
        "Cache-Control": ext === ".html" ? "no-store" : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : bytes);
    },
  };
}
