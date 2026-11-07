import { describe, expect, it } from "vitest";
import {
  ignoresSecrets,
  SECRETS_IGNORE,
  withLines,
} from "../src/gitignore-secrets.js";

// Review of #35, finding 7. Red when only the exact line counts: git reads
// patterns, and the person's file may use any that covers the path.
describe("ignoresSecrets", () => {
  it.each([
    [".demoman/secrets.env\n", true],
    ["/.demoman/secrets.env\n", true],
    [".demoman/\n", true],
    ["*.env\n", true],
    ["node_modules\ndist\n", false],
    ["", false],
  ])("%j ignores .demoman/secrets.env: %s", async (text, expected) => {
    expect(await ignoresSecrets(text)).toBe(expected);
  });
});

describe("withLines", () => {
  it("adds the lines after a blank line, ending the base's last line first", () => {
    expect(withLines("node_modules", SECRETS_IGNORE)).toBe(
      `node_modules\n\n${SECRETS_IGNORE}`,
    );
    expect(withLines("node_modules\n", SECRETS_IGNORE)).toBe(
      `node_modules\n\n${SECRETS_IGNORE}`,
    );
  });
  it("is the lines alone for an empty file", () => {
    expect(withLines("", SECRETS_IGNORE)).toBe(SECRETS_IGNORE);
  });
});
