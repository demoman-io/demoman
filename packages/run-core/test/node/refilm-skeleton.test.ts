import type { DemoScript, SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  anchorDigest,
  parseSkeleton,
  skeletonOf,
} from "../../src/refilm/skeleton.js";

const FP = {
  stableId: "filter",
  role: "searchbox",
  accessibleName: "Filter invoices",
  textContent: null,
  treePath: "body:1/main:1/input:1",
};

const script: DemoScript = {
  scriptVersion: 1,
  name: "Filter",
  target: "http://127.0.0.1:4321/sample/",
  steps: [
    { do: "waitForLoad" },
    { do: "pause", ms: 600 },
    { do: "type", into: { stableId: "filter" }, text: "Lumen" },
    { do: "waitFor", on: { text: "Harbor & Pine" }, until: "hidden" },
    { do: "pause", ms: 1500 },
  ],
} as DemoScript;

// The run's steps: pauses yield none, so indices 1 and 4 are absent — the
// shape `RunReport.steps` has (the 2026-10-14 Lumen run reported 0, 2, 3).
const steps = [
  { index: 0, actionId: "ac-load" },
  { index: 2, actionId: "ac-type" },
  { index: 3, actionId: "ac-wait" },
];

const scene = {
  meta: { id: "scene-1" },
  actions: [
    { id: "ac-load", kind: "waitFor", anchorId: null },
    { id: "ac-type", kind: "type", anchorId: "an-filter", text: "Lumen" },
    { id: "ac-wait", kind: "waitFor", anchorId: "an-row" },
  ],
  anchors: [
    { id: "an-filter", fingerprint: FP },
    {
      id: "an-row",
      fingerprint: {
        ...FP,
        stableId: null,
        role: null,
        accessibleName: null,
        textContent: "Harbor & Pine",
      },
    },
  ],
} as unknown as SceneDocument;

describe("skeletonOf", () => {
  it("keeps every pause and each acting step's verb and action id, in order", () => {
    const sk = skeletonOf(script, steps, scene);
    expect(sk.steps.map((s) => s.do)).toEqual([
      "waitForLoad",
      "pause",
      "type",
      "waitFor",
      "pause",
    ]);
    expect(sk.steps[1]).toEqual({ do: "pause", ms: 600 });
    expect(sk.steps[2]).toMatchObject({ do: "type", actionId: "ac-type" });
    expect(sk.steps[2]).toMatchObject({ anchorDigest: anchorDigest(FP) });
    expect(sk.steps[0]).toMatchObject({
      actionId: "ac-load",
      anchorDigest: null,
    });
    expect(sk).toMatchObject({
      name: "Filter",
      scriptVersion: 1,
      viewport: null,
      device: null,
      look: null,
    });
  });

  it("keeps the script's account, and reads a skeleton without one", () => {
    const sk = skeletonOf(
      { ...script, scriptVersion: 5, account: "seller" },
      steps,
      scene,
    );
    expect(sk.account).toBe("seller");
    const back = parseSkeleton(JSON.parse(JSON.stringify(sk)));
    expect(back.ok && back.skeleton.account).toBe("seller");
    const { account: _a, ...older } = sk;
    // Premise: the older skeleton really has no account key.
    expect("account" in older).toBe(false);
    const old = parseSkeleton(JSON.parse(JSON.stringify(older)));
    expect(old.ok, JSON.stringify(old)).toBe(true);
    expect(old.ok && old.skeleton.account).toBeUndefined();
    const bad = parseSkeleton({
      ...JSON.parse(JSON.stringify(sk)),
      account: 7,
    });
    expect(bad.ok).toBe(false);
  });

  it("holds no typed text, no target and no start URL", () => {
    const text = JSON.stringify(skeletonOf(script, steps, scene));
    // Premise: the script did carry all three.
    expect(JSON.stringify(script)).toMatch(/Lumen|Harbor|127\.0\.0\.1/);
    expect(text).not.toMatch(/Lumen/);
    expect(text).not.toMatch(/Harbor/);
    expect(text).not.toMatch(/127\.0\.0\.1/);
    expect(text).not.toMatch(/"filter"/);
  });

  it("gives a step the run never performed a null action id", () => {
    const sk = skeletonOf(script, steps.slice(0, 1), scene);
    expect(sk.steps[2]).toMatchObject({
      do: "type",
      actionId: null,
      anchorDigest: null,
    });
  });
});

describe("anchorDigest", () => {
  it("changes when any fingerprint field changes, and only then", () => {
    expect(anchorDigest(FP)).toBe(anchorDigest({ ...FP }));
    expect(anchorDigest(FP)).toMatch(/^[0-9a-f]{8}$/);
    for (const key of Object.keys(FP) as (keyof typeof FP)[]) {
      expect(anchorDigest({ ...FP, [key]: "changed" })).not.toBe(
        anchorDigest(FP),
      );
    }
  });
});

describe("parseSkeleton", () => {
  it("accepts what skeletonOf writes, through JSON", () => {
    const sk = skeletonOf(script, steps, scene);
    expect(parseSkeleton(JSON.parse(JSON.stringify(sk)))).toEqual({
      ok: true,
      skeleton: sk,
    });
  });

  it.each([
    ["not an object", 7],
    [
      "a newer version",
      {
        skeletonVersion: 2,
        name: "x",
        scriptVersion: 1,
        viewport: null,
        device: null,
        look: null,
        steps: [],
      },
    ],
    [
      "a pause without ms",
      {
        skeletonVersion: 1,
        name: "x",
        scriptVersion: 1,
        viewport: null,
        device: null,
        look: null,
        steps: [{ do: "pause" }],
      },
    ],
    [
      "a step with no actionId key",
      {
        skeletonVersion: 1,
        name: "x",
        scriptVersion: 1,
        viewport: null,
        device: null,
        look: null,
        steps: [{ do: "click", anchorDigest: null }],
      },
    ],
  ])("refuses %s, saying where", (_label, raw) => {
    const out = parseSkeleton(raw);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.length).toBeGreaterThan(10);
  });
});
