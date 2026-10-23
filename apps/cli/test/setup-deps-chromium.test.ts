import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The Chromium every launch uses is the runner's (`fullChromiumPath`), so
// setup asks the same question of the same path: two Playwrights resolving
// different revisions would otherwise have setup say "installed" while every
// launch answers browserMissing. Pointed somewhere empty here, so the answer
// can only come from the runner's path.
const NOWHERE = "/nonexistent/demoman-test/chromium";
vi.mock("@demoman/runner/package", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fullChromiumPath: () => NOWHERE,
}));

describe("realSetupDeps' chromiumInstalled", () => {
  it("asks the runner's Chromium path, the one every launch uses", async () => {
    const { chromium } = await import("playwright");
    // Premise: this machine has Playwright's own Chromium, so an answer read
    // off that path would say installed.
    expect(existsSync(chromium.executablePath())).toBe(true);
    expect(existsSync(NOWHERE)).toBe(false);
    const { realSetupDeps } = await import("../src/setup-deps.js");
    const dist = fileURLToPath(new URL("../pkg/dist", import.meta.url));
    expect(realSetupDeps("0.0.0", dist).chromiumInstalled()).toBe(false);
  });
});
