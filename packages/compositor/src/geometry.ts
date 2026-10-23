export interface Vec {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectCenter(r: Rect): Vec {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Grows a rect by `pad` on every side. Never produces negative dimensions. */
export function padRect(r: Rect, pad: number): Rect {
  const width = Math.max(0, r.width + pad * 2);
  const height = Math.max(0, r.height + pad * 2);
  return {
    x: r.x + (r.width - width) / 2,
    y: r.y + (r.height - height) / 2,
    width,
    height,
  };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec(a: Vec, b: Vec, t: number): Vec {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Largest rect with `inner`'s aspect that fits inside `outer`, centred. */
export function containRect(
  inner: { width: number; height: number },
  outer: Rect,
): Rect {
  const scale = Math.min(
    outer.width / inner.width,
    outer.height / inner.height,
  );
  const width = inner.width * scale;
  const height = inner.height * scale;
  return {
    x: outer.x + (outer.width - width) / 2,
    y: outer.y + (outer.height - height) / 2,
    width,
    height,
  };
}

export function distance(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
