import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import {
  HOVER_PROBE_PRE_MS,
  planHoverProbes,
} from "../../src/render/hover-verdict";

// `action.timestamp` is 2000 below; the marker echoes it so every test in
// this file except the marker-resolution ones below exercises exactly what
// it did before markers existed as a source of truth.
const bundle = {
  viewport: { width: 1280, height: 800 },
  markers: [{ actionId: "act-1", sourceTimeMs: 2000 }],
} as unknown as FrameBundle;

function scene(over: {
  rect: { x: number; y: number; width: number; height: number } | null;
  treePath?: string | null;
  signal?: "mutation" | "style";
}): SceneDocument {
  return {
    anchors: [
      {
        id: "a1",
        fingerprint: {
          stableId: "menu",
          role: null,
          accessibleName: null,
          textContent: null,
          treePath: over.treePath ?? "div:0/button:1",
          boundingRect: over.rect,
          imagePatchRef: null,
          dataKey: null,
        },
      },
    ],
    actions: [
      {
        id: "act-1",
        kind: "moveTo",
        anchorId: "a1",
        timestamp: 2000,
        marker: "m1",
        signal: over.signal ?? "style",
      },
    ],
  } as unknown as SceneDocument;
}

const only = (doc: SceneDocument) => planHoverProbes(doc, bundle)[0];

describe("planHoverProbes", () => {
  it("brackets the probe before the pointer arrived and after the transition ran", () => {
    const probe = only(
      scene({ rect: { x: 10, y: 10, width: 120, height: 32 } }),
    );
    expect(probe).toEqual({
      kind: "probe",
      actionId: "act-1",
      rect: { x: 10, y: 10, width: 120, height: 32 },
      preMs: 2000 - HOVER_PROBE_PRE_MS,
      postMs: 2100,
    });
  });

  it("refuses a null boundingRect rather than cropping nothing", () => {
    expect(only(scene({ rect: null }))).toEqual({
      kind: "unknown",
      actionId: "act-1",
      reason: "noRect",
    });
  });

  it("refuses an iframe-local rect, which would crop unrelated pixels", () => {
    // A hop-prefixed treePath means the rect is in the frame's coordinates and
    // nothing stores the offset to the top document.
    const doc = scene({
      rect: { x: 10, y: 10, width: 120, height: 32 },
      treePath: "#frame(origin=https://js.stripe.com,name=,ordinal=0)/div:0",
    });
    expect(only(doc)).toEqual({
      kind: "unknown",
      actionId: "act-1",
      reason: "crossFrameRect",
    });
  });

  it("refuses a rect scrolled outside the frame", () => {
    const doc = scene({ rect: { x: 10, y: 900, width: 120, height: 32 } });
    expect(only(doc)).toEqual({
      kind: "unknown",
      actionId: "act-1",
      reason: "offFrame",
    });
  });

  it("refuses a crop thinner than a JPEG macroblock", () => {
    const doc = scene({ rect: { x: 10, y: 10, width: 120, height: 4 } });
    expect(only(doc)).toEqual({
      kind: "unknown",
      actionId: "act-1",
      reason: "cropTooSmall",
    });
  });

  it("brackets the probe from the bundle's marker, not the action's own timestamp", () => {
    // Marker sits far from `action.timestamp` (2000) — the way a replay
    // bundle's marker (pushed on the replay clock) drifts from the capture
    // clock the scene's `timestamp` was authored against. An implementation
    // that reads `action.timestamp` produces `preMs: 1600, postMs: 2100`;
    // only one that resolves through `bundle.markers` produces `4600`/`5100`.
    const driftedBundle = {
      viewport: { width: 1280, height: 800 },
      markers: [{ actionId: "act-1", sourceTimeMs: 5000 }],
    } as unknown as FrameBundle;
    const probe = planHoverProbes(
      scene({ rect: { x: 10, y: 10, width: 120, height: 32 } }),
      driftedBundle,
    )[0];
    expect(probe).toEqual({
      kind: "probe",
      actionId: "act-1",
      rect: { x: 10, y: 10, width: 120, height: 32 },
      preMs: 5000 - HOVER_PROBE_PRE_MS,
      postMs: 5100,
    });
  });

  it("refuses an action with no marker rather than falling back to its own timestamp", () => {
    const noMarkerBundle = {
      viewport: { width: 1280, height: 800 },
      markers: [],
    } as unknown as FrameBundle;
    const probe = planHoverProbes(
      scene({ rect: { x: 10, y: 10, width: 120, height: 32 } }),
      noMarkerBundle,
    )[0];
    expect(probe).toEqual({
      kind: "unknown",
      actionId: "act-1",
      reason: "noMarker",
    });
  });

  it("crops each sighting at its own anchorRects entry, not the last one written", () => {
    // Two moveTo actions on ONE anchor — the second after a scroll, so the
    // element is 200px higher. `anchorRects` is keyed by actionId for exactly
    // this: a map keyed by anchorId collapses both entries onto whichever was
    // written last and crops act-1's frames at act-2's rect, reporting
    // still/changed with total confidence about pixels nobody looked at.
    const twoSightings = {
      viewport: { width: 1280, height: 800 },
      markers: [
        { actionId: "act-1", sourceTimeMs: 2000 },
        { actionId: "act-2", sourceTimeMs: 6000 },
      ],
      anchorRects: [
        {
          actionId: "act-1",
          anchorId: "a1",
          rect: { x: 10, y: 400, width: 120, height: 32 },
        },
        {
          actionId: "act-2",
          anchorId: "a1",
          rect: { x: 10, y: 200, width: 120, height: 32 },
        },
      ],
    } as unknown as FrameBundle;
    const doc = scene({ rect: { x: 10, y: 10, width: 120, height: 32 } });
    // Fixture guard: the two entries must genuinely differ, or this asserts
    // nothing about the keying.
    expect(twoSightings.anchorRects[0]?.rect.y).not.toBe(
      twoSightings.anchorRects[1]?.rect.y,
    );
    const withSecond = {
      ...doc,
      actions: [
        ...doc.actions,
        { ...doc.actions[0], id: "act-2", timestamp: 6000 },
      ],
    } as SceneDocument;
    const probes = planHoverProbes(withSecond, twoSightings);
    expect(probes[0]).toMatchObject({
      kind: "probe",
      actionId: "act-1",
      rect: { x: 10, y: 400, width: 120, height: 32 },
    });
    expect(probes[1]).toMatchObject({
      kind: "probe",
      actionId: "act-2",
      rect: { x: 10, y: 200, width: 120, height: 32 },
    });
  });

  it("falls back to the fingerprint rect for an action with no anchorRects entry", () => {
    // The other half of the two-map split: `actionRects` misses, so the
    // element's first sighting is what gets cropped — the spec's "an action's
    // element is gone at rect time" row.
    const otherActionOnly = {
      viewport: { width: 1280, height: 800 },
      markers: [{ actionId: "act-1", sourceTimeMs: 2000 }],
      anchorRects: [
        {
          actionId: "act-99",
          anchorId: "a1",
          rect: { x: 10, y: 400, width: 120, height: 32 },
        },
      ],
    } as unknown as FrameBundle;
    const probe = planHoverProbes(
      scene({ rect: { x: 10, y: 10, width: 120, height: 32 } }),
      otherActionOnly,
    )[0];
    expect(probe).toMatchObject({
      kind: "probe",
      rect: { x: 10, y: 10, width: 120, height: 32 },
    });
  });

  it("refuses a hover the DOM already witnessed", () => {
    // A mutation-signalled hover has independent evidence; pixels must not
    // overrule it.
    const doc = scene({
      rect: { x: 10, y: 10, width: 120, height: 32 },
      signal: "mutation",
    });
    expect(only(doc)).toEqual({
      kind: "unknown",
      actionId: "act-1",
      reason: "notStyleSignalled",
    });
  });
});

// A page with no meta viewport on a phone is shown zoomed out, and its rects
// are in the page's own px (`screen-space.ts`). The crop is taken from the
// frames, so it has to be where the screen showed the target.
describe("planHoverProbes on a zoomed-out page", () => {
  it("crops where the screen showed the target", () => {
    const zoomed = {
      ...bundle,
      cursorSamples: [],
      anchorRects: [],
      viewportTransforms: [
        { sourceTimeMs: 0, scale: 0.5, offsetX: 0, offsetY: 0 },
      ],
    } as unknown as FrameBundle;
    const doc = scene({ rect: { x: 200, y: 100, width: 120, height: 40 } });
    // The premise: without the transform the crop is the stored rect.
    const flat = planHoverProbes(doc, bundle)[0];
    expect(flat && "rect" in flat ? flat.rect.x : null).toBe(200);
    const probe = planHoverProbes(doc, zoomed)[0];
    expect(probe && "rect" in probe ? probe.rect : null).toEqual({
      x: 100,
      y: 50,
      width: 60,
      height: 20,
    });
  });
});
