import { describe, expect, it } from "vitest";
import { recorderPlatform } from "../src/platform.js";

describe("recorderPlatform", () => {
  it("records on macOS of either arch and on x86_64 Linux", () => {
    expect(recorderPlatform("darwin", "arm64")).toEqual({ ok: true });
    expect(recorderPlatform("darwin", "x64")).toEqual({ ok: true });
    expect(recorderPlatform("linux", "x64")).toEqual({ ok: true });
  });

  it("refuses arm64 Linux, naming the missing H.264 encoder", () => {
    const r = recorderPlatform("linux", "arm64");
    expect(r).toMatchObject({ ok: false, reason: "unsupportedPlatform" });
    expect(r.ok === false && r.detail).toContain("no H.264 encoder");
  });

  it("refuses any other platform, naming it and its arch", () => {
    const r = recorderPlatform("win32", "x64");
    expect(r).toMatchObject({ ok: false, reason: "unsupportedPlatform" });
    expect(r.ok === false && r.detail).toContain("win32 (x64)");
  });
});
