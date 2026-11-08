import { describe, expect, it } from "vitest";
import {
  type KeptReceipt,
  parseReceipt,
  screensDirOf,
  serializeReceipt,
} from "../../src/kept/receipt.js";

const window = { x: 202.5, y: 86, width: 876, height: 548, radius: 12 };
const receipt: KeptReceipt = {
  receiptVersion: 1,
  flow: "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90",
  video: "t1",
  filmedAt: "2026-10-31T12:00:00.000Z",
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
  screensDir: null,
  screensSize: null,
};
const v2: KeptReceipt = {
  ...receipt,
  receiptVersion: 2,
  screensDir: "order.screens",
  screensSize: { width: 1440, height: 900 },
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

  it("reads a receipt without filmedAt as unknown, and refuses one that is no time", () => {
    const { filmedAt: _gone, ...older } = JSON.parse(serializeReceipt(receipt));
    expect(_gone, "premise: the fixture has a filmedAt").toBe(receipt.filmedAt);
    expect(parseReceipt(JSON.stringify(older), "r.json")).toEqual({
      ok: true,
      receipt: { ...receipt, filmedAt: null },
    });
    expect(refusal(withChange({ filmedAt: "yesterday" }))).toContain(
      "filmedAt must be an ISO time or null",
    );
  });

  it("refuses a flow that is not a flow id, naming flow", () => {
    // Premise: the fixture's own flow passes, so only the change can refuse.
    expect(parseReceipt(serializeReceipt(receipt), "r.json").ok).toBe(true);
    expect(refusal(withChange({ flow: "../../etc" }))).toContain(
      "flow must be a flow id",
    );
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
    expect(refusal(withChange({ receiptVersion: 3 }))).toContain(
      "receiptVersion is 3; this Demoman reads 1 and 2",
    );
  });

  it("names the file when the JSON is invalid", () => {
    expect(refusal("{nope")).toContain("r.json");
  });

  it("reads a version 1 receipt as naming no screen folder", () => {
    // Premise: the fixture is version 1 and writes no folder.
    const text = serializeReceipt(receipt);
    expect(JSON.parse(text).receiptVersion).toBe(1);
    const parsed = parseReceipt(text, "r.json");
    expect(parsed).toEqual({ ok: true, receipt });
    expect(parsed.ok && parsed.receipt.screensDir).toBeNull();
  });

  it("round-trips a version 2 receipt that names its screen folder and size", () => {
    const text = serializeReceipt(v2);
    expect(JSON.parse(text).receiptVersion).toBe(2);
    expect(JSON.parse(text).screensDir).toBe("order.screens");
    expect(parseReceipt(text, "r.json")).toEqual({ ok: true, receipt: v2 });
  });

  it("round-trips the script digest, and reads a receipt without one", () => {
    const withDigest: KeptReceipt = { ...v2, scriptDigest: "9f3a" };
    const text = serializeReceipt(withDigest);
    expect(JSON.parse(text).scriptDigest).toBe("9f3a");
    expect(parseReceipt(text, "r.json")).toEqual({
      ok: true,
      receipt: withDigest,
    });
    // Absent: written before it was recorded, still read, and not written back.
    const without = parseReceipt(serializeReceipt(v2), "r.json");
    expect(without.ok && "scriptDigest" in without.receipt).toBe(false);
    expect(refusal(withChange({ scriptDigest: "" }))).toContain("scriptDigest");
  });

  // Red when a receipt cannot say which instant its video was pinned to (DEM-79).
  it("round-trips pinnedNow", () => {
    const pinned: KeptReceipt = { ...v2, pinnedNow: "2026-11-06T09:00:00Z" };
    const text = serializeReceipt(pinned);
    expect(JSON.parse(text).pinnedNow).toBe("2026-11-06T09:00:00Z");
    expect(parseReceipt(text, "r.json")).toEqual({ ok: true, receipt: pinned });
  });

  it("a receipt without pinnedNow parses and writes as before", () => {
    const text = serializeReceipt(v2);
    expect(text).not.toContain("pinnedNow");
    const r = parseReceipt(text, "r.json");
    expect(r.ok && "pinnedNow" in r.receipt).toBe(false);
  });

  it("refuses a pinnedNow that is not an instant, naming it", () => {
    for (const pinnedNow of ["", "2026-11-06", "soon", 5]) {
      expect(refusal(withChange({ pinnedNow }))).toContain("pinnedNow");
    }
  });

  it("refuses a screen folder that is not beside the receipt", () => {
    // Premise: the same change with a folder beside the receipt is accepted.
    expect(
      parseReceipt(
        withChange({
          receiptVersion: 2,
          screensDir: "order.screens",
          screensSize: { width: 1440, height: 900 },
        }),
        "r.json",
      ).ok,
    ).toBe(true);
    expect(
      refusal(
        withChange({
          receiptVersion: 2,
          screensDir: "../x",
          screensSize: { width: 1440, height: 900 },
        }),
      ),
    ).toContain("screensDir must be a folder beside the receipt");
  });

  it("refuses a version 2 receipt whose screen size is not whole pixels", () => {
    expect(
      refusal(
        withChange({
          receiptVersion: 2,
          screensDir: "order.screens",
        }),
      ),
    ).toContain("screensSize must be { width, height } in whole pixels");
  });

  it("refuses a screens folder under version 1, which has none", () => {
    expect(
      refusal(
        withChange({
          screensDir: "order.screens",
          screensSize: { width: 1440, height: 900 },
        }),
      ),
    ).toContain("screensDir needs receiptVersion 2");
  });

  it("writes version 2 only when it names a screen folder", () => {
    expect(JSON.parse(serializeReceipt(receipt)).receiptVersion).toBe(1);
    expect(JSON.parse(serializeReceipt(v2)).receiptVersion).toBe(2);
  });

  it("names the screen folder beside a receipt, dropping only .json", () => {
    expect(screensDirOf("order.json")).toBe("order.screens");
    expect(screensDirOf("order.receipt.json")).toBe("order.receipt.screens");
  });
});
