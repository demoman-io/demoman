import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import type { PageAgent, ResolveReport } from "../../src/index.js";
import { REPLAY_TARGETS, runReplay } from "../../src/index.js";
import { wrapCdp } from "../helpers/cdp-playwright";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { scene } from "../helpers/replay-scene";

/**
 * How much of a scrolling take the video actually contains.
 *
 * The corrective scroll used to be instant and to run before the span opened,
 * so nothing recorded it. Measured here before the change: a beat travelled
 * 843px in a cut and 389px in the recorded smooth scroll, and the next beat
 * jumped 1452px. Two thirds of the movement was missing from the deliverable,
 * which is what the author saw as a demo that jumps around the page.
 *
 * The assertion is about coverage, not about smoothness: every pixel the page
 * travels must fall inside some motion span, because a span is the only thing
 * the compositor can draw movement from. A pixel that moves outside one is a
 * cut by construction.
 */
const PAGE = `<!doctype html><meta charset=utf-8><title>tall</title>
<style>html,body{margin:0}section{height:1800px;border-bottom:1px solid #ccc;
font:20px system-ui;padding:20px}b{display:block;margin-top:1600px;background:#fd0}</style>
<section><b id="t-1">one</b></section>
<section><b id="t-2">two</b></section>
<section><b id="t-3">three</b></section>`;

function agentFor(page: import("playwright").Page): PageAgent {
  return {
    async resolve(anchors): Promise<ResolveReport[]> {
      return Promise.all(
        anchors.map(async (a) => {
          const ok = await page
            .evaluate(
              ({ key, id }) => {
                const el = document.querySelector(`#${id}`);
                const w = window as unknown as Record<
                  string,
                  Record<string, unknown>
                >;
                w[key] = w[key] ?? {};
                if (el) w[key][id] = el;
                return el !== null;
              },
              { key: REPLAY_TARGETS, id: a.id },
            )
            .catch(() => false);
          return {
            anchorId: a.id,
            strategy: ok ? ("stableId" as const) : ("broken" as const),
            resolved: ok,
            failureReason: ok ? null : ("notInTree" as const),
          };
        }),
      );
    },
  };
}

describe("a take that scrolls down a long page", () => {
  it("records the travel instead of cutting to it", async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/`;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1024, height: 640 },
      });
      const session = await page.context().newCDPSession(page);
      const cdp = wrapCdp(session);
      await page.goto(url, { waitUntil: "load" });

      const t0 = Date.now();
      // The real scroll position, sampled independently of the bundle. This
      // is the ground truth the bundle's spans are checked against — without
      // it a take that scrolled nowhere would satisfy any coverage claim.
      const trace: { at: number; y: number }[] = [];
      const sampler = setInterval(() => {
        void page
          .evaluate(() => Math.round(window.scrollY))
          .then((y) => trace.push({ at: Date.now() - t0, y }))
          .catch(() => undefined);
      }, 30);

      const base = scene({ anchorIds: ["t-1", "t-2", "t-3"] });
      const doc: SceneDocument = {
        ...base,
        actions: ["t-1", "t-2", "t-3"].map((id, i) => ({
          id: `act-${i + 1}`,
          kind: "scrollTo" as const,
          anchorId: id,
          timestamp: i * 900,
          marker: `scrollTo:${id}`,
        })),
        meta: {
          ...base.meta,
          capture: { ...base.meta.capture, originUrl: url },
        },
      } as SceneDocument;

      const store = createMemoryFrameStore();
      const result = await runReplay(doc, {
        cdp,
        page: agentFor(page),
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
      clearInterval(sampler);

      const spans = result.bundle?.motionSpans ?? [];
      const covered = (ms: number): boolean =>
        spans.some((s) => ms >= s.startMs && ms <= s.endMs);

      let travelled = 0;
      let uncovered = 0;
      for (let i = 1; i < trace.length; i++) {
        const previous = trace[i - 1] as { at: number; y: number };
        const current = trace[i] as { at: number; y: number };
        const moved = Math.abs(current.y - previous.y);
        if (moved === 0) continue;
        travelled += moved;
        if (!covered(current.at)) uncovered += moved;
      }
      console.log(
        `[scroll] travelled ${travelled}px, ${uncovered}px outside any span ` +
          `(${((uncovered / travelled) * 100).toFixed(0)}%)`,
      );
      console.log(
        "[scroll] spans:",
        spans.map((s) => `${s.startMs.toFixed(0)}..${s.endMs.toFixed(0)}ms`),
      );

      // The premise: this take really did travel a long way. Without it a
      // page that never scrolled would satisfy the claim below trivially.
      expect(result.outcome).toBe("complete");
      expect(travelled).toBeGreaterThan(3000);

      // The claim. Every pixel of travel is inside a span, so the compositor
      // has something to draw it from. Before this, two thirds of it was a
      // cut. The margin is for the sampler's own granularity — it reads the
      // page every 30ms, so a sample can straddle a span boundary.
      expect(uncovered / travelled).toBeLessThan(0.1);
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});
