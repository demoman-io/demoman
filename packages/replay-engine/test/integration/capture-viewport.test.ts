import { type CDPSession, chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  buildCaptureBundle,
  CAPTURE_MOTION_BUDGET_BYTES,
  decodeBase64,
  jpegSize,
  KEYFRAME_QUALITY,
} from "../../src/index.js";
import { FIXTURE_URL } from "../helpers/cdp-playwright";
import { scene } from "../helpers/replay-scene";

/**
 * What `Page.captureScreenshot` actually hands back to the capture harvester,
 * checked against a real browser instead of assumed.
 *
 * The popup measures `window.innerWidth/innerHeight` a second time after
 * Start and sends that as the take's viewport, because attaching the
 * harvester's debugger raises an infobar that shrinks the page. Whether that
 * correction genuinely describes the frames depends on what the screenshot
 * call returns — and the answer is not the one the design assumed.
 *
 * The harvester deliberately sends no `Emulation.setDeviceMetricsOverride`
 * (v9: the author is performing in this tab). This lane exists to pin what
 * that means for the pixels.
 */

const RECORDED = { width: 1280, height: 800 };
/** What the infobar leaves. The engine's own constant for this does not
 *  exist because the height is Chrome's, not ours; 765 is a plausible one. */
const AFTER_INFOBAR = { width: 1280, height: 765 };

async function withPage(
  dpr: number,
  fn: (ctx: {
    shoot: () => Promise<{ width: number; height: number }>;
    measure: () => Promise<{ width: number; height: number }>;
    shrink: () => Promise<void>;
    override: (deviceScaleFactor: number) => Promise<void>;
    // The raw session and page, for the screencast measurement below: it
    // needs to register a `Page.screencastFrame` listener and drive real
    // page motion, neither of which the four helpers above expose.
    session: CDPSession;
    page: Page;
  }) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: RECORDED,
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    await page.goto(FIXTURE_URL);
    await page.waitForSelector("#static-btn");

    await fn({
      // Byte for byte the call the harvester makes, and nothing else.
      shoot: async () => {
        const reply = (await session.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: KEYFRAME_QUALITY,
        })) as { data?: string };
        return jpegSize(decodeBase64(String(reply.data ?? "")));
      },
      measure: () =>
        page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        })),
      shrink: async () => {
        await page.setViewportSize(AFTER_INFOBAR);
        await page.waitForFunction(
          (h) => window.innerHeight === h,
          AFTER_INFOBAR.height,
        );
      },
      // Not something the harvester ever does — this is the replay engine's
      // regime, reproduced here only to show the two are different.
      override: async (deviceScaleFactor) => {
        await session.send("Emulation.setDeviceMetricsOverride", {
          ...AFTER_INFOBAR,
          deviceScaleFactor,
          mobile: false,
        });
      },
      session,
      page,
    });
  } finally {
    await browser.close();
  }
}

describe("capture-time viewport, against a real browser", () => {
  // The assumption this replaced was `frame ÷ dpr`. It is wrong: with no
  // override, the frame is CSS pixels whatever devicePixelRatio reports, so
  // dividing by 2 would have claimed a 640x400 viewport.
  it("returns CSS pixels, not viewport times devicePixelRatio", async () => {
    await withPage(2, async ({ shoot, measure }) => {
      const css = await measure();
      const frame = await shoot();

      expect(css).toEqual(RECORDED);
      expect(frame).toEqual(RECORDED);
      expect(frame.height).not.toBe(RECORDED.height * 2);
    });
  });

  // The shape of the bug: something shrinks the page after the first
  // measurement — in production, the infobar the harvester raises — and the
  // frames follow the page, not the number already recorded.
  it("follows the page when it shrinks under a measurement already taken", async () => {
    await withPage(2, async ({ shoot, measure, shrink }) => {
      const stale = await measure();
      await shrink();
      const corrected = await measure();
      const frame = await shoot();

      // The stale reading is what the document would have carried: 35 CSS px
      // taller than the pixels, a 4.6% vertical stretch, silently.
      expect(stale).toEqual(RECORDED);
      expect(corrected).toEqual(AFTER_INFOBAR);
      expect(frame.height).not.toBe(stale.height);
      // The re-measured one is the frames, exactly. This is the claim the
      // whole correction rests on, and it holds for the real call.
      expect(frame).toEqual(corrected);
    });
  });

  // Both regimes exist and nothing in the bytes says which produced them, so
  // the bundle's own recovery is anchored on the recorded width instead.
  it("recovers the true height from the frames at either scale", async () => {
    const stale = scene();
    expect(stale.meta.capture.viewport).toEqual(RECORDED);

    const viewports: { width: number; height: number }[] = [];
    await withPage(2, async ({ shoot, shrink, override }) => {
      await shrink();
      viewports.push(
        buildCaptureBundle(stale, [
          { sourceTimeMs: 0, ref: "kf:s:0", byteLength: 0, ...(await shoot()) },
        ]).viewport,
      );

      // The same page, shot the way replay shoots it: now 2x and 3x scaled.
      for (const deviceScaleFactor of [2, 3]) {
        await override(deviceScaleFactor);
        const frame = await shoot();
        expect(frame.width).toBe(AFTER_INFOBAR.width * deviceScaleFactor);
        viewports.push(
          buildCaptureBundle(stale, [
            { sourceTimeMs: 0, ref: "kf:s:0", byteLength: 0, ...frame },
          ]).viewport,
        );
      }
    });

    // One answer from three different frame sizes, and it is the corrected
    // viewport rather than the stale one the document carries.
    expect(viewports).toEqual([AFTER_INFOBAR, AFTER_INFOBAR, AFTER_INFOBAR]);
  });

  // Task 12: what `CAPTURE_MOTION_BUDGET_BYTES` is provisional on. Same
  // session, same no-override regime as the tests above, plus the
  // harvester's screencast alongside its keyframe shots — because the
  // budget is a bytes-per-take question and per-frame size is not
  // knowable without driving real paint through a real browser.
  it("records screencast and keyframe dimensions and bytes across real page motion", async () => {
    await withPage(2, async ({ shoot, session, page }) => {
      const spanFrames: { width: number; height: number; bytes: number }[] = [];
      session.on("Page.screencastFrame", (params) => {
        const bytes = decodeBase64(params.data);
        const size = jpegSize(bytes);
        spanFrames.push({ ...size, bytes: bytes.byteLength });
        // Byte for byte the harvester's own ack — Chrome sends nothing
        // further until the previous frame is acknowledged. Same swallow as
        // capture-frames.ts: a rejected ack (e.g. racing browser.close())
        // must not surface as an unhandled rejection.
        void session
          .send("Page.screencastFrameAck", { sessionId: params.sessionId })
          .catch(() => {});
      });

      // The harvester's exact screencast parameters (capture-frames.ts).
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        everyNthFrame: 1,
      });

      const keyframes: { width: number; height: number }[] = [];
      keyframes.push(await shoot());

      // Real page motion: open and close the fixture's 800ms-eased panel a
      // few times over. One open already produced ~50 screencast frames in
      // the measurement behind SPAN_MIN_FRAMES's comment; three round trips
      // is headroom against the >=30 floor this step needs, not a tuned
      // number.
      const motionStartedAt = Date.now();
      for (let i = 0; i < 3; i++) {
        await page.click("#animate-btn");
        await page.waitForTimeout(900);
        keyframes.push(await shoot());
        await page.evaluate(() =>
          document.querySelector("#panel")?.classList.remove("open"),
        );
        await page.waitForTimeout(900);
        await page.evaluate(() =>
          document.querySelector("#panel")?.classList.add("open"),
        );
      }
      await page.waitForTimeout(900);
      const motionMs = Date.now() - motionStartedAt;
      keyframes.push(await shoot());

      await session.send("Page.stopScreencast");
      // Frames already in flight when stopScreencast is sent can still
      // arrive after it resolves; give them a moment to land before reading
      // the collected set, the same drain the harvester does through
      // `motionInFlight` before it reads spans back.
      await page.waitForTimeout(200);

      // The invariant the design rests on: every span frame's dimensions
      // and every keyframe's dimensions are recorded, so the numbers reach
      // a human. Nothing about their absolute values is asserted here.
      expect(spanFrames.length).toBeGreaterThanOrEqual(30);
      for (const frame of spanFrames) {
        expect(frame.width).toBeGreaterThan(0);
        expect(frame.height).toBeGreaterThan(0);
        expect(frame.bytes).toBeGreaterThan(0);
      }
      expect(keyframes.length).toBeGreaterThan(0);
      for (const frame of keyframes) {
        expect(frame.width).toBeGreaterThan(0);
        expect(frame.height).toBeGreaterThan(0);
      }

      const meanSpanBytes =
        spanFrames.reduce((sum, f) => sum + f.bytes, 0) / spanFrames.length;
      // The observed rate over the actual driving window, not an assumed
      // fps: `spanFps` in production is likewise computed from the frames
      // and the span duration, never a fixed constant.
      const observedFps = spanFrames.length / (motionMs / 1000);
      const impliedBytesPerSecond = meanSpanBytes * observedFps;
      const impliedMinutes =
        CAPTURE_MOTION_BUDGET_BYTES / impliedBytesPerSecond / 60;

      const screencastWxH = `${spanFrames[0]?.width}x${spanFrames[0]?.height}`;
      const keyframeWxH = `${keyframes[0]?.width}x${keyframes[0]?.height}`;
      console.log(
        `[capture-viewport] screencast ${screencastWxH} (n=${spanFrames.length}), ` +
          `keyframe ${keyframeWxH} (n=${keyframes.length}), ` +
          `mean ${meanSpanBytes.toFixed(0)} bytes/span-frame, ` +
          `observed ${observedFps.toFixed(1)} fps, ` +
          `implied ${impliedMinutes.toFixed(1)} min at CAPTURE_MOTION_BUDGET_BYTES ` +
          `(${(CAPTURE_MOTION_BUDGET_BYTES / (1024 * 1024)).toFixed(0)} MB)`,
      );
    });
  });
});
