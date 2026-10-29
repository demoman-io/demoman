import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWallpaper } from "../src/executor/wallpaper-read.js";
import { WALLPAPERS_DIR } from "./fixture.js";

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) {
    await rm(h, { recursive: true, force: true });
  }
});
async function home(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), "demoman-wallpaper-read-"));
  homes.push(h);
  return h;
}

describe("readWallpaper", () => {
  // Red if the shape is dropped from the file name, or the id is not read
  // from the folder it is given.
  it("reads a built-in id from the folder, in the shape asked for", async () => {
    const h = await home();
    const vivid = { kind: "wallpaper", id: "vivid-1" } as const;
    for (const shape of ["landscape", "portrait"] as const) {
      const read = await readWallpaper(h, WALLPAPERS_DIR, vivid, shape);
      if (read?.ok !== true) throw new Error(JSON.stringify(read));
      expect([read.contentType, read.name]).toEqual(["image/webp", "vivid-1"]);
      // Compared as one boolean: a failing diff of two megabyte arrays
      // takes minutes to print.
      const file = join(WALLPAPERS_DIR, `vivid-1-${shape}.webp`);
      expect(Buffer.from(read.bytes).equals(readFileSync(file)), file).toBe(
        true,
      );
    }
  });

  it("says an id this install does not have, naming it", async () => {
    const read = await readWallpaper(
      await home(),
      WALLPAPERS_DIR,
      { kind: "wallpaper", id: "vivid-9" },
      "landscape",
    );
    expect(read).toEqual({
      ok: false,
      error: 'the wallpaper "vivid-9" is not in this install',
    });
  });

  it("reads a home-relative image from the home", async () => {
    const h = await home();
    await mkdir(join(h, "assets"));
    const bytes = new Uint8Array([1, 2, 3]);
    await writeFile(join(h, "assets", "mine.webp"), bytes);
    const read = await readWallpaper(
      h,
      WALLPAPERS_DIR,
      { kind: "image", ref: "assets/mine.webp" },
      "landscape",
    );
    expect(read).toEqual({
      ok: true,
      bytes,
      contentType: "image/webp",
      name: join(h, "assets", "mine.webp"),
    });
  });

  // Report before you forgive: an upload moved or deleted is a reason with
  // its path in it, never a throw and never a quiet null.
  it("says a file that is gone could not be read, naming its path", async () => {
    const h = await home();
    const read = await readWallpaper(
      h,
      WALLPAPERS_DIR,
      { kind: "image", ref: "assets/gone.webp" },
      "landscape",
    );
    expect(read?.ok).toBe(false);
    expect(read?.ok === false && read.error).toMatch(
      new RegExp(
        `^${join(h, "assets", "gone.webp").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} could not be read \\(.*ENOENT`,
      ),
    );
  });

  // An SVG is rasterised where it enters; none reaches the render.
  it("refuses a vector by its extension, naming the path", async () => {
    const h = await home();
    const read = await readWallpaper(
      h,
      WALLPAPERS_DIR,
      { kind: "image", ref: "assets/mark.svg" },
      "landscape",
    );
    expect(read).toEqual({
      ok: false,
      error: `${join(h, "assets", "mark.svg")} is not a PNG, WebP or JPEG file (by its extension)`,
    });
  });

  it("answers null for a solid or gradient background", async () => {
    const h = await home();
    expect(
      await readWallpaper(
        h,
        WALLPAPERS_DIR,
        { kind: "solid", color: "#ffffff" },
        "landscape",
      ),
    ).toBeNull();
    expect(
      await readWallpaper(
        h,
        WALLPAPERS_DIR,
        { kind: "gradient", from: "#000000", to: "#ffffff", angle: 90 },
        "portrait",
      ),
    ).toBeNull();
  });
});
