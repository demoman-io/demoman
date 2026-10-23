import { describe, expect, it } from "vitest";
import { browserFlagRefusal, RETIRED_EXTENSION } from "../src/browser-flag.js";

// `--browser` after the extension was archived (2026-10-20): `cli` and no
// flag are this server's one executor; `extension` is refused by name, so
// an MCP registration written for it says what changed rather than
// starting something else or failing a parse.
describe("the --browser flag", () => {
  it("accepts no flag, and cli", () => {
    expect(browserFlagRefusal(undefined)).toBeNull();
    expect(browserFlagRefusal("cli")).toBeNull();
  });

  it("refuses extension, naming the retirement", () => {
    expect(browserFlagRefusal("extension")).toBe(RETIRED_EXTENSION);
    expect(RETIRED_EXTENSION).toBe(
      "--browser extension was retired: Demoman's Chrome extension is archived, and demoman-mcp runs scripts in its own browser only. Remove --browser from this server's registration.",
    );
  });

  it("refuses any other value, saying the one that exists", () => {
    expect(browserFlagRefusal("firefox")).toBe(
      '--browser takes only "cli" (the default), not "firefox"',
    );
  });
});
