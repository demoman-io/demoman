import { CAMERA_DEFAULTS } from "@demoman/compositor";
import type {
  SceneAspect,
  SceneCursor,
  SceneDocument,
  SceneMarker,
  SceneMotion,
  SourcePoint,
} from "@demoman/scene-schema";
import { MOTION_DEFAULTS, SceneDocumentSchema } from "@demoman/scene-schema";
import { applyBrandingPatch, type BrandingPatch } from "./branding";
import type { IdSource } from "./ports";

export interface EditRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ZoomTarget =
  | { kind: "element"; anchorId: string }
  | { kind: "point"; x: number; y: number };

export type EditCommand =
  | { kind: "rename"; name: string }
  | { kind: "setTrim"; head?: SceneMarker | null; tail?: SceneMarker | null }
  | {
      kind: "addZoom";
      marker: SceneMarker;
      target: ZoomTarget;
      scale: number;
      note?: string;
    }
  | {
      kind: "setZoomRange";
      id: string;
      start: SceneMarker;
      end: SceneMarker | null;
    }
  | { kind: "setZoomScale"; id: string; scale: number }
  | { kind: "setZoomTarget"; id: string; point: { x: number; y: number } }
  | { kind: "removeZoom"; id: string }
  | {
      kind: "addMask";
      rect: EditRect;
      start: SourcePoint;
      end: SourcePoint;
      note?: string;
    }
  | { kind: "setMaskRange"; id: string; start: SourcePoint; end: SourcePoint }
  | { kind: "moveMask"; id: string; rect: EditRect }
  /** The mask panel's note field. An empty string clears it. */
  | { kind: "setMaskNote"; id: string; note: string }
  | { kind: "removeMask"; id: string }
  /** How the pointer is drawn. One field per dispatch from the panel, so a
   *  drag is one undo entry and a toggle is another. */
  | { kind: "setCursor"; patch: Partial<SceneCursor> }
  /** How the camera moves — the Cursor panel's Camera rows. One field per
   *  dispatch, like `setCursor`; the first one writes the whole block. */
  | { kind: "setMotion"; patch: Partial<SceneMotion> }
  /** The frame's shape, picked under the preview. One undo entry. */
  | { kind: "setAspect"; aspect: SceneAspect }
  /** The Background panel. One command for background, logo and the
   *  brand kit's Reset; each control dispatches one, so one adjustment is
   *  one undo entry. */
  | { kind: "setBranding"; patch: BrandingPatch }
  /** Split the clip at a point of the frames (spec 2026-10-22). */
  | { kind: "split"; at: SourcePoint }
  /** Remove the frames between two points; a null side is the take's end
   *  on that side. `pieces.ts` decides which two. */
  | { kind: "removePiece"; start: SourcePoint | null; end: SourcePoint | null }
  /** A join mark's click: bring that piece back. */
  | { kind: "restorePiece"; id: string }
  /** Move one end of a stored removed range (a piece's edge dragged). */
  | {
      kind: "setRemovedEdge";
      id: string;
      start?: SourcePoint | null;
      end?: SourcePoint | null;
    }
  | { kind: "setGap"; afterActionId: string; durationMs: number }
  | { kind: "clearGap"; afterActionId: string };

function indexOfAction(scene: SceneDocument, actionId: string): number {
  const index = scene.actions.findIndex((a) => a.id === actionId);
  if (index === -1) throw new Error(`unknown action "${actionId}"`);
  return index;
}

function zoomById(
  scene: SceneDocument,
  id: string,
): SceneDocument["camera"][number] {
  const zoom = scene.camera.find((c) => c.id === id);
  if (!zoom) throw new Error(`unknown zoom "${id}"`);
  return zoom;
}

/** The smallest side a mask may be dragged to, in capture CSS pixels.
 *  Anything under it covers nothing; the value is the one the removed
 *  `startMaskDrag` used. */
const MIN_MASK_PX = 1;

// A 1:1 "zoom" is a camera move that shows nothing: the plan spends two
// transitions arriving at full frame and leaving it again. It used to be how
// the editor said "no zoom here" — removal says that now.
const notAZoom = (scale: number): Error =>
  new Error(
    `1:1 is not a zoom — remove the zoom instead of authoring ${scale}`,
  );

function reduce(
  scene: SceneDocument,
  command: EditCommand,
  newId: IdSource,
): SceneDocument {
  switch (command.kind) {
    case "rename":
      return { ...scene, meta: { ...scene.meta, name: command.name } };

    case "setTrim": {
      const current = scene.edits.trim ?? {};
      const next: { head?: SceneMarker; tail?: SceneMarker } = { ...current };
      for (const side of ["head", "tail"] as const) {
        const value = command[side];
        if (value === undefined) continue;
        if (value === null) delete next[side];
        else {
          indexOfAction(scene, value.actionId);
          next[side] = value;
        }
      }
      const edits = { ...scene.edits };
      if (next.head === undefined && next.tail === undefined) delete edits.trim;
      else edits.trim = next;
      return { ...scene, edits };
    }

    case "addZoom": {
      indexOfAction(scene, command.marker.actionId);
      if (command.scale <= 1) throw notAZoom(command.scale);
      const target = command.target;
      if (
        target.kind === "element" &&
        !scene.anchors.some((a) => a.id === target.anchorId)
      ) {
        throw new Error(`unknown anchor "${target.anchorId}"`);
      }
      // On a tick (offset 0) an element zoom gets the default lead-in — the
      // value the old per-step toggle wrote — so the push-in arrives before
      // the click. A click between ticks keeps the offset it was given.
      //
      // `target.kind`, not `offsetMs` alone: a POINT zoom is aimed at where
      // the cursor was at the instant it was dropped, and `resolveGesture`
      // reaches its point branch on a tick too, whenever that beat carries
      // no anchor (a navigation `waitFor`). Shifting one back by the lead-in
      // moved it 350ms before the drop point while its aim stayed sampled at
      // the un-shifted instant — the zoom landed early and pointed at where
      // the cursor would be. It also meant the gesture's own overlap check,
      // which ran against the un-shifted instant, could let the stored zoom
      // land inside a preceding one.
      const offsetMs =
        target.kind === "element" && command.marker.offsetMs === 0
          ? CAMERA_DEFAULTS.leadInMs
          : command.marker.offsetMs;
      const event = {
        id: newId(),
        kind: "zoom" as const,
        ...(target.kind === "element"
          ? { anchorId: target.anchorId }
          : { point: { x: target.x, y: target.y } }),
        marker: { actionId: command.marker.actionId, offsetMs },
        scale: command.scale,
        ...(command.note === undefined ? {} : { note: command.note }),
      };
      return { ...scene, camera: [...scene.camera, event] };
    }

    case "setZoomRange": {
      const zoom = zoomById(scene, command.id);
      indexOfAction(scene, command.start.actionId);
      if (command.end) indexOfAction(scene, command.end.actionId);
      const { end: _dropped, ...rest } = zoom;
      const next =
        command.end === null
          ? { ...rest, marker: command.start }
          : { ...rest, marker: command.start, end: command.end };
      return {
        ...scene,
        camera: scene.camera.map((c) => (c.id === zoom.id ? next : c)),
      };
    }

    case "setZoomScale": {
      const zoom = zoomById(scene, command.id);
      if (command.scale <= 1) throw notAZoom(command.scale);
      return {
        ...scene,
        camera: scene.camera.map((c) =>
          c.id === zoom.id ? { ...c, scale: command.scale } : c,
        ),
      };
    }

    // An element target becomes a point target; the inspector says so.
    //
    // The note goes with the anchor. It is `addZoom`'s aim-fallback sentence
    // — `Aimed at "…" instead of the cursor: …` — which `lanes.ts` reads back
    // as `aimFallback` and the zoom panel prints. Left behind, it went on
    // explaining a fallback the author had just overruled by aiming the
    // focus box themselves: the panel blamed a cursor gap for a point the
    // author placed by hand.
    case "setZoomTarget": {
      const zoom = zoomById(scene, command.id);
      const { anchorId: _anchor, note: _note, ...rest } = zoom;
      return {
        ...scene,
        camera: scene.camera.map((c) =>
          c.id === zoom.id
            ? { ...rest, point: { x: command.point.x, y: command.point.y } }
            : c,
        ),
      };
    }

    case "removeZoom":
      zoomById(scene, command.id);
      return {
        ...scene,
        camera: scene.camera.filter((c) => c.id !== command.id),
      };

    case "addMask": {
      indexOfAction(scene, command.start.actionId);
      indexOfAction(scene, command.end.actionId);
      return {
        ...scene,
        edits: {
          ...scene.edits,
          masks: [
            ...scene.edits.masks,
            {
              id: newId(),
              rect: command.rect,
              start: command.start,
              end: command.end,
              ...(command.note === undefined ? {} : { note: command.note }),
            },
          ],
        },
      };
    }

    case "setMaskRange": {
      indexOfAction(scene, command.start.actionId);
      indexOfAction(scene, command.end.actionId);
      if (!scene.edits.masks.some((m) => m.id === command.id)) {
        throw new Error(`unknown mask "${command.id}"`);
      }
      return {
        ...scene,
        edits: {
          ...scene.edits,
          masks: scene.edits.masks.map((m) =>
            m.id === command.id
              ? { ...m, start: command.start, end: command.end }
              : m,
          ),
        },
      };
    }

    case "moveMask": {
      if (!scene.edits.masks.some((m) => m.id === command.id)) {
        throw new Error(`unknown mask "${command.id}"`);
      }
      // `canvasRectToCss` clamps a drag to the capture viewport, so a box
      // carried clean off an edge comes back with a zero side — which the
      // schema accepts (`nonnegative`), the lane still lists, and
      // `drawCosmetics` paints as nothing. Stored, that is a redaction
      // thrown away by a drag that reported success. The overlay's own
      // guard went with `startMaskDrag`; this is it, back where every
      // caller passes through, and saying so rather than snapping back.
      if (
        command.rect.width < MIN_MASK_PX ||
        command.rect.height < MIN_MASK_PX
      ) {
        throw new Error(
          "That drag left the mask off the frame — nothing would be covered. " +
            "Drag it back over the picture.",
        );
      }
      return {
        ...scene,
        edits: {
          ...scene.edits,
          masks: scene.edits.masks.map((m) =>
            m.id === command.id ? { ...m, rect: command.rect } : m,
          ),
        },
      };
    }

    case "setMaskNote":
      return {
        ...scene,
        edits: {
          ...scene.edits,
          masks: scene.edits.masks.map((m) => {
            if (m.id !== command.id) return m;
            const { note: _note, ...rest } = m;
            return command.note === "" ? rest : { ...rest, note: command.note };
          }),
        },
      };

    case "removeMask":
      return {
        ...scene,
        edits: {
          ...scene.edits,
          masks: scene.edits.masks.filter((m) => m.id !== command.id),
        },
      };

    // Validated by `applyCommandWithReport`'s `SceneDocumentSchema.parse`,
    // which refuses a colour or size the painter could not honour with the
    // schema's own reason — surfaced as "That edit did not go through".
    case "setBranding":
      return {
        ...scene,
        branding: applyBrandingPatch(scene.branding, command.patch),
      };

    case "setCursor":
      return {
        ...scene,
        cursor: { ...scene.cursor, ...command.patch },
      };

    // Written whole from `MOTION_DEFAULTS` on the first edit, so a document
    // never holds half a block: the schema requires all three fields once
    // `motion` is present, and an absent one reads as the defaults anyway.
    // Range-checked by the same `SceneDocumentSchema.parse` as the cursor.
    case "setMotion":
      return {
        ...scene,
        motion: { ...(scene.motion ?? MOTION_DEFAULTS), ...command.patch },
      };

    case "setAspect":
      return {
        ...scene,
        canvas: { ...scene.canvas, aspect: command.aspect },
      };

    case "split": {
      indexOfAction(scene, command.at.actionId);
      return {
        ...scene,
        edits: {
          ...scene.edits,
          splits: [
            ...(scene.edits.splits ?? []),
            { id: newId(), at: command.at },
          ],
        },
      };
    }

    case "removePiece": {
      if (command.start === null && command.end === null) {
        throw new Error(
          "Removing the whole take would leave nothing to export.",
        );
      }
      if (command.start) indexOfAction(scene, command.start.actionId);
      if (command.end) indexOfAction(scene, command.end.actionId);
      return {
        ...scene,
        edits: {
          ...scene.edits,
          removed: [
            ...(scene.edits.removed ?? []),
            { id: newId(), start: command.start, end: command.end },
          ],
        },
      };
    }

    case "restorePiece": {
      const removed = scene.edits.removed ?? [];
      if (!removed.some((r) => r.id === command.id)) {
        throw new Error(`there is no removed piece "${command.id}" to restore`);
      }
      return {
        ...scene,
        edits: {
          ...scene.edits,
          removed: removed.filter((r) => r.id !== command.id),
        },
      };
    }

    case "setRemovedEdge": {
      const removed = scene.edits.removed ?? [];
      const range = removed.find((r) => r.id === command.id);
      if (range === undefined) {
        throw new Error(`there is no removed piece "${command.id}" to move`);
      }
      if (command.start) indexOfAction(scene, command.start.actionId);
      if (command.end) indexOfAction(scene, command.end.actionId);
      const next = {
        ...range,
        ...(command.start === undefined ? {} : { start: command.start }),
        ...(command.end === undefined ? {} : { end: command.end }),
      };
      if (next.start === null && next.end === null) {
        throw new Error(
          "Removing the whole take would leave nothing to export.",
        );
      }
      return {
        ...scene,
        edits: {
          ...scene.edits,
          removed: removed.map((r) => (r.id === command.id ? next : r)),
        },
      };
    }

    // The time between two steps. Supersedes `setHold`: a hold at offset 0
    // after an action was a longer gap by another name, and two controls for
    // "pause here" is one more than the author can be asked to distinguish.
    // One gap per action — a second is the first one moved.
    //
    // `scene.edits.gaps ?? []` throughout: the field is required on
    // `SceneDocument` and `SceneDocumentSchema.parse` always fills it, but
    // this reducer is also handed hand-built documents (tests, and any
    // caller that cast a stored row instead of parsing it), where Zod's
    // `.default([])` never ran.
    case "setGap": {
      const index = indexOfAction(scene, command.afterActionId);
      // `planScene` pairs each action with the NEXT one, so it emits no pace
      // for the final action and a gap there would never be read. Refused by
      // name rather than stored: an authored number the render silently
      // ignores is a failure the author cannot tell from a success.
      if (index === scene.actions.length - 1) {
        throw new Error(
          `there is no step after "${command.afterActionId}" — a gap is the time between two steps, so the last step cannot carry one`,
        );
      }
      const gaps = scene.edits.gaps ?? [];
      const existing = gaps.find(
        (g) => g.afterActionId === command.afterActionId,
      );
      const gap = {
        id: existing?.id ?? newId(),
        afterActionId: command.afterActionId,
        durationMs: command.durationMs,
      };
      return {
        ...scene,
        edits: {
          ...scene.edits,
          gaps: existing
            ? gaps.map((g) => (g.id === existing.id ? gap : g))
            : [...gaps, gap],
        },
      };
    }

    // Distinct from `setGap(…, 0)`: absence restores the RECORDED duration,
    // zero authors a zero-length pause. Precisely the distinction `clearHold`
    // drew, and for the same reason — except that here it is the schema's
    // `nonnegative` rather than `positive` that keeps both meanings
    // available. Clearing an action that carries no gap is not an error (the
    // inspector's field can be emptied twice), but it must not leave one
    // behind either, which is why this filters rather than requiring a hit.
    case "clearGap":
      return {
        ...scene,
        edits: {
          ...scene.edits,
          gaps: (scene.edits.gaps ?? []).filter(
            (g) => g.afterActionId !== command.afterActionId,
          ),
        },
      };
  }
}

/**
 * The one path from the editor to a stored scene, and it validates.
 *
 * Parsing on the way out rather than trusting the reducer is what makes
 * "there is no path from the editor to an invalid document" a property the
 * suite can assert instead of a convention the next command has to remember.
 */
export function applyCommand(
  scene: SceneDocument,
  command: EditCommand,
  newId: IdSource,
): SceneDocument {
  return SceneDocumentSchema.parse(reduce(scene, command, newId));
}
