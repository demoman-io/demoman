// Draws the built-in wallpapers from recipes.json, in colours drawn from
// palette.json's measured family ranges, and writes them as WebP into
// apps/studio/pages/public/wallpapers/. See README.md.
//
//   node apps/studio/scripts/wallpapers/generate.mjs [--only vivid-1,dark-2]
//        [--quality 0.97] [--sheet contact-sheet.png] [--preview <dir>]
//
// --preview draws every shape at a 1600px long side into <dir> instead of
// writing the shipped files. Each recipe colour is { h, s, l }: h in degrees
// and inside one of its family's measured hue ranges, s and l positions
// (0 to 1) inside its family's saturation and lightness ranges.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const here = import.meta.dirname;
const { values } = parseArgs({
  options: {
    only: { type: "string" },
    quality: { type: "string", default: "0.97" },
    sheet: { type: "string" },
    preview: { type: "string" },
  },
});
const LONG = 9600; // 3840 × 2.5, README.md
const SHAPES = {
  landscape: [LONG, (LONG * 3) / 4],
  portrait: [(LONG * 3) / 4, LONG],
  thumb: [320, 240],
};
const palette = JSON.parse(readFileSync(join(here, "palette.json"), "utf8"));
const recipes = JSON.parse(readFileSync(join(here, "recipes.json"), "utf8"));
const only = values.only?.split(",");
const out = values.preview ?? join(here, "../../pages/public/wallpapers");
mkdirSync(out, { recursive: true });

/** A recipe colour to an HSL triple inside its family's measured ranges. */
function resolveColour(fam, c, where) {
  const inHue = fam.hue.some(([a, b]) =>
    a <= b ? c.h >= a && c.h <= b : c.h >= a || c.h <= b,
  );
  if (!inHue)
    throw new Error(
      `${where}: hue ${c.h} is outside the family's measured ranges ${JSON.stringify(fam.hue)}`,
    );
  const at = ([lo, hi], t) => lo + (hi - lo) * t;
  return [c.h, at(fam.saturation, c.s), at(fam.lightness, c.l)];
}
function resolveRecipe(r) {
  const fam = palette.families[r.family];
  if (!fam) throw new Error(`${r.id}: no measured family ${r.family}`);
  const walk = (v, where) =>
    Array.isArray(v)
      ? v.map((x, i) => walk(x, `${where}[${i}]`))
      : v && typeof v === "object"
        ? "h" in v
          ? resolveColour(fam, v, where)
          : Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, walk(x, `${where}.${k}`)]),
            )
        : v;
  return walk(r, r.id);
}

/** Runs in the page: paints one composition and answers WebP bytes as
 *  base64, and for the thumb two representative colours. */
async function paint({ recipe, shape, w, h, quality }) {
  let seed = recipe.seed + (shape === "portrait" ? 7919 : 0);
  const rand = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const hsl = ([hh, s, l], a = 1) =>
    `hsla(${hh}, ${(s * 100).toFixed(2)}%, ${(l * 100).toFixed(2)}%, ${a})`;
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d");
  const L = Math.hypot(w, h);
  // Composition coordinates: u along the long side, v along the short one,
  // so a portrait lays the same recipe out for its own shape.
  const long = w >= h;
  const at = ([u, v]) => (long ? [u * w, v * h] : [v * w, u * h]);

  g.fillStyle = hsl(recipe.base);
  g.fillRect(0, 0, w, h);

  // Soft field: near-Gaussian radial blobs.
  for (const b of recipe.blobs) {
    const [x, y] = at(b.at);
    const r = b.r * L;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      grad.addColorStop(
        t,
        hsl(b.colour, (b.alpha ?? 1) * Math.exp(-4.6 * t * t) * (1 - t)),
      );
    }
    g.globalCompositeOperation = b.blend ?? "source-over";
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }
  g.globalCompositeOperation = "source-over";

  /** A smooth curve across the frame at `angle`, `offset` (-1 to 1) of the
   *  frame's half-extent along its normal, undulating by `amp`. A band's
   *  second edge passes `like`, the first's waves, so the two run together. */
  function curve(angle, offset, amp, like) {
    const a = (angle * Math.PI) / 180;
    const d = [Math.cos(a), Math.sin(a)];
    const n = [-d[1], d[0]];
    const e = Math.abs(n[0]) * (w / 2) + Math.abs(n[1]) * (h / 2);
    const wave = like
      ? { ...like.wave, p1: like.wave.p1 + 0.5, p2: like.wave.p2 - 0.7 }
      : {
          f1: 0.5 + rand() * 0.6,
          f2: 1.3 + rand() * 0.8,
          p1: rand() * 6.283,
          p2: rand() * 6.283,
        };
    const pts = [];
    for (let i = 0; i <= 32; i++) {
      const t = i / 32 - 0.5;
      const k =
        offset * e +
        amp *
          e *
          (0.8 * Math.sin(wave.f1 * t * 6.283 + wave.p1) +
            0.2 * Math.sin(wave.f2 * t * 6.283 + wave.p2));
      pts.push([
        w / 2 + d[0] * t * L * 1.3 + n[0] * k,
        h / 2 + d[1] * t * L * 1.3 + n[1] * k,
      ]);
    }
    return { pts, d, n, wave };
  }
  /** Catmull-Rom through `pts` as Béziers onto path `p`. */
  function spline(p, pts, move = true) {
    if (move) p.moveTo(...pts[0]);
    else p.lineTo(...pts[0]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      p.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6,
        p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6,
        p2[1] - (p3[1] - p1[1]) / 6,
        p2[0],
        p2[1],
      );
    }
    return p;
  }

  for (const layer of recipe.layers) {
    // The region, and the edges along which it folds.
    const region = new Path2D();
    const edges = [];
    let along;
    if (layer.kind === "disc") {
      const [x, y] = at(layer.at);
      const r = layer.r * L;
      region.arc(x, y, r, 0, Math.PI * 2);
      edges.push(region);
      const a = ((layer.angle ?? 0) * Math.PI) / 180;
      along = [
        x - Math.cos(a) * r,
        y - Math.sin(a) * r,
        x + Math.cos(a) * r,
        y + Math.sin(a) * r,
      ];
    } else {
      const one = curve(layer.angle, layer.offset, layer.amp);
      spline(region, one.pts);
      edges.push(spline(new Path2D(), one.pts));
      if (layer.kind === "band") {
        const two = curve(
          layer.angle,
          layer.offset + layer.width,
          layer.amp,
          one,
        );
        spline(region, [...two.pts].reverse(), false);
        edges.push(spline(new Path2D(), two.pts));
      } else {
        // Everything on the curve's normal side.
        const far = one.n.map((v) => v * L * 2);
        const [first, last] = [one.pts[0], one.pts.at(-1)];
        region.lineTo(last[0] + far[0], last[1] + far[1]);
        region.lineTo(first[0] + far[0], first[1] + far[1]);
      }
      region.closePath();
      along = [
        w / 2 - one.d[0] * L * 0.5,
        h / 2 - one.d[1] * L * 0.5,
        w / 2 + one.d[0] * L * 0.5,
        h / 2 + one.d[1] * L * 0.5,
      ];
    }

    const fill = g.createLinearGradient(...along);
    for (const [i, col] of layer.colours.entries())
      fill.addColorStop(i / (layer.colours.length - 1), hsl(col));
    // The shadow (or, on a dark field, the glow) it casts on what is below.
    g.save();
    g.shadowColor = layer.glow
      ? hsl(layer.glow, layer.glowAlpha ?? 0.6)
      : `rgba(0, 0, 0, ${layer.shadow ?? 0.3})`;
    g.shadowBlur = L * (layer.shadowBlur ?? 0.02);
    g.shadowOffsetY = L * 0.003;
    g.fillStyle = fill;
    g.fill(region);
    g.restore();

    // Fold shading inside the edge: a soft sheen, then the sheet curving away.
    g.save();
    g.clip(region);
    for (const edge of edges) {
      g.filter = `blur(${L * 0.05}px)`;
      g.strokeStyle = `rgba(0, 0, 0, ${layer.curl ?? 0.16})`;
      g.lineWidth = L * 0.22;
      g.stroke(edge);
      g.filter = `blur(${L * 0.012}px)`;
      g.strokeStyle = layer.sheen
        ? hsl(layer.sheen, layer.sheenAlpha ?? 0.35)
        : `rgba(255, 255, 255, ${layer.sheenAlpha ?? 0.14})`;
      g.lineWidth = L * 0.035;
      g.stroke(edge);
    }
    g.restore();
    // A crisp rim where the two fields meet, when the recipe asks for one.
    if (layer.rim) {
      g.save();
      g.strokeStyle = hsl(layer.rim, layer.rimAlpha ?? 0.7);
      g.lineWidth = Math.max(1, L * 0.0011);
      for (const edge of edges) g.stroke(edge);
      g.restore();
    }
  }

  // Triangular dither of ±1 level, so a slow gradient does not step in
  // 8-bit bands (below one level of amplitude, so it is not grain).
  const img = g.getImageData(0, 0, w, h);
  const px = img.data;
  let x = 0x9e3779b9 ^ recipe.seed;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
  for (let i = 0; i < px.length; i++) {
    if ((i & 3) === 3) continue;
    px[i] += Math.round(next() + next() - 1);
  }
  g.putImageData(img, 0, 0);

  const blob = await c.convertToBlob({ type: "image/webp", quality });
  if (blob.type !== "image/webp")
    throw new Error(`asked for image/webp, the encoder wrote ${blob.type}`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { b64: btoa(bin), swatch: shape === "thumb" ? swatchOf(px) : null };

  /** Two representative colours: 2-means over the pixels, the cluster that
   *  sits further left first, so a left-to-right gradient reads like it. */
  function swatchOf(d) {
    const pts = [];
    for (let i = 0; i < d.length; i += 4)
      pts.push([d[i], d[i + 1], d[i + 2], (i / 4) % w]);
    const dist = (p, q) =>
      (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
    const far = (from) =>
      pts.reduce((a, p) => (dist(p, from) > dist(a, from) ? p : a));
    let cs = [far(pts[0])];
    cs.push(far(cs[0]));
    let groups = [];
    for (let k = 0; k < 12; k++) {
      groups = [[], []];
      for (const p of pts)
        groups[dist(p, cs[0]) <= dist(p, cs[1]) ? 0 : 1].push(p);
      cs = groups.map((gr) =>
        [0, 1, 2, 3].map((j) => gr.reduce((a, p) => a + p[j], 0) / gr.length),
      );
    }
    const hex = (c) =>
      `#${c
        .slice(0, 3)
        .map((v) => Math.round(v).toString(16).padStart(2, "0"))
        .join("")}`;
    const [a, b] = cs[0][3] <= cs[1][3] ? cs : [cs[1], cs[0]];
    return { from: hex(a), to: hex(b) };
  }
}

const browser = await chromium.launch();
const sizes = {};
const swatches = {};
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });
  const quality = Number(values.quality);
  for (const raw of recipes) {
    if (only && !only.includes(raw.id)) continue;
    const recipe = resolveRecipe(raw);
    for (const [shape, [w0, h0]] of Object.entries(SHAPES)) {
      if (values.preview && shape === "thumb") continue;
      const k = values.preview ? 1600 / LONG : 1;
      const [w, h] = [Math.round(w0 * k), Math.round(h0 * k)];
      const t0 = Date.now();
      const { b64, swatch } = await page.evaluate(paint, {
        recipe,
        shape,
        w,
        h,
        quality,
      });
      if (swatch) swatches[raw.id] = swatch;
      const file = join(out, `${raw.id}-${shape}.webp`);
      const bytes = Buffer.from(b64, "base64");
      writeFileSync(file, bytes);
      sizes[file] = bytes.length;
      console.log(
        `${raw.id}-${shape} ${w}x${h} ${(bytes.length / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
      );
    }
  }
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  console.log(
    `${Object.keys(sizes).length} files, ${(total / 1e6).toFixed(2)} MB at quality ${quality}`,
  );
  // wallpapers.ts's swatch for each, sampled from what was just drawn.
  for (const [id, sw] of Object.entries(swatches))
    console.log(`swatch ${id} from ${sw.from} to ${sw.to}`);
  if (values.sheet) {
    // Every wallpaper's thumb (a preview's landscape and portrait), labelled.
    const src = (id, shape) =>
      `data:image/webp;base64,${readFileSync(join(out, `${id}-${shape}.webp`)).toString("base64")}`;
    const cells = recipes
      .map(
        ({ id }) =>
          `<figure>${(values.preview ? ["landscape", "portrait"] : ["thumb"])
            .map((s) => `<img class="${s}" src="${src(id, s)}">`)
            .join("")}<figcaption>${id}</figcaption></figure>`,
      )
      .join("");
    await page.setContent(
      `<style>body{margin:0;padding:24px;background:#18181b;color:#e4e4e7;font:600 18px system-ui;display:grid;grid-template-columns:repeat(${values.preview ? 3 : 5},auto);gap:24px;width:max-content}figure{margin:0}img{display:inline-block;margin-right:8px;border-radius:6px}.thumb,.landscape{width:320px;height:240px}.portrait{width:180px;height:240px}figcaption{margin-top:8px}</style>${cells}`,
    );
    await page.waitForFunction(() =>
      [...document.images].every((i) => i.complete && i.naturalWidth > 0),
    );
    await page.screenshot({ path: values.sheet, fullPage: true });
    console.log(`contact sheet: ${values.sheet}`);
  }
} finally {
  await browser.close();
}
