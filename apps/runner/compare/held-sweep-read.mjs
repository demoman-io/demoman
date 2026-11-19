#!/usr/bin/env node
// Reads an export of `held-sweep.json` (record it with pacing-pairs.mjs) off
// its decoded pixels, for lane A's held sweep (DEM-186, 191, 188):
//
//   node apps/runner/compare/held-sweep-read.mjs <video.mp4>...
//
// Prints one JSON line per video:
// - `freezes`: every run of 200 ms or more in which the picture did not move.
//   The fixture's stripes slide on every frame, so on its page any such run
//   is a freeze the video added (DEM-186), not a still page.
// - `greenMs`: the times the fixture's 40 ms green box shows (DEM-191, 188:
//   a change too short to be a motion span). Empty means the video lost it.
// - `diff`: the median and the smallest frame-to-frame change outside
//   freezes, so the freeze threshold can be read against the motion.
// Needs ffmpeg and ffprobe on the PATH.
import { spawn, spawnSync } from "node:child_process";

const WIDTH = 480;
/** Mean absolute change per channel (0–255) under which two decoded frames
 *  are the same picture: encoder noise on a repeated frame is well under 1. */
const SAME = 1;
const FREEZE_MS = 200;

for (const file of process.argv.slice(2)) {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) {
    // A missing ffprobe has no status and no stderr: its error says so.
    throw new Error(
      `ffprobe ${file}: ${probe.error?.message ?? probe.stderr ?? "no output"}`,
    );
  }
  const s = JSON.parse(probe.stdout).streams[0];
  const [n, d] = s.r_frame_rate.split("/").map(Number);
  const fps = n / d;
  const height = Math.round((WIDTH * s.height) / s.width / 2) * 2;
  const size = WIDTH * height * 3;
  const ff = spawn("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    `scale=${WIDTH}:${height}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  let err = "";
  ff.stderr.on("data", (c) => {
    err += c;
  });
  // A missing ffmpeg: its spawn error, said, rather than an unhandled event.
  const spawned = new Promise((_, reject) =>
    ff.on("error", (e) => reject(new Error(`ffmpeg ${file}: ${e.message}`))),
  );
  spawned.catch(() => undefined);
  let pending = Buffer.alloc(0);
  let prev = null;
  let index = 0;
  const diffs = [];
  const green = [];
  const read = (frame) => {
    let g = 0;
    for (let i = 0; i < size; i += 3) {
      if (frame[i + 1] > 180 && frame[i] < 90 && frame[i + 2] < 90) g++;
    }
    if (g >= 20) green.push(Math.round((index / fps) * 1000));
    if (prev !== null) {
      let sum = 0;
      for (let i = 0; i < size; i++) sum += Math.abs(frame[i] - prev[i]);
      diffs.push(sum / size);
    }
    prev = Buffer.from(frame);
    index++;
  };
  for await (const chunk of ff.stdout) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= size) {
      read(pending.subarray(0, size));
      pending = pending.subarray(size);
    }
  }
  const code = await Promise.race([
    spawned,
    new Promise((r) => ff.on("close", r)),
  ]);
  if (code !== 0) throw new Error(`ffmpeg ${file} exited ${code}: ${err}`);

  const freezes = [];
  let start = null;
  const close = (end) => {
    if (start === null) return;
    const ms = ((end - start) / fps) * 1000;
    if (ms >= FREEZE_MS)
      freezes.push({
        atMs: Math.round((start / fps) * 1000),
        ms: Math.round(ms),
      });
    start = null;
  };
  diffs.forEach((v, i) => {
    // diffs[i] compares frame i+1 with frame i.
    if (v < SAME) start ??= i;
    else close(i);
  });
  close(diffs.length);
  const moving = diffs.filter((v) => v >= SAME).sort((a, b) => a - b);
  console.info(
    JSON.stringify({
      file,
      fps,
      frames: index,
      freezes,
      greenMs: green,
      diff: {
        median: moving[Math.floor(moving.length / 2)] ?? null,
        smallest: moving[0] ?? null,
        sameFrames: diffs.length - moving.length,
      },
    }),
  );
}
