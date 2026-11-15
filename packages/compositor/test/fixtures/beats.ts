import type { SceneDocument } from "@demoman/scene-schema";
import type { FrameBundle, MarkerEntry } from "../../src/bundle";
import { sceneWithActions } from "./scene";

// Hand-built real-time bundles for the planned-pacing lane: two steps, each
// preceded by a cursor journey and followed by the page's response, with
// the dead air around them as the caller says. Motion lengths are fixed, so
// two bundles built with different idle differ ONLY in idle.

/** The cursor's walk to each step. */
export const JOURNEY_MS = 700;
/** The page's response to each step. */
export const ACT_MS = 500;

export interface Idle {
  /** Before the first journey sets off. */
  openRest: number;
  /** After the first journey, before s1. */
  openArrive: number;
  /** After s1's response, before the second journey. */
  rest: number;
  /** After the second journey, before s2. */
  arrive: number;
  /** After s2's response. */
  tail: number;
}

export interface PacedBundle {
  bundle: FrameBundle;
  /** Source instants, for the assertions. */
  at: { approach1: number; s1: number; approach2: number; s2: number };
}

export function pacedBundle(
  idle: Idle,
  overrides: Partial<FrameBundle> = {},
): PacedBundle {
  let t = idle.openRest;
  const approach1 = t;
  const journey1 = { startMs: t, endMs: (t += JOURNEY_MS) };
  t += idle.openArrive;
  const s1 = t;
  const act1 = { startMs: t, endMs: (t += ACT_MS) };
  t += idle.rest;
  const approach2 = t;
  const journey2 = { startMs: t, endMs: (t += JOURNEY_MS) };
  t += idle.arrive;
  const s2 = t;
  const act2 = { startMs: t, endMs: (t += ACT_MS) };
  t += idle.tail;
  const end = t;

  const markers: MarkerEntry[] = [
    { actionId: "s1", sourceTimeMs: s1, approachSourceTimeMs: approach1 },
    { actionId: "s2", sourceTimeMs: s2, approachSourceTimeMs: approach2 },
  ];
  const keyframe = (sourceTimeMs: number, ref: string) => ({
    byteLength: 0,
    sourceTimeMs,
    ref,
    width: 1280,
    height: 800,
    actionId: null,
  });
  return {
    bundle: {
      bundleVersion: 1,
      sceneId: "scene-actions-001",
      source: "replay",
      timing: "real",
      dpr: 1,
      viewport: { width: 1280, height: 800 },
      keyframes: [keyframe(0, "k0"), keyframe(end, "k1")],
      motionSpans: [journey1, act1, journey2, act2].map((span, i) => ({
        ...span,
        byteLength: 0,
        ref: `m${i}`,
        width: 1280,
        height: 800,
        fps: 60,
      })),
      cursorSamples: [{ sourceTimeMs: 0, x: 0, y: 0 }],
      cursorGaps: [],
      anchorRects: [],
      markers,
      degradations: [],
      ...overrides,
    },
    at: { approach1, s1, approach2, s2 },
  };
}

/** The two-step scene the bundles above film. */
export function twoStepScene(
  pacing?: SceneDocument["pacing"],
  gaps: SceneDocument["edits"]["gaps"] = [],
): SceneDocument {
  const scene = sceneWithActions([
    { id: "s1", timestamp: 1000 },
    { id: "s2", timestamp: 3000 },
  ]);
  return {
    ...scene,
    ...(pacing ? { pacing } : {}),
    edits: { ...scene.edits, gaps },
  };
}

export const SLOW: Idle = {
  openRest: 900,
  openArrive: 250,
  rest: 6000,
  arrive: 340,
  tail: 1200,
};

/**
 * Takes without a beat plan, for the "nothing changes" case: the bundles
 * carry `approachSourceTimeMs` anyway, so a timeline that read it without a
 * plan would differ. Their plans and timelines as the code drew them before
 * planned pacing existed (35f94523) are in `timeline-no-pacing.json`.
 */
export function noPacingCases(): {
  name: string;
  scene: SceneDocument;
  bundle: FrameBundle;
}[] {
  const interrupted = pacedBundle(SLOW, {
    degradations: [
      {
        startMs: 3000,
        endMs: 5000,
        kind: "occlusionPause",
        note: "the replay window was covered",
      },
    ],
  }).bundle;
  return [
    {
      name: "real-time, interrupted",
      scene: twoStepScene(),
      bundle: interrupted,
    },
    {
      name: "real-time, authored gap",
      scene: twoStepScene(undefined, [
        { id: "g1", afterActionId: "s1", durationMs: 800 },
      ]),
      bundle: interrupted,
    },
    {
      name: "sampled replay",
      scene: twoStepScene(),
      bundle: { ...pacedBundle(SLOW).bundle, timing: undefined },
    },
  ];
}
