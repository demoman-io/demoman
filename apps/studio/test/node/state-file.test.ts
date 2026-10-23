import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readStudioState,
  removeStudioState,
  type StudioState,
  studioStatePath,
  writeStudioState,
} from "../../src/state-file.js";

const state: StudioState = {
  pid: 4242,
  port: 5555,
  token: "tok",
  startedAt: "2026-10-16T00:00:00.000Z",
  version: "0.2.0",
};
const home = () => mkdtemp(join(tmpdir(), "studio-state-"));

describe("studio.json", () => {
  it("is written at mode 0600 and reads back", async () => {
    const h = await home();
    await writeStudioState(h, state);
    expect((await stat(studioStatePath(h))).mode & 0o777).toBe(0o600);
    expect(await readStudioState(h)).toEqual(state);
  });

  it("reads null when absent", async () => {
    expect(await readStudioState(await home())).toBeNull();
  });

  it("says unreadable for garbage and for a wrong shape", async () => {
    const h = await home();
    await writeFile(studioStatePath(h), "{nope");
    expect(await readStudioState(h)).toEqual({
      unreadable: expect.stringContaining("not valid JSON"),
    });
    await writeFile(studioStatePath(h), JSON.stringify({ pid: 1 }));
    expect(await readStudioState(h)).toEqual({
      unreadable: expect.stringContaining("missing fields"),
    });
  });

  it("removeStudioState leaves a file that names another pid", async () => {
    const h = await home();
    await writeStudioState(h, state);
    await removeStudioState(h, state.pid + 1);
    expect(await readStudioState(h)).toEqual(state);
  });

  it("removeStudioState removes the file that names its pid", async () => {
    const h = await home();
    await writeStudioState(h, state);
    await removeStudioState(h, state.pid);
    expect(await readStudioState(h)).toBeNull();
  });
});
