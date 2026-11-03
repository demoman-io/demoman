import { describe, expect, it } from "vitest";
import { parseRefreshArgs } from "../src/refresh-args.js";

describe("parseRefreshArgs", () => {
  it("passes --out-dir and --previous on to refreshKept's arguments", () => {
    expect(
      parseRefreshArgs(["a-flow", "--out-dir", "out", "--previous", "last"]),
    ).toEqual({ only: ["a-flow"], outDir: "out", previous: "last" });
  });
  it("takes --check alone or with --previous, and nothing else beside it", () => {
    expect(parseRefreshArgs(["--check"])).toEqual({ only: [], check: true });
    expect(parseRefreshArgs(["--check", "--previous", "last"])).toEqual({
      only: [],
      check: true,
      previous: "last",
    });
    expect(
      parseRefreshArgs(["--check", "--since", "abc1234", "--previous", "p"]),
    ).toEqual({ only: [], check: true, since: "abc1234", previous: "p" });
    expect(parseRefreshArgs(["--since", "abc1234"])).toEqual({
      error: "--since goes only with --check",
    });
    expect(parseRefreshArgs(["--check", "--since", "not a sha"])).toEqual({
      error: '--since is a commit sha, not "not a sha"',
    });
    for (const more of [["--deliver", "pr"], ["a-flow"], ["--out-dir", "o"]])
      expect(parseRefreshArgs(["--check", ...more])).toEqual({
        error: "--check takes only --previous and --since",
      });
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
