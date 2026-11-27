// How the camera moves in a video, frame by frame, read from its pixels.
//   node apps/runner/compare/camera-motion.mjs --video <mp4> [--from <s>] [--to <s>]
//   node apps/runner/compare/camera-motion.mjs --repo <root> --take <id> --out <mp4> [--from <s>] [--to <s>]
// With --take, first exports that take with <root>'s built runner, from a
// copy in a throwaway home (the take store is never written), to --out.
// Prints each frame's pan (px at 2560 wide; dx + = the picture moves right,
// dy + = down) and the lines that answer the drag camera and frame-rate questions:
//   reversals x: <n> [times] the pan changing direction at 8 px/frame or more
//   reversals y: <n> [times] the same, up and down
//   repeats: <n> [times]     a frame identical to the one before, between two
//                            that changed: anything moving (camera, card,
//                            pointer) steps every other frame there
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const say = (line) => console.info(`[camera-motion] ${line}`);
const { values } = parseArgs({
  options: {
    video: { type: "string" },
    repo: { type: "string" },
    take: { type: "string" },
    out: { type: "string" },
    from: { type: "string", default: "0" },
    to: { type: "string" },
    plan: { type: "boolean", default: false },
  },
});

if (values.plan) {
  if (!values.repo || !values.take) {
    say("usage: --plan --repo <root> --take <id>");
    process.exit(2);
  }
  await planMotion(resolve(values.repo), values.take);
  process.exit(0);
}

let video = values.video && resolve(values.video);
if (values.take) {
  if (!values.repo || !values.out) {
    say("usage: --repo <root> --take <id> --out <mp4>");
    process.exit(2);
  }
  video = await exportTake(
    resolve(values.repo),
    values.take,
    resolve(values.out),
  );
}
if (!video) {
  say("usage: --video <mp4> | --repo <root> --take <id> --out <mp4>");
  process.exit(2);
}

const W = 640;
const H = 360;
const from = Number(values.from);
const span =
  values.to === undefined ? [] : ["-t", String(Number(values.to) - from)];
// Streamed a frame at a time: a long take decoded whole is over a gigabyte.
const ffmpeg = spawn(
  "ffmpeg",
  [
    "-loglevel",
    "error",
    "-ss",
    String(from),
    ...span,
    "-i",
    video,
    "-vf",
    `fps=60,scale=${W}:${H}`,
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    "-",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
ffmpeg.stderr.on("data", (d) => {
  stderr += d;
});
const exited = new Promise((r) => ffmpeg.on("close", r));

/** Column means over the middle rows (x) and row means over the middle
 *  columns (y), each less its mean: a board's columns, a page's lines. */
const profile = (f) => {
  const x = new Float64Array(W);
  const y = new Float64Array(H);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      const v = f[r * W + c];
      if (r >= H / 4 && r < (3 * H) / 4) x[c] += v;
      if (c >= W / 4 && c < (3 * W) / 4) y[r] += v;
    }
  const centred = (p) => {
    const mean = p.reduce((a, b) => a + b, 0) / p.length;
    return p.map((v) => v - mean);
  };
  return { x: centred(x), y: centred(y) };
};
/** The shift that best lines `b` up with `a`, searched to a tenth of their
 *  length either way; a pan faster than that reads as the search's edge. */
const shift = (a, b) => {
  const reach = Math.round(a.length / 10);
  let best = 0;
  let bestScore = -Infinity;
  for (let s = -reach; s <= reach; s++) {
    let score = 0;
    for (let k = reach; k < a.length - reach; k++) score += a[k] * b[k + s];
    if (score > bestScore) [best, bestScore] = [s, score];
  }
  return best;
};

const scale = 2560 / W;
const rows = [];
let lastFrame = null;
let previous = null;
let i = 0;
let pending = Buffer.alloc(0);
for await (const chunk of ffmpeg.stdout) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= W * H) {
    const frame = pending.subarray(0, W * H);
    pending = pending.subarray(W * H);
    const now = profile(frame);
    if (lastFrame !== null) {
      // An encoder may not repeat a frame byte for byte: a repeated frame
      // decodes 0.00–0.02 grey levels apart on average, a pointer moving
      // alone 0.2 or more (the Sublime drag, 2026-11-22).
      let diff = 0;
      for (let k = 0; k < W * H; k++) diff += Math.abs(frame[k] - lastFrame[k]);
      rows.push({
        t: from + i / 60,
        dx: shift(previous.x, now.x) * scale,
        dy: shift(previous.y, now.y) * scale,
        same: diff / (W * H) < 0.05,
        diff: diff / (W * H),
      });
    }
    lastFrame = Buffer.from(frame);
    previous = now;
    i++;
  }
}
const code = await exited;
if (code !== 0 || rows.length < 1) {
  say(
    `ffmpeg exited ${code} after ${i} frame(s) of ${video}: ${stderr.trim() || "no message"}`,
  );
  process.exit(1);
}
for (const { t, dx, dy, same, diff } of rows) {
  const bar = (dx < 0 ? "<" : ">").repeat(
    Math.min(40, Math.round(Math.abs(dx) / 4)),
  );
  console.info(
    `${t.toFixed(3)} dx ${dx.toFixed(0).padStart(5)} dy ${dy.toFixed(0).padStart(5)} diff ${diff.toFixed(2).padStart(5)}${same ? " same" : "     "} ${bar}`,
  );
}
const reversalsOf = (axis) => {
  const moving = rows.filter((r) => Math.abs(r[axis]) >= 8);
  return moving
    .filter(
      (r, i) => i > 0 && Math.sign(r[axis]) !== Math.sign(moving[i - 1][axis]),
    )
    .map((r) => r.t.toFixed(2));
};
// A repeat counts only between two frames that changed: a still picture
// repeats by nature.
const repeats = rows
  .filter(
    (r, i) =>
      r.same && rows[i - 1]?.same === false && rows[i + 1]?.same === false,
  )
  .map((r) => r.t.toFixed(2));
for (const axis of ["dx", "dy"]) {
  const found = reversalsOf(axis);
  console.info(`reversals ${axis[1]}: ${found.length} [${found.join(", ")}]`);
}
console.info(`repeats: ${repeats.length} [${repeats.join(", ")}]`);

/** The camera as <root> plans it for the take, read from the plan rather
 *  than the picture, so nothing the page draws moves it: the centre's step
 *  each 60 fps frame (CSS px) while zoomed, its reversals on each axis at
 *  0.5 px a frame or more, and its fastest step. Read-only on the take.
 *  The centres are the plan's, not clamped to the canvas as a frame is
 *  drawn (`frameTrack`): near a canvas edge a count can differ from the
 *  video's, so check a surprising one with --video. */
async function planMotion(repo, takeId) {
  const at = (p) => import(join(repo, p));
  const { createLibrary } = await at("apps/runner/dist/executor/library.js");
  const { composeForTarget, planScene, sampleTrack } = await at(
    "packages/compositor/dist/index.js",
  );
  const { targetFor, frameOf, DEFAULT_EXPORT_QUALITY } = await at(
    "packages/run-core/dist/index.js",
  );
  const library = createLibrary(
    process.env.DEMOMAN_HOME ?? join(homedir(), ".demoman"),
  );
  const read = await library.getSceneRead(takeId);
  const bundle = await library.frameStore(takeId).getBundle(takeId);
  if (read === null || bundle === null) {
    say(`take ${takeId} has ${read === null ? "no scene" : "no frames"}`);
    process.exit(1);
  }
  const { scene } = read;
  const target = targetFor("mp4", scene.canvas.aspect, bundle, frameOf(scene), {
    quality: DEFAULT_EXPORT_QUALITY,
  });
  const { resolved } = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target,
  });
  const frame = 1000 / 60;
  const steps = [];
  let previous = sampleTrack(resolved, 0);
  for (let t = frame; t <= resolved.timeline.outputDurationMs; t += frame) {
    const now = sampleTrack(resolved, t);
    if (now.scale > 1 && previous.scale > 1) {
      steps.push({
        t,
        dx: now.center.x - previous.center.x,
        dy: now.center.y - previous.center.y,
      });
    }
    previous = now;
  }
  for (const axis of ["dx", "dy"]) {
    const moving = steps.filter((s) => Math.abs(s[axis]) >= 0.5);
    const found = moving
      .filter(
        (s, i) =>
          i > 0 && Math.sign(s[axis]) !== Math.sign(moving[i - 1][axis]),
      )
      .map((s) => (s.t / 1000).toFixed(2));
    console.info(
      `plan reversals ${axis[1]}: ${found.length} [${found.join(", ")}]`,
    );
  }
  const fastest = steps.reduce(
    (m, s) => Math.max(m, Math.hypot(s.dx, s.dy)),
    0,
  );
  console.info(`plan fastest: ${fastest.toFixed(1)} px/frame`);
  // Each push-in's length and where it lands: a short one was cut to the gap
  // its step left (a drag got 0.5 s of 1.3 until 2026-11-23).
  const pushIns = resolved.cameraKeys
    .filter(
      (k, i) => k.scale > 1 && (resolved.cameraKeys[i - 1]?.scale ?? 1) === 1,
    )
    .map(
      (k) =>
        `${Math.round(k.transitionMs)} ms at ${(k.outputTimeMs / 1000).toFixed(2)}`,
    );
  console.info(`plan push-ins: ${pushIns.length} [${pushIns.join(", ")}]`);
}

async function exportTake(repo, takeId, out) {
  const dist = (p) => import(join(repo, "apps", "runner", "dist", p));
  const { createLocalExecutor } = await dist("executor/executor.js");
  const home = mkdtempSync(join(tmpdir(), "camera-motion-home-"));
  const store = process.env.DEMOMAN_HOME ?? join(homedir(), ".demoman");
  cpSync(join(store, "takes", takeId), join(home, "takes", takeId), {
    recursive: true,
  });
  const executor = createLocalExecutor({
    home,
    wallpapersDir: join(
      repo,
      "apps",
      "studio",
      "pages",
      "public",
      "wallpapers",
    ),
    headless: true,
    outDir: join(home, "out"),
    log: () => {},
  });
  try {
    const exp = await executor.request("export", {
      takeId,
      quality: "high",
      callId: "camera-motion",
    });
    const answer = exp.ok ? exp.value : exp;
    if (answer.outcome !== "saved") {
      throw new Error(
        `export ${answer.outcome ?? "refused"}: ${JSON.stringify(answer).slice(0, 400)}`,
      );
    }
    cpSync(answer.file.path, out);
    say(`exported ${takeId} with ${repo} to ${out}`);
    return out;
  } finally {
    await executor.close().catch((e) => say(`close failed (${e})`));
    rmSync(home, { recursive: true, force: true });
  }
}
