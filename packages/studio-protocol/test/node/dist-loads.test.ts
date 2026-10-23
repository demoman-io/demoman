import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Red if a relative import in `src/` loses its `.js`, or if a runtime import
 * of another package sneaks in (the wire types are `import type` only).
 */
describe("@demoman/studio-protocol's dist, under node", () => {
  it("loads and routes", async () => {
    const path = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
    expect(
      existsSync(path),
      `${path} does not exist — run \`pnpm -r build\` (or \`pnpm test\`) first`,
    ).toBe(true);
    const mod = (await import(path)) as typeof import("../../src/index.js");
    expect(mod.pathFor("frame", { id: "a", ref: "kf:1/2" })).toBe(
      "/api/takes/a/frames/kf%3A1%2F2",
    );
    expect(mod.matchRoute("GET", "/api/ping")?.id).toBe("ping");
  });
});
