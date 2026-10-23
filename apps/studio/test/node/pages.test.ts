import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startStudio } from "./harness.js";

let home: string;
let h: Harness;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "studio-pages-"));
  h = await startStudio(home);
});
afterEach(async () => {
  await h.close();
  await rm(home, { recursive: true, force: true });
});

const page = (path: string, method = "GET") => h.call(path, { method });

describe("the pages", () => {
  // The studio is dark only (spec 2026-10-19 §6): the build writes
  // data-theme="dark" into each page, and the server serves the file as it
  // is. Red: put a per-request theme back into pages.ts.
  it("serves each page byte for byte, whatever settings.json holds", async () => {
    for (const held of [
      null,
      { theme: "light" },
      { theme: "dark" },
      { theme: "system" },
    ]) {
      if (held !== null) {
        await writeFile(join(home, "settings.json"), JSON.stringify(held));
      }
      for (const name of ["library.html", "editor.html", "settings.html"]) {
        const r = await page(`/${name}`);
        expect(r.status).toBe(200);
        expect(r.text, `${name} with ${JSON.stringify(held)}`).toBe(
          await readFile(join(h.pagesDir, name), "utf8"),
        );
      }
    }
  });

  it("/ is library.html; /editor.html is the editor; assets carry their type", async () => {
    const root = await page("/");
    expect(root.status).toBe(200);
    expect(root.text).toContain("<body>library</body>");
    expect(root.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect((await page("/editor.html?scene=x")).text).toContain(
      "<body>editor</body>",
    );
    const js = await page("/assets/main.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.text).toBe("console.log(1);\n");
  });

  // Red: drop the /favicon.ico alias — Chrome's own request for it 404s,
  // a console error on every page load (found by the browser lane).
  it("answers /favicon.ico with the toolbar icon", async () => {
    const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await mkdir(join(h.pagesDir, "icon"), { recursive: true });
    await writeFile(join(h.pagesDir, "icon", "32.png"), icon);
    const r = await page("/favicon.ico");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(new Uint8Array(r.bytes)).toEqual(icon);
  });

  // Red: answer the pages `no-cache` again, as the assets are.
  it("offers a page for no keeping (no-store), and lets an asset revalidate", async () => {
    expect((await page("/")).headers["cache-control"]).toBe("no-store");
    expect((await page("/editor.html")).headers["cache-control"]).toBe(
      "no-store",
    );
    expect((await page("/assets/main.js")).headers["cache-control"]).toBe(
      "no-cache",
    );
  });

  it("every page answer carries the door's CSP", async () => {
    const r = await page("/");
    expect(String(r.headers["content-security-policy"])).toContain(
      "default-src 'self'",
    );
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("a path out of the pages dir, a folder and a missing file are 404", async () => {
    // Red: drop the `startsWith(root + sep)` check — the encoded ../ reaches
    // settings.json in the home, one level above the pages dir.
    await writeFile(
      join(home, "settings.json"),
      '{"theme":"system","x":"SECRET"}',
    );
    for (const path of [
      "/..%2Fsettings.json",
      "/assets%2F..%2F..%2Fsettings.json",
      "/assets",
      "/nope.html",
    ]) {
      const r = await page(path);
      expect(r.status, path).toBe(404);
      expect(r.text, path).not.toContain("SECRET");
    }
  });

  it("only GET and HEAD are pages", async () => {
    expect((await page("/", "HEAD")).status).toBe(200);
    expect((await page("/", "POST")).status).toBe(405);
  });

  it("a page with no <html> tag is served as it is, and nothing is said about a theme", async () => {
    await writeFile(join(h.pagesDir, "bare.html"), "<p>bare</p>");
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ theme: "dark" }),
    );
    const r = await page("/bare.html");
    expect(r.text).toBe("<p>bare</p>");
    expect(h.logs.filter((l) => /theme/i.test(l))).toEqual([]);
  });
});
