// What colour space a held take's export says it is in, and what its pixels
// are, so this machine's answer can be set beside another's.
//
//   node apps/runner/compare/colour-tags.mjs [--repo <root>] [--keep <dir>]
//
// Needs `pnpm install` and `pnpm -r build` in <root> (default: this
// checkout); ffprobe and ffmpeg on the PATH add two sections, and their
// absence is said, not skipped in silence. Records one short take headless
// (held clock unless DEMOMAN_HELD_CLOCK=0) of a page of six flat swatches
// with a spinner, so the run muxes motion spans, then exports it and prints,
// for the export and for each span mp4 the run left in its home:
//   - the `colr` box in `moov` (absent when the encoder reported no
//     complete colour space: mediabunny writes it only then),
//   - ffprobe's pix_fmt and color_* fields, and the SPS VUI ffmpeg's
//     trace_headers reads out of the bitstream itself;
// and for the export only, decoded in this Playwright's Chromium:
//   - the colour space of a `VideoFrame` made from a canvas (what the
//     compositor hands the encoder) and of the decoded frame,
//   - per swatch, the most common Y'CbCr code values against BT.709 and
//     BT.601 in limited and full range, and the most common RGB Chrome
//     paints it as against the page's own value.
// `--keep` copies the export and span mp4s there; otherwise the home goes.
//
// Linux: the Docker command in README.md's "Colour tags", which runs this
// file unchanged in a fresh clone.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { arch, platform, release, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const say = (line) => console.info(`[colour-tags] ${line}`);
const { values } = parseArgs({
  options: { repo: { type: "string" }, keep: { type: "string" } },
});
const repo = resolve(
  values.repo ?? join(import.meta.dirname, "..", "..", ".."),
);
const dist = (p) => import(join(repo, "apps", "runner", "dist", p));
const { createLocalExecutor } = await dist("executor/executor.js");
const { launch } = await dist("launch.js");

// The page's own values, in sRGB: the primaries, where BT.709 and BT.601
// disagree most, a mid grey, where they agree, and two in between.
const SWATCHES = [
  ["red", [255, 0, 0]],
  ["green", [0, 255, 0]],
  ["blue", [0, 0, 255]],
  ["grey", [128, 128, 128]],
  ["orange", [232, 89, 12]],
  ["teal", [18, 140, 126]],
];
// The verdicts read against these, so check them against published values
// (BT.709 and BT.601 red in limited range) before anything is recorded.
assert.deepEqual(expected([255, 0, 0])["709 limited"], [63, 102, 240]);
assert.deepEqual(expected([255, 0, 0])["601 limited"], [81, 90, 240]);
assert.deepEqual(expected([128, 128, 128])["709 full"], [128, 128, 128]);
const hex = (rgb) =>
  `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
const cells = SWATCHES.map(
  ([, rgb]) => `<div style="background:${hex(rgb)}"></div>`,
).join("");
const PAGE = `<!doctype html><meta charset=utf-8><link rel=icon href="data:,">
<style>html,body{margin:0;height:100%}body{display:grid;grid-template:1fr 1fr/1fr 1fr 1fr}
#go{position:fixed;left:40px;top:40px;width:120px;height:40px}
@keyframes s{to{transform:rotate(360deg)}}
#spin{position:fixed;right:40px;bottom:40px;width:40px;height:40px;background:#fff;animation:s 1s linear infinite}</style>
${cells}<button id=go>Go</button><div id=spin></div>`;

const server = createServer((req, res) => {
  if (req.url !== "/index.html") return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;

const home = mkdtempSync(join(tmpdir(), "colour-tags-home-"));
const executor = createLocalExecutor({
  home,
  wallpapersDir: join(repo, "apps", "studio", "pages", "public", "wallpapers"),
  headless: true,
  // As the CLI and MCP do: headless stands in for this machine's display,
  // so the take records at its scale, as a real one does.
  standInDisplay: true,
  outDir: join(home, "out"),
  log: (m) => say(typeof m === "string" ? m : JSON.stringify(m)),
});
let failed = false;
try {
  say(`machine: ${platform()} ${release()} ${arch()}, node ${process.version}`);
  say(`commit: ${git("rev-parse", "--short", "HEAD")}`);
  say(
    `clock: ${process.env.DEMOMAN_HELD_CLOCK === "0" ? "real time (DEMOMAN_HELD_CLOCK=0)" : "held"}`,
  );
  const script = {
    scriptVersion: 1,
    name: "Colour tags",
    target: pageUrl,
    viewport: { width: 1280, height: 800 },
    steps: [
      { do: "waitForLoad" },
      { do: "pause", ms: 600 },
      // No zoom: every swatch stays in the frame the pixels are read from.
      { do: "click", on: { stableId: "go" }, zoom: false },
      { do: "pause", ms: 1500 },
    ],
  };
  const run = await executor.request("run", {
    script,
    video: { new: "colour-tags", confirmedNew: true },
    callId: "colour-tags-run",
  });
  // Only "complete" is a finished take; a stopped one is not measured.
  if (!run.ok)
    throw new Error(`run not answered: ${JSON.stringify(run).slice(0, 400)}`);
  say(`run: ${run.value.outcome}`);
  if (run.value.outcome !== "complete") {
    const v = run.value;
    const why =
      v.stopped?.detail ??
      v.stopped?.sentence ??
      v.detail ??
      v.reason ??
      v.summary ??
      "no reason given";
    throw new Error(`run outcome "${v.outcome}": ${why}`);
  }
  const takeId = run.value.provenance?.takeId;
  if (typeof takeId !== "string")
    throw new Error(
      `the run made no take: ${JSON.stringify(run).slice(0, 400)}`,
    );
  const exp = await executor.request("export", {
    takeId,
    callId: "colour-tags-export",
  });
  const answer = exp.ok ? exp.value : exp;
  if (answer.outcome !== "saved" || typeof answer.file?.path !== "string")
    throw new Error(
      `the export saved no file: ${JSON.stringify(answer).slice(0, 400)}`,
    );
  const exported = answer.file.path;
  const spans = mp4sUnder(home).filter((p) => p !== exported);
  if (spans.length === 0) {
    // The spinner is there to make spans; a run without them measured only
    // the export's encode, so say so rather than print an empty section.
    failed = true;
    say("no span mp4 in the run's home: the recording mux was not measured");
  }
  for (const [label, file] of [
    ["export", exported],
    ...spans.map((s, i) => [`span ${i}`, s]),
  ]) {
    say(`${label}: ${basename(file)}`);
    tags(file);
  }
  if (values.keep) {
    const keep = resolve(values.keep);
    mkdirSync(keep, { recursive: true });
    for (const f of [exported, ...spans])
      copyFileSync(f, join(keep, basename(f)));
    say(`kept: ${keep}`);
  }
  await pixels(exported);
} catch (error) {
  failed = true;
  say(`failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await executor.close().catch((e) => say(`close failed (${e})`));
  server.close();
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

function git(...args) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
    }).trim();
  } catch (e) {
    return `unknown (git: ${e.message.split("\n")[0]})`;
  }
}

/** Every file under `dir` that opens with an `ftyp` box. */
function mp4sUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile()) continue;
    const p = join(entry.parentPath, entry.name);
    const head = Buffer.alloc(8);
    const fd = openSync(p, "r");
    readSync(fd, head, 0, 8, 0);
    closeSync(fd);
    if (head.subarray(4, 8).toString("latin1") === "ftyp") found.push(p);
  }
  return found.sort();
}

function tags(file) {
  say(`  colr: ${colrBox(readFileSync(file))}`);
  say(
    `  ffprobe: ${tool("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,profile,pix_fmt,color_range,color_space,color_transfer,color_primaries",
      "-of",
      "compact=p=0",
      file,
    ])}`,
  );
  const vui = tool(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "info",
      "-i",
      file,
      "-frames:v",
      "1",
      "-c",
      "copy",
      "-bsf:v",
      "trace_headers",
      "-f",
      "null",
      "-",
    ],
    true,
  );
  const fields = [
    ...vui.matchAll(
      /(video_signal_type_present_flag|video_full_range_flag|colour_description_present_flag|colour_primaries|transfer_characteristics|matrix_coefficients)\s+\S+\s+=\s+(\d+)/g,
    ),
  ];
  // First SPS only: one stream carries one, and the fields repeat per frame.
  const seen = new Map();
  for (const [, k, v] of fields) if (!seen.has(k)) seen.set(k, v);
  say(
    `  sps vui: ${seen.size > 0 ? [...seen].map(([k, v]) => `${k}=${v}`).join(" ") : /^(not run|ffmpeg failed)/.test(vui) ? vui : "no VUI fields in the trace"}`,
  );
}

function tool(name, args, stderr = false) {
  const r = spawnSync(name, args, { encoding: "utf8" });
  if (r.error?.code === "ENOENT") return `not run: ${name} is not on the PATH`;
  if (r.error || r.status !== 0)
    return `${name} failed (${r.status ?? r.error?.message}): ${String(r.stderr).trim().split("\n").pop()}`;
  // trace_headers writes what it reads to stderr.
  return (stderr ? r.stderr : r.stdout).trim();
}

/** The `colr` box inside `moov`, or why there is none. */
function colrBox(bytes) {
  const top = boxes(bytes, 0, bytes.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov)
    return `no moov box (top level: ${top.map((b) => b.type).join(" ")})`;
  const at = bytes.subarray(moov.start, moov.end).indexOf(Buffer.from("colr"));
  if (at < 0) return "none in moov";
  const p = moov.start + at + 4;
  const kind = bytes.subarray(p, p + 4).toString("latin1");
  if (kind !== "nclx") return `colr of type ${kind}`;
  const v = new DataView(bytes.buffer, bytes.byteOffset + p + 4, 7);
  return `nclx primaries=${v.getUint16(0)} transfer=${v.getUint16(2)} matrix=${v.getUint16(4)} fullRange=${v.getUint8(6) >> 7}`;
}

function boxes(bytes, start, end) {
  const out = [];
  for (let p = start; p + 8 <= end; ) {
    let size = bytes.readUInt32BE(p);
    const type = bytes.subarray(p + 4, p + 8).toString("latin1");
    if (size === 1) size = Number(bytes.readBigUInt64BE(p + 8));
    if (size === 0) size = end - p;
    if (size < 8) break;
    out.push({ type, start: p, end: p + size });
    p += size;
  }
  return out;
}

/** Y'CbCr code values for an sRGB triple under each matrix and range. */
function expected(rgb) {
  const out = {};
  for (const [m, kr, kb] of [
    ["709", 0.2126, 0.0722],
    ["601", 0.299, 0.114],
  ]) {
    const [r, g, b] = rgb.map((c) => c / 255);
    const y = kr * r + (1 - kr - kb) * g + kb * b;
    const cb = (b - y) / (2 * (1 - kb));
    const cr = (r - y) / (2 * (1 - kr));
    out[`${m} limited`] = [16 + 219 * y, 128 + 224 * cb, 128 + 224 * cr].map(
      Math.round,
    );
    out[`${m} full`] = [255 * y, 128 + 255 * cb, 128 + 255 * cr].map((c) =>
      Math.min(255, Math.round(c)),
    );
  }
  return out;
}

async function pixels(file) {
  const launched = await launch({
    headless: true,
    log: (l) => say(`launch: ${l}`),
  });
  const bytes = readFileSync(file);
  const mediabunny = readFileSync(
    join(
      repo,
      "apps",
      "runner",
      "node_modules",
      "mediabunny",
      "dist",
      "bundles",
      "mediabunny.min.mjs",
    ),
  );
  const probe = createServer((req, res) => {
    if (req.url === "/mediabunny.mjs")
      return void res
        .writeHead(200, { "content-type": "text/javascript" })
        .end(mediabunny);
    if (req.url === "/v.mp4")
      return void res
        .writeHead(200, { "content-type": "video/mp4" })
        .end(bytes);
    res
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><title>colour</title>");
  });
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  try {
    say(`chrome: ${launched.page.context().browser()?.version() ?? "unknown"}`);
    const page = launched.page;
    await page.goto(`http://127.0.0.1:${probe.address().port}/`);
    const targets = SWATCHES.map(([name, rgb]) => ({
      name,
      rgb,
      yuv: expected(rgb),
    }));
    const r = await page.evaluate(readFrame, targets);
    if (r.error) throw new Error(`decoding the export in Chrome: ${r.error}`);
    say(
      `encode input VideoFrame(canvas).colorSpace: ${JSON.stringify(r.canvasSpace)}`,
    );
    say(
      `decoder config colorSpace (as mediabunny reads the container): ${JSON.stringify(r.configSpace)}`,
    );
    say(
      `decoded VideoFrame at ${r.tSec.toFixed(2)} s: ${r.format} ${r.width}x${r.height} colorSpace ${JSON.stringify(r.decodedSpace)}`,
    );
    for (const s of r.swatches) {
      if (s.yuv === null || s.rgb === null) {
        // The swatch fills a sixth of the page; not finding it means the
        // frame is not the picture this trial assumes.
        failed = true;
        say(`  ${s.name}: not found in the frame (${s.why})`);
        continue;
      }
      const [best, dist] = Object.entries(s.expected)
        .map(([k, e]) => [
          k,
          Math.max(...e.map((c, i) => Math.abs(c - s.yuv[i]))),
        ])
        .sort((a, b) => a[1] - b[1])[0];
      const target = SWATCHES.find(([n]) => n === s.name)[1];
      const off = Math.max(...target.map((c, i) => Math.abs(c - s.rgb[i])));
      say(
        `  ${s.name} ${hex(target)}: yuv ${s.yuv.join(",")} (${s.yuvShare}% of frame) nearest ${best} by ${dist}; Chrome paints ${hex(s.rgb)} (${s.rgbShare}%), off by ${off}/255`,
      );
    }
  } finally {
    probe.close();
    await launched.close();
  }
}

/** In the page: decode the export's frame 0.2 s before its end, and read its
 *  colour space and, per swatch, the most common code values and paint. */
async function readFrame(targets) {
  try {
    // As sink-mp4 hands mediabunny a drawn 2d canvas (a canvas with no
    // context is refused as a source).
    const drawn = new OffscreenCanvas(16, 16);
    drawn.getContext("2d").fillRect(0, 0, 16, 16);
    const input0 = new VideoFrame(drawn, { timestamp: 0 });
    const canvasSpace = input0.colorSpace.toJSON();
    input0.close();
    // WebCodecs through mediabunny, as the product's own decode probe reads
    // an export: a <video> here refused `new VideoFrame(video)` headless.
    const mb = await import("/mediabunny.mjs");
    const input = new mb.Input({
      source: new mb.UrlSource("/v.mp4"),
      formats: mb.ALL_FORMATS,
    });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("the export has no video track");
    const configSpace = (await track.getDecoderConfig())?.colorSpace ?? null;
    const tSec = Math.max(0, (await track.computeDuration()) - 0.2);
    const sample = await new mb.VideoSampleSink(track).getSample(tSec);
    if (!sample) throw new Error(`no frame at ${tSec} s`);
    const frame = sample.toVideoFrame();
    sample.close();
    // copyTo with no rect copies the visible rect, laid out at its size: a
    // software decode's coded height can be rounded up past the picture.
    const { format } = frame;
    const { width, height } = frame.visibleRect;
    const decodedSpace = frame.colorSpace.toJSON();
    const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(frame, 0, 0);
    const painted = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let planes = null;
    if (format === "I420" || format === "NV12") {
      const buf = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(buf);
      planes = { buf, layout };
    }
    frame.close();
    const mode = (count) => {
      let best = null;
      for (const [k, n] of count)
        if (best === null || n > best[1]) best = [k, n];
      return best;
    };
    const near = (a, b, tol) => a.every((c, i) => Math.abs(c - b[i]) <= tol);
    const swatches = targets.map(({ name, rgb, yuv }) => {
      const out = { name, expected: yuv, yuv: null, rgb: null, why: "" };
      const paint = new Map();
      for (let i = 0; i < painted.length; i += 4) {
        const px = [painted[i], painted[i + 1], painted[i + 2]];
        if (!near(px, rgb, 48)) continue;
        const k = px.join(",");
        paint.set(k, (paint.get(k) ?? 0) + 1);
      }
      const p = mode(paint);
      // A sixth of the page, unzoomed, is far more than 1% of the frame.
      if (p && p[1] > painted.length / 4 / 100) {
        out.rgb = p[0].split(",").map(Number);
        out.rgbShare = ((100 * p[1]) / (painted.length / 4)).toFixed(1);
      } else out.why = `paint: ${p ? p[1] : 0} pixels within 48 of it`;
      if (planes === null) {
        out.why += ` raw planes not read: decoded format ${format}`;
        return out;
      }
      const { buf, layout } = planes;
      const cands = Object.values(yuv);
      const code = new Map();
      let total = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          total++;
          const Y = buf[layout[0].offset + y * layout[0].stride + x];
          let U;
          let V;
          if (format === "I420") {
            U = buf[layout[1].offset + (y / 2) * layout[1].stride + x / 2];
            V = buf[layout[2].offset + (y / 2) * layout[2].stride + x / 2];
          } else {
            U = buf[layout[1].offset + (y / 2) * layout[1].stride + x];
            V = buf[layout[1].offset + (y / 2) * layout[1].stride + x + 1];
          }
          const px = [Y, U, V];
          if (!cands.some((c) => near(px, c, 10))) continue;
          const k = px.join(",");
          code.set(k, (code.get(k) ?? 0) + 1);
        }
      }
      const c = mode(code);
      if (c && c[1] > total / 100) {
        out.yuv = c[0].split(",").map(Number);
        out.yuvShare = ((100 * c[1]) / total).toFixed(1);
      } else
        out.why += ` code values: ${c ? c[1] : 0} of ${total} within 10 of any matrix`;
      return out;
    });
    return {
      canvasSpace,
      configSpace,
      decodedSpace,
      format,
      width,
      height,
      tSec,
      swatches,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
