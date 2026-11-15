#!/usr/bin/env node
// What today's pacing does, measured on real takes, to fit `BASE_REST_MS` and
// `OPENING_REST_MS` (packages/run-core/src/beats.ts).
//
//   node apps/runner/compare/beat-fit.mjs <takes-dir>      (e.g. ~/.demoman/takes)
//
// For every take with a scene, a real-time bundle and a script, per adjacent
// marker pair (a pair's window starts at the previous marker, or source 0 for the first): the idle
// is the span minus motion (the bundle's motion spans and degradations, merged
// with the cursor's travel, via the compositor's own `motionSpansOf` and
// `cursorMotionSpans`), minus the `roomMs` wait the pair carried and minus the
// script's `pause` before the step. It is split at the pair's last cursor
// journey: idle BEFORE it is today's rest, idle AFTER it today's arrive.
// Approximation: keyframe-diff motion hints need pixels and are not used.
// Prints numbers and take ids only, never page text or script contents.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const dist = (p) =>
  import(new URL(`../../../packages/compositor/dist/${p}`, import.meta.url));
const { cursorMotionSpans, inScreenSpace, isRealTime, sourceDurationOf } =
  await dist("index.js");
const { motionSpansOf } = await dist("plan/timeline.js");

const dir = process.argv[2];
if (!dir) {
  console.error("usage: beat-fit.mjs <takes-dir>");
  process.exit(2);
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const skipped = {};
const skip = (why) => {
  skipped[why] = (skipped[why] ?? 0) + 1;
};

const merge = (spans) => {
  const out = [];
  for (const s of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const last = out.at(-1);
    if (last && s.startMs <= last.endMs)
      last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ ...s });
  }
  return out;
};
const idleIn = (a, b, motion) => {
  if (b <= a) return 0;
  let moving = 0;
  for (const m of motion) {
    moving += Math.max(0, Math.min(b, m.endMs) - Math.max(a, m.startMs));
  }
  return b - a - moving;
};
const pct = (xs, p) => {
  if (xs.length === 0) return "n/a";
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return Math.round(s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo));
};
const summary = (name, xs) =>
  console.info(
    `${name.padEnd(30)} n=${String(xs.length).padStart(4)}  p25=${pct(xs, 0.25)}  p50=${pct(xs, 0.5)}  p75=${pct(xs, 0.75)}`,
  );

const preFirst = [];
const preRest = [];
const postFirst = [];
const postRest = [];
const rooms = [];
let read = 0;
let noJourney = 0;
const home = homedir();

for (const id of readdirSync(resolve(dir)).sort()) {
  try {
    const take = join(resolve(dir), id);
    const scenePath = join(take, "scene.json");
    const bundles = join(take, "frames", "bundles");
    if (!existsSync(scenePath) || !existsSync(bundles)) continue;
    const bundleFile = readdirSync(bundles).find((f) => f.endsWith(".json"));
    if (!existsSync(join(take, "script.json"))) {
      skip("no script.json");
      continue;
    }
    if (bundleFile === undefined) {
      skip("no bundle");
      continue;
    }
    // Keyed on video.json's `made`: only the author's own door ("mcp") with a
    // repo root under this home. "migration" takes record no origin; a CI run
    // would carry a root outside this home (/home/runner, /Users/runner).
    const video = existsSync(join(take, "video.json"))
      ? readJson(join(take, "video.json"))
      : null;
    const made = video?.made;
    if (made?.door !== "mcp") {
      skip(`made via door "${made?.door ?? "unknown"}" (origin not recorded)`);
      continue;
    }
    if (made.repo?.root !== undefined && !made.repo.root.startsWith(home)) {
      skip("repo root outside this home (CI or another machine)");
      continue;
    }
    const scene = readJson(scenePath);
    if (scene.pacing !== undefined) {
      skip("carries scene.pacing (this branch's)");
      continue;
    }
    const bundle = readJson(join(bundles, bundleFile));
    if (!isRealTime(bundle)) {
      skip("bundle not real-time");
      continue;
    }
    const markers = [...bundle.markers].sort(
      (a, b) => a.sourceTimeMs - b.sourceTimeMs,
    );
    if (markers.length === 0) {
      skip("no markers");
      continue;
    }
    // A script pause belongs to the next step that has an action.
    const pauseOf = new Map();
    let pending = 0;
    for (const s of readJson(join(take, "script.json")).steps ?? []) {
      if (s.do === "pause") pending += s.ms ?? 0;
      else if (s.actionId) {
        pauseOf.set(s.actionId, pending);
        pending = 0;
      }
    }
    const screen = inScreenSpace(bundle, undefined).bundle;
    const travel = cursorMotionSpans(screen.cursorSamples);
    const motion = merge([...motionSpansOf(bundle), ...travel]);
    const pres = [];
    // The walk's "first" is the first step that plans a beat, i.e. the first
    // one with a journey; a leading waitFor marker is only where its window starts.
    let seenJourney = false;
    markers.forEach((m, i) => {
      const start = i === 0 ? 0 : markers[i - 1].sourceTimeMs;
      const end = m.sourceTimeMs;
      const inPair = travel.filter((t) => t.endMs > start && t.startMs < end);
      if (inPair.length === 0) {
        noJourney++;
        return;
      }
      // The last journey: walk back over travel spans less than 150 ms apart.
      let j0 = inPair.length - 1;
      while (j0 > 0 && inPair[j0].startMs - inPair[j0 - 1].endMs < 150) j0--;
      const jStart = inPair[j0].startMs;
      const jEnd = inPair.at(-1).endMs;
      const room = m.roomMs ?? 0;
      if (room > 0) rooms.push(room);
      const pause = pauseOf.get(m.actionId) ?? 0;
      const pre = Math.max(0, idleIn(start, jStart, motion) - room - pause);
      const post = idleIn(jEnd, end, motion);
      (seenJourney ? preRest : preFirst).push(pre);
      (seenJourney ? postRest : postFirst).push(post);
      seenJourney = true;
      pres.push(pre);
    });
    read++;
    console.info(
      `${id}  steps=${markers.length}  median pre-journey idle=${pct(pres, 0.5)} ms  length=${Math.round(sourceDurationOf(bundle))} ms`,
    );
  } catch {
    // Take id only: a corrupt file must not print its path or text.
    skip("unreadable (corrupt or unreadable file)");
    console.info(`${id}  unreadable`);
  }
}

console.info(
  `\ntakes read: ${read}; skipped: ${Object.values(skipped).reduce((a, b) => a + b, 0)}`,
);
for (const [why, n] of Object.entries(skipped)) console.info(`  ${n}  ${why}`);
console.info(`pairs with no cursor journey (not counted): ${noJourney}`);
if (read < 8) console.info(`FEWER THAN 8 TAKES QUALIFY (${read})`);
summary("pre-journey idle, first steps", preFirst);
summary("pre-journey idle, other steps", preRest);
summary("post-journey idle, first steps", postFirst);
summary("post-journey idle, other steps", postRest);
summary("roomMs where present", rooms);
