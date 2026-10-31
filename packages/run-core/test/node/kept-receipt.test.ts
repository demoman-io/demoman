import { describe, expect, it } from "vitest";
import {
  type KeptReceipt,
  parseReceipt,
  serializeReceipt,
} from "../../src/kept/receipt.js";

const window = { x: 202.5, y: 86, width: 876, height: 548, radius: 12 };
const receipt: KeptReceipt = {
  receiptVersion: 1,
  flow: "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90",
  video: "t1",
  filmedCode: { commit: "abc123", tree: "def456", dirty: false },
  screens: {
    steps: 2,
    moments: [
      { step: 0, ms: 400, window },
      { step: null, ms: 900, window },
    ],
    look: "1a2b3c",
  },
  recordedRevision: "r1",
};

const refusal = (text: string) => {
  const r = parseReceipt(text, "r.json");
  if (r.ok) throw new Error("expected a refusal");
  return r.detail;
};
const withChange = (change: Record<string, unknown>) =>
  JSON.stringify({ ...JSON.parse(serializeReceipt(receipt)), ...change });

describe("the receipt", () => {
  it("round-trips, window and look included", () => {
    const text = serializeReceipt(receipt);
    // The premise: the fixture carries the optional keys it claims to.
    expect(JSON.parse(text).screens.look).toBe("1a2b3c");
    expect(JSON.parse(text).screens.moments[0].window).toEqual(window);
    expect(parseReceipt(text, "r.json")).toEqual({ ok: true, receipt });
  });

  it("round-trips a filmedCode that says why there is none, and a null revision", () => {
    const none: KeptReceipt = {
      ...receipt,
      filmedCode: { none: "x" },
      recordedRevision: null,
    };
    const text = serializeReceipt(none);
    expect(JSON.parse(text).filmedCode).toEqual({ none: "x" });
    expect(parseReceipt(text, "r.json")).toEqual({ ok: true, receipt: none });
  });

  it("refuses empty moments, naming screens.moments", () => {
    expect(
      refusal(withChange({ screens: { steps: 2, moments: [] } })),
    ).toContain("screens.moments must list at least one still screen");
  });

  it("refuses a bad filmedCode and another receiptVersion, naming them", () => {
    expect(refusal(withChange({ filmedCode: { commit: 3 } }))).toContain(
      "filmedCode",
    );
    expect(refusal(withChange({ receiptVersion: 2 }))).toContain(
      "receiptVersion",
    );
  });

  it("names the file when the JSON is invalid", () => {
    expect(refusal("{nope")).toContain("r.json");
  });
});
