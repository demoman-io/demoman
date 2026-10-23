import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import type { CdpSession, PageAgent, ResolveReport } from "../../src/index.js";
import { REPLAY_TARGETS, runReplay } from "../../src/index.js";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { SCENE_VIEWPORT, scene } from "../helpers/replay-scene";

/**
 * A take whose click leaves the page.
 *
 * The lane's own fixture never navigates, so nothing here has ever harvested
 * across a document swap — and a demo that clicks a search result is the
 * ordinary case, not an exotic one. What this asks is the simplest question
 * there is about such a take: does every frame in the bundle show the page
 * that was on screen at the instant the frame is filed under?
 *
 * The two pages are told apart by JPEG size rather than by decoding: the
 * first is blank white and compresses to a few KB, the second paints
 * full-viewport noise and compresses to hundreds. Nothing in between is
 * possible, so a threshold either side of the gap is a reliable classifier.
 */

/**
 * Measured, not guessed: keyframes come back at the emulated 3840x2400, where
 * the blank results page is ~62KB and the noise article ~5.8MB. An earlier
 * threshold calibrated at 800x600 put both pages on the same side of the line
 * and the test passed without exercising anything.
 */
const BLANK_MAX_BYTES = 1_000_000;

async function withSite(
  fn: (ctx: {
    url: string;
    cdp: CdpSession;
    page: import("playwright").Page;
  }) => Promise<void>,
): Promise<void> {
  const first = `<!doctype html><meta charset=utf-8><title>results</title>
<style>html,body{margin:0;background:#fff;height:100%}
a{position:absolute;top:40px;left:40px;font:16px system-ui}</style>
<a id="result" href="/article">the result</a>`;
  const second = `<!doctype html><meta charset=utf-8><title>article</title>
<style>html,body{margin:0;height:100%;overflow:hidden}canvas{display:block}</style>
<canvas id="c" width="${SCENE_VIEWPORT.width}" height="${SCENE_VIEWPORT.height}"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  const img = ctx.createImageData(${SCENE_VIEWPORT.width}, ${SCENE_VIEWPORT.height});
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (i * 7919) % 255;
    img.data[i + 1] = (i * 104729) % 255;
    img.data[i + 2] = (i * 1299709) % 255;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
</script>`;
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/article" ? second : first);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1024, height: 640 },
    });
    const session = await page.context().newCDPSession(page);
    const cdp: CdpSession = {
      send: (method, params) =>
        session.send(method as never, params as never) as Promise<
          Record<string, unknown>
        >,
      on: (event, handler) => {
        const wrapped = (params: unknown): void =>
          handler((params ?? {}) as Record<string, unknown>);
        session.on(event as never, wrapped as never);
        return () => session.off(event as never, wrapped as never);
      },
      detach: async () => {
        await session.detach().catch(() => undefined);
      },
    };
    await fn({ url: `http://127.0.0.1:${port}/`, cdp, page });
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/** Parks the link by selector, in whichever document is current. */
function linkAgent(page: import("playwright").Page): PageAgent {
  return {
    async resolve(anchors): Promise<ResolveReport[]> {
      return Promise.all(
        anchors.map(async (anchor) => {
          const parked = await page
            .evaluate(
              ({ key, id }) => {
                const el = document.querySelector("#result");
                const w = window as unknown as Record<
                  string,
                  Record<string, unknown>
                >;
                w[key] = w[key] ?? {};
                if (el) w[key][id] = el;
                return el !== null;
              },
              { key: REPLAY_TARGETS, id: anchor.id },
            )
            .catch(() => false);
          return {
            anchorId: anchor.id,
            strategy: parked ? ("stableId" as const) : ("broken" as const),
            resolved: parked,
            // `notInTree` and not `anchorNotRendered`: the latter is a stop
            // reason the engine derives, not one a resolver may report, and
            // `ResolveReport["failureReason"]` does not accept it.
            failureReason: parked ? null : ("notInTree" as const),
          };
        }),
      );
    },
  };
}

describe("a take whose click navigates", () => {
  it("files every keyframe under an instant its own picture belongs to", async () => {
    await withSite(async ({ url, cdp, page }) => {
      const store = createMemoryFrameStore();
      const base = scene({ anchorIds: ["result"] });
      const doc: SceneDocument = {
        ...base,
        // A `waitFor` after the click, which is what the sensor records for a
        // click that navigates and what the fixture's click-only action list
        // never had. Without it this lane cannot see the defect it now pins:
        // the wait is the beat that owns the arrival, and it used to own no
        // picture of it.
        actions: [
          ...base.actions,
          {
            id: "act-nav",
            anchorId: null,
            timestamp: 9000,
            marker: "waitFor:navigation",
            kind: "waitFor",
            condition: "loaded",
          },
        ],
        meta: {
          ...base.meta,
          capture: { ...base.meta.capture, originUrl: url },
        },
        sideChannels: {
          ...base.sideChannels,
          urlTrace: [{ url, timestamp: 0 }],
        },
      } as SceneDocument;

      await page.goto(url, { waitUntil: "load" });

      const result = await runReplay(doc, {
        cdp,
        page: linkAgent(page),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: {
          now: () => Date.now(),
          sleep: (ms: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, ms)),
        },
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      const keyframes = result.bundle?.keyframes ?? [];
      expect(keyframes.length).toBeGreaterThan(1);

      const sized = await Promise.all(
        keyframes.map(async (k) => ({
          sourceTimeMs: k.sourceTimeMs,
          actionId: k.actionId,
          bytes: (await store.load(k.ref)).byteLength,
        })),
      );
      const shows = (b: number) =>
        b > BLANK_MAX_BYTES ? "article" : "results";
      console.log(
        "[nav] keyframes:",
        sized.map(
          (s) =>
            `${s.sourceTimeMs.toFixed(0)}ms ${shows(s.bytes)} (${s.bytes}B)`,
        ),
      );
      console.log(
        "[nav] spans:",
        (result.bundle?.motionSpans ?? []).map(
          (m) =>
            `${m.startMs.toFixed(0)}..${m.endMs.toFixed(0)}ms ${m.width}x${m.height} @${m.fps}fps`,
        ),
      );
      console.log(
        "[nav] degradations:",
        (result.bundle?.degradations ?? []).map((d) => `${d.kind}: ${d.note}`),
      );

      // The premise: this take really did leave the first page. Without it a
      // bundle of nothing but the results page would satisfy everything below.
      expect(sized.some((s) => shows(s.bytes) === "article")).toBe(true);

      // Once the take has reached the article it must not show the results
      // page again. A keyframe filed after the navigation whose picture is
      // the page before it is the jump: the video arrives, snaps back, and
      // arrives a second time.
      const firstArticle = sized.findIndex((s) => shows(s.bytes) === "article");
      const after = sized.slice(firstArticle);
      expect(after.map((s) => shows(s.bytes))).toEqual(
        after.map(() => "article"),
      );

      // The wait owns the arrival, so the wait must own a picture of it.
      // Without a frame of its own the compositor's `stillSourceMs` falls
      // back to the nearest keyframe at or before this marker — the results
      // page — and the video holds the page the click left, across the whole
      // load and until the next positioned action.
      const wait = sized.find((s) => s.actionId === "act-nav");
      expect(wait).toBeDefined();
      expect(shows(wait?.bytes as number)).toBe("article");
    });
  }, 60_000);

  // Review Focus 5 (plan 2026-10-03): the same navigation under continuous
  // recording completes, validates as real-time, and records the paint
  // between the click and the new page landing.
  it("records the navigation's own paint under continuous recording", async () => {
    await withSite(async ({ url, cdp, page }) => {
      const store = createMemoryFrameStore();
      const base = scene({ anchorIds: ["result"] });
      const doc: SceneDocument = {
        ...base,
        actions: [
          ...base.actions,
          {
            id: "act-nav",
            anchorId: null,
            timestamp: 9000,
            marker: "waitFor:navigation",
            kind: "waitFor",
            condition: "loaded",
          },
        ],
        meta: {
          ...base.meta,
          capture: { ...base.meta.capture, originUrl: url },
        },
        sideChannels: {
          ...base.sideChannels,
          urlTrace: [{ url, timestamp: 0 }],
        },
      } as SceneDocument;

      await page.goto(url, { waitUntil: "load" });

      const encoder = createNodeFrameEncoder(store, doc.meta.id);
      const result = await runReplay(doc, {
        cdp,
        page: linkAgent(page),
        encoder,
        store,
        clock: {
          now: () => Date.now(),
          sleep: (ms: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, ms)),
        },
        mayReplay: true,
        madeFrom: madeFromOf(doc),
        recording: "continuous",
      });

      expect(result.outcome).toBe("complete");
      // The bundle validated on the way out (the walk calls validateBundle),
      // so a null bundle here would be that refusal.
      expect(result.bundle).not.toBeNull();
      expect(result.bundle?.timing).toBe("real");
      const navAt =
        result.bundle?.markers.find((m) => m.actionId === "act-nav")
          ?.sourceTimeMs ?? 0;
      const clickAt =
        result.bundle?.markers.find((m) => m.actionId === "act-1")
          ?.sourceTimeMs ?? 0;
      expect(
        encoder.pushed().some((f) => f.ms > clickAt && f.ms <= navAt),
        `frame times ${encoder
          .pushed()
          .map((f) => Math.round(f.ms))
          .join(",")}; click ${Math.round(clickAt)}, nav ${Math.round(navAt)}`,
      ).toBe(true);
    });
  }, 60_000);
});
