import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `apps/mcp` loads this package's `dist` under raw node. Red if a relative
 * import in `src/` loses its `.js` (node's ESM loader refuses it; vite's
 * would not, which is why `vitest.config.ts` externalizes `dist`).
 */
describe("@demoman/agent-bridge's dist, under node", () => {
  it("loads and exports the call's outcome helper", async () => {
    const path = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
    expect(
      existsSync(path),
      `${path} does not exist — run \`pnpm -r build\` (or \`pnpm test\`) first`,
    ).toBe(true);
    const mod = (await import(path)) as {
      failure?: (reason: string, detail: string) => unknown;
    };
    expect(mod.failure?.("r", "d")).toEqual({
      ok: false,
      reason: "r",
      detail: "d",
    });
  });
});
