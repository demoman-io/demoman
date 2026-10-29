// Measures the colour of Apple's abstract macOS wallpapers on this Mac and
// writes the per-family ranges to palette.json. Only numbers and file names
// leave this script: every decoded image goes to a scratch folder outside
// the repo, and nothing of Apple's is copied into it.
//
//   node apps/studio/scripts/wallpapers/measure.mjs <scratch-dir>
//
// Each image is converted to a PNG of at most 512px with `sips`, decoded in
// Playwright's Chromium, and summarised as HSL. An image is filed under a
// family by what it measures, not by its name: dark when its median
// lightness is under 0.25, light when over 0.7, vivid in between; an image
// whose median saturation is under 0.4 (greys, silvers) is left out.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { chromium } from "playwright";

const scratch = process.argv[2];
if (!scratch) {
  console.error("usage: measure.mjs <scratch-dir> (outside the repo)");
  process.exit(2);
}
// Resolved first: a relative path from the repo root is inside it too.
const inRepo = relative(
  resolve(import.meta.dirname, "../../../.."),
  resolve(scratch),
);
if (!inRepo.startsWith("..") && !isAbsolute(inRepo)) {
  console.error(
    `refusing a scratch dir inside the repo (Apple's images must not land in the work tree): ${resolve(scratch)}`,
  );
  process.exit(2);
}
mkdirSync(scratch, { recursive: true });

const ROOT = "/System/Library/Desktop Pictures";
const THUMBS = join(ROOT, ".thumbnails");
const ASSETS = join(
  homedir(),
  "Library/Application Support/com.apple.mobileAssetDesktop",
);
// Abstract and colour-field sets; photos of places (Big Sur coast, Catalina,
// The Beach, Dome, Peak, Tree, Valley, …) are left out by not being here.
const ABSTRACT = [
  "Big Sur Graphic",
  "Chroma",
  "Grid",
  "hello",
  "Hello Metallic",
  "iMac",
  "Iridescence",
  "Light Stream",
  "Mac",
  "Monterey Graphic",
  "Motion",
  "Radial",
  "Solar Gradients",
  "Sonoma",
  "Studio Color",
  "Ventura Graphic",
];
const isAbstract = (name) =>
  ABSTRACT.some((p) => name === p || name.startsWith(`${p} `));

/** name → the best source on disk: a full-size .heic beats a thumbnail. */
function sources() {
  const found = new Map();
  const consider = (name, path) => {
    if (!isAbstract(name)) return;
    if (!existsSync(path)) {
      console.warn(`${name}: ${path} is not on disk, not measured`);
      return;
    }
    if (!found.has(name) || !path.includes("/.thumbnails/"))
      found.set(name, path);
  };
  for (const f of execFileSync("ls", [THUMBS], { encoding: "utf8" }).split(
    "\n",
  )) {
    if (f.endsWith(".heic")) consider(basename(f, ".heic"), join(THUMBS, f));
  }
  for (const dir of [ROOT, ASSETS]) {
    if (!existsSync(dir)) continue;
    for (const f of execFileSync("ls", [dir], { encoding: "utf8" }).split(
      "\n",
    )) {
      if (f.endsWith(".heic")) consider(basename(f, ".heic"), join(dir, f));
      if (f.endsWith(".madesktop")) {
        // A plist naming its picture (often only the thumbnail is on disk).
        const plist = readFileSync(join(dir, f), "utf8");
        for (const m of plist.matchAll(/<string>([^<]+\.heic)<\/string>/g))
          consider(basename(f, ".madesktop"), m[1]);
      }
    }
  }
  // A dynamic wallpaper's own thumbnail is half light, half dark; when its
  // Light and Dark variants are on disk, those are measured instead.
  for (const name of [...found.keys()]) {
    if (
      found.get(name).includes("/.thumbnails/") &&
      found.has(`${name} Light`) &&
      found.has(`${name} Dark`)
    )
      found.delete(name);
  }
  return found;
}

const decoded = [];
const failed = [];
for (const [name, path] of sources()) {
  const out = join(scratch, `${name}.png`);
  try {
    execFileSync(
      "sips",
      ["-s", "format", "png", "-Z", "512", path, "--out", out],
      {
        stdio: "pipe",
      },
    );
    decoded.push({ name: `${basename(path)}`, png: out });
  } catch (e) {
    failed.push(
      `${name}: ${
        String(e.stderr ?? e)
          .trim()
          .split("\n")[0]
      }`,
    );
  }
}
for (const f of failed) console.warn(`could not decode ${f}`);

const browser = await chromium.launch();
const page = await browser.newPage();
const stats = [];
for (const { name, png } of decoded) {
  const b64 = readFileSync(png).toString("base64");
  stats.push({
    name,
    ...(await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes]));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const H = [];
      const S = [];
      const L = [];
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255;
        const gr = d[i + 1] / 255;
        const b = d[i + 2] / 255;
        const max = Math.max(r, gr, b);
        const min = Math.min(r, gr, b);
        const l = (max + min) / 2;
        const ch = max - min;
        const s = ch === 0 ? 0 : ch / (1 - Math.abs(2 * l - 1));
        let h = 0;
        if (ch > 0) {
          if (max === r) h = ((gr - b) / ch + 6) % 6;
          else if (max === gr) h = (b - r) / ch + 2;
          else h = (r - gr) / ch + 4;
          h *= 60;
        }
        L.push(l);
        // HSL saturation is unstable at the black and white ends.
        if (l > 0.08 && l < 0.92) S.push(s);
        // Hue only where there is colour to see.
        if (s > 0.25 && l > 0.08 && l < 0.92) H.push(h);
      }
      const q = (a, p) => {
        const s = Float64Array.from(a).sort();
        return s[Math.min(s.length - 1, Math.floor(p * s.length))];
      };
      const hist = new Array(36).fill(0);
      for (const h of H) hist[Math.floor(h / 10) % 36]++;
      return {
        pixels: L.length,
        hueHist: hist.map((n) => n / L.length),
        s: [q(S, 0.1), q(S, 0.5), q(S, 0.9)],
        l: [q(L, 0.05), q(L, 0.5), q(L, 0.95)],
      };
    }, b64)),
  });
}
await browser.close();

// Greys and silvers (median saturation under 0.4) are no family's colour.
const familyOf = (st) =>
  !(st.s[1] >= 0.4)
    ? null
    : st.l[1] < 0.25
      ? "dark"
      : st.l[1] > 0.7
        ? "light"
        : "vivid";

const r3 = (x) => Math.round(x * 1000) / 1000;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const families = {};
const measuredFrom = [];
for (const fam of ["vivid", "light", "dark"]) {
  const members = stats.filter((st) => familyOf(st) === fam);
  if (members.length === 0) continue;
  measuredFrom.push(...members.map((m) => m.name));
  // Hue bins holding at least 1.5% of the family's coloured pixels, merged
  // into contiguous ranges (wrapping at 360).
  const hist = new Array(36).fill(0);
  for (const m of members)
    for (const [i, v] of m.hueHist.entries()) hist[i] += v;
  const total = hist.reduce((a, b) => a + b, 0) || 1;
  const on = hist.map((v) => v / total >= 0.015);
  const hue = [];
  for (let i = 0; i < 36; i++) {
    if (!on[i] || on[(i + 35) % 36]) continue;
    let j = i;
    while (on[(j + 1) % 36] && (j + 1) % 36 !== i) j++;
    hue.push([i * 10, ((j + 1) * 10) % 360 || 360]);
  }
  if (on.every(Boolean)) hue.push([0, 360]);
  families[fam] = {
    hue,
    saturation: [
      r3(median(members.map((m) => m.s[0]))),
      r3(median(members.map((m) => m.s[2]))),
    ],
    lightness: [
      r3(median(members.map((m) => m.l[0]))),
      r3(median(members.map((m) => m.l[2]))),
    ],
    contrast: r3(median(members.map((m) => m.l[2] - m.l[0]))),
  };
}

const missing = ["vivid", "light", "dark"].filter((f) => !families[f]);
if (decoded.length === 0) {
  console.error("no Apple wallpaper decoded; palette.json left as it is");
  process.exit(1);
}
// The muted family is picked by eye, not measured (README.md): keep it.
const { muted } = JSON.parse(
  readFileSync(join(import.meta.dirname, "palette.json"), "utf8"),
).families;
const palette = {
  families: { ...families, muted },
  measuredFrom: measuredFrom.sort(),
};
if (missing.length) console.warn(`no image measured as ${missing.join(", ")}`);
for (const st of stats)
  console.log(
    `${(familyOf(st) ?? "-").padEnd(5)} s50 ${r3(st.s[1])} l50 ${r3(st.l[1])} l5-95 ${r3(st.l[0])}-${r3(st.l[2])}  ${st.name}`,
  );
writeFileSync(
  join(import.meta.dirname, "palette.json"),
  `${JSON.stringify(palette, null, 2)}\n`,
);
console.log(
  `${decoded.length} decoded, ${measuredFrom.length} measured into palette.json`,
);
