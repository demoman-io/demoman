import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
  readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(read(p));
const PAGES = ["resolve-entry", "executor-entry", "render-entry", "mux-entry"];

const packageIn = (input: string): string | undefined => {
  const all = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)];
  const last = all.at(-1)?.[1];
  return last === ".pnpm" ? undefined : last;
};

/** node_modules packages vite put into the studio's pages (dist/studio),
 *  from the build's own module list. */
function studioPackages(): Set<string> {
  const names = new Set<string>();
  for (const id of json("build-meta/studio-modules.json") as string[]) {
    const name = packageIn(id);
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** node_modules packages esbuild put into the bundles, read straight from
 *  the metafiles — independent of how build.mjs computes its list — and
 *  those vite put into the studio's pages. */
function bundledPackages(): Set<string> {
  const names = studioPackages();
  for (const file of [
    "build-meta/node.json",
    ...PAGES.map((n) => `build-meta/page-${n}.json`),
  ]) {
    for (const input of Object.keys(json(file).inputs)) {
      const name = packageIn(input);
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

describe("licenses", () => {
  it("LICENSE is the repo's FSL-1.1-ALv2 text, byte for byte", () => {
    expect(read("pkg/LICENSE")).toBe(
      readFileSync(
        new URL("../../../packages/compositor/LICENSE", import.meta.url),
        "utf8",
      ),
    );
  });

  it("the bundles carry third-party code (the fixture for the next case)", () => {
    // mediabunny is bundled into render-entry and mux-entry (draft §1).
    expect(bundledPackages().has("mediabunny")).toBe(true);
    // And into the studio's pages, whose list is read separately.
    expect(studioPackages().has("mediabunny")).toBe(true);
  });

  it("THIRD_PARTY_NOTICES names every bundled package with its license text", () => {
    const notices = read("pkg/THIRD_PARTY_NOTICES");
    const listed = json("build-meta/notices.json").bundled as Array<{
      name: string;
      version: string;
      license: string;
    }>;
    for (const name of bundledPackages()) {
      const entry = listed.find((e) => e.name === name);
      expect(entry, `${name} is bundled but not in the notices`).toBeDefined();
      expect(notices).toContain(
        `== ${name} ${entry?.version} (${entry?.license}) ==`,
      );
    }
    expect(notices).toMatch(
      /== mediabunny [\d.]+ \(MPL-2\.0\) ==\nSource: https:\/\/www\.npmjs\.com\/package\/mediabunny\/v\/[\d.]+\n\nMozilla Public License/,
    );
  });

  it("THIRD_PARTY_NOTICES carries the Studio's hand-copied fonts and icons", () => {
    const notices = read("pkg/THIRD_PARTY_NOTICES");
    // The shipped folder, not the build's list: a font copied in without a
    // notice is what this exists to catch.
    const fonts = readdirSync(
      new URL("../pkg/dist/studio/fonts", import.meta.url),
    );
    expect(fonts.length, "premise: the Studio ships fonts").toBeGreaterThan(0);
    for (const font of fonts) expect(notices).toContain(`fonts/${font}:`);
    expect(notices).toContain("SIL OPEN FONT LICENSE Version 1.1");
    // The studio draws Lucide outlines (pages/src/shell/icons.ts).
    expect(notices).toContain(
      "Copyright (c) 2026 Lucide Icons and Contributors",
    );
  });

  it("names no license as UNKNOWN", () => {
    expect(read("pkg/THIRD_PARTY_NOTICES")).not.toContain("UNKNOWN");
  });

  it("names every installed dependency and its license", () => {
    const deps = Object.keys(json("pkg/package.json").dependencies);
    const installed = json("build-meta/notices.json").installed as Array<{
      name: string;
    }>;
    expect(installed.map((e) => e.name).sort()).toEqual(deps.sort());
  });
});
