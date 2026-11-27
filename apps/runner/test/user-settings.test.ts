import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultExportFolder,
  exportFolderOf,
  readUserSettings,
} from "../src/executor/user-settings.js";

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
      exportFolder: null,
      keepFootage: "30d",
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

// One answer to "where does this export land".
describe("exportFolderOf", () => {
  it("a given folder wins, else the setting, else ~/Downloads", async () => {
    const home = await temp();
    expect(await exportFolderOf(home, "/given")).toEqual({
      folder: "/given",
      from: "given",
    });
    expect(await exportFolderOf(home, undefined)).toEqual({
      folder: defaultExportFolder(),
      from: "default",
    });
    await writeFile(file(home), JSON.stringify({ exportFolder: "/films" }));
    expect(await exportFolderOf(home, undefined)).toEqual({
      folder: "/films",
      from: "setting",
    });
    expect(await exportFolderOf(home, "/given")).toMatchObject({
      folder: "/given",
    });
    // null is the Studio's "back to the default".
    await writeFile(file(home), JSON.stringify({ exportFolder: null }));
    expect(await exportFolderOf(home, undefined)).toMatchObject({
      from: "default",
    });
  });

  // Red if a folder the person chose but cannot be used falls back to
  // ~/Downloads without a word.
  it("a setting it cannot use is unusable, naming the file and the value", async () => {
    const home = await temp();
    await writeFile(file(home), JSON.stringify({ exportFolder: "films" }));
    expect(await exportFolderOf(home, undefined)).toEqual({
      unusable: `${file(home)}: exportFolder must be an absolute path; got "films"`,
    });
    // A file that will not read may never have named a folder: ~/Downloads,
    // with why, for the export to say (refusing here stopped every export over
    // a broken file).
    await writeFile(file(home), "{nope");
    const broken = await exportFolderOf(home, undefined);
    expect(broken).toMatchObject({
      folder: defaultExportFolder(),
      from: "default",
      unread: expect.stringContaining(file(home)),
    });
    // A bad folder leaves the other keys readable.
    await writeFile(
      file(home),
      JSON.stringify({ exportFolder: 3, exportQuality: "full" }),
    );
    expect((await readUserSettings(home)).exportQuality).toBe("full");
  });
});

// Red if a choice that cannot be read is taken for 30 days: expiry
// would then remove footage the person may have chosen to keep forever.
describe("readUserSettings: keepFootage", () => {
  it("reads a choice, 30 days when unset, and null with why when unusable", async () => {
    const home = await temp();
    expect((await readUserSettings(home)).keepFootage).toBe("30d");
    await writeFile(file(home), JSON.stringify({ keepFootage: "forever" }));
    expect((await readUserSettings(home)).keepFootage).toBe("forever");
    await writeFile(file(home), JSON.stringify({ keepFootage: 30 }));
    const bad = await readUserSettings(home);
    expect(bad.keepFootage).toBeNull();
    expect(bad.problems?.keepFootage).toBe(
      `${file(home)}: keepFootage must be 30d, 90d, forever; got 30`,
    );
    await writeFile(file(home), "{");
    const broken = await readUserSettings(home);
    expect(broken.keepFootage).toBeNull();
    expect(broken.problems?.keepFootage).toContain(file(home));
  });
});
