import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGO_MAX_BYTES } from "@demoman/run-core";
import { pathFor } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startStudio } from "./harness.js";

let home: string;
let h: Harness;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "studio-wallpaper-"));
  h = await startStudio(home);
});
afterEach(async () => {
  await h.close();
  await rm(home, { recursive: true, force: true });
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const put = (name: string, type: string, body: Buffer | string) =>
  h.call(pathFor("wallpaperPut"), {
    method: "POST",
    headers: { "X-File-Name": encodeURIComponent(name), "Content-Type": type },
    body,
  });

/** A RIFF/WEBP header and `size` bytes in all: the studio does not decode
 *  what the page resized, so its header is what the file is. */
function webpOf(size: number): Buffer {
  const bytes = Buffer.alloc(size, 7);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(size - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  return bytes;
}

describe("wallpaper uploads", () => {
  it("stores a 30 MB WebP as assets/<uuid>.webp, past the logo's 2 MB cap, and serves it back", async () => {
    const body = webpOf(30 * 1024 * 1024);
    // The fixture: far past what a logo may be.
    expect(body.byteLength).toBeGreaterThan(10 * LOGO_MAX_BYTES);
    const r = await put("photo.jpg", "image/webp", body);
    expect(r.status, r.text).toBe(200);
    const { ref } = r.json() as { ref: string };
    expect(ref).toMatch(/^assets\/[0-9a-f-]{36}\.webp$/);
    expect((await readFile(join(home, ref))).equals(body)).toBe(true);
    // No temp file is left beside it.
    expect(await readdir(join(home, "assets"))).toEqual([
      ref.slice("assets/".length),
    ]);
    const back = await h.call(
      `${pathFor("wallpaper")}?ref=${encodeURIComponent(ref)}`,
    );
    expect(back.status).toBe(200);
    expect(back.headers["content-type"]).toBe("image/webp");
    expect(back.bytes.equals(body)).toBe(true);
  });

  it("refuses a text/plain body as wallpaperRefused, naming the type, and writes nothing", async () => {
    const r = await put("notes.txt", "text/plain", "hello");
    expect(r.status).toBe(400);
    expect(r.json()).toEqual({
      reason: "wallpaperRefused",
      detail:
        'The image "notes.txt" is a text/plain file — use PNG, JPEG, WebP or SVG',
    });
    expect(await exists(join(home, "assets"))).toBe(false);
  });

  it("refuses an accepted type the page did not resize, and writes nothing", async () => {
    const r = await put("photo.png", "image/png", Buffer.from([0x89, 0x50]));
    expect(r.status).toBe(400);
    const body = r.json() as { reason: string; detail: string };
    expect(body.reason).toBe("wallpaperRefused");
    expect(body.detail).toContain("image/png");
    expect(await exists(join(home, "assets"))).toBe(false);
  });

  it("a ref that cannot be served is 422 wallpaperRefused, naming the file", async () => {
    const r = await h.call(
      `${pathFor("wallpaper")}?ref=${encodeURIComponent("assets/gone.webp")}`,
    );
    expect(r.status).toBe(422);
    const body = r.json() as { reason: string; detail: string };
    expect(body.reason).toBe("wallpaperRefused");
    expect(body.detail).toContain(join(home, "assets/gone.webp"));
  });
});
