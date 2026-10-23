import type { SceneDocument } from "@demoman/scene-schema";
import type { FrameBundle, ViewportTransform } from "../bundle.js";

interface Point {
  x: number;
  y: number;
}
interface Rect extends Point {
  width: number;
  height: number;
}

/** The record in force at `sourceTimeMs`: the last at or before it, else the
 *  first — a sample stamped before the first record was taken on the page
 *  the first record describes. Records are in time order. */
export function transformAt(
  transforms: readonly ViewportTransform[],
  sourceTimeMs: number,
): ViewportTransform | null {
  let at = transforms[0] ?? null;
  for (const t of transforms) {
    if (t.sourceTimeMs > sourceTimeMs) break;
    at = t;
  }
  return at;
}

const point = (p: Point, t: ViewportTransform): Point => ({
  x: (p.x - t.offsetX) * t.scale,
  y: (p.y - t.offsetY) * t.scale,
});

const rect = <R extends Rect>(r: R, t: ViewportTransform): R => ({
  ...r,
  ...point(r, t),
  width: r.width * t.scale,
  height: r.height * t.scale,
});

const isIdentity = (t: ViewportTransform): boolean =>
  t.scale === 1 && t.offsetX === 0 && t.offsetY === 0;

/**
 * The take as the frames show it: every stored point and rect moved from the
 * page's layout px onto the screen (`bundle.viewport`'s space), and the
 * transforms cleared, so calling this again on its own output changes
 * nothing. Every reader that draws or crops calls it; nothing that replays
 * or matches anchors does, because those speak the page's own px.
 *
 * A rect is converted at its action's marker; an anchor's fingerprint rect
 * at its first action's marker, which is when the sensor first saw it.
 */
export function inScreenSpace<S extends SceneDocument | undefined>(
  bundle: FrameBundle,
  scene: S,
): { bundle: FrameBundle; scene: S } {
  const transforms = bundle.viewportTransforms ?? [];
  if (transforms.every(isIdentity)) {
    return transforms.length === 0
      ? { bundle, scene }
      : { bundle: { ...bundle, viewportTransforms: [] }, scene };
  }
  const markerMs = new Map(
    bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
  );
  // Non-null: `transforms` is non-empty past the identity test above.
  const at = (ms: number): ViewportTransform =>
    transformAt(transforms, ms) as ViewportTransform;
  const atAction = (actionId: string | undefined): ViewportTransform =>
    at((actionId === undefined ? undefined : markerMs.get(actionId)) ?? 0);

  const converted: FrameBundle = {
    ...bundle,
    viewportTransforms: [],
    cursorSamples: bundle.cursorSamples.map((s) => ({
      ...s,
      ...point(s, at(s.sourceTimeMs)),
    })),
    anchorRects: bundle.anchorRects.map((e) => ({
      ...e,
      rect: rect(e.rect, atAction(e.actionId)),
    })),
  };
  if (scene === undefined) return { bundle: converted, scene };

  const firstSeen = new Map<string, string>();
  for (const action of scene.actions) {
    const anchorId = "anchorId" in action ? action.anchorId : undefined;
    if (typeof anchorId === "string" && !firstSeen.has(anchorId)) {
      firstSeen.set(anchorId, action.id);
    }
  }
  const sceneOut: SceneDocument = {
    ...scene,
    actions: scene.actions.map((a) =>
      "rect" in a && a.rect !== undefined
        ? { ...a, rect: rect(a.rect, atAction(a.id)) }
        : a,
    ),
    anchors: scene.anchors.map((anchor) => {
      const r = anchor.fingerprint.boundingRect;
      if (!r) return anchor;
      return {
        ...anchor,
        fingerprint: {
          ...anchor.fingerprint,
          boundingRect: rect(r, atAction(firstSeen.get(anchor.id))),
        },
      };
    }),
  };
  return { bundle: converted, scene: sceneOut as S };
}

/**
 * A plan's cursor segments as the frames show them, each at its arrival's
 * marker. The plan keeps its own in page px, because replay reads the same
 * segments as input; only the drawing of a frozen take's synthesized cursor
 * wants these.
 */
export function segmentsInScreenSpace<
  T extends { toActionId: string; from: Point; to: Point; via: Point[] },
>(
  segments: readonly T[],
  transforms: readonly ViewportTransform[],
  markerSourceMs: ReadonlyMap<string, number>,
): T[] {
  if (transforms.every(isIdentity)) return [...segments];
  return segments.map((s) => {
    const t = transformAt(
      transforms,
      markerSourceMs.get(s.toActionId) ?? 0,
    ) as ViewportTransform;
    return {
      ...s,
      from: point(s.from, t),
      to: point(s.to, t),
      via: s.via.map((v) => point(v, t)),
    };
  });
}
