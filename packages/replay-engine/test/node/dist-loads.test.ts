import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The one thing no other test in this repo can say: that the compiled output
 * loads in node.
 *
 * Every other consumer of these packages is a bundler — wxt, vite, esbuild —
 * and all of them resolve extensionless relative imports and interop a CJS
 * dependency's named exports. Node does neither. `apps/runner` is the first
 * node consumer, so this is the first test that can fail on it.
 *
 * Dynamic `import()` of a path, not a bare specifier: the point is to load
 * the emitted file exactly as node would, without vite in the way.
 */
const dist = (pkg: string, file = "index.js"): string =>
  fileURLToPath(new URL(`../../../${pkg}/dist/${file}`, import.meta.url));

describe("the packages' built output, under node", () => {
  for (const pkg of [
    "scene-schema",
    "resolver",
    "compositor",
    "replay-engine",
  ]) {
    it(`loads @demoman/${pkg}'s dist/index.js`, async () => {
      const path = dist(pkg);
      // A missing dist is a different failure from a broken one, and saying
      // so here saves the reader a round: `pnpm -r test` does not build.
      expect(
        existsSync(path),
        `${path} does not exist — run \`pnpm -r build\` (or \`pnpm test\`, which does) first`,
      ).toBe(true);
      await expect(import(path)).resolves.toBeDefined();
    });
  }

  it("loads @demoman/replay-engine's ./page subpath", async () => {
    const path = dist("replay-engine", "page.js");
    expect(
      existsSync(path),
      `${path} does not exist — run \`pnpm -r build\``,
    ).toBe(true);
    const page = await import(path);
    // Named, not just "it loaded": this is the door apps/runner bundles into
    // the demoed app, and an empty module would satisfy a bare import.
    expect(typeof page.resolveForReplay).toBe("function");
    expect(typeof page.stripLeadingHop).toBe("function");
    // Plan 2: the sensor's snapshot and the engine's run build a step's
    // fingerprint with this one function; it must be on the page door.
    expect(typeof page.targetFromFingerprint).toBe("function");
    expect(typeof page.fingerprintFromTarget).toBe("function");
  });
});
