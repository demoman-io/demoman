import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLogo } from "../src/executor/logo-ref.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-logo-"));
});
afterEach(async () => rm(home, { recursive: true, force: true }));

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';

describe("readLogo", () => {
  it("reads a path relative to DEMOMAN_HOME, typed by its extension", async () => {
    await writeFile(join(home, "acme.svg"), SVG);
    const got = await readLogo(home, "acme.svg");
    expect(got).toMatchObject({ ok: true, contentType: "image/svg+xml" });
    if (got.ok) expect(new TextDecoder().decode(got.bytes)).toBe(SVG);
  });

  it("reads an absolute path as given", async () => {
    const path = join(home, "mark.png");
    await writeFile(path, new Uint8Array([137, 80, 78, 71]));
    expect(await readLogo("/nowhere", path)).toMatchObject({
      ok: true,
      contentType: "image/png",
    });
  });

  // Review Focus 2: the file went away after the run. The reason names the
  // path and the OS's own words.
  it("says which file is missing, with the OS error", async () => {
    const got = await readLogo(home, "gone.svg");
    expect(got.ok).toBe(false);
    if (!got.ok) {
      // Node's own ENOENT text also carries the path, so `toContain` on it
      // stays green when our `${path}` is dropped. `startsWith` pins our line.
      expect(
        got.error.startsWith(`${join(home, "gone.svg")} could not be read (`),
      ).toBe(true);
      expect(got.error).toContain("ENOENT");
    }
  });

  it("refuses a file that is not SVG, PNG, WebP or JPEG", async () => {
    await writeFile(join(home, "mark.gif"), "GIF89a");
    expect(await readLogo(home, "mark.gif")).toMatchObject({ ok: false });
  });

  // The extension's own size rule, through the moved checkLogoFile.
  it("refuses a logo over 2 MB in the extension's words", async () => {
    await writeFile(join(home, "big.png"), new Uint8Array(2 * 1024 * 1024 + 1));
    const got = await readLogo(home, "big.png");
    expect(got).toMatchObject({ ok: false });
    if (!got.ok) expect(got.error).toMatch(/limited to 2 MB/);
  });

  // A kit copied out of the extension names its storage, not a file.
  it("says a logo:<uuid> ref names the extension's storage, and how to fix it", async () => {
    const got = await readLogo(home, "logo:1b2c");
    expect(got).toMatchObject({ ok: false });
    if (!got.ok) {
      expect(got.error).toContain("extension's own storage");
      expect(got.error).toContain(join(home, "kits.json"));
    }
  });
});
