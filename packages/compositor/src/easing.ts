import { lerpVec, type Vec } from "./geometry.js";

export type EasingName =
  | "linear"
  | "easeInOutCubic"
  | "easeOutCubic"
  | "easeInOutSine"
  | "easeOutBackDamped"
  | "minimumJerk";

export const easings: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  // Damped overshoot: enough to feel alive, never enough to bounce.
  easeOutBackDamped: (t) => {
    const c1 = 0.35;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  // Flash & Hogan's minimum-jerk reach (smootherstep): neither speed nor
  // acceleration at either end, so a move gathers itself and settles rather
  // than starting or stopping with a kick. The cursor's shape since
  // 2026-10-09; the author asked for a ramp-up and a settle at the same
  // overall speed. The camera took it too for a day, and moved to
  // `springEase` below the same day (polish-parity plan §1). Its speed is one smooth
  // bell peaking at 1.875x the average; easeInOutCubic's is two parabolas
  // meeting in a 3x spike, with the acceleration flipping sign in a single
  // instant at the midpoint — a lurch through the middle of every move.
  minimumJerk: (t) => t * t * t * (t * (6 * t - 15) + 10),
};

/**
 * Centripetal-style Catmull-Rom through every control point, parameterised
 * uniformly over the whole path. Passes through its controls by construction,
 * which is what makes a cursor land exactly on its anchor.
 */
export function catmullRom(points: Vec[], t: number): Vec {
  if (points.length === 0)
    throw new Error("catmullRom needs at least one point");
  const first = points[0] as Vec;
  if (points.length === 1) return { ...first };
  const last = points[points.length - 1] as Vec;
  if (t <= 0) return { ...first };
  if (t >= 1) return { ...last };
  if (points.length === 2) return lerpVec(first, last, t);

  const spans = points.length - 1;
  const scaled = t * spans;
  const i = Math.min(spans - 1, Math.floor(scaled));
  const local = scaled - i;

  const p0 = points[Math.max(0, i - 1)] as Vec;
  const p1 = points[i] as Vec;
  const p2 = points[i + 1] as Vec;
  const p3 = points[Math.min(points.length - 1, i + 2)] as Vec;

  const axis = (a: number, b: number, c: number, d: number): number => {
    const t2 = local * local;
    const t3 = t2 * local;
    return (
      0.5 *
      (2 * b +
        (-a + c) * local +
        (2 * a - 5 * b + 4 * c - d) * t2 +
        (-a + 3 * b - 3 * c + d) * t3)
    );
  };

  return {
    x: axis(p0.x, p1.x, p2.x, p3.x),
    y: axis(p0.y, p1.y, p2.y, p3.y),
  };
}

/**
 * The camera's curve: the step response of a critically damped spring,
 * corrected to land exactly on 1 with exactly zero velocity, in closed form.
 *
 *     g(t)  = 1 − (1 + a·t)·e^(−a·t)
 *     g'(t) = a²·t·e^(−a·t)
 *     f(t)  = (g(t) − g'(1)·t²·(t − 1)) / g(1)
 *
 * `g` alone starts at rest and is mostly there early — the shape a spring
 * camera has — but at t = 1 it is still short of 1 and still moving. The
 * cubic `t²·(t − 1)` is zero, with zero slope, at t = 0, and is zero with
 * slope 1 at t = 1, so subtracting `g'(1)` of it cancels the residual
 * velocity without touching the start; dividing by `g(1)` lands it. So
 * f(0) = 0, f(1) = 1, f'(0) = f'(1) = 0, and it is monotone on [0, 1] for
 * any `a` above 1 (the plan's range is 5.5..8).
 *
 * Why a closed form and not a stepped spring: every frame of a take is a
 * pure function of output time — preview, export, the film check and the
 * mask overlay must agree frame for frame, and a scrubbed frame must equal
 * the exported one. A spring integrated frame by frame carries state from
 * the frame before; this carries none.
 *
 * `a` is the stiffness: larger is a faster departure and a shorter tail. At
 * 6.75 (the default smoothness) f(0.5) ≈ 0.865 where `minimumJerk` gives
 * 0.5 — most of the move is made early and the rest is a long, soft landing.
 *
 * `t` is clamped to [0, 1]. A stiffness that is not a positive finite
 * number throws rather than returning NaN: a NaN camera paints a garbage
 * frame that nothing downstream would report.
 */
export function springEase(t: number, a: number): number {
  if (!(Number.isFinite(a) && a > 0)) {
    throw new RangeError(`springEase needs a positive stiffness, got ${a}`);
  }
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (x === 0) return 0;
  if (x === 1) return 1;
  const g = (u: number) => 1 - (1 + a * u) * Math.exp(-a * u);
  const slopeAtEnd = a * a * Math.exp(-a);
  return (g(x) - slopeAtEnd * x * x * (x - 1)) / g(1);
}
