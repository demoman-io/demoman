import { describe, expect, it } from "vitest";
import { parseStudioArgs } from "../src/studio-args";

describe("parseStudioArgs", () => {
  it("opens the library with no arguments and a take with one id", () => {
    expect(parseStudioArgs([])).toEqual({ kind: "open" });
    expect(parseStudioArgs(["abc"])).toEqual({ kind: "open", takeId: "abc" });
  });

  it("reads --stop and --serve", () => {
    expect(parseStudioArgs(["--stop"])).toEqual({ kind: "stop" });
    expect(parseStudioArgs(["--serve"])).toEqual({ kind: "serve" });
  });

  // Red if a typo such as --stp opened the library as if nothing was wrong.
  it("refuses what it cannot read, saying what", () => {
    for (const args of [
      ["--stp"],
      ["--stop", "--serve"],
      ["--stop", "abc"],
      ["a", "b"],
    ]) {
      const parsed = parseStudioArgs(args);
      expect(parsed.kind, args.join(" ")).toBe("error");
      expect(
        parsed.kind === "error" ? parsed.message : "",
        args.join(" "),
      ).toMatch(/studio/);
    }
    expect(parseStudioArgs(["--stp"])).toEqual({
      kind: "error",
      message: "studio does not take --stp",
    });
  });
});
