import { CURSOR_DEFAULTS, type SceneDocument } from "@demoman/scene-schema";

/**
 * Scene fixtures, in `src/` rather than `test/` because two consumers need
 * them: the test lanes, and the editor's `?fixture=` door (see
 * `src/fixtures/seed.ts`).
 *
 * They stay a single definition. `test/helpers/scenes.ts` re-exports from
 * here rather than holding its own copy — a second copy is the failure mode
 * `test/helpers/bundles.ts`'s own docblock names about reaching into another
 * package's fixtures, and it would let the scene a test reasons about drift
 * from the scene the door puts on screen. The door exists so a person can
 * compare the two, which only works while they are the same object.
 *
 * Nothing here is imported by a production code path. `seed.ts` is the only
 * runtime consumer and it is compiled out of a store build; see its docblock.
 */

function anchor(
  id: string,
  stableId: string | null,
  rect: { x: number; y: number; width: number; height: number },
  actionIndex: number,
): SceneDocument["anchors"][number] {
  return {
    id,
    fingerprint: {
      stableId,
      role: "button",
      accessibleName: id,
      textContent: id,
      treePath: `body:1/main:1/*:${actionIndex + 1}`,
      boundingRect: rect,
      imagePatchRef: null,
      dataKey: null,
    },
    resolution: {
      url: "https://app.example.com/orders",
      actionIndex,
      entryState: actionIndex === 0,
      strategy: stableId ? "stableId" : "roleName",
      failureReason: null,
      candidates: 1,
    },
  };
}

/** Mirrors packages/compositor/test/fixtures/scene.ts so the two read as one app. */
export function readonlyScene(): SceneDocument {
  return {
    schemaVersion: 12,
    meta: {
      id: "scene-readonly-001",
      name: "Orders walkthrough",
      createdAt: "2026-08-25T05:00:00.000Z",
      toolchain: {
        resolverVersion: "1.0.0",
        compositorVersion: null,
        captureVersion: "1.0.0",
      },
      capture: {
        originUrl: "https://app.example.com/orders",
        originClass: "published",
        buildSha: "abc1234def",
        buildShaSource: "git-describe",
        viewport: { width: 1280, height: 800 },
        dpr: 3,
        mode: "record",
      },
    },
    anchors: [
      anchor("a-search", null, { x: 40, y: 24, width: 320, height: 36 }, 0),
      anchor(
        "a-row",
        "order-row-8891",
        { x: 60, y: 300, width: 1160, height: 56 },
        1,
      ),
      anchor(
        "a-checkout",
        "checkout-btn",
        { x: 980, y: 620, width: 160, height: 44 },
        2,
      ),
    ],
    actions: [
      {
        id: "act-1",
        anchorId: "a-search",
        timestamp: 400,
        marker: "type:a-search",
        kind: "type",
        text: "northwind",
        redacted: false,
      },
      {
        id: "act-2",
        anchorId: "a-row",
        timestamp: 3200,
        marker: "scrollTo:a-row",
        kind: "scrollTo",
      },
      {
        id: "act-3",
        anchorId: "a-checkout",
        timestamp: 9000,
        marker: "click:a-checkout",
        kind: "click",
        button: "left",
      },
    ],
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
    branding: {
      background: {
        kind: "gradient",
        from: "#daebff",
        to: "#a8c2ff",
        angle: 150,
      },
      logo: null,
      padding: 0.08,
    },
    cursor: CURSOR_DEFAULTS,
    canvas: { aspect: "16:9" },
  };
}
