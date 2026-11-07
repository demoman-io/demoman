import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteCredential,
  readCredential,
  writeCredential,
} from "../src/hosted/credential.js";

const C = {
  base: "https://demoman.io",
  token: "tok",
  login: "octo",
  workspace: { id: "w1", name: "octo" },
};

describe("the hosted credential", () => {
  it("writes 0600 in a 0700 folder and reads it back", () => {
    const home = mkdtempSync(join(tmpdir(), "dm-cred-"));
    writeCredential(home, C);
    expect(statSync(join(home, "hosted")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "hosted", "credential.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(readCredential(home)).toEqual({ ok: true, credential: C });
    deleteCredential(home);
    expect("none" in readCredential(home)).toBe(true);
  });

  it("a missing file is none, a file of junk is unreadable with the parser's words", () => {
    const home = mkdtempSync(join(tmpdir(), "dm-cred-"));
    const none = readCredential(home);
    expect(none.ok).toBe(false);
    expect("none" in none).toBe(true);
    mkdirSync(join(home, "hosted"));
    writeFileSync(join(home, "hosted", "credential.json"), "{not json");
    const junk = readCredential(home);
    expect("unreadable" in junk && junk.unreadable).toMatch(/JSON/);
  });
});
