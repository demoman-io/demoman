import { beforeAll, describe, expect, it } from "vitest";
import geistUrl from "../../../../apps/studio/pages/public/fonts/geist-variable.woff2?url";
import {
  type KeyCap,
  type KeyGlyph,
  planKeyMarks,
} from "../../src/plan/key-marks";
import { planScene } from "../../src/plan/plan";
import { type ResolvedPlan, resolvePlan } from "../../src/plan/resolve";
import { renderFrame } from "../../src/render/compose";
import { dialogFontLoaded, loadDialogFont } from "../../src/render/draw-dialog";
import {
  clickTagRect,
  drawClickTag,
  drawKeycapPill,
  drawRightClickMouse,
  keycapPillLayout,
  rightClickMouseRect,
} from "../../src/render/draw-keys";
import { KEY_GLYPHS } from "../../src/render/key-glyphs";
import { derivePresentation } from "../../src/render/presentation";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene } from "../fixtures/scene";

type Px = { r: number; g: number; b: number };
const luma = (p: Px) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
const near = (p: Px, q: Px, tol: number) =>
  Math.abs(p.r - q.r) <= tol &&
  Math.abs(p.g - q.g) <= tol &&
  Math.abs(p.b - q.b) <= tol;
const show = (p: Px) => `rgb(${p.r}, ${p.g}, ${p.b})`;
const WHITE = { r: 255, g: 255, b: 255 };
/** `#111c` over white: 17 · 0.8 + 255 · 0.2. */
const PILL_ON_WHITE = { r: 65, g: 65, b: 65 };
const INK = { r: 0x18, g: 0x18, b: 0x1b };
const BLUE = { r: 0x1a, g: 0x73, b: 0xe8 };
const TARGET = { width: 1280, height: 720 };

function white(width = TARGET.width, height = TARGET.height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  return ctx;
}

function at(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number): Px {
  const [r, g, b] = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return { r: r as number, g: g as number, b: b as number };
}

const notWhite = (p: Px) => !near(p, WHITE, 3);

beforeAll(async () => {
  const response = await fetch(geistUrl);
  expect(response.ok, `fetching ${geistUrl}: ${response.status}`).toBe(true);
  await loadDialogFont(await response.arrayBuffer());
});

describe("drawKeycapPill", () => {
  const CAPS: KeyCap[] = [
    { glyph: "command" },
    { glyph: "shift" },
    { text: "K" },
  ];

  it("premise: Geist is loaded", () => {
    expect(dialogFontLoaded()).toBe(true);
  });

  it("is #111c at the bottom centre, its bottom edge 58px above the output's", () => {
    const ctx = white();
    drawKeycapPill(ctx, CAPS, undefined, TARGET, 1);
    // The edges read off the picture, not the layout.
    let bottom = -1;
    for (let y = TARGET.height - 1; y >= 0; y--) {
      if (notWhite(at(ctx, TARGET.width / 2, y))) {
        bottom = y + 1;
        break;
      }
    }
    expect(bottom, "premise: the pill drew in the centre column").toBe(
      TARGET.height - 58,
    );
    const mid = bottom - 32;
    let left = -1;
    let right = -1;
    for (let x = 0; x < TARGET.width; x++) {
      if (notWhite(at(ctx, x, mid))) {
        if (left < 0) left = x;
        right = x + 1;
      }
    }
    expect(left, "premise: the pill drew on its middle row").toBeGreaterThan(0);
    expect(Math.abs((left + right) / 2 - TARGET.width / 2)).toBeLessThanOrEqual(
      1,
    );
    const inside = at(ctx, left + 10, mid);
    expect(
      near(inside, PILL_ON_WHITE, 12),
      `10px inside the left end: ${show(inside)}`,
    ).toBe(true);
  });

  it("puts white ink in each cap's centre", () => {
    const ctx = white();
    drawKeycapPill(ctx, CAPS, undefined, TARGET, 1);
    const layout = keycapPillLayout(ctx, CAPS, undefined, TARGET);
    expect(layout.caps, "premise: one rect per cap").toHaveLength(3);
    layout.caps.forEach((r, i) => {
      const data = ctx.getImageData(
        Math.round(r.x + r.width / 2 - 4),
        Math.round(r.y + r.height / 2 - 4),
        8,
        8,
      ).data;
      let brightest = 0;
      for (let j = 0; j < data.length; j += 4) {
        brightest = Math.max(
          brightest,
          luma({
            r: data[j] as number,
            g: data[j + 1] as number,
            b: data[j + 2] as number,
          }),
        );
      }
      expect(brightest, `cap ${i}'s centre, brightest luma`).toBeGreaterThan(
        200,
      );
    });
  });

  it("every glyph is its own shape", () => {
    const names = Object.keys(KEY_GLYPHS) as KeyGlyph[];
    expect(names, "premise: the eight glyphs").toHaveLength(8);
    const crops = names.map((glyph) => {
      const ctx = white();
      drawKeycapPill(ctx, [{ glyph }], undefined, TARGET, 1);
      const [r] = keycapPillLayout(ctx, [{ glyph }], undefined, TARGET).caps;
      if (r === undefined) throw new Error("premise: one cap");
      const data = ctx.getImageData(
        Math.round(r.x),
        Math.round(r.y),
        44,
        44,
      ).data;
      const ink: boolean[] = [];
      for (let j = 0; j < data.length; j += 4) {
        ink.push(
          luma({
            r: data[j] as number,
            g: data[j + 1] as number,
            b: data[j + 2] as number,
          }) > 160,
        );
      }
      const inked = ink.filter(Boolean).length / ink.length;
      expect(inked, `premise: ${glyph} has ink`).toBeGreaterThan(0.02);
      return ink;
    });
    for (let i = 0; i < crops.length; i++) {
      for (let j = i + 1; j < crops.length; j++) {
        const a = crops[i] as boolean[];
        const b = crops[j] as boolean[];
        const differ = a.filter((v, k) => v !== b[k]).length / a.length;
        expect(
          differ,
          `${names[i]} against ${names[j]}: fraction of pixels that differ`,
        ).toBeGreaterThan(0.05);
      }
    }
  });

  it("refuses to draw in a fallback face", () => {
    const fonts = document.fonts as unknown as Set<FontFace>;
    const geist: FontFace[] = [];
    fonts.forEach((face) => {
      if (face.family.replace(/"/g, "") === "Geist") geist.push(face);
    });
    expect(geist.length, "premise: Geist faces to take away").toBeGreaterThan(
      0,
    );
    for (const face of geist) fonts.delete(face);
    try {
      expect(() => drawKeycapPill(white(), CAPS, undefined, TARGET, 1)).toThrow(
        /the video's text needs the font Geist/,
      );
    } finally {
      for (const face of geist) fonts.add(face);
    }
    expect(dialogFontLoaded()).toBe(true);
  });
});

describe("the tag and the mouse", () => {
  const POINT = { x: 300, y: 200 };

  it("the tag reads dark #18181b beside the cursor point", () => {
    const ctx = white();
    drawClickTag(ctx, POINT, 2, 1, 1);
    const r = clickTagRect(ctx, POINT, 2, 1);
    // Inside its left padding, clear of the text.
    const p = at(ctx, r.x + 4, r.y + r.height / 2);
    expect(near(p, INK, 12), `tag at ${show(p)}`).toBe(true);
    // Beside the point, not on it.
    expect(r.x).toBeGreaterThan(POINT.x);
    expect(r.y).toBeGreaterThan(POINT.y);
  });

  it("the mouse's upper right is lit and its upper left is white", () => {
    const ctx = white();
    drawRightClickMouse(ctx, POINT, 1, 1);
    const o = rightClickMouseRect(POINT, 1);
    const y = o.y + o.height * 0.2;
    const right = at(ctx, o.x + o.width * 0.75, y);
    const left = at(ctx, o.x + o.width * 0.25, y);
    expect(near(right, BLUE, 12), `upper right at ${show(right)}`).toBe(true);
    expect(near(left, WHITE, 12), `upper left at ${show(left)}`).toBe(true);
  });
});

describe("renderFrame's key marks", () => {
  const target = LANDSCAPE_1080P;
  const caps: KeyCap[] = [{ glyph: "command" }, { text: "K" }];

  async function frame(
    resolved: ResolvedPlan,
    outputTimeMs: number,
  ): Promise<Uint8ClampedArray> {
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    await renderFrame({
      resolved,
      target,
      presentation: derivePresentation(
        readonlyScene().branding,
        target,
        resolved.plan.viewport,
      ),
      frames: createProceduralFrameSource(proceduralBundle()),
      ctx,
      outputTimeMs,
    });
    return ctx.getImageData(0, 0, target.width, target.height).data;
  }

  /** Pixels that differ, inside the pill's rect and outside it. */
  function differ(a: Uint8ClampedArray, b: Uint8ClampedArray) {
    const ctx = new OffscreenCanvas(1, 1).getContext(
      "2d",
    ) as OffscreenCanvasRenderingContext2D;
    const { pill } = keycapPillLayout(ctx, caps, undefined, target);
    let inside = 0;
    let outside = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2])
        continue;
      const x = (i / 4) % target.width;
      const y = Math.floor(i / 4 / target.width);
      const inPill =
        x >= pill.x - 1 &&
        x <= pill.x + pill.width + 1 &&
        y >= pill.y - 1 &&
        y <= pill.y + pill.height + 1;
      if (inPill) inside++;
      else outside++;
    }
    return { inside, outside };
  }

  it("with the cursor hidden: the pill is drawn, and the tag and mouse are not", async () => {
    const scene = readonlyScene();
    const base = resolvePlan(planScene(scene), proceduralBundle(), scene);
    const click = base.clickOutputMs[0];
    if (click === undefined) throw new Error("premise: the fixture clicks");
    const marked = (r: ResolvedPlan): ResolvedPlan => ({
      ...r,
      keycaps: [{ range: { startMs: click - 150, endMs: click + 1100 }, caps }],
      clickTags: [{ outputMs: click, count: 2 }],
      rightClicks: [click],
    });
    const t = click + 200;

    // Positive control: with the pointer drawn, each of the tag and the
    // mouse, drawn alone, puts ink outside the pill.
    const shown = differ(await frame(marked(base), t), await frame(base, t));
    expect(shown.inside, "premise: the pill drew").toBeGreaterThan(0);
    const tagOnly = { ...base, clickTags: marked(base).clickTags };
    const mouseOnly = { ...base, rightClicks: marked(base).rightClicks };
    // Premise: the click already presses the pointer, so the right-click
    // changes nothing but the mouse mark.
    expect(base.pulseOutputMs).toContain(click);
    expect(
      differ(await frame(tagOnly, t), await frame(base, t)).outside,
      "premise: the tag drew",
    ).toBeGreaterThan(0);
    expect(
      differ(await frame(mouseOnly, t), await frame(base, t)).outside,
      "premise: the mouse drew",
    ).toBeGreaterThan(0);

    const hidden = {
      ...base,
      cursorLook: { ...base.cursorLook, hidden: true },
    };
    const off = differ(await frame(marked(hidden), t), await frame(hidden, t));
    expect(off.inside, "the pill, with the cursor hidden").toBeGreaterThan(0);
    expect(off.outside, "ink outside the pill, with the cursor hidden").toBe(0);
  });

  it("rapid presses hand the pill over at full opacity, with no blink", async () => {
    const scene = readonlyScene();
    const base = resolvePlan(planScene(scene), proceduralBundle(), scene);
    const t0 = base.clickOutputMs[0];
    if (t0 === undefined) throw new Error("premise: the fixture clicks");
    // Three ⏎ presses 300 ms apart: each pill is cut short by the next.
    const presses = ["a", "b", "c"].map((id) => ({
      id,
      anchorId: null,
      timestamp: 1,
      marker: "press:none",
      kind: "press" as const,
      key: "Enter",
      modifiers: [],
    }));
    const { keycaps } = planKeyMarks(
      presses as never,
      presses.map((p, i) => ({ actionId: p.id, outputMs: t0 + 300 * i })),
      new Set(["click", "type", "drag", "press"]),
    );
    const marked = { ...base, keycaps };
    const [first, second, third] = keycaps.map((p) => p.range);
    if (!first || !second || !third) throw new Error("premise: three pills");
    expect(first.endMs, "premise: the first pill hands over").toBe(
      second.startMs,
    );
    expect(
      third.endMs,
      "premise: the take runs past the last pill",
    ).toBeLessThan(base.timeline.outputDurationMs);

    // A point in the pill's left padding, clear of the cap; every pill here
    // has one ⏎ cap, so every one is laid out alike.
    const layoutCtx = new OffscreenCanvas(1, 1).getContext(
      "2d",
    ) as OffscreenCanvasRenderingContext2D;
    const { pill } = keycapPillLayout(
      layoutCtx,
      [{ glyph: "return" }],
      undefined,
      target,
    );
    const x = Math.round(pill.x + 4);
    const y = Math.round(pill.y + pill.height / 2);
    const px = (d: Uint8ClampedArray): Px => {
      const i = (y * target.width + x) * 4;
      return {
        r: d[i] as number,
        g: d[i + 1] as number,
        b: d[i + 2] as number,
      };
    };
    // At full opacity `#111c` reads at most 17 · 0.8 + 255 · 0.2 = 65.
    const FULL_MAX = 66;
    const read = async (ms: number) => ({
      ms,
      under: px(await frame(base, ms)),
      drawn: px(await frame(marked, ms)),
    });
    const said = (r: Awaited<ReturnType<typeof read>>) =>
      `at ${r.ms} ms: under ${show(r.under)}, drawn ${show(r.drawn)}`;

    for (const ms of [
      first.endMs - 1,
      second.startMs,
      second.endMs - 1,
      third.startMs,
    ]) {
      const r = await read(ms);
      // Premise: the page under the point is light, so a faded pill reads
      // lighter than a full one.
      expect(luma(r.under), `premise, light page; ${said(r)}`).toBeGreaterThan(
        120,
      );
      expect(
        luma(r.drawn),
        `full pill at the handover; ${said(r)}`,
      ).toBeLessThanOrEqual(FULL_MAX);
    }
    // Positive control: the last pill still fades out at its own end, and
    // the first fades in at its start.
    for (const ms of [third.endMs - 1, first.startMs + 1]) {
      const r = await read(ms);
      expect(luma(r.under), `premise, light page; ${said(r)}`).toBeGreaterThan(
        120,
      );
      expect(luma(r.drawn), `a fading pill; ${said(r)}`).toBeGreaterThan(100);
    }
  });
});
