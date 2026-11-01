import { describe, expect, it } from "vitest";
import { parseRefreshArgs } from "../src/refresh-args.js";

describe("parseRefreshArgs", () => {
  it("passes --out-dir and --previous on to refreshKept's arguments", () => {
    expect(
      parseRefreshArgs(["a-flow", "--out-dir", "out", "--previous", "last"]),
    ).toEqual({ only: ["a-flow"], outDir: "out", previous: "last" });
  });
  it("still refuses a flag it does not know, saying which", () => {
    expect(parseRefreshArgs(["--to", "x"])).toMatchObject({
      error: expect.stringContaining("--to"),
    });
  });
  it("keeps --deliver and --base-url checked", () => {
    expect(parseRefreshArgs(["--deliver", "x"])).toHaveProperty("error");
    expect(parseRefreshArgs(["--base-url", "ftp://a"])).toHaveProperty("error");
    expect(
      parseRefreshArgs(["--deliver", "pr", "--base-url", "http://a:3/x"]),
    ).toEqual({ only: [], route: "pr", baseUrl: "http://a:3" });
  });
});
