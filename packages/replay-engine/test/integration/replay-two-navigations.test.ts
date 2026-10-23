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
 * A take that navigates twice: page one to page two to page three.
 *
 * The lane's existing navigation test stops at one hop, and one hop cannot
 * show the reported defect — a video that reaches the third page and then
 * flips back and forth between the second and the third a few times before
 * settling. Two hops is the smallest take that can, because it is the first
 * one with two documents behind the current one to flip back to.
 *
 * The three pages are told apart by JPEG size, the classifier this lane
 * already uses: blank white compresses to tens of KB, quarter-height noise to
 * around a megabyte, and full-viewport noise to several. The bands are an
 * order of magnitude apart, so nothing in between is possible.
 */
const BLANK_MAX_BYTES = 400_000;
const SPARSE_MAX_BYTES = 3_000_000;

type Page = "one" | "two" | "three";

function shows(bytes: number): Page {
  if (bytes < BLANK_MAX_BYTES) return "one";
  return bytes < SPARSE_MAX_BYTES ? "two" : "three";
}

/** A page painting `fraction` of its height with noise, linking onward. */
function noisePage(title: string, href: string, fraction: number): string {
  return `<!doctype html><meta charset=utf-8><title>${title}</title>
<style>html,body{margin:0;height:100%;overflow:hidden}
canvas{display:block}a{position:absolute;top:8px;left:8px;z-index:1;font:16px system-ui;background:#fff}</style>
<a id="onward" href="${href}">onward</a>
<canvas id="c" width="${SCENE_VIEWPORT.width}" height="${SCENE_VIEWPORT.height}"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  const h = Math.round(${SCENE_VIEWPORT.height} * ${fraction});
  const img = ctx.createImageData(${SCENE_VIEWPORT.width}, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (i * 7919) % 255;
    img.data[i + 1] = (i * 104729) % 255;
    img.data[i + 2] = (i * 1299709) % 255;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Keep painting after load, the way a content page does while its images
  // and its client-side chrome arrive. This is what holds a motion span open
  // across the navigation, which is the condition the static fixture never
  // reproduced and the reported take always has.
  let n = 0;
  const tick = () => {
    ctx.fillStyle = n % 2 ? "#000" : "#fff";
    ctx.fillRect(0, ${SCENE_VIEWPORT.height} - 20, 40 + n, 12);
    if (++n < 40) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
</script>`;
}

async function withSite(
  fn: (ctx: {
    url: string;
    cdp: CdpSession;
    page: import("playwright").Page;
  }) => Promise<void>,
): Promise<void> {
  const first = `<!doctype html><meta charset=utf-8><title>one</title>
<style>html,body{margin:0;background:#fff;height:100%}
a{position:absolute;top:40px;left:40px;font:16px system-ui}</style>
<a id="onward" href="/two">onward</a>`;
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/two") res.end(noisePage("two", "/three", 0.25));
    else if (req.url === "/three") res.end(noisePage("three", "/two", 1));
    else res.end(first);
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

/** Parks the onward link, in whichever document is current. */
function linkAgent(page: import("playwright").Page): PageAgent {
  return {
    async resolve(anchors): Promise<ResolveReport[]> {
      return Promise.all(
        anchors.map(async (anchor) => {
          const parked = await page
            .evaluate(
              ({ key, id }) => {
                const el = document.querySelector("#onward");
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
            failureReason: parked ? null : ("notInTree" as const),
          };
        }),
      );
    },
  };
}

describe("a take that navigates twice", () => {
  it("never shows a page it has already left", async () => {
    await withSite(async ({ url, cdp, page }) => {
      const store = createMemoryFrameStore();
      const base = scene({ anchorIds: ["onward-1", "onward-2"] });
      const doc: SceneDocument = {
        ...base,
        actions: [
          {
            id: "act-1",
            kind: "click",
            anchorId: "onward-1",
            timestamp: 0,
            marker: "click:onward-1",
          },
          {
            id: "act-2",
            kind: "waitFor",
            anchorId: null,
            timestamp: 900,
            marker: "waitFor:nav-1",
            condition: "loaded",
          },
          {
            id: "act-3",
            kind: "click",
            anchorId: "onward-2",
            timestamp: 1800,
            marker: "click:onward-2",
          },
          {
            id: "act-4",
            kind: "waitFor",
            anchorId: null,
            timestamp: 2700,
            marker: "waitFor:nav-2",
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
      const sized = await Promise.all(
        keyframes.map(async (k) => ({
          sourceTimeMs: k.sourceTimeMs,
          actionId: k.actionId,
          page: shows((await store.load(k.ref)).byteLength),
          bytes: (await store.load(k.ref)).byteLength,
        })),
      );
      console.log(
        "[2nav] outcome:",
        result.outcome,
        result.reason,
        `${result.completed}/${result.total}`,
      );
      console.log(
        "[2nav] keyframes:",
        sized.map(
          (s) =>
            `${s.sourceTimeMs.toFixed(0)}ms ${s.actionId ?? "-"} ${s.page} (${s.bytes}B)`,
        ),
      );
      console.log(
        "[2nav] spans:",
        (result.bundle?.motionSpans ?? []).map(
          (m) => `${m.startMs.toFixed(0)}..${m.endMs.toFixed(0)}ms`,
        ),
      );
      console.log(
        "[2nav] degradations:",
        (result.bundle?.degradations ?? []).map((d) => `${d.kind}: ${d.note}`),
      );

      // The premise: this take really did make both hops. Without it a bundle
      // that never left page one would satisfy everything below.
      expect(sized.some((s) => s.page === "two")).toBe(true);
      expect(sized.some((s) => s.page === "three")).toBe(true);

      // The claim. A document the take has left must never come back: the
      // keyframes, read in time order, must be non-decreasing in page order.
      // A flip is exactly a decrease, and it is what the author sees as the
      // video arriving on a page, snapping back to the one before it, and
      // arriving again.
      const order: Record<Page, number> = { one: 0, two: 1, three: 2 };
      const seen = sized.map((s) => order[s.page]);
      expect(seen).toEqual([...seen].sort((a, b) => a - b));

      // The condition the compositor's trailing-span rule exists for, pinned
      // here because it is a property of the *engine*: every span ends before
      // the keyframe that follows it, so there is always a stretch the span
      // has left and no keyframe has yet reached. The compositor answers it
      // with the span's last frame; answering it with the nearest keyframe at
      // or before — which is what it did — draws the page the take just left.
      // See `packages/compositor/test/browser/frame-source-gap.test.ts`.
      const spans = result.bundle?.motionSpans ?? [];
      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) {
        const next = sized.find((k) => k.sourceTimeMs >= span.endMs);
        expect(next).toBeDefined();
        console.log(
          `[2nav] gap after span ending ${span.endMs.toFixed(0)}ms: ` +
            `${((next?.sourceTimeMs ?? 0) - span.endMs).toFixed(0)}ms`,
        );
      }
    });
  }, 60_000);
});
