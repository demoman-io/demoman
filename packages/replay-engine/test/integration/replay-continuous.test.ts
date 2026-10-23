import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { REPLAY_DPR, runReplay, SPAN_MAX_MS } from "../../src/index.js";
import {
  selectorPageAgent,
  withReplayBrowser,
} from "../helpers/cdp-playwright";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { SCENE_VIEWPORT, scene } from "../helpers/replay-scene";

/**
 * Continuous replay (spec 2026-10-03) against a real Chromium: the page's own
 * motion is kept through a hold, and a sharp still lands once it stops.
 *
 * The fixture's pulsing square stands in for a landing page's hero video —
 * the case that started this: a background video frozen through a 2.2 s
 * hold and jumping to another scene during the cursor move. It pulses from
 * load, on the compositor thread, until `#stop-btn` stops it; `#start-btn`
 * is a click target that changes nothing while it already pulses.
 */

const FIXTURE = {
  url: pathToFileURL(
    join(import.meta.dirname, "..", "fixtures", "continuous-app.html"),
  ).href,
  readySelector: "#start-btn",
};
/** The recorded gap between the two clicks: long enough that a stretch of it
 *  lies past any verb span's ceiling, which is where sampling saw nothing. */
const RECORDED_GAP_MS = 5000;
/** The centre of #pulse, in CSS px. */
const PULSE = { x: 140, y: 140 };

const clock = () => ({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
});

/** Decode a screencast JPEG in the page and read one CSS-px point of it. */
async function rgbAt(page: Page, bytes: Uint8Array): Promise<number[]> {
  return page.evaluate(
    async ({ b64, x, y, cssWidth }) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / cssWidth;
      const d = ctx.getImageData(
        Math.round(x * scale),
        Math.round(y * scale),
        1,
        1,
      ).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
    },
    {
      b64: Buffer.from(bytes).toString("base64"),
      x: PULSE.x,
      y: PULSE.y,
      cssWidth: SCENE_VIEWPORT.width,
    },
  );
}

function startThenStop(): SceneDocument {
  const doc = scene({ anchorIds: ["start-btn", "stop-btn"] });
  const [a, b] = doc.actions as [
    (typeof doc.actions)[number],
    (typeof doc.actions)[number],
  ];
  return {
    ...doc,
    actions: [
      { ...a, timestamp: 0 },
      { ...b, timestamp: RECORDED_GAP_MS },
    ],
  } as SceneDocument;
}

const agentFor = (page: Page) =>
  selectorPageAgent(page, {
    "start-btn": "#start-btn",
    "stop-btn": "#stop-btn",
  });

describe("continuous replay against a real browser", () => {
  it("keeps the page's own motion through a hold, on decoded pixels", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      // The premise: the fixture animates on its own from load, as a hero
      // video does — no click starts it.
      const animates = await page.evaluate(async () => {
        const pulse = document.getElementById("pulse") as HTMLElement;
        const a = getComputedStyle(pulse).opacity;
        await new Promise((r) => setTimeout(r, 300));
        const b = getComputedStyle(pulse).opacity;
        return a !== b;
      });
      expect(animates, "the fixture's pulse no longer animates").toBe(true);

      const store = createMemoryFrameStore();
      const doc = startThenStop();
      const encoder = createNodeFrameEncoder(store, doc.meta.id);
      const result = await runReplay(doc, {
        cdp,
        page: agentFor(page),
        encoder,
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
        recording: "continuous",
      });
      expect(result.outcome).toBe("complete");
      expect(result.bundle?.timing).toBe("real");

      const [m1, m2] = (result.bundle?.markers ?? []).map(
        (m) => m.sourceTimeMs,
      );
      // The premise of the window below: pacing held the recorded gap. To
      // the millisecond less one: the walk sleeps with setTimeout, which
      // keeps its own millisecond clock, and Date.now() read on waking can
      // stand 1 ms short of the target (CI, 2026-10-18: 4999 of 5000). A
      // pacing fault misses by a frame or more.
      expect((m2 ?? 0) - (m1 ?? 0)).toBeGreaterThanOrEqual(RECORDED_GAP_MS - 1);
      // The stretch no verb span could reach: past the start click's
      // ceiling and before the stop click.
      const from = (m1 ?? 0) + SPAN_MAX_MS + 300;
      const to = (m2 ?? 0) - 300;
      const inHold = encoder.pushed().filter((f) => f.ms >= from && f.ms <= to);
      const evidence = `frames in [${Math.round(from)}, ${Math.round(to)}]: ${inHold.length}; all frame times: ${encoder
        .pushed()
        .map((f) => Math.round(f.ms))
        .join(",")}`;
      expect(inHold.length, evidence).toBeGreaterThanOrEqual(2);
      // The pulse's red channel across the hold, every third frame: a blue
      // square fading over white reads 0 opaque and ~230 at its faintest. Its
      // spread, not its endpoints: the pulse cycles every 2 s, so two frames
      // a whole cycle apart read the same colour (seen 2026-10-03 on the
      // earlier colour fixture: equal at both ends of a hold that swept
      // 54 -> 247 -> 114 between them).
      const reds: [number, number][] = [];
      for (const f of inHold.filter((_, i) => i % 3 === 0)) {
        reds.push([Math.round(f.ms), (await rgbAt(page, f.bytes))[0] ?? 0]);
      }
      const values = reds.map(([, r]) => r);
      // Evidence for a red run, which cannot be reproduced from here: what
      // the page itself says the pulse is doing now, and every frame time.
      const live = await page.evaluate(() => ({
        pulsing: document.body.classList.contains("pulsing"),
        animations: document.getAnimations().map((a) => a.playState),
        opacity: getComputedStyle(document.getElementById("pulse") as Element)
          .opacity,
      }));
      expect(
        Math.max(...values) - Math.min(...values),
        `pulse red across the hold (ms, r): ${JSON.stringify(reds)}; page now ${JSON.stringify(live)}; ${evidence}`,
      ).toBeGreaterThan(40);
    }, FIXTURE);
    // A 5 s recorded gap plus a real browser: about 7 s here, doubled and
    // then some for CI's slower runner.
  }, 30_000);

  // Between the two clicks, not at the end: the closing still lands after
  // the last marker whatever the recorder does, so a still asserted there
  // passed with the settled still disconnected (final review I4). Here the
  // first click stops the pulse and the second restarts it, so the page is
  // quiet between them — which is where the sharp still has to be.
  it("takes a sharp still once the page stops moving", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();
      const base = scene({ anchorIds: ["stop-btn", "start-btn"] });
      const [a, b] = base.actions as [
        (typeof base.actions)[number],
        (typeof base.actions)[number],
      ];
      const doc = {
        ...base,
        actions: [
          { ...a, timestamp: 0 },
          { ...b, timestamp: 4000 },
        ],
      } as SceneDocument;
      const encoder = createNodeFrameEncoder(store, doc.meta.id);
      const result = await runReplay(doc, {
        cdp,
        page: agentFor(page),
        encoder,
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
        recording: "continuous",
      });
      expect(result.outcome).toBe("complete");
      const [m1, m2] = (result.bundle?.markers ?? []).map(
        (m) => m.sourceTimeMs,
      );
      // The premise: the pulse was painting before the stop click.
      expect(
        encoder.pushed().filter((f) => f.ms < (m1 ?? 0)).length,
      ).toBeGreaterThanOrEqual(3);
      const settled = result.bundle?.keyframes.find(
        (k) =>
          k.actionId === null &&
          k.sourceTimeMs > (m1 ?? 0) &&
          k.sourceTimeMs < (m2 ?? 0),
      );
      expect(
        settled,
        `keyframes: ${JSON.stringify(result.bundle?.keyframes.map((k) => [Math.round(k.sourceTimeMs), k.actionId]))}; markers ${Math.round(m1 ?? 0)}, ${Math.round(m2 ?? 0)}`,
      ).toBeDefined();
      expect(settled?.width).toBe(SCENE_VIEWPORT.width * REPLAY_DPR);
    }, FIXTURE);
  }, 30_000);
});
