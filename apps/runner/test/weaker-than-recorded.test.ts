import type { SerializedReport } from "@demoman/replay-engine/page";
import type { AnchorIntent } from "@demoman/resolver";
import type { SceneAnchor, StrategyName } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { weakerThanRecorded } from "../src/page-agent.js";

const fingerprint: SceneAnchor["fingerprint"] = {
  stableId: null,
  role: "button",
  accessibleName: "Edit",
  textContent: "Edit",
  treePath: "main[0]>button[1]",
  boundingRect: null,
  imagePatchRef: null,
  dataKey: null,
};

const recordedBy = (strategy: StrategyName): SceneAnchor => ({
  id: "a-edit",
  fingerprint,
  resolution: {
    url: "https://app.example.com/",
    actionIndex: 0,
    entryState: true,
    strategy,
    failureReason: null,
    candidates: 1,
  },
});

const foundBy = (
  strategy: StrategyName,
  extra: Partial<SerializedReport> = {},
): SerializedReport => ({
  anchorId: "a-edit",
  strategy,
  element: null,
  candidates: 1,
  failureReason: null,
  corroboration: [],
  durationMs: 1,
  ...extra,
});

describe("weakerThanRecorded", () => {
  it("says so when a replay found the element by a weaker tier than capture", () => {
    const note = weakerThanRecorded(
      recordedBy("roleName"),
      foundBy("treePath"),
    );
    expect(note).toContain('"a-edit"');
    expect(note).toContain("its position in the page");
    expect(note).toContain("not by its role and name");
  });

  it("names the tie the weaker tier broke", () => {
    const note = weakerThanRecorded(
      recordedBy("stableId"),
      foundBy("text", { tiedAt: { strategy: "roleName", count: 2 } }),
    );
    expect(note).toContain("among 2 that share its role and name");
    expect(note).toContain("not by its stable id");
  });

  it("says nothing at the same tier, a stronger one, or for a refusal", () => {
    expect(
      weakerThanRecorded(recordedBy("treePath"), foundBy("treePath")),
    ).toBeNull();
    expect(
      weakerThanRecorded(recordedBy("treePath"), foundBy("roleName")),
    ).toBeNull();
    // A refusal is reported as a stop of its own, not as a weaker find.
    expect(
      weakerThanRecorded(recordedBy("roleName"), foundBy("ambiguous")),
    ).toBeNull();
    expect(
      weakerThanRecorded(recordedBy("ambiguous"), foundBy("treePath")),
    ).toBeNull();
  });

  // An authored step's intent has no capture behind it to compare with.
  it("says nothing for an intent, which records no resolution", () => {
    const intent: AnchorIntent = { id: "a-edit", fingerprint };
    expect(weakerThanRecorded(intent, foundBy("imagePatch"))).toBeNull();
  });
});
