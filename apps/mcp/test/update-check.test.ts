import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUpdateCheck, isNewer } from "../src/update-check.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function home(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "demoman-update-"));
  dirs.push(d);
  return d;
}
const DAY = 24 * 60 * 60 * 1000;
const quiet = () => undefined;

describe("isNewer", () => {
  it.each([
    ["0.2.0", "0.1.9", true],
    ["0.2.0", "0.2.0", false],
    ["0.1.9", "0.2.0", false],
    ["0.10.0", "0.9.0", true],
    ["0.2.0", "0.2.0-rc.1", true],
    ["0.2.0-rc.2", "0.2.0-rc.1", true],
    ["0.2.0-rc.10", "0.2.0-rc.9", true],
    ["0.2.0-rc.1", "0.2.0", false],
  ])("%s newer than %s: %s", (latest, current, want) => {
    expect(isNewer(latest, current)).toBe(want);
  });
});

describe("createUpdateCheck", () => {
  it("asks the registry, says newer, and asks again only after a day", async () => {
    let asked = 0;
    let t = 1_000;
    const check = createUpdateCheck({
      name: "demoman",
      current: "0.2.0",
      home: await home(),
      log: quiet,
      env: {},
      now: () => t,
      fetchLatest: async () => {
        asked++;
        return "0.3.0";
      },
    });
    expect(await check()).toEqual({
      current: "0.2.0",
      latest: "0.3.0",
      newer: true,
    });
    t += DAY - 1;
    await check();
    expect(asked).toBe(1);
    t += 2;
    await check();
    expect(asked).toBe(2);
  });

  it("says a failed check failed, never up to date, and retries after an hour", async () => {
    let t = 0;
    let asked = 0;
    const check = createUpdateCheck({
      name: "demoman",
      current: "0.2.0",
      home: await home(),
      log: quiet,
      env: {},
      now: () => t,
      fetchLatest: async () => {
        asked++;
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      },
    });
    expect(await check()).toEqual({
      current: "0.2.0",
      check: "failed: getaddrinfo ENOTFOUND registry.npmjs.org",
    });
    t += 60 * 1000;
    await check();
    expect(asked).toBe(1);
    t += 60 * 60 * 1000;
    await check();
    expect(asked).toBe(2);
  });

  it("is off with DEMOMAN_NO_UPDATE_CHECK=1, says so, and asks nothing", async () => {
    let asked = 0;
    const check = createUpdateCheck({
      name: "demoman",
      current: "0.2.0",
      home: await home(),
      log: quiet,
      env: { DEMOMAN_NO_UPDATE_CHECK: "1" },
      fetchLatest: async () => {
        asked++;
        return "9.9.9";
      },
    });
    expect(await check()).toEqual({
      current: "0.2.0",
      check: "off: DEMOMAN_NO_UPDATE_CHECK=1",
    });
    expect(asked).toBe(0);
  });

  // Review Focus 3: two sessions writing at once, or a crash mid-write.
  it("treats an unreadable cache as none, says so on its log, and replaces it", async () => {
    const h = await home();
    await writeFile(join(h, "update-check.json"), '{"checkedAt": 1, "lat');
    const lines: string[] = [];
    const check = createUpdateCheck({
      name: "demoman",
      current: "0.2.0",
      home: h,
      log: (l) => void lines.push(l),
      env: {},
      fetchLatest: async () => "0.2.0",
    });
    expect(await check()).toEqual({
      current: "0.2.0",
      latest: "0.2.0",
      newer: false,
    });
    expect(lines.join("\n")).toContain("update-check.json could not be read");
    expect(
      JSON.parse(await readFile(join(h, "update-check.json"), "utf8")),
    ).toMatchObject({ latest: "0.2.0" });
  });

  // Review fix: a cache that parses but holds neither a string `latest`
  // nor a string `failed` is no answer — not "failed: undefined" for an
  // hour, and not a throw out of isNewer inside status.
  it.each([
    ["a non-string latest", { latest: null }],
    ["neither latest nor failed", {}],
    ["a non-string failed", { failed: 3 }],
  ])("treats a cache with %s as none and asks npm", async (_, body) => {
    const h = await home();
    await writeFile(
      join(h, "update-check.json"),
      JSON.stringify({ checkedAt: 1_000, ...body }),
    );
    const lines: string[] = [];
    let asked = 0;
    const check = createUpdateCheck({
      name: "demoman",
      current: "0.2.0",
      home: h,
      log: (l) => void lines.push(l),
      env: {},
      now: () => 1_001,
      fetchLatest: async () => {
        asked++;
        return "0.2.0";
      },
    });
    expect(await check()).toEqual({
      current: "0.2.0",
      latest: "0.2.0",
      newer: false,
    });
    expect(asked).toBe(1);
    expect(lines.join("\n")).toContain("update-check.json could not be read");
  });

  // Review Focus 4.
  it("creates a DEMOMAN_HOME that does not exist yet", async () => {
    const h = join(await home(), "not", "yet");
    const check = createUpdateCheck({
      name: "demoman",
      current: "0.2.0",
      home: h,
      log: quiet,
      env: {},
      fetchLatest: async () => "0.2.1",
    });
    await check();
    expect(
      JSON.parse(await readFile(join(h, "update-check.json"), "utf8")),
    ).toMatchObject({ latest: "0.2.1" });
  });

  it("says when its answer could not be saved", async () => {
    const h = await home();
    // A file where the home folder should be: mkdir and write both fail.
    const blocked = join(h, "file");
    await writeFile(blocked, "");
    const lines: string[] = [];
    const check = createUpdateCheck({
      name: "demoman",
      current: "0.2.0",
      home: join(blocked, "home"),
      log: (l) => void lines.push(l),
      env: {},
      fetchLatest: async () => "0.2.1",
    });
    expect(await check()).toMatchObject({ latest: "0.2.1" });
    expect(lines.join("\n")).toContain("was not saved");
  });
});
