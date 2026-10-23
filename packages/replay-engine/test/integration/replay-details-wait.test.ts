import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { runReplay, WAIT_TIMEOUT_MS } from "../../src/index.js";
import {
  selectorPageAgent,
  withReplayBrowser,
} from "../helpers/cdp-playwright";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { scene } from "../helpers/replay-scene";

/**
 * `waitFor` on the content of a closed `<details>`.
 *
 * The agent door's snapshot reports such an element with `rect: null`, because
 * it asks `checkVisibility()`. The run asked `DOM.getBoxModel` instead, and
 * Chrome 151+ still lays a closed `<details>`'s content out a box
 * (`::details-content` is `content-visibility: hidden`). So a script that
 * waited for an FAQ answer to be `visible` passed the wait with the answer
 * still folded away, and a wait for it to be `hidden` could never pass at
 * all — the two halves of the run disagreed about the same element.
 *
 * Real Chromium over CDP, because the defect lives in what CDP answers; the
 * in-page browser lane holds no debugger session and cannot ask it.
 */

const DETAILS_URL = pathToFileURL(
  join(import.meta.dirname, "..", "fixtures", "details-app.html"),
).href;

const SELECTORS = {
  "faq-q": "#faq-q",
  answer: "#answer",
  "open-answer": "#open-answer",
};

const clock = () => ({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
});

type Step =
  | { kind: "click"; anchorId: string }
  | { kind: "waitFor"; anchorId: string; condition: "visible" | "hidden" };

function detailsScene(steps: Step[]): SceneDocument {
  const base = scene({ anchorIds: Object.keys(SELECTORS) });
  return {
    ...base,
    meta: {
      ...base.meta,
      capture: { ...base.meta.capture, originUrl: DETAILS_URL },
    },
    actions: steps.map((step, i) => ({
      id: `act-${i + 1}`,
      timestamp: i * 900,
      marker: `${step.kind}:${step.anchorId}`,
      ...step,
    })),
  } as SceneDocument;
}

async function replayIn(
  cdp: Parameters<typeof runReplay>[1]["cdp"],
  page: Parameters<typeof selectorPageAgent>[0],
  doc: SceneDocument,
) {
  const store = createMemoryFrameStore();
  return runReplay(doc, {
    cdp,
    page: selectorPageAgent(page, SELECTORS),
    encoder: createNodeFrameEncoder(store, doc.meta.id),
    store,
    clock: clock(),
    mayReplay: true,
    madeFrom: madeFromOf(doc),
  });
}

const OPTS = { url: DETAILS_URL, readySelector: "#faq-q" };

describe("waitFor on a closed <details>'s content", () => {
  // The premise every case below stands on, asserted rather than assumed: the
  // answer is not shown, and CDP still gives it a box. If a future Chrome
  // stops laying it out, `DOM.getBoxModel` rejects, the rect-based check
  // agrees with the snapshot again, and the cases below would pass without
  // testing anything — so this goes red first and says why.
  it("is not shown, yet CDP still gives it a box", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const shown = await page.evaluate(() => ({
        open: (document.querySelector("#faq") as HTMLDetailsElement).open,
        answer: (
          document.querySelector("#answer") as Element
        ).checkVisibility(),
        openAnswer: (
          document.querySelector("#open-answer") as Element
        ).checkVisibility(),
      }));
      expect(shown).toEqual({ open: false, answer: false, openAnswer: true });

      const { result } = (await cdp.send("Runtime.evaluate", {
        expression: "document.querySelector('#answer')",
      })) as { result: { objectId?: string } };
      expect(result.objectId, "the answer is in the tree").toBeDefined();
      const { model } = (await cdp.send("DOM.getBoxModel", {
        objectId: result.objectId,
      })) as { model?: { border?: number[] } };
      expect(
        model?.border,
        "CDP no longer gives a closed <details>'s content a box; the premise of this file is gone",
      ).toHaveLength(8);
    }, OPTS);
  });

  it(
    "does not pass a `visible` wait while the answer is folded away",
    async () => {
      await withReplayBrowser(async ({ cdp, page }) => {
        const result = await replayIn(
          cdp,
          page,
          detailsScene([
            { kind: "waitFor", anchorId: "answer", condition: "visible" },
          ]),
        );
        expect(
          { outcome: result.outcome, reason: result.reason },
          `the wait passed on an answer nobody opened; markers: ${JSON.stringify(result.bundle?.markers ?? null)}`,
        ).toEqual({ outcome: "partial", reason: "waitTimeout" });
        // Nothing opened it while the run waited: the timeout is the page's
        // truth, not a page that changed under the test.
        expect(
          await page.evaluate(
            () => (document.querySelector("#faq") as HTMLDetailsElement).open,
          ),
        ).toBe(false);
      }, OPTS);
      // The run waits out `WAIT_TIMEOUT_MS` (10 s) by design before it can say
      // `waitTimeout`; the lane's 60 s covers it with CI's slower launch.
    },
    WAIT_TIMEOUT_MS + 50_000,
  );

  it("passes a `hidden` wait on the folded answer", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const result = await replayIn(
        cdp,
        page,
        detailsScene([
          { kind: "waitFor", anchorId: "answer", condition: "hidden" },
        ]),
      );
      expect({ outcome: result.outcome, reason: result.reason }).toEqual({
        outcome: "complete",
        reason: null,
      });
    }, OPTS);
  });

  // The controls: a visible-wait still passes on content that is shown —
  // already open, and opened by the run's own click. Without these, a fix
  // that made every `visible` wait time out would pass the two cases above.
  it("still passes a `visible` wait on an open answer, and on one the run opened", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const result = await replayIn(
        cdp,
        page,
        detailsScene([
          { kind: "waitFor", anchorId: "open-answer", condition: "visible" },
          { kind: "click", anchorId: "faq-q" },
          { kind: "waitFor", anchorId: "answer", condition: "visible" },
        ]),
      );
      expect(
        { outcome: result.outcome, reason: result.reason },
        `markers: ${JSON.stringify(result.bundle?.markers ?? null)}`,
      ).toEqual({ outcome: "complete", reason: null });
      // The click is what opened it, so the last wait met a real opening.
      expect(
        await page.evaluate(
          () => (document.querySelector("#faq") as HTMLDetailsElement).open,
        ),
      ).toBe(true);
    }, OPTS);
  });
});
