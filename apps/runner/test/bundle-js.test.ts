import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleEntry,
  PAGE_ENTRIES,
  usePrebuiltPages,
} from "../src/bundle-js.js";

// The published package ships the four page bundles prebuilt and no esbuild
// (launch B). Red if bundleEntry ignores usePrebuiltPages: it would hand
// these nonexistent entry paths to esbuild, which rejects.
let dir: string | null = null;
afterEach(async () => {
  usePrebuiltPages(null);
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

async function prebuilt(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "demoman-pages-"));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(dir, name), text);
  }
  usePrebuiltPages(dir);
  return dir;
}

describe("usePrebuiltPages", () => {
  it("answers each entry from its prebuilt file, by name, from src or dist paths", async () => {
    await prebuilt(
      Object.fromEntries(PAGE_ENTRIES.map((n) => [`${n}.js`, `/*${n}*/`])),
    );
    expect(await bundleEntry("/nowhere/src/resolve-entry.ts")).toBe(
      "/*resolve-entry*/",
    );
    expect(await bundleEntry("/nowhere/dist/executor/executor-entry.js")).toBe(
      "/*executor-entry*/",
    );
  });

  it("refuses an entry the package does not prebuild, naming it", async () => {
    await prebuilt({});
    await expect(bundleEntry("/x/decode-probe-entry.ts")).rejects.toThrow(
      /decode-probe-entry\.ts has no prebuilt page bundle/,
    );
  });

  it("names the missing file when a prebuilt bundle is not there", async () => {
    const d = await prebuilt({});
    await expect(bundleEntry("/x/mux-entry.js")).rejects.toThrow(
      join(d, "mux-entry.js"),
    );
  });

  it("refuses an empty prebuilt bundle rather than inject nothing", async () => {
    const d = await prebuilt({ "render-entry.js": "" });
    await expect(bundleEntry("/x/render-entry.js")).rejects.toThrow(
      `the prebuilt page bundle ${join(d, "render-entry.js")} is empty`,
    );
  });
});
