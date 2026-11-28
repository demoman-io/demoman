import { describe, expect, it } from "vitest";
import { commitPathsOf } from "../../src/kept/commit-paths.js";
import type { KeptVideo } from "../../src/kept/file.js";

const kept = (over: Partial<KeptVideo>): KeptVideo =>
  ({
    name: "Checkout",
    deliver: "commit",
    outputs: [
      { path: "docs/a.mp4", fileType: "mp4" },
      { path: "docs/a.gif", fileType: "gif" },
    ],
    report: "docs/a.report.json",
    ...over,
  }) as KeptVideo;

const FILE = ".demoman/flows/checkout.json";

describe("commitPathsOf", () => {
  it("names outputs, report and receipt, and the screens folder", () => {
    const k = kept({});
    // The premise the expectation leans on: two outputs and a report.
    expect(k.outputs).toHaveLength(2);
    expect(k.report).toBe("docs/a.report.json");
    expect(commitPathsOf(k, FILE)).toEqual({
      files: [
        "docs/a.mp4",
        "docs/a.gif",
        "docs/a.report.json",
        ".demoman/receipts/checkout.json",
      ],
      receipt: ".demoman/receipts/checkout.json",
      screens: ".demoman/receipts/checkout.screens",
    });
  });

  it("leaves the report out when the flow has none", () => {
    const k = kept({ report: null });
    expect(commitPathsOf(k, FILE).files).toEqual([
      "docs/a.mp4",
      "docs/a.gif",
      ".demoman/receipts/checkout.json",
    ]);
  });

  it("throws for a files flow", () => {
    expect(() => commitPathsOf(kept({ deliver: "files" }), FILE)).toThrow(
      /delivers files/,
    );
  });
});
