import { describe, expect, it } from "vitest";
import { RUNNER_VERSION } from "../src/version.js";

describe("the runner's lane", () => {
  it("runs, and resolves @demoman/* through dist rather than src", async () => {
    expect(RUNNER_VERSION).toBe("0.1.0");
    // The lane's own premise, asserted rather than assumed. `import.meta
    // .resolve` throws under vite-node's synthetic import.meta here, and
    // `createRequire(...).resolve` bypasses vite-node's resolver entirely
    // (it always reports node's own real resolution, so it cannot see a
    // vitest.config.ts alias at all) -- both were tried and rejected; see
    // the task report. Instead: a bare specifier and an explicit dist path
    // are loaded through the same import() vite-node transforms, and their
    // module namespace objects are compared by reference. Node/Vite cache
    // an ES module by its resolved file, so if the bare specifier resolves
    // to the same dist file the explicit import names, both imports return
    // the identical cached namespace object. If a resolve.alias ever
    // diverts the bare specifier to src, it becomes a second, distinct
    // module instance and this reference equality fails.
    const bare = await import("@demoman/replay-engine");
    const explicit = await import(
      "../../../packages/replay-engine/dist/index.js"
    );
    expect(bare).toBe(explicit);
  });
});
