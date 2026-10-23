import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRANDING_DEFAULTS } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readKits } from "../src/executor/kits.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-kits-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

describe("readKits", () => {
  it("reads no file as no kits, ready", async () => {
    expect(await readKits(home)).toEqual({
      state: "ready",
      kits: [],
      defaultId: null,
      migrationPending: false,
    });
  });

  it("reads kits.json's kits and default", async () => {
    await writeFile(
      join(home, "kits.json"),
      JSON.stringify({
        kits: [{ id: "k1", name: "Dark", branding: BRANDING_DEFAULTS }],
        default: "k1",
      }),
    );
    const read = await readKits(home);
    expect(read.state).toBe("ready");
    if (read.state === "ready") {
      expect(read.kits.map((k) => k.name)).toEqual(["Dark"]);
      expect(read.defaultId).toBe("k1");
    }
  });

  it("says invalid, with the parse error, for a hand-broken file", async () => {
    await writeFile(join(home, "kits.json"), "{ kits: [");
    const read = await readKits(home);
    expect(read.state).toBe("invalid");
    if (read.state === "invalid") {
      expect(read.reason).toContain(join(home, "kits.json"));
    }
  });

  it("says invalid, with the path, for JSON of the wrong shape", async () => {
    for (const text of ["[]", "5", '"x"', "null", '{"kit": []}']) {
      await writeFile(join(home, "kits.json"), text);
      const read = await readKits(home);
      expect(read.state, text).toBe("invalid");
      if (read.state === "invalid") {
        expect(read.reason, text).toContain(join(home, "kits.json"));
      }
    }
  });

  it("reads {} and an empty kits list as no kits, ready", async () => {
    for (const text of ["{}", '{"kits": []}']) {
      await writeFile(join(home, "kits.json"), text);
      const read = await readKits(home);
      expect(read.state, text).toBe("ready");
    }
  });
});
