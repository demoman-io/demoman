import { CURSOR_DEFAULTS, type SceneDocument } from "@demoman/scene-schema";
import { CAMERA_DEFAULTS } from "../../src/plan/camera";

// Scene fixtures for the planning lane. Coordinates are CSS pixels in a
// 1280x800 viewport, chosen to match packages/scene-schema/fixtures so the
// two sets read as the same imaginary app.

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

function baseMeta(id: string, mode: "record" | "retro"): SceneDocument["meta"] {
  return {
    id,
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
      mode,
    },
  };
}

export function readonlyScene(): SceneDocument {
  return {
    schemaVersion: 14,
    meta: baseMeta("scene-readonly-001", "record"),
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

export function mutatingScene(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    meta: { ...baseMeta("scene-mutating-001", "record") },
    flags: { mutating: true, hoverSensitive: true },
  };
}

/**
 * `readonlyScene` with a zoom authored on the checkout click.
 *
 * Auto-zoom-on-click used to supply this: a scene with an empty `camera`
 * array still came out of `planScene` with a zoom on every click, so any test
 * that needed a zoomed camera could take the plain fixture and find one.
 * Nothing generates a zoom now, so a test that wants one has to say so — and
 * a test that does not want one is no longer quietly given one.
 *
 * Keeps `readonlyScene`'s meta, so the bundles keyed to `scene-readonly-001`
 * still match it.
 */
export function sceneWithZoomOnClick(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    camera: [
      {
        id: "cam-checkout",
        kind: "zoom",
        anchorId: "a-checkout",
        marker: { actionId: "act-3", offsetMs: CAMERA_DEFAULTS.leadInMs },
        scale: CAMERA_DEFAULTS.defaultZoomScale,
      },
    ],
  };
}

export function sceneWithCamera(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    meta: { ...baseMeta("scene-camera-001", "record") },
    camera: [
      {
        id: "cam-1",
        kind: "zoom",
        anchorId: "a-row",
        marker: { actionId: "act-2", offsetMs: -300 },
        scale: 2.2,
      },
      {
        id: "cam-2",
        kind: "zoom",
        anchorId: "a-checkout",
        marker: { actionId: "act-3", offsetMs: 0 },
        scale: 1.6,
      },
    ],
  };
}

/**
 * A navigation `waitFor` carries no anchor (v3): it names no element, so it
 * has no on-screen position. Inserted between the type and the scroll so
 * chaining tests can confirm the scroll's cursor segment starts from the
 * type's landing point rather than teleporting or restarting from the entry
 * point.
 */
export function sceneWithNavigationWait(): SceneDocument {
  return {
    ...readonlyScene(),
    meta: { ...baseMeta("scene-navigation-001", "record") },
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
        id: "act-nav",
        anchorId: null,
        timestamp: 1200,
        marker: "waitFor:navigation",
        kind: "waitFor",
        condition: "loaded",
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
  };
}

export function sceneWithCosmetics(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    meta: { ...baseMeta("scene-cosmetics-001", "record") },
    edits: {
      masks: [
        {
          id: "mask-1",
          rect: { x: 60, y: 380, width: 400, height: 24 },
          note: "customer email column",
        },
      ],
      holds: [],
      gaps: [],
      splits: [],
      removed: [],
    },
  };
}

/**
 * A scene whose only fixed shape is its action list — id and timestamp per
 * action, nothing else. For the pacing tests, which plan from timestamps and
 * `edits.gaps` alone and don't care about anchors, rects or camera.
 *
 * Every action is a navigation `waitFor`: the one verb whose `anchorId` is
 * nullable (v3), so this needs no anchor fixtures — `planScene`'s cursor and
 * camera planning both already skip a null-anchor action.
 */
export function sceneWithActions(
  actions: { id: string; timestamp: number }[],
): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    meta: { ...baseMeta("scene-actions-001", "record") },
    anchors: [],
    actions: actions.map((a): SceneDocument["actions"][number] => ({
      id: a.id,
      anchorId: null,
      timestamp: a.timestamp,
      marker: `waitFor:${a.id}`,
      kind: "waitFor",
      condition: "loaded",
    })),
    camera: [],
    edits: {
      masks: [],
      holds: [],
      gaps: [],
      splits: [],
      removed: [],
    },
  };
}

/**
 * Step cuts as removed pieces, the way schema 12's migration converts them:
 * each run of adjacent cut steps from its first step's frame to the next
 * kept step's frame, or to the take's end.
 */
export function removedFor(
  scene: SceneDocument,
  cuts: { id: string; actionId: string }[],
): SceneDocument["edits"]["removed"] {
  const cut = new Map(cuts.map((c) => [c.actionId, c.id]));
  const ids = scene.actions.map((a) => a.id);
  const removed: SceneDocument["edits"]["removed"] = [];
  let i = 0;
  while (i < ids.length) {
    const start = ids[i] as string;
    const id = cut.get(start);
    if (id === undefined) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < ids.length && cut.has(ids[j] as string)) j += 1;
    const end = ids[j];
    removed.push({
      id,
      start: { actionId: start, sourceOffsetMs: 0 },
      end: end === undefined ? null : { actionId: end, sourceOffsetMs: 0 },
    });
    i = j;
  }
  return removed;
}
