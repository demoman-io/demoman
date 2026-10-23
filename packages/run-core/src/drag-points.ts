type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/** A point as a rect of no size, for what measures rects. */
export const pointRect = (p: Point): Rect => ({
  x: p.x,
  y: p.y,
  width: 0,
  height: 0,
});
