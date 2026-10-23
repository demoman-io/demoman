import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readUserSettings } from "../src/executor/user-settings.js";

const made: string[] = [];
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "demoman-user-settings-"));
  made.push(d);
  return d;
};
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});
const file = (home: string) => join(home, "settings.json");

describe("readUserSettings: exportQuality", () => {
  it("no file is high, without a complaint", async () => {
    const out = await readUserSettings(await temp());
    expect(out.exportQuality).toBe("high");
    expect(out).not.toHaveProperty("unreadable");
  });

  it("a file without the key is high", async () => {
    const home = await temp();
    await writeFile(file(home), JSON.stringify({ theme: "dark" }));
    const out = await readUserSettings(home);
    expect(out.exportQuality).toBe("high");
    expect(out).not.toHaveProperty("unreadable");
  });

  it("exportQuality full is read, and pullRequests beside it", async () => {
    const home = await temp();
    await writeFile(
      file(home),
      JSON.stringify({ exportQuality: "full", pullRequests: "ask" }),
    );
    expect(await readUserSettings(home)).toEqual({
      exportQuality: "full",
      pullRequests: "ask",
    });
  });

  it("an invalid value is high and unreadable names the file, the key and the choices", async () => {
    const home = await temp();
    await writeFile(
      file(home),
      JSON.stringify({ exportQuality: "best", pullRequests: "ask" }),
    );
    const out = await readUserSettings(home);
    expect(out.exportQuality).toBe("high");
    expect(out.unreadable).toContain(file(home));
    expect(out.unreadable).toContain("exportQuality");
    expect(out.unreadable).toContain("share, high, full");
    expect(out.unreadable).toContain('"best"');
    // Premise of "one key's bad value does not unset the other": the other
    // key is a good value, and it survives.
    expect(out.pullRequests).toBe("ask");
    expect(out.problems).toEqual({ exportQuality: out.unreadable });
  });

  it.each(["{", "[]", "null", "5"])(
    "a file holding %s costs both keys, each with the reason",
    async (text) => {
      const home = await temp();
      await writeFile(file(home), text);
      const out = await readUserSettings(home);
      expect(out.exportQuality).toBe("high");
      expect(out.pullRequests).toBeNull();
      expect(out.problems?.exportQuality).toContain(file(home));
      expect(out.problems?.pullRequests).toContain(file(home));
    },
  );

  it("a bad pullRequests does not unset a good exportQuality", async () => {
    const home = await temp();
    await writeFile(
      file(home),
      JSON.stringify({ exportQuality: "full", pullRequests: "yes" }),
    );
    const out = await readUserSettings(home);
    expect(out.exportQuality).toBe("full");
    expect(out.pullRequests).toBeNull();
    expect(out.problems?.pullRequests).toContain("pullRequests");
    expect(out.problems).not.toHaveProperty("exportQuality");
  });

  it("the file is left as it was by a read", async () => {
    const home = await temp();
    await writeFile(file(home), '{"exportQuality":"nope"}');
    await readUserSettings(home);
    expect(await readFile(file(home), "utf8")).toBe('{"exportQuality":"nope"}');
  });
});
