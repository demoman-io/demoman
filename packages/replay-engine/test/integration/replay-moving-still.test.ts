import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { jpegSize } from "../../src/image.js";
import { REPLAY_DPR, runReplay } from "../../src/index.js";
import {
  selectorPageAgent,
  withReplayBrowser,
} from "../helpers/cdp-playwright";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { SCENE_VIEWPORT, scene } from "../helpers/replay-scene";

/**
 * A step's own still, against a real Chromium, on the frames themselves.
 *
 * `Page.captureScreenshot` stalls the screencast while it runs, and every
 * step takes a full still: measured 2026-10-24 on three takes, each of ten
 * stills taken while the page painted left a 87–272 ms hole in the video,
 * one through a sheet sliding shut. A step whose page is moving now takes
 * the next screencast frame as its still instead; a page where only a
 * spinner turns still gets the full one (the author's call: a sliver of
 * repaint is a still page).
 */

const FIXTURE = {
  url: pathToFileURL(
    join(import.meta.dirname, "..", "fixtures", "sheet-app.html"),
  ).href,
  readySelector: "#open-btn",
};
const SELECTORS = {
  "open-btn": "#open-btn",
  "next-btn": "#next-btn",
  "other-btn": "#other-btn",
};
/** The sheet's slide, in the fixture's CSS. */
const SLIDE_MS = 1500;
/** When the second step comes: well inside the slide. */
const SECOND_STEP_MS = 400;

const clock = () => ({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
});

function twoClicks(first: string, second: string): SceneDocument {
  const doc = scene({ anchorIds: Object.keys(SELECTORS) });
  const [a, b] = doc.actions as [
    (typeof doc.actions)[number],
    (typeof doc.actions)[number],
  ];
  return {
    ...doc,
    actions: [
      { ...a, anchorId: first, timestamp: 0 },
      { ...b, anchorId: second, timestamp: SECOND_STEP_MS },
    ],
  } as SceneDocument;
}

async function replay(
  page: Page,
  cdp: Parameters<typeof runReplay>[1]["cdp"],
  doc: SceneDocument,
) {
  const store = createMemoryFrameStore();
  const encoder = createNodeFrameEncoder(store, doc.meta.id);
  const result = await runReplay(doc, {
    cdp,
    page: selectorPageAgent(page, SELECTORS),
    encoder,
    store,
    clock: clock(),
    mayReplay: true,
    madeFrom: madeFromOf(doc),
    recording: "continuous",
  });
  const frames = encoder.pushed();
  const second = doc.actions[1]?.id;
  const marker = result.bundle?.markers.find((m) => m.actionId === second);
  const still = result.bundle?.keyframes.find((k) => k.actionId === second);
  const evidence = (from: number, to: number): string =>
    `marker ${Math.round(marker?.sourceTimeMs ?? -1)}, still ${still?.width}x${still?.height} at ${Math.round(still?.sourceTimeMs ?? -1)}; frames in [${Math.round(from)}, ${Math.round(to)}]: ${frames
      .filter((f) => f.ms >= from && f.ms <= to)
      .map((f) => Math.round(f.ms))
      .join(",")}`;
  return { result, frames, marker, still, evidence };
}

const gaps = (times: number[]): number[] =>
  times.slice(1).map((t, i) => t - (times[i] as number));
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

describe("a step's still while the page moves", () => {
  it("is a screencast frame, and the slide keeps every frame through it", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const { result, frames, marker, still, evidence } = await replay(
        page,
        cdp,
        twoClicks("open-btn", "next-btn"),
      );
      expect(result.outcome).toBe("complete");
      const m2 = marker?.sourceTimeMs ?? 0;
      const opened = result.bundle?.markers[0]?.sourceTimeMs ?? 0;
      // Premise: the second step came while the sheet was still sliding,
      // and the slide painted, or nothing below tests a moving page.
      expect(m2 - opened, evidence(opened, m2)).toBeLessThan(SLIDE_MS - 300);
      const slide = frames
        .map((f) => f.ms)
        .filter((ms) => ms > opened + 100 && ms < opened + SLIDE_MS);
      expect(
        slide.length,
        evidence(opened, opened + SLIDE_MS),
      ).toBeGreaterThanOrEqual(10);

      // The still is a screencast frame: the screencast's size, not the
      // full still's.
      const screencast = jpegSize(
        frames[frames.length - 1]?.bytes ?? new Uint8Array(),
      );
      expect(still?.width, evidence(m2 - 200, m2 + 400)).toBe(screencast.width);
      expect(still?.width).not.toBe(SCENE_VIEWPORT.width * REPLAY_DPR);

      // And no hole where the step's still was taken: nothing in the window
      // around the step wider than three of the slide's ordinary gaps. A
      // full still there was a hole of several frames on every machine.
      const around = slide.filter((ms) => ms >= m2 - 100 && ms <= m2 + 400);
      const typical = median(gaps(slide));
      const widest = Math.max(...gaps(around));
      expect(
        widest,
        `widest gap ${Math.round(widest)} ms against a typical ${Math.round(typical)} ms; ${evidence(m2 - 100, m2 + 400)}`,
      ).toBeLessThanOrEqual(Math.max(3 * typical, 50));
    }, FIXTURE);
  });

  it("is the full still when only a spinner repaints", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const { result, frames, marker, still, evidence } = await replay(
        page,
        cdp,
        twoClicks("next-btn", "other-btn"),
      );
      expect(result.outcome).toBe("complete");
      const m2 = marker?.sourceTimeMs ?? 0;
      // Premise: the spinner was painting up to the step, so the page was
      // judged on what changed, not on frames stopping.
      const before = frames.filter((f) => f.ms >= m2 - 100 && f.ms <= m2);
      expect(before.length, evidence(m2 - 100, m2)).toBeGreaterThanOrEqual(2);
      expect(still?.width, evidence(m2 - 100, m2 + 200)).toBe(
        SCENE_VIEWPORT.width * REPLAY_DPR,
      );
    }, FIXTURE);
  });
});
