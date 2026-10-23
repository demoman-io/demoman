import type { SceneDocument } from "./document.js";

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type DragAction = Extract<SceneDocument["actions"][number], { kind: "drag" }>;

/** A spot in `rect` as fractions of its box; its centre when absent, the
 *  point a click uses. */
export function spotIn(rect: Rect, at: Point | undefined): Point {
  if (at === undefined) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  return { x: rect.x + at.x * rect.width, y: rect.y + at.y * rect.height };
}

/** Where a drag lets go: an offset from its start, or a spot in its end's
 *  box. Null when the end names a box nobody measured. */
export function dragEndPoint(
  start: Point,
  to: DragAction["to"],
  toRect: Rect | null | undefined,
): Point | null {
  if ("by" in to) return { x: start.x + to.by.x, y: start.y + to.by.y };
  return toRect == null ? null : spotIn(toRect, to.at);
}

/**
 * Where a take's drag pressed and where it let go: the spot the walk chose
 * itself (`pressedAt`, a range's thumb), else the script's (`fromAt`), else
 * the box's centre. Null when an end cannot be placed.
 *
 * One rule for the walk, the film check, auto zoom and the camera: three
 * copies of it had drifted apart (review of 2026-10-21), and a slider's drag
 * was framed from its centre while the walk pressed its thumb.
 */
export function dragPoints(
  action: Pick<DragAction, "fromAt" | "pressedAt" | "to">,
  rect: Rect | undefined,
  toRect: Rect | undefined,
): { start: Point; end: Point } | null {
  if (rect === undefined) return null;
  const start = spotIn(rect, action.pressedAt ?? action.fromAt);
  const end = dragEndPoint(start, action.to, toRect);
  return end === null ? null : { start, end };
}
