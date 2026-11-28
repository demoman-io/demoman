import { describe, expect, it } from "vitest";
import { DELIVER_MOVED, parseRefreshArgs } from "../src/refresh-args.js";

describe("parseRefreshArgs", () => {
  it("passes --out-dir, --previous and --failures on to refreshKept's arguments", () => {
    expect(
      parseRefreshArgs(["a-flow", "--out-dir", "out", "--previous", "last"]),
    ).toEqual({ only: ["a-flow"], outDir: "out", previous: "last" });
    expect(parseRefreshArgs(["--failures", "kept"])).toEqual({
      only: [],
      failures: "kept",
    });
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
    for (const more of [
      ["--hand-off", "h"],
      ["a-flow"],
      ["--out-dir", "o"],
      ["--failures", "f"],
    ])
      expect(parseRefreshArgs(["--check", ...more])).toEqual({
        error: "--check takes only --previous and --since",
      });
  });
  it("still refuses a flag it does not know, saying which", () => {
    expect(parseRefreshArgs(["--to", "x"])).toMatchObject({
      error: expect.stringContaining("--to"),
    });
  });
  it("keeps --base-url checked", () => {
    expect(parseRefreshArgs(["--base-url", "ftp://a"])).toHaveProperty("error");
    expect(parseRefreshArgs(["--base-url", "http://a:3/x"])).toEqual({
      only: [],
      baseUrl: "http://a:3",
    });
  });
  it("refuses --deliver with the line that says what to do", () => {
    const moved =
      "--deliver now runs in a job of its own, apart from the app. Delete .github/workflows/demoman.yml on the default branch and run `npx demoman setup --ci` again.";
    expect(DELIVER_MOVED).toBe(moved);
    for (const route of ["pr", "main", "x"])
      expect(parseRefreshArgs(["--deliver", route])).toEqual({ error: moved });
  });
  it("takes --hand-off with the other flags, but not with --check", () => {
    expect(parseRefreshArgs(["--hand-off", "x", "--out-dir", "o"])).toEqual({
      only: [],
      handOff: "x",
      outDir: "o",
    });
    expect(parseRefreshArgs(["--check", "--hand-off", "x"])).toEqual({
      error: "--check takes only --previous and --since",
    });
  });
});
