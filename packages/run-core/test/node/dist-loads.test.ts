import { describe, expect, it } from "vitest";

// Both doors of the exports map, imported the way a node consumer (the
// runner) imports them. Fails on an extensionless relative import in the
// emit, or a missing `dist/page.js`.
describe("@demoman/run-core dist", () => {
  it("loads the node entry under raw node", async () => {
    const mod = await import("../../dist/index.js");
    expect(typeof mod).toBe("object");
    // Real exports, from the two ends of the module graph: an empty
    // namespace would load under raw node too.
    expect(typeof mod.zoomsForClicks).toBe("function");
    expect(typeof mod.lookForRun).toBe("function");
  });
  it("loads the page entry under raw node", async () => {
    const mod = await import("../../dist/page.js");
    expect(typeof mod).toBe("object");
    expect(typeof mod.snapshotTargets).toBe("function");
    expect(typeof mod.captureForIntent).toBe("function");
  });
  it("loads the logo entry under raw node", async () => {
    const mod = await import("../../dist/logo.js");
    expect(typeof mod.decodeLogo).toBe("function");
  });
  it("loads the render entry under raw node", async () => {
    const mod = await import("../../dist/render/index.js");
    expect(typeof mod.renderOutput).toBe("function");
    expect(typeof mod.framesFor).toBe("function");
  });
});
