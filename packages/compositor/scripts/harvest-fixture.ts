import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CDPSession, Locator } from "playwright";
import { chromium } from "playwright";
import { type FrameBundle, validateBundle } from "../src/bundle";
import { easings } from "../src/easing";
import { rectCenter } from "../src/geometry";
import { sampleSegment } from "../src/plan/cursor";
import { planScene } from "../src/plan/plan";
import {
  FIXTURE_SELECTORS,
  fixtureScene,
  MOTION_CLICK_ACTION_ID,
} from "./fixture-scene";

const OUT = join(import.meta.dirname, "..", ".fixtures");
const VIEWPORT = { width: 1280, height: 800 };
const DPR = 3;
const SETTLE_MS = 300; // SP1: a tooltip needs ~275ms after the path lands.
const PANEL_MS = 800; // the fixture app's panel transition, exactly.
const PANEL_TAIL_MS = 200; // screencast past the transition, so the span has a still edge.
const DEAD_AIR_MS = 600; // what the retimer is supposed to compress away.
/** How far a measured rect may drift from the scene's before the harvest is a lie. */
const RECT_DRIFT_PX = 8;

/** A frame the screencast delivered, at the source time it actually arrived. */
interface MotionFrame {
  ms: number;
  ref: string;
}

async function main(): Promise<void> {
  // A stale frame directory silently mixes two harvests: refs are indexed,
  // so an older run's k-4.png outlives a shorter run that never wrote one.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "frames"), { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  // SP1's production condition, minus the visible window: this harvest is
  // for fixture fidelity, not for re-measuring what SP1 already settled.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: DPR,
    mobile: false,
  });
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  await page.goto(
    pathToFileURL(join(import.meta.dirname, "fixture-app.html")).href,
  );
  await page.waitForSelector("#checkout-btn");

  const scene = fixtureScene();
  const plan = planScene(scene);

  const keyframes: FrameBundle["keyframes"] = [];
  const cursorSamples: FrameBundle["cursorSamples"] = [];
  const anchorRects: FrameBundle["anchorRects"] = [];
  const markers: FrameBundle["markers"] = [];
  const motionSpans: FrameBundle["motionSpans"] = [];

  let clock = 0;
  const shot = async (actionId: string | null): Promise<void> => {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
    });
    const ref = `frames/k-${keyframes.length}.png`;
    const bytes = Buffer.from(data, "base64");
    writeFileSync(join(OUT, ref), bytes);
    // Record what arrived, not what was asked for: the deliverable's
    // resolution is picked from these numbers, and detail.ts refuses zoom
    // the frames cannot back. Guessing viewport x dpr here would let a
    // surface-capped capture claim 4K it never had.
    const size = pngSize(bytes);
    keyframes.push({
      sourceTimeMs: clock,
      ref,
      width: size.width,
      height: size.height,
      actionId,
      byteLength: bytes.byteLength,
    });
  };

  await shot(null);

  for (const [i, action] of scene.actions.entries()) {
    const segment = plan.cursorSegments[i];
    if (!segment) continue;

    // Dispatch the planned path and record every sample we actually sent —
    // this is the inversion contract, and it is what SP5 will hand back.
    const steps = Math.max(2, Math.round(segment.durationMs / 8));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const point = sampleSegment(segment, easings.easeInOutCubic(t));
      clock += segment.durationMs / steps;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      cursorSamples.push({ sourceTimeMs: clock, x: point.x, y: point.y });
    }

    clock += SETTLE_MS;
    await page.waitForTimeout(SETTLE_MS);

    // `as string` used to paper over two different holes: an action's
    // anchorId is `string | null`, so a null one indexed this map with null,
    // and even a real anchorId can miss the map. Either way `page.locator`
    // received `undefined` and failed far from here, describing neither. A
    // malformed fixture should say so where it is malformed.
    const { anchorId } = action;
    if (anchorId === null) {
      throw new Error(`fixture action ${action.id} has no anchor`);
    }
    const selector = FIXTURE_SELECTORS[anchorId];
    if (selector === undefined) {
      throw new Error(`no fixture selector for anchor ${anchorId}`);
    }
    const locator = page.locator(selector);
    if (action.kind === "type") await locator.fill("northwind");
    if (action.kind === "scrollTo") await locator.scrollIntoViewIfNeeded();

    const box = await locator.boundingBox();
    if (box) {
      const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
      assertNoDrift(anchorId, rect);
      anchorRects.push({ actionId: action.id, anchorId, rect });
    }

    // The marker is the beat itself. Putting it after the panel finished
    // opening would fire the click pulse 900ms late and drag the camera's
    // lead-in into the middle of the transition.
    markers.push({ actionId: action.id, sourceTimeMs: clock });

    if (action.kind === "click" && action.id !== MOTION_CLICK_ACTION_ID) {
      // A click with no transition behind it. There is nothing to screencast:
      // the page changes instantly and the next keyframe carries the result.
      // Screencasting it anyway would write a second motion-index.json over
      // the first and hand the panel's frames to a span that never had any.
      await locator.click();
    }

    if (action.id === MOTION_CLICK_ACTION_ID) {
      // The keyframe tagged with this action is taken *now*, at the marker
      // instant, before the screencast starts. The pointer has already
      // arrived and SETTLE_MS has elapsed, so hover state is correct; the
      // click has not fired yet. This is what makes every action's tagged
      // keyframe coincident with its own marker — an animating click was
      // previously the one exception, tagged 800ms downstream on the
      // post-transition frame instead, which rendered its still from a
      // camera position (and a pointer position) that beat was never played
      // at.
      await shot(action.id);

      const span = await recordPanelTransition(cdp, locator, clock);
      motionSpans.push(span.entry);
      writeFileSync(
        join(OUT, "motion-index.json"),
        `${JSON.stringify(span.frames, null, 2)}\n`,
      );
      // Land the next keyframe *exactly* on the span's end, not after the
      // tail. `createImageFrameSource` serves the newest keyframe at or
      // before a source time, so a gap between a span's end and the next
      // keyframe is served by the last pre-span keyframe: at the seam the
      // deliverable flashes back to the pre-click page for the length of the
      // gap and then forward again. The wall-clock wait still runs past the
      // transition, so the pixels are settled; only the stamp is the edge.
      clock += PANEL_MS;
      // The settled post-animation frame is still valuable — it is the
      // "stable state" keyframe the design calls for alongside the marker
      // one — but it no longer carries this action's tag: that keyframe now
      // exists already, coincident with the marker above.
      await shot(null);
    } else {
      await shot(action.id);
    }

    clock += DEAD_AIR_MS; // dead air, kept verbatim now (P5, 2026-09-08)
  }

  // A closing hold, so the deliverable does not cut the instant the last
  // beat lands. It is dead air, and the retimer no longer trims it — it
  // plays back at its recorded duration, same as everywhere else.
  await shot(null);

  const bundle = validateBundle({
    bundleVersion: 1,
    sceneId: scene.meta.id,
    source: "replay",
    dpr: DPR,
    viewport: VIEWPORT,
    keyframes,
    motionSpans,
    cursorSamples,
    cursorGaps: [],
    anchorRects,
    markers,
    degradations: [],
  } satisfies FrameBundle);

  writeFileSync(
    join(OUT, "bundle.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
  writeFileSync(join(OUT, "scene.json"), `${JSON.stringify(scene, null, 2)}\n`);
  await browser.close();

  const span = motionSpans[0];
  console.log(
    `harvested ${keyframes.length} keyframes at ${keyframes[0]?.width}x${keyframes[0]?.height}, ` +
      `${motionSpans.length} motion span(s)` +
      (span
        ? ` at ${span.width}x${span.height}, ${span.fps.toFixed(1)} fps`
        : "") +
      `, ${cursorSamples.length} cursor samples -> ${OUT}`,
  );
}

/**
 * Screencast across the panel transition: the one span with real in-app
 * motion, harvested at whatever the surface actually gives. SP1's finding is
 * that this is routinely smaller than viewport x dpr, and that is fine — the
 * compositor upscales it and `detail.ts` refuses zoom it cannot back.
 */
async function recordPanelTransition(
  cdp: CDPSession,
  locator: Locator,
  spanStartMs: number,
): Promise<{
  entry: FrameBundle["motionSpans"][number];
  frames: MotionFrame[];
}> {
  const frames: MotionFrame[] = [];
  let baseTimestamp: number | null = null;
  let size = { width: 0, height: 0 };

  const onFrame = (event: {
    data: string;
    sessionId: number;
    metadata: { timestamp?: number };
  }): void => {
    // Index synchronously: an async body would race two frames onto one ref.
    const index = frames.length;
    const bytes = Buffer.from(event.data, "base64");
    const ref = `frames/m-${index}.jpg`;
    // Real arrival times, not an assumed 60 Hz. Jitter is the point of a
    // harvested fixture — a perfectly spaced span would be a procedural one.
    const timestamp = event.metadata.timestamp ?? 0;
    baseTimestamp ??= timestamp;
    frames.push({
      ms: spanStartMs + Math.max(0, (timestamp - baseTimestamp) * 1000),
      ref,
    });
    writeFileSync(join(OUT, ref), bytes);
    if (index === 0) size = jpegSize(bytes);
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
  };

  cdp.on("Page.screencastFrame", onFrame);
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 90,
    everyNthFrame: 1,
  });
  await locator.click();
  await locator.page().waitForTimeout(PANEL_MS + PANEL_TAIL_MS);
  await cdp.send("Page.stopScreencast");
  cdp.off("Page.screencastFrame", onFrame);

  if (frames.length === 0) {
    throw new Error(
      "screencast delivered no frames; the motion span would be a lie",
    );
  }
  const inSpan = frames.filter((f) => f.ms <= spanStartMs + PANEL_MS).length;
  return {
    entry: {
      startMs: spanStartMs,
      endMs: spanStartMs + PANEL_MS,
      ref: (frames[0] as MotionFrame).ref,
      width: size.width,
      height: size.height,
      fps: Math.max(1, inSpan / (PANEL_MS / 1000)),
      byteLength: 0,
    },
    frames,
  };
}

function assertNoDrift(
  anchorId: string,
  rect: { x: number; y: number; width: number; height: number },
): void {
  const authored = fixtureScene().anchors.find((a) => a.id === anchorId)
    ?.fingerprint.boundingRect;
  if (!authored) return;
  const a = rectCenter(authored);
  const b = rectCenter(rect);
  const drift = Math.hypot(a.x - b.x, a.y - b.y);
  if (drift > RECT_DRIFT_PX) {
    throw new Error(
      `anchor ${anchorId} has drifted ${drift.toFixed(1)}px from fixture-scene.ts ` +
        `(page says ${JSON.stringify(rect)}). The planned cursor path would miss it; ` +
        "update the rect in fixture-scene.ts to match the page.",
    );
  }
}

/** IHDR is always the first chunk, at a fixed offset. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Walk JPEG markers to the start-of-frame, which is the only one carrying size. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2; // skip SOI
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1] as number;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error("screencast frame is not a JPEG this parser understands");
}

await main();
