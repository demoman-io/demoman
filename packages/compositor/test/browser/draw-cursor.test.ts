import { describe, expect, it } from "vitest";
import {
  CURSOR_UPRIGHT,
  cursorTrailStamps,
  drawClickPulse,
  drawCursor,
  drawCursorTrail,
  PULSE_DURATION_MS,
} from "../../src/render/draw-cursor";

function canvas() {
  const c = new OffscreenCanvas(400, 400);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, 400, 400);
  return ctx;
}

function at(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number) {
  const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
  return { r: r as number, g: g as number, b: b as number, a: a as number };
}

function differsFromGrey(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
) {
  const px = at(ctx, x, y);
  return (
    Math.abs(px.r - 128) > 6 ||
    Math.abs(px.g - 128) > 6 ||
    Math.abs(px.b - 128) > 6
  );
}

describe("drawCursor", () => {
  it("draws at its hotspot, not centred on it", () => {
    const ctx = canvas();
    drawCursor(ctx, { x: 200, y: 200 }, 1, CURSOR_UPRIGHT);
    // The arrow's tip is the hotspot: pixels go down-right, not up-left.
    expect(differsFromGrey(ctx, 202, 204)).toBe(true);
    expect(differsFromGrey(ctx, 190, 190)).toBe(false);
  });

  it("has a light fill and a dark outline, so it survives any background", () => {
    const ctx = canvas();
    drawCursor(ctx, { x: 200, y: 200 }, 1, CURSOR_UPRIGHT);
    let sawLight = false;
    let sawDark = false;
    for (let y = 200; y < 232; y++) {
      for (let x = 200; x < 232; x++) {
        const px = at(ctx, x, y);
        if (px.r > 230 && px.g > 230 && px.b > 230) sawLight = true;
        if (px.r < 60 && px.g < 60 && px.b < 60) sawDark = true;
      }
    }
    expect(sawLight).toBe(true);
    expect(sawDark).toBe(true);
  });

  it("shrinks slightly while pressed", () => {
    const idle = canvas();
    drawCursor(idle, { x: 100, y: 100 }, 1, CURSOR_UPRIGHT);
    const pressed = canvas();
    drawCursor(pressed, { x: 100, y: 100 }, 1, { press: 0.86, angleRad: 0 });
    const count = (ctx: OffscreenCanvasRenderingContext2D) => {
      let n = 0;
      for (let y = 90; y < 160; y++) {
        for (let x = 90; x < 160; x++) if (differsFromGrey(ctx, x, y)) n++;
      }
      return n;
    };
    expect(count(pressed)).toBeLessThan(count(idle));
  });

  it("scales with the output resolution factor", () => {
    const small = canvas();
    drawCursor(small, { x: 100, y: 100 }, 1, CURSOR_UPRIGHT);
    const large = canvas();
    drawCursor(large, { x: 100, y: 100 }, 2, CURSOR_UPRIGHT);
    const count = (ctx: OffscreenCanvasRenderingContext2D) => {
      let n = 0;
      for (let y = 90; y < 200; y++) {
        for (let x = 90; x < 200; x++) if (differsFromGrey(ctx, x, y)) n++;
      }
      return n;
    };
    expect(count(large)).toBeGreaterThan(count(small) * 2);
  });

  it("draws `dark` as a dark fill inside a light outline", () => {
    const ctx = canvas();
    drawCursor(ctx, { x: 200, y: 200 }, 1, CURSOR_UPRIGHT, "dark");
    let sawLight = false;
    let sawDark = false;
    for (let y = 200; y < 232; y++) {
      for (let x = 200; x < 232; x++) {
        const px = at(ctx, x, y);
        if (px.r > 230 && px.g > 230 && px.b > 230) sawLight = true;
        if (px.r < 60 && px.g < 60 && px.b < 60) sawDark = true;
      }
    }
    // Both present, as the light style — the contrast pair is the point of
    // either. What differs is which one is the body.
    expect(sawLight).toBe(true);
    expect(sawDark).toBe(true);
    // The body: a pixel well inside the arrow is dark here and light there.
    const body = at(ctx, 203, 210);
    expect(body.r).toBeLessThan(100);
  });

  it("draws `touch` centred on the position, not down-and-right of it", () => {
    const ctx = canvas();
    drawCursor(ctx, { x: 200, y: 200 }, 1, CURSOR_UPRIGHT, "touch");
    // A finger covers the point it taps. Ink on every side of it.
    expect(differsFromGrey(ctx, 200, 186)).toBe(true);
    expect(differsFromGrey(ctx, 200, 214)).toBe(true);
    expect(differsFromGrey(ctx, 186, 200)).toBe(true);
    expect(differsFromGrey(ctx, 214, 200)).toBe(true);
    // And clear of where the arrow's tail would be.
    expect(differsFromGrey(ctx, 200, 236)).toBe(false);
  });

  it("leans about its tip: the tail swings left for a clockwise lean", () => {
    // Where the arrow's own ink sits, as a centroid relative to the tip.
    const inkCentroid = (ctx: OffscreenCanvasRenderingContext2D) => {
      let n = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 120; y < 300; y++) {
        for (let x = 120; x < 300; x++) {
          if (differsFromGrey(ctx, x, y)) {
            n++;
            sx += x - 200;
            sy += y - 200;
          }
        }
      }
      return { n, x: sx / n, y: sy / n };
    };
    const angle = (15 * Math.PI) / 180;
    const upright = canvas();
    drawCursor(upright, { x: 200, y: 200 }, 2, CURSOR_UPRIGHT);
    const leaning = canvas();
    drawCursor(leaning, { x: 200, y: 200 }, 2, { press: 1, angleRad: angle });
    const a = inkCentroid(upright);
    const b = inkCentroid(leaning);
    // The premise: an 80px arrow painted ink, and it hangs down-right of
    // its tip — the shape the derivation below assumes.
    expect(a.n).toBeGreaterThan(800);
    expect(a.x).toBeGreaterThan(5);
    expect(a.y).toBeGreaterThan(20);
    // Derived, not guessed: a clockwise turn by θ about the tip (y down)
    // takes (x, y) to (x·cosθ − y·sinθ, x·sinθ + y·cosθ). The ink is a rigid
    // copy of the upright ink, so its centroid is the upright centroid
    // turned the same way — mostly LEFT, since the tail hangs below the tip
    // and sin θ pulls it toward −x. The drop shadow sits 1.5px below the
    // shape whichever way it leans, so the match is to about a pixel.
    const expected = {
      x: a.x * Math.cos(angle) - a.y * Math.sin(angle),
      y: a.x * Math.sin(angle) + a.y * Math.cos(angle),
    };
    expect(
      b.x - a.x,
      `upright ${JSON.stringify(a)}, leaning ${JSON.stringify(b)}`,
    ).toBeLessThan(-5);
    expect(b.x).toBeCloseTo(expected.x, 0);
    expect(Math.abs(b.y - expected.y)).toBeLessThan(1.5);
    // Still pointing at the same pixel: the tip did not move.
    expect(differsFromGrey(leaning, 201, 203)).toBe(true);
  });

  it("does not turn the touch circle", () => {
    // A turned circle is the same circle, so what this catches is narrow:
    // the path's start point and its antialiasing move with the turn, and
    // byte equality sees that (measured red with the touch guard removed,
    // 2026-10-09). The guard is there for exactly this — the lean is
    // meaningless on a contact point, so it should cost it nothing at all.
    const upright = canvas();
    drawCursor(upright, { x: 200, y: 200 }, 1, CURSOR_UPRIGHT, "touch");
    const leaning = canvas();
    drawCursor(
      leaning,
      { x: 200, y: 200 },
      1,
      { press: 1, angleRad: 0.3 },
      "touch",
    );
    const a = upright.getImageData(0, 0, 400, 400).data;
    const b = leaning.getImageData(0, 0, 400, 400).data;
    let differ = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
    expect(differ).toBe(0);
    // ...and it did paint, so "identical" is not two blank canvases.
    expect(differsFromGrey(upright, 200, 186)).toBe(true);
  });

  it("grows with its scale", () => {
    const small = canvas();
    drawCursor(small, { x: 200, y: 200 }, 1, CURSOR_UPRIGHT);
    const big = canvas();
    drawCursor(big, { x: 200, y: 200 }, 2, CURSOR_UPRIGHT);
    // A point beyond the arrow's reach at 1x that the 2x arrow covers.
    expect(differsFromGrey(small, 205, 250)).toBe(false);
    expect(differsFromGrey(big, 205, 250)).toBe(true);
  });
});

const BACKGROUNDS: Array<[string, [number, number, number]]> = [
  // The three surfaces a click actually lands on, taken from the fixture app:
  // its primary button, a table row, and the dark detail panel. The button's
  // #3b5bdb is the colour the pulse used to be drawn in.
  ["the primary button", [59, 91, 219]],
  ["a light table row", [250, 251, 252]],
  ["the dark panel", [31, 41, 55]],
  ["mid grey", [128, 128, 128]],
];

function over(bg: [number, number, number]) {
  const c = new OffscreenCanvas(400, 400);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
  ctx.fillRect(0, 0, 400, 400);
  return ctx;
}

const relativeLuminance = (c: [number, number, number]) => {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2])
  );
};

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/**
 * Scans the ray running right from the pulse centre and reports the most
 * contrasting pixel on it, how far the drawing reaches, and whether the
 * centre itself was touched.
 */
function probe(bg: [number, number, number], t: number, scale = 1) {
  const ctx = over(bg);
  drawClickPulse(ctx, { x: 200, y: 200 }, scale, t);
  const row = ctx.getImageData(200, 200, 200, 1).data;
  let ratio = 1;
  let levels = 0;
  let reach = 0;
  for (let i = 0; i < 200; i++) {
    const px: [number, number, number] = [
      row[i * 4] as number,
      row[i * 4 + 1] as number,
      row[i * 4 + 2] as number,
    ];
    const delta = Math.max(
      Math.abs(px[0] - bg[0]),
      Math.abs(px[1] - bg[1]),
      Math.abs(px[2] - bg[2]),
    );
    if (delta > 0) reach = i;
    if (delta > levels) levels = delta;
    ratio = Math.max(ratio, contrast(px, bg));
  }
  const centre = [row[0], row[1], row[2]] as [number, number, number];
  return { ratio, levels, reach, centre };
}

describe("drawClickPulse", () => {
  it("draws nothing before the click and nothing after it has finished", () => {
    const before = canvas();
    drawClickPulse(before, { x: 200, y: 200 }, 1, -0.1);
    expect(differsFromGrey(before, 200, 200)).toBe(false);

    const after = canvas();
    drawClickPulse(after, { x: 200, y: 200 }, 1, 1.2);
    expect(differsFromGrey(after, 200, 200)).toBe(false);
  });

  const radiusAt = (t: number) => {
    const ctx = canvas();
    drawClickPulse(ctx, { x: 200, y: 200 }, 1, t);
    let furthest = 0;
    for (let x = 200; x < 320; x++) {
      if (differsFromGrey(ctx, x, 200)) furthest = x - 200;
    }
    return furthest;
  };

  it("expands over its life", () => {
    expect(radiusAt(0.7)).toBeGreaterThan(radiusAt(0.1));
  });

  it("carries its own contrast, so it reads on whatever it lands on", () => {
    // The defect this guards is the one that shipped: the ring was filled and
    // stroked in a hardcoded rgba(59, 91, 219, ...) — #3b5bdb — which is
    // byte-identical to the fixture app's primary button. Source-over with
    // the destination's own RGB cannot change a pixel at any alpha, so on
    // that button the pulse was not faint, it was provably absent (measured:
    // a peak difference of 1 of 255 levels, from antialiasing rounding).
    // Any single tinted colour just moves the collision to another app, so
    // this asserts contrast against every kind of surface a click lands on.
    for (const [name, bg] of BACKGROUNDS) {
      for (const t of [0.1, 0.25, 0.5]) {
        const { ratio } = probe(bg, t);
        expect(
          ratio,
          `pulse has no contrast over ${name} at t=${t}`,
        ).toBeGreaterThan(2);
      }
    }
  });

  it("stays visible across its whole stated life, on every background", () => {
    // The second regression here: alpha used to fade on the same ease-out
    // cubic the radius expands on, which put it at 0.35 * (1 - t)^3 — below
    // one 8-bit level well before t reached 1. The last ~180ms of a 400ms
    // pulse drew nothing, so the ring read as shorter and weaker than
    // PULSE_DURATION_MS says it is. Re-measured with the current two-tone
    // ring, a cubic fade is still dead by t = 0.75 (3 levels of 255), so the
    // linear fade is load-bearing rather than a leftover.
    for (const [name, bg] of BACKGROUNDS) {
      for (const t of [0.25, 0.5, 0.75, 0.9]) {
        const { levels } = probe(bg, t);
        expect(
          levels,
          `pulse invisible over ${name} at t=${t}`,
        ).toBeGreaterThan(8);
      }
    }
  });

  it("expands past a normal-sized control instead of dying inside it", () => {
    // A 4K landscape draws the cursor layer at uiScale = 2160/1080 and the
    // page at ~2.99 output px per CSS px, so a control 44 CSS px tall reaches
    // 22 CSS px from a centred click. The ring has to clear that to be seen
    // against anything but the thing it was aimed at; the old one topped out
    // at 18 CSS px and never did.
    const outputPxPerCssPx = 2.99;
    const cssReach = (t: number) =>
      probe([128, 128, 128], t, 2).reach / outputPxPerCssPx;
    expect(cssReach(0.25)).toBeGreaterThan(22);
    // Not t = 1 exactly: the ring has faded to nothing by then, by design.
    expect(cssReach(0.99)).toBeGreaterThan(30);
  });

  it("is stroke-only, so it never veils the control it just clicked", () => {
    // A filled disc at the alpha this ring needs would be a flashbulb over
    // the button, and it would hide the state change the click caused.
    for (const [name, bg] of BACKGROUNDS) {
      for (const t of [0.05, 0.3, 0.6]) {
        const { centre } = probe(bg, t);
        expect(
          centre,
          `pulse filled its centre over ${name} at t=${t}`,
        ).toEqual(bg);
      }
    }
  });

  it("fades to nothing by the end of its life", () => {
    const peak = (t: number) => probe([128, 128, 128], t).ratio;
    expect(peak(0.9)).toBeLessThan(peak(0.15));
    expect(probe([128, 128, 128], 1).levels).toBe(0);
  });

  it("exposes its duration so the composer can window it", () => {
    expect(PULSE_DURATION_MS).toBe(400);
  });
});

describe("drawCursorTrail", () => {
  it("paints ink behind a moving cursor", () => {
    const ctx = canvas();
    // Four ghosts trailing back up-left from where the cursor now is.
    drawCursorTrail(
      ctx,
      [
        { x: 140, y: 160 },
        { x: 155, y: 170 },
        { x: 170, y: 180 },
        { x: 185, y: 190 },
      ],
      1,
      "light",
    );
    drawCursor(ctx, { x: 200, y: 200 }, 1, CURSOR_UPRIGHT);
    // Behind the cursor, where nothing would be drawn without a trail.
    //
    // The first probe was (143, 165) — the oldest ghost's own tip region —
    // but that ghost's alpha (t=0.2, so 0.2^2 * TRAIL_PEAK_ALPHA = 0.022)
    // is genuinely too faint there to clear differsFromGrey's >6 threshold:
    // measured r=130, a diff of 2. That is not a stray pixel off the drawn
    // shape (ray-casting confirms (143,165) is inside the oldest ghost's
    // fill), it is the whole fill at that uniform low alpha. (158, 178)
    // sits inside the second-oldest ghost (155,170) instead, where alpha is
    // still faint (t=0.4, 0.088) but measured r=138, a diff of 10 with
    // margin. It keeps both claims this test makes — ink exists behind the
    // cursor where nothing would be drawn without a trail — without
    // depending on the single faintest ghost being individually detectable
    // at this threshold, which by design it barely is.
    expect(differsFromGrey(ctx, 158, 178)).toBe(true);
    expect(differsFromGrey(ctx, 173, 185)).toBe(true);
  });

  it("paints nothing for an empty trail, so a still cursor gets no halo", () => {
    const ctx = canvas();
    drawCursorTrail(ctx, [], 1, "light");
    drawCursor(ctx, { x: 200, y: 200 }, 1, CURSOR_UPRIGHT);
    expect(differsFromGrey(ctx, 158, 178)).toBe(false);
    expect(differsFromGrey(ctx, 173, 185)).toBe(false);
  });

  // Each ghost is the pointer at an earlier instant, so it carries that
  // instant's lean rather than the frame's (`cursorTrailGhosts`). One ghost
  // per canvas — the middle alpha of a one-ghost trail, bright enough to
  // measure — leaning clockwise against one standing upright. Red on a
  // `drawCursorTrail` that stamps every ghost with one shared angle.
  it("leans each ghost by its own angle", () => {
    const ghostCentroid = (angleRad: number) => {
      const ctx = canvas();
      drawCursorTrail(ctx, [{ x: 200, y: 200, angleRad }], 2, "light");
      let n = 0;
      let sx = 0;
      for (let y = 120; y < 300; y++) {
        for (let x = 120; x < 300; x++) {
          if (differsFromGrey(ctx, x, y)) {
            n++;
            sx += x - 200;
          }
        }
      }
      return { n, x: sx / n };
    };
    const upright = ghostCentroid(0);
    const leaning = ghostCentroid((15 * Math.PI) / 180);
    // The premise: the ghost painted enough ink to have a centroid.
    expect(upright.n).toBeGreaterThan(400);
    expect(leaning.n).toBeGreaterThan(400);
    // A clockwise lean swings the tail left (see "leans about its tip").
    expect(
      leaning.x - upright.x,
      `upright ${JSON.stringify(upright)}, leaning ${JSON.stringify(leaning)}`,
    ).toBeLessThan(-5);
  });

  it("fades backwards: the oldest ghost is fainter than the newest", () => {
    const ctx = canvas();
    // Two ghosts far apart, so neither samples the other's ink.
    drawCursorTrail(
      ctx,
      [
        { x: 100, y: 100 },
        { x: 250, y: 100 },
      ],
      1,
      "light",
    );
    const oldest = at(ctx, 103, 110);
    const newest = at(ctx, 253, 110);
    // Both lighter than the grey they sit on, and the newer one more so.
    expect(newest.r).toBeGreaterThan(oldest.r);
    expect(oldest.r).toBeGreaterThan(128);
  });
});

describe("cursorTrailStamps", () => {
  it("asks for no ghosts at all when blur is off", () => {
    expect(cursorTrailStamps(0)).toBe(0);
  });

  it("asks for more ghosts as the slider rises", () => {
    expect(cursorTrailStamps(1)).toBeGreaterThan(cursorTrailStamps(0.5));
    expect(cursorTrailStamps(0.5)).toBeGreaterThan(0);
  });
});
