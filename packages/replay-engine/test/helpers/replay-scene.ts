import {
  BRANDING_DEFAULTS,
  CURSOR_DEFAULTS,
  type SceneDocument,
} from "@demoman/scene-schema";

/**
 * One anchor to build, named by its stable id. The object form carries a
 * `treePath` for an element that is not in the top document: the frame hops
 * in that path are how replay knows which CDP frame to measure in.
 */
export type AnchorSpec = string | { id: string; treePath: string };

/**
 * The viewport every scene built here records, and therefore the one replay
 * emulates. Exported so a test can say "the engine emulated this" without
 * restating the numbers — the integration lane's browser context is created
 * at different ones on purpose.
 */
export const SCENE_VIEWPORT = { width: 1280, height: 800 };

export interface SceneOptions extends Partial<SceneDocument> {
  /**
   * Replace the default two-click scene with one click action per id, in
   * order (`act-1`, `act-2`, …), each against an anchor whose `id` and
   * `stableId` are that id.
   */
  anchorIds?: readonly AnchorSpec[];
  /**
   * Convenience for `meta.capture.mode`, without a caller having to restate
   * the rest of `meta.capture` just to flip one field.
   */
  mode?: SceneDocument["meta"]["capture"]["mode"];
}

// A two-click scene. Keep it minimal but schema-valid: the engine parses
// nothing, but every test here asserts against a real document's shape.
export function scene(over: SceneOptions = {}): SceneDocument {
  const { anchorIds, mode, ...overrides } = over;
  const anchor = (id: string, treePath = "button:1") => ({
    id,
    fingerprint: {
      stableId: id,
      role: "button",
      accessibleName: id,
      textContent: null,
      treePath,
      boundingRect: { x: 0, y: 0, width: 100, height: 40 },
      imagePatchRef: null,
      dataKey: null,
    },
    resolution: {
      url: "https://app.example.com/",
      actionIndex: 0,
      entryState: true,
      strategy: "stableId" as const,
      failureReason: null,
      candidates: 1,
    },
  });
  const built = (anchorIds ?? ["first-btn", "second-btn"]).map((spec) =>
    typeof spec === "string" ? { id: spec, treePath: "button:1" } : spec,
  );
  return {
    schemaVersion: 13,
    meta: {
      id: "scene-1",
      name: "take",
      createdAt: "2026-08-25T10:00:00.000Z",
      toolchain: {
        resolverVersion: "1.1.0",
        compositorVersion: null,
        captureVersion: "0.1.0",
      },
      capture: {
        originUrl: "https://app.example.com/",
        originClass: "published",
        buildSha: null,
        buildShaSource: null,
        viewport: SCENE_VIEWPORT,
        dpr: 2,
        mode: mode ?? "record",
      },
    },
    anchors: built.map((spec) => anchor(spec.id, spec.treePath)),
    actions: built.map((spec, i) => ({
      id: `act-${i + 1}`,
      kind: "click" as const,
      anchorId: spec.id,
      timestamp: i * 900,
      marker: `click:${spec.id}`,
    })),
    camera: [],
    edits: {
      masks: [],
      holds: [],
      gaps: [],
      splits: [],
      removed: [],
    },
    sideChannels: {
      network: [],
      consoleExcerpt: [],
      urlTrace: [],
      uncoveredOrigins: [],
    },
    flags: { mutating: false, hoverSensitive: false },
    branding: BRANDING_DEFAULTS,
    cursor: CURSOR_DEFAULTS,
    canvas: { aspect: "16:9" },
    ...overrides,
  } as SceneDocument;
}
