import { CURSOR_DEFAULTS, type SceneDocument } from "@demoman/scene-schema";

/**
 * A read-only scene, and a mutating one whose writes went where we say.
 *
 * Shared by `policy.test.ts` and by a later task that writes a scene to a
 * file (`readOnlySceneJson` / `mutatingSceneJson`, plain JSON-shaped
 * objects rather than `SceneDocument` values) — see task-3-brief.md's
 * Step 2 for the original inline version this was lifted from unchanged.
 */
export function scene(
  mutating: boolean,
  writeUrls: string[] = [],
): SceneDocument {
  return {
    schemaVersion: 12,
    meta: {
      id: "s1",
      name: "s",
      createdAt: "2026-09-08T00:00:00.000Z",
      toolchain: {
        resolverVersion: "1.0.0",
        compositorVersion: null,
        captureVersion: null,
      },
      capture: {
        originUrl: "https://app.example.com/",
        originClass: "published",
        buildSha: null,
        buildShaSource: null,
        viewport: { width: 1280, height: 800 },
        dpr: 2,
        mode: "record",
      },
    },
    anchors: [],
    actions: [],
    camera: [],
    edits: {
      masks: [],
      holds: [],
      gaps: [],
      splits: [],
      removed: [],
    },
    sideChannels: {
      network: writeUrls.map((url, i) => ({
        id: `n${i}`,
        url,
        method: "POST" as const,
        classification: "mutation" as const,
        timestamp: 0,
        reclassified: false,
      })),
      consoleExcerpt: [],
      urlTrace: [],
      uncoveredOrigins: [],
    },
    flags: { mutating, hoverSensitive: false },
    // v5 `primaryColor: "#000000"` as the v5 -> v6 migration converts it:
    // the grey tint v5 painted, not a black frame.
    branding: {
      background: {
        kind: "gradient",
        from: "#ebebeb",
        to: "#c4c4c4",
        angle: 150,
      },
      logo: null,
      padding: 0.08,
    },
    cursor: CURSOR_DEFAULTS,
    canvas: { aspect: "16:9" },
  } as SceneDocument;
}

/** Plain JSON-shaped read-only scene, for a task that writes a scene to a
 *  file rather than importing `SceneDocument` values. */
export function readOnlySceneJson(): unknown {
  return scene(false);
}

/** Plain JSON-shaped mutating scene with one recorded write, same use as
 *  `readOnlySceneJson`. */
export function mutatingSceneJson(): unknown {
  return scene(true, ["https://api.example.com/orders"]);
}
