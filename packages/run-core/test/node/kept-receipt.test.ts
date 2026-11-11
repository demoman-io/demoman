import { describe, expect, it } from "vitest";
import {
  type KeptReceipt,
  parseReceipt,
  RECEIPT_VERSION,
  screensDirOf,
  serializeReceipt,
} from "../../src/kept/receipt.js";

const receipt: KeptReceipt = {
  receiptVersion: 3,
  flow: "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90",
  video: "t1",
  filmedAt: "2026-10-31T12:00:00.000Z",
  filmedCode: { commit: "abc123", tree: "def456", dirty: false },
  screens: {
    steps: 2,
    screens: [
      { step: 0 },
      { step: 1, unsettled: "the DOM never went quiet" },
      { step: null },
    ],
    look: "1a2b3c",
  },
  recordedRevision: "r1",
  screensDir: "order.screens",
};
/** The fields every version shares, as a version 1 or 2 receipt wrote
 *  them: what an old receipt is read for until a refresh replaces it. */
const shared = {
  flow: receipt.flow,
  video: receipt.video,
  filmedAt: receipt.filmedAt,
  filmedCode: receipt.filmedCode,
  recordedRevision: receipt.recordedRevision,
};
const window = { x: 202.5, y: 86, width: 876, height: 548, radius: 12 };
const oldScreens = {
  steps: 2,
  moments: [
    { step: 0, ms: 400, window },
    { step: null, ms: 900, window },
  ],
  look: "1a2b3c",
};
const v1Text = JSON.stringify({
  receiptVersion: 1,
  ...shared,
  screens: oldScreens,
});
const v2Text = JSON.stringify({
  receiptVersion: 2,
  ...shared,
  screensDir: "order.screens",
  screensSize: { width: 1440, height: 900 },
  screens: oldScreens,
});

const refusal = (text: string) => {
  const r = parseReceipt(text, "r.json");
  if (r.ok) throw new Error("expected a refusal");
  return r.detail;
};
const withChange = (change: Record<string, unknown>) =>
  JSON.stringify({ ...JSON.parse(serializeReceipt(receipt)), ...change });

describe("the receipt", () => {
  it("a v3 receipt round-trips", () => {
    const text = serializeReceipt(receipt);
    // The premise: the fixture carries the optional keys it claims to.
    expect(JSON.parse(text).receiptVersion).toBe(3);
    expect(RECEIPT_VERSION).toBe(3);
    expect(JSON.parse(text).screens.look).toBe("1a2b3c");
    expect(JSON.parse(text).screens.screens[1].unsettled).toBe(
      "the DOM never went quiet",
    );
    expect(JSON.parse(text)).not.toHaveProperty("screensSize");
    expect(parseReceipt(text, "r.json")).toEqual({ ok: true, receipt });
  });

  // Read only to be replaced: its moments are a picture refresh no longer
  // compares, so none of them is carried.
  it("a v2 receipt parses with screens null", () => {
    // Premise: the text is a v2 receipt with moments and a size.
    expect(JSON.parse(v2Text).screens.moments).toHaveLength(2);
    expect(parseReceipt(v2Text, "r.json")).toEqual({
      ok: true,
      receipt: {
        receiptVersion: 2,
        ...shared,
        screens: null,
        screensDir: "order.screens",
      },
    });
  });

  it("a v1 receipt parses with screens null", () => {
    expect(JSON.parse(v1Text).screens.moments).toHaveLength(2);
    expect(parseReceipt(v1Text, "r.json")).toEqual({
      ok: true,
      receipt: {
        receiptVersion: 1,
        ...shared,
        screens: null,
        screensDir: null,
      },
    });
  });

  it("a step named twice is refused, naming it", () => {
    const twice = { steps: 2, screens: [{ step: 1 }, { step: 1 }] };
    expect(refusal(withChange({ screens: twice }))).toContain(
      "screens.screens[1].step 1 is named by an earlier screen",
    );
    const finals = { steps: 2, screens: [{ step: null }, { step: null }] };
    expect(refusal(withChange({ screens: finals }))).toContain(
      "screens.screens[1].step is a second final screen",
    );
  });

  it("an empty unsettled reason is refused", () => {
    const empty = { steps: 2, screens: [{ step: 0, unsettled: "" }] };
    expect(refusal(withChange({ screens: empty }))).toContain(
      "screens.screens[0].unsettled must be a non-empty string",
    );
  });

  it("refuses a step that is not below steps, and steps that are no whole number", () => {
    expect(
      refusal(withChange({ screens: { steps: 2, screens: [{ step: 2 }] } })),
    ).toContain("screens.screens[0].step 2 is not below screens.steps 2");
    expect(
      refusal(withChange({ screens: { steps: 1.5, screens: [{ step: 0 }] } })),
    ).toContain("screens.steps must be a whole number of steps");
  });

  it("refuses a v3 receipt with no screen, or with no screen folder", () => {
    expect(
      refusal(withChange({ screens: { steps: 2, screens: [] } })),
    ).toContain("screens.screens must list at least one screen");
    expect(refusal(withChange({ screensDir: undefined }))).toContain(
      "screensDir must be a folder beside the receipt",
    );
  });

  it("refuses a look that is not a non-empty string", () => {
    expect(
      refusal(withChange({ screens: { ...receipt.screens, look: "" } })),
    ).toContain("screens.look must be a non-empty string");
  });

  // A v1 or v2 receipt is never written again: the next refresh replaces it.
  it("refuses to write a receipt with no page screens", () => {
    const parsed = parseReceipt(v2Text, "r.json");
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(() => serializeReceipt(parsed.receipt)).toThrow(
      "predates page screens",
    );
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

  it("refuses a bad filmedCode and another receiptVersion, naming them", () => {
    expect(refusal(withChange({ filmedCode: { commit: 3 } }))).toContain(
      "filmedCode",
    );
    expect(refusal(withChange({ receiptVersion: 4 }))).toContain(
      "receiptVersion is 4; this Demoman reads 1 and 2 and 3 — it was written by a newer Demoman; update Demoman",
    );
    expect(refusal(withChange({ receiptVersion: "3" }))).not.toContain("newer");
  });

  it("names the file when the JSON is invalid", () => {
    expect(refusal("{nope")).toContain("r.json");
  });

  it("round-trips the script digest, and reads a receipt without one", () => {
    const withDigest: KeptReceipt = { ...receipt, scriptDigest: "9f3a" };
    const text = serializeReceipt(withDigest);
    expect(JSON.parse(text).scriptDigest).toBe("9f3a");
    expect(parseReceipt(text, "r.json")).toEqual({
      ok: true,
      receipt: withDigest,
    });
    // Absent: written before it was recorded, still read, and not written back.
    const without = parseReceipt(serializeReceipt(receipt), "r.json");
    expect(without.ok && "scriptDigest" in without.receipt).toBe(false);
    expect(refusal(withChange({ scriptDigest: "" }))).toContain("scriptDigest");
  });

  // Red when a receipt cannot say which instant its video was pinned to (DEM-79).
  it("round-trips pinnedNow", () => {
    const pinned: KeptReceipt = {
      ...receipt,
      pinnedNow: "2026-11-06T09:00:00Z",
    };
    const text = serializeReceipt(pinned);
    expect(JSON.parse(text).pinnedNow).toBe("2026-11-06T09:00:00Z");
    expect(parseReceipt(text, "r.json")).toEqual({ ok: true, receipt: pinned });
  });

  it("a receipt without pinnedNow parses and writes as before", () => {
    const text = serializeReceipt(receipt);
    expect(text).not.toContain("pinnedNow");
    const r = parseReceipt(text, "r.json");
    expect(r.ok && "pinnedNow" in r.receipt).toBe(false);
  });

  it("refuses a pinnedNow that is not an instant, naming it", () => {
    for (const pinnedNow of ["", "2026-11-06", "soon", 5]) {
      expect(refusal(withChange({ pinnedNow }))).toContain("pinnedNow");
    }
  });

  it("refuses a screen folder that is not beside the receipt, in any version", () => {
    // Premise: the fixture's folder beside the receipt is accepted.
    expect(parseReceipt(serializeReceipt(receipt), "r.json").ok).toBe(true);
    expect(refusal(withChange({ screensDir: "../x" }))).toContain(
      "screensDir must be a folder beside the receipt",
    );
    expect(
      refusal(JSON.stringify({ ...JSON.parse(v2Text), screensDir: "/x" })),
    ).toContain("screensDir must be a folder beside the receipt");
  });

  it("refuses a screens folder under version 1, which has none", () => {
    expect(
      refusal(
        JSON.stringify({ ...JSON.parse(v1Text), screensDir: "o.screens" }),
      ),
    ).toContain("screensDir needs receiptVersion 2 or 3");
  });

  it("names the screen folder beside a receipt, dropping only .json", () => {
    expect(screensDirOf("order.json")).toBe("order.screens");
    expect(screensDirOf("order.receipt.json")).toBe("order.receipt.screens");
  });
});
