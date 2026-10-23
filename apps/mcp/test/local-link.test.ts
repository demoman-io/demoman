import { describe, expect, it } from "vitest";
import { localLink } from "../src/local-link.js";

const fake = (version: string | null) => ({
  calls: [] as unknown[],
  request: async (op: string, args: Record<string, unknown>) => ({
    ok: true as const,
    value: { op, args },
  }),
  browser: () => version,
  close: async () => undefined,
});

describe("localLink", () => {
  it("passes requests straight to the executor", async () => {
    const link = localLink(fake(null));
    expect(await link.request("takes", { a: 1 })).toEqual({
      ok: true,
      value: { op: "takes", args: { a: 1 } },
    });
  });
  it("reports no browser until one has launched, then its version", () => {
    expect(localLink(fake(null)).connected()).toBeNull();
    expect(localLink(fake("140.0.1")).connected()).toEqual({
      browser: "Chromium 140.0.1 (demoman-mcp's own)",
    });
  });
});
