import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { madeFromOf } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import type { CdpFrameNode } from "../../src/index.js";
import { KEYFRAME_QUALITY, REPLAY_DPR, runReplay } from "../../src/index.js";
import {
  CONTEXT_DPR,
  CONTEXT_VIEWPORT,
  FIXTURE_URL,
  selectorPageAgent,
  withReplayBrowser,
} from "../helpers/cdp-playwright";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { SCENE_VIEWPORT, scene } from "../helpers/replay-scene";

/** The fixture's `#panel` height transition — the animation the motion-span
 *  test measures. Asserted against the fixture itself rather than trusted:
 *  a duration assertion whose fixture had stopped animating would go green
 *  while measuring nothing. */
const PANEL_TRANSITION_MS = 800;

/** A floor on repaints per second, well under any real browser's rate and
 *  well over what a one-shot paint can reach. This is the machine-independent
 *  form of "painted throughout the transition": a frame *count* is a paint
 *  rate times a duration, and the rate belongs to the machine — 46/s on a dev
 *  laptop against 20/s on the CI runner, measured. The duration is the
 *  fixture's, and identical everywhere. */
const CONTINUOUS_PAINT_FPS = 10;

/**
 * The real-browser lane.
 *
 * **What it proves.** The *protocol call sequence*: that
 * `Emulation.setDeviceMetricsOverride` makes `Page.captureScreenshot`
 * deliver at the emulated viewport and DPR — against a browser context
 * created at *different* metrics, so the claim can fail — that
 * `Page.startScreencast` emits on paint and
 * therefore tells motion from stillness, that injected
 * `Input.dispatchMouseEvent` moves land hover state in the pixels that get
 * harvested, and that `DOM.getBoxModel` quads are in the same coordinate
 * space those input events are dispatched in — including for an element
 * inside an iframe, where a naive in-page rect would be off by the frame's
 * offset. Every one of those is a claim the engine makes about a browser, and
 * this is the only lane where a browser gets to answer.
 *
 * **What it does not prove.** Anchor *resolution*. That is SP3's suite and
 * Task 8's browser test, and there is no extension here to inject the sensor
 * into — so the `PageAgent` is a shim that parks elements by a selector map,
 * exactly as the compositor's `harvest-fixture.ts` does with
 * `FIXTURE_SELECTORS`. It also does not prove the encoder: WebCodecs does not
 * exist in node, so the muxer is swapped for a counting encoder that still
 * applies core's own `spanIsMotion` (see `frame-encoder-node.ts`). A lane that
 * quietly tests less than its name suggests is worse than a smaller lane
 * honestly labelled, so: emulation, screenshots, screencast, input, geometry.
 * Nothing else.
 */

/** `Page.getFrameTree`'s reply, narrowed to what these tests read. */
type CdpFrameTree = CdpFrameNode;

const clock = () => ({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
});

describe("replay against a real browser", () => {
  // SP1 §1: captureScreenshot honours emulated DPR and delivers true
  // 3840x2400. The deliverable's resolution depends on that staying true.
  it("harvests keyframes at the emulated DPR", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();
      const doc = scene({ anchorIds: ["static-btn"] });
      const result = await runReplay(doc, {
        cdp,
        page: selectorPageAgent(page, { "static-btn": "#static-btn" }),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      expect(result.reason).toBe(null);
      expect(result.outcome).toBe("complete");

      // The control, and the only thing that makes the two assertions below
      // mean anything: the context this page is running in is 1024x640 at
      // DPR 1. If the engine's override were deleted, the keyframe would come
      // back at those numbers and this test would go red — which was not true
      // while the context was created at the scene's own viewport and DPR.
      expect(CONTEXT_VIEWPORT).not.toEqual(SCENE_VIEWPORT);
      expect(CONTEXT_DPR).not.toBe(REPLAY_DPR);
      const first = result.bundle?.keyframes[0];
      expect(first?.width).not.toBe(CONTEXT_VIEWPORT.width * CONTEXT_DPR);

      expect(first?.width).toBe(SCENE_VIEWPORT.width * REPLAY_DPR);
      expect(first?.height).toBe(SCENE_VIEWPORT.height * REPLAY_DPR);

      // The control for the hover test's byte comparison below. Moving the
      // cursor onto this button changes nothing on screen — no :hover rule,
      // and a mouse click gives no :focus-visible ring — and the keyframe at
      // the marker instant is taken *before* the click fires, so it must come
      // back byte-identical to the opening shot. Without this, "the hover
      // keyframe differs" could just mean two captures of one page never
      // match.
      const opening = result.bundle?.keyframes.find((k) => k.actionId === null);
      const atMarker = result.bundle?.keyframes.find(
        (k) => k.actionId === "act-1",
      );
      const before = await store.load(opening?.ref as string);
      const harvested = await store.load(atMarker?.ref as string);
      expect(Buffer.from(harvested).equals(Buffer.from(before))).toBe(true);
    });
  });

  // The motion detector, end to end: the screencast emits only on paint, so a
  // click that starts an 800ms transition keeps a span and a click that
  // changes nothing keeps none.
  //
  // Asserted two ways, because the exact form alone would not say *why* it
  // holds. The paint counts are the underlying fact — one or two frames
  // against roughly fifty, measured — and `motionSpans.length` is the verdict
  // `SPAN_MIN_FRAMES` draws from them. The gap is what makes the verdict
  // stable: at the threshold of 2 this test flaked about one run in eight,
  // because a static click paints twice whenever the press and release happen
  // to land on separate frames (14 times in 60, measured). The constant now
  // sits at 3, which is the floor of the gap, and the exact assertion is
  // sound again.
  it("keeps a span for the click that animates and none for the click that does not", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();
      const doc = scene({ anchorIds: ["static-btn", "animate-btn"] });
      const encoder = createNodeFrameEncoder(store, doc.meta.id);
      const result = await runReplay(doc, {
        cdp,
        page: selectorPageAgent(page, {
          "static-btn": "#static-btn",
          "animate-btn": "#animate-btn",
        }),
        encoder,
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      expect(result.outcome).toBe("complete");

      // One span opened per click, in order, kept or not.
      const [staticSpan, animateSpan] = encoder.spans();
      expect(encoder.spans().length).toBe(2);

      // The click that changes nothing paints once, or at most twice — the
      // whole measured repaint population, and below the threshold. If the
      // screencast emitted on a timer rather than on paint this would be in
      // the dozens like the one below it.
      expect(staticSpan?.frames).toBeGreaterThanOrEqual(1);
      expect(staticSpan?.frames).toBeLessThanOrEqual(2);
      expect(staticSpan?.kept).toBe(false);

      // The click that opens the fixture's transition paints throughout it.
      //
      // Never as an absolute frame count. `toBeGreaterThan(20)` stood here
      // until 2026-09-15, chosen against the ~50 this laptop paints; the
      // runner paints the same 800ms transition 20 times and CI went red on
      // "expected 20 to be greater than 20" with nothing wrong in the repo.
      // Raising or lowering that number buys one machine a green run and
      // leaves the guard measuring the hardware. The two forms below hold on
      // any machine that can render at all: the span covers the fixture's own
      // transition, and it repainted continuously across it rather than
      // landing a burst at each end.
      const spans = JSON.stringify(encoder.spans());
      expect(
        readFileSync(fileURLToPath(FIXTURE_URL), "utf8"),
        "the fixture no longer declares the transition this span measures",
      ).toContain(`transition: height ${PANEL_TRANSITION_MS}ms`);
      expect(animateSpan?.kept).toBe(true);
      expect(
        animateSpan?.durationMs ?? 0,
        `the span must stay open across the whole ${PANEL_TRANSITION_MS}ms transition; spans: ${spans}`,
      ).toBeGreaterThanOrEqual(PANEL_TRANSITION_MS);
      const animateFps =
        (animateSpan?.frames ?? 0) / ((animateSpan?.durationMs ?? 1) / 1000);
      expect(
        animateFps,
        `the animating click must repaint continuously, not twice; spans: ${spans}`,
      ).toBeGreaterThan(CONTINUOUS_PAINT_FPS);

      // So exactly one span reaches the bundle, and it is the animating one:
      // it starts at or after that action's marker instant.
      expect(result.bundle?.motionSpans.length).toBe(1);
      const span = result.bundle?.motionSpans[0];
      const animateMarker = result.bundle?.markers.find(
        (m) => m.actionId === "act-2",
      );
      expect(span?.startMs).toBeGreaterThanOrEqual(
        animateMarker?.sourceTimeMs ?? 0,
      );

      // Measured, and settled: the screencast stream is capped at the
      // physical display surface and ignores the emulated DPR, which is why
      // the compositor upscales it against the DPR-honouring keyframes.
      // Now that the context is 1024x640 DPR 1 while the engine emulates
      // 1280x800 DPR 3, this says something it could not say before: the
      // frames arrive at the emulated *CSS* size, 1280x800 — not the
      // context's own surface, and emphatically not 3840x2400.
      expect(span?.width).toBe(SCENE_VIEWPORT.width);
      expect(span?.height).toBe(SCENE_VIEWPORT.height);
      expect(span?.width).not.toBe(SCENE_VIEWPORT.width * REPLAY_DPR);
    });
  });

  // SP1 §5, made permanent: hover state in the harvested pixels follows the
  // injected path. The tooltip's 150ms transition is why the settle exists.
  //
  // The property is that the hover is **complete** in the harvested frame,
  // not merely begun. Two weaker forms were tried and both let the defect
  // through: a computed opacity read after the run is 1 whatever the settle
  // was, because the cursor is still parked on the button; and "the keyframe
  // differs from the opening shot" fires the moment opacity leaves zero —
  // measured, a 40 ms settle catches the tooltip at 0.106 and would have
  // passed. So the harvested keyframe is compared against a reference taken
  // through the same call once the transition has fully finished. Anything
  // mid-fade differs from that reference, and the assertion is exact.
  it("lands hover state before the keyframe is taken", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();
      const doc = scene({ anchorIds: ["hover-btn"] });
      const result = await runReplay(doc, {
        cdp,
        page: selectorPageAgent(page, { "hover-btn": "#hover-btn" }),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      const opening = result.bundle?.keyframes.find((k) => k.actionId === null);
      const atMarker = result.bundle?.keyframes.find(
        (k) => k.actionId === "act-1",
      );
      expect(opening?.ref).toBeDefined();
      expect(atMarker?.ref).toBeDefined();
      const before = await store.load(opening?.ref as string);
      const harvested = await store.load(atMarker?.ref as string);

      // The reference. The run left the cursor on the button, so the page is
      // already in the hover state the keyframe was meant to catch; waiting
      // for opacity to reach exactly 1 and then for a painted frame makes it
      // the *settled* one. Same session, same emulation, same format and
      // quality the engine asks for, so a byte comparison is meaningful —
      // test 1's control proves two captures of an unchanged page match.
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector("#tooltip") as Element)
            .opacity === "1",
      );
      await page.evaluate(
        () =>
          new Promise<void>((r) => {
            requestAnimationFrame(() => requestAnimationFrame(() => r()));
          }),
      );
      const settled = Buffer.from(
        String(
          (
            await cdp.send("Page.captureScreenshot", {
              format: "jpeg",
              quality: KEYFRAME_QUALITY,
            })
          ).data ?? "",
        ),
        "base64",
      );

      // The fixture's tooltip has to still be fading when the injected path
      // ends, or the settle is not what makes this test pass and removing it
      // would leave it green — which is exactly what happened while the fade
      // was 150ms. Both halves are measured from this run rather than
      // hardcoded: the fade from the page's own computed style, the path tail
      // from the samples the engine actually dispatched.
      const fadeMs = await page.evaluate(() => {
        const st = getComputedStyle(
          document.querySelector("#tooltip") as Element,
        );
        return (
          (Number.parseFloat(st.transitionDuration) +
            Number.parseFloat(st.transitionDelay)) *
          1000
        );
      });
      const rect = await page.evaluate(() => {
        const r = (
          document.querySelector("#hover-btn") as Element
        ).getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      const samples = result.bundle?.cursorSamples ?? [];
      const entered = samples.find(
        (c) =>
          c.x >= rect.left &&
          c.x <= rect.right &&
          c.y >= rect.top &&
          c.y <= rect.bottom,
      );
      expect(entered).toBeDefined();
      const pathTailMs =
        (samples.at(-1)?.sourceTimeMs ?? 0) - (entered?.sourceTimeMs ?? 0);
      expect(fadeMs).toBeGreaterThan(pathTailMs);

      // Begun...
      expect(Buffer.from(harvested).equals(Buffer.from(before))).toBe(false);
      // ...and finished.
      expect(Buffer.from(harvested).equals(settled)).toBe(true);
    });
  });

  // The coordinate claim: DOM.getBoxModel quads are in the same space
  // Input.dispatchMouseEvent dispatches in — including inside an iframe,
  // where a naive in-page rect would be off by the frame's offset.
  it("clicks the element it measured, in the top frame and inside a frame", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();
      const doc = scene({
        anchorIds: [
          "static-btn",
          // The hop exactly as the sensor records it for an element captured
          // inside `#deep`: origin "" because a srcdoc frame has no src to
          // parse, and name "" because the iframe carries only an id. Both
          // empties are "no claim" — and the second one matters, because
          // Chrome reports this frame's name as "deep", falling back to the
          // id. Written with `name=deep` instead, this test would pass while
          // proving nothing about the case that actually ships.
          {
            id: "inner-btn",
            treePath: "#frame(origin=,name=,ordinal=1)/button:1",
          },
        ],
      });
      const result = await runReplay(doc, {
        cdp,
        page: selectorPageAgent(page, {
          "static-btn": "#static-btn",
          "inner-btn": { frame: "#deep", selector: "#inner-btn" },
        }),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      expect(result.outcome).toBe("complete");
      expect(
        await page.evaluate(
          () => (window as unknown as { __clicks?: string[] }).__clicks,
        ),
      ).toContain("static-btn");

      const inner = page.frameLocator("#deep").locator("#inner-btn");
      expect(
        await inner.evaluate(
          () =>
            (window as unknown as { __innerClicked?: boolean }).__innerClicked,
        ),
      ).toBe(true);

      // The rect replay measured for the framed element has to be in the top
      // frame's space, or the click above could not have landed: it must sit
      // inside the iframe's own box on the main page, not near the origin
      // where the frame-local rect would put it.
      const frameBox = await page.locator("#deep").boundingBox();
      const measured = result.bundle?.anchorRects.find(
        (r) => r.anchorId === "inner-btn",
      )?.rect;
      expect(measured).toBeDefined();
      expect(measured?.y).toBeGreaterThan(frameBox?.y ?? 0);
      expect(measured?.y).toBeLessThan(
        (frameBox?.y ?? 0) + (frameBox?.height ?? 0),
      );
    });
  });
  // Bug A's control, and the half that was NOT loosened. Where capture
  // genuinely observed a `name` attribute, Chrome reports the same string and
  // the hop is still corroborated strictly. Without this, "an empty recorded
  // name is no claim" would be indistinguishable from "the name is never
  // checked" — and the second would let replay dispatch into a frame the
  // capture never saw.
  //
  // The matching and contradicting hops are two tests rather than two runs in
  // one, so that neither can mask the other. They once *had* to be split:
  // `Runtime.enable` replays existing execution contexts only on a first
  // enable, so the second run on a session failed every cross-frame anchor
  // for want of a context id, and the contradicted case went green without
  // the name check doing anything. The engine now cycles Runtime at setup and
  // session reuse has its own test below; the split is kept for isolation.
  it("still corroborates a frame name the capture actually recorded", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();
      const doc = scene({
        anchorIds: [
          {
            id: "named-btn",
            treePath: "#frame(origin=,name=paybox,ordinal=2)/button:1",
          },
        ],
      });
      const result = await runReplay(doc, {
        cdp,
        page: selectorPageAgent(page, {
          "named-btn": { frame: "#named-frame", selector: "#named-btn" },
        }),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      expect(result.outcome).toBe("complete");
      expect(
        await page
          .frameLocator("#named-frame")
          .locator("#named-btn")
          .evaluate(
            () =>
              (window as unknown as { __namedClicked?: boolean })
                .__namedClicked,
          ),
      ).toBe(true);
    });
  });

  it("refuses a frame whose name contradicts the hop, rather than dispatching into it", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();
      // Ordinal 2 IS `#named-frame`, and the origin is "no claim", so the
      // name is the only thing that can reject this. Chrome reports "paybox".
      const doc = scene({
        anchorIds: [
          {
            id: "named-btn",
            treePath: "#frame(origin=,name=wallet,ordinal=2)/button:1",
          },
        ],
      });
      const result = await runReplay(doc, {
        cdp,
        page: selectorPageAgent(page, {
          "named-btn": { frame: "#named-frame", selector: "#named-btn" },
        }),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      // The anchor resolved; the frame its hop names does not corroborate,
      // so there was nowhere to measure it. The author's fix is the frame,
      // not the element — and not a re-run either, which is why this is its
      // own reason rather than `anchorUnreachable`.
      expect(result.reason).toBe("anchorFrameMismatch");
      expect(result.completed).toBe(0);
      expect(
        await page
          .frameLocator("#named-frame")
          .locator("#named-btn")
          .evaluate(
            () =>
              (window as unknown as { __namedClicked?: boolean })
                .__namedClicked,
          ),
      ).toBeUndefined();
    });
  });

  /**
   * Document order and attach order are not the same list.
   *
   * Capture assigns a hop's ordinal from `querySelectorAll("iframe")` —
   * document order — while `Page.getFrameTree`'s `childFrames` is *attach*
   * order. Measured here rather than reasoned about, because that is this
   * branch's rule for claims about a browser: the fixture mounts #late-frame
   * from script ahead of #static-frame in the document, and Chromium reports
   * the two the other way round. Both are `srcdoc` and `id`-only, so the
   * origin relaxation and the name relaxation both skip their checks and the
   * ordinal is the whole of the selection.
   *
   * So a hop naming ordinal 3 — #late-frame, where the sensor parked the
   * element — indexes to #static-frame, a document the take was never
   * recorded against. The run must refuse rather than reach into it. What
   * makes this test say something the pre-fix engine did not already satisfy
   * is the *context* assertion: without the corroboration the engine
   * evaluates in #static-frame's execution context and reports
   * `unresolvedAnchor` only because the element is not parked there — the
   * right answer for the wrong reason, and one that turns into a click in the
   * wrong document the moment something is parked there.
   */
  it("refuses a frame whose attach order contradicts the recorded document order", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const documentOrder = await page.evaluate(() =>
        [...document.querySelectorAll("iframe")].map((f) => f.id),
      );
      const treeBefore = (await cdp.send("Page.getFrameTree"))
        .frameTree as CdpFrameTree;
      const attachOrder = (treeBefore.childFrames ?? []).map(
        (c) => c.frame.name,
      );

      // The measurement, asserted so this test carries its own evidence and
      // goes red if Chromium ever starts reporting document order. `name`
      // falls back to the element's id, which is why three of these four are
      // ids and #named-frame's is its real name.
      expect(documentOrder).toEqual([
        "deep",
        "named-frame",
        "late-frame",
        "static-frame",
      ]);
      expect(attachOrder).toEqual([
        "deep",
        "paybox",
        "static-frame",
        "late-frame",
      ]);

      // Which execution context belongs to which frame, tracked from out here
      // so the assertion below can name the frame the engine must not touch.
      const contexts = new Map<string, number>();
      cdp.on("Runtime.executionContextCreated", (params) => {
        const context = params.context as {
          id: number;
          auxData?: { frameId?: string; isDefault?: boolean };
        };
        const { frameId, isDefault } = context.auxData ?? {};
        if (isDefault === true && frameId !== undefined) {
          contexts.set(frameId, context.id);
        }
      });

      const evaluatedIn: unknown[] = [];
      const recorded = {
        ...cdp,
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate")
            evaluatedIn.push(params?.contextId);
          return cdp.send(method, params);
        },
      };

      const store = createMemoryFrameStore();
      const doc = scene({
        anchorIds: [
          {
            id: "late-inner-btn",
            treePath: "#frame(origin=,name=,ordinal=3)/button:1",
          },
        ],
      });
      const result = await runReplay(doc, {
        cdp: recorded,
        page: selectorPageAgent(page, {
          "late-inner-btn": {
            frame: "#late-frame",
            selector: "#late-inner-btn",
          },
        }),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      // As above: a resolved anchor behind a frame the tree does not
      // corroborate is a frame mismatch, not a gone element.
      expect(result.reason).toBe("anchorFrameMismatch");
      expect(result.completed).toBe(0);

      // And it never asked the wrong document anything at all.
      const wrongFrameId = (treeBefore.childFrames ?? [])[2]?.frame.id;
      const wrongContext = contexts.get(wrongFrameId as string);
      expect(wrongContext).toBeDefined();
      expect(evaluatedIn).not.toContain(wrongContext);

      // Nor dispatched into it.
      expect(
        await page
          .frameLocator("#static-frame")
          .locator("#static-inner-btn")
          .evaluate(
            () =>
              (window as unknown as { __staticFrameClicked?: boolean })
                .__staticFrameClicked,
          ),
      ).toBeUndefined();
    });
  });

  // Bug B. Box-model quads are viewport-relative — measured here, not
  // assumed — so a target below the fold is otherwise clicked at a y that
  // lands on whatever is at that coordinate instead, and the run still
  // reports `complete`. A demo that silently did nothing is worse than one
  // that reported a failure.
  it("scrolls an off-screen target into view and clicks it where it now is", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();

      // The control: without it this test would pass on a page where the
      // button happened to be visible all along, proving nothing. Measured
      // before the run, so it reads the *context's* viewport rather than the
      // one the engine goes on to emulate — hence the greater of the two, so
      // "below the fold" holds under either.
      const topBefore = await page.evaluate(
        () =>
          (
            document.querySelector("#low-btn") as Element
          ).getBoundingClientRect().top,
      );
      expect(topBefore).toBeGreaterThan(
        Math.max(CONTEXT_VIEWPORT.height, SCENE_VIEWPORT.height),
      );

      const doc = scene({ anchorIds: ["low-btn"] });
      const result = await runReplay(doc, {
        cdp,
        page: selectorPageAgent(page, { "low-btn": "#low-btn" }),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      expect(result.outcome).toBe("complete");
      // It actually hit the button, rather than whatever sat at the
      // off-screen coordinate.
      expect(
        await page.evaluate(
          () => (window as unknown as { __clicks?: string[] }).__clicks,
        ),
      ).toContain("low-btn");

      // And the ordering trap: the rect has to be measured *after* the
      // scroll. A rect from before it describes where the element used to
      // be — `topBefore` above — and everything downstream, the cursor path
      // and the camera the compositor frames from it, would be pointed
      // somewhere nothing is.
      const measured = result.bundle?.anchorRects.find(
        (r) => r.anchorId === "low-btn",
      )?.rect;
      expect(measured).toBeDefined();
      expect(measured?.y).toBeGreaterThanOrEqual(0);
      expect(measured?.y).toBeLessThan(SCENE_VIEWPORT.height);

      // And it is the rect the element has *now*, edge for edge. Measured
      // before the scroll it would sit ~3040 px down, nowhere near. Stated
      // against the live rect rather than as a number so it cannot rot, and
      // as equality rather than "the centre falls inside" because the engine
      // reads the border quad, which is exactly what
      // `getBoundingClientRect` reports — the two agree on the edges, not
      // merely on the centre.
      const live = await page.evaluate(() => {
        const r = (
          document.querySelector("#low-btn") as Element
        ).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      expect(measured?.x).toBeCloseTo(live.x, 1);
      expect(measured?.y).toBeCloseTo(live.y, 1);
      expect(measured?.width).toBeCloseTo(live.width, 1);
      expect(measured?.height).toBeCloseTo(live.height, 1);
    });
  });

  // Re-replay after an edit is a product feature, and a runner may well hand
  // the same session to the second run. `Runtime.enable` replays the
  // execution contexts that already exist only the first time — six, then
  // zero — so without the engine cycling Runtime at setup the second run
  // begins blind and every cross-frame anchor fails for want of a context id.
  // A replay that works exactly once, reporting the same "element not found"
  // a genuinely missing element reports.
  //
  // Cross-frame in *both* runs, because the top frame never needed a context
  // id and would pass either way.
  it("replays twice through one session, frames and all", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();
      const inFrame = {
        id: "inner-btn",
        treePath: "#frame(origin=,name=,ordinal=1)/button:1",
      };
      const agent = selectorPageAgent(page, {
        "inner-btn": { frame: "#deep", selector: "#inner-btn" },
      });
      const doc = scene({ anchorIds: [inFrame] });
      const run = (sceneId: string) =>
        runReplay(doc, {
          cdp,
          page: agent,
          encoder: createNodeFrameEncoder(store, sceneId),
          store,
          clock: clock(),
          mayReplay: true,
          madeFrom: madeFromOf(doc),
        });

      const first = await run("scene-1");
      expect(first.outcome).toBe("complete");

      const second = await run("scene-2");
      expect(second.reason).toBe(null);
      expect(second.outcome).toBe("complete");
      expect(second.completed).toBe(1);
      // And it measured the frame's element, not something at the origin of
      // the top document — the run reaching the end is not on its own proof
      // the lookup worked.
      const frameBox = await page.locator("#deep").boundingBox();
      const measured = second.bundle?.anchorRects.find(
        (r) => r.anchorId === "inner-btn",
      )?.rect;
      expect(measured?.y).toBeGreaterThan(frameBox?.y ?? 0);
      expect(measured?.y).toBeLessThan(
        (frameBox?.y ?? 0) + (frameBox?.height ?? 0),
      );
    });
  });

  // C, against a browser that has real padding. The bundle's rects are what
  // the compositor frames its camera from, and capture wrote
  // `getBoundingClientRect` into the fingerprint — so replay has to describe
  // the same element the same way or an auto-zoom frames a different box than
  // the one that was authored. `DOM.getBoxModel` also returns a `content`
  // quad, inset by padding: on this fixture's button that is 41.7x18 against
  // the border box's 81.7x42, and reading it would leave clicks working while
  // the framing quietly drifted.
  it("measures the box capture measured, padding and all", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();

      // The control: a button with no padding could not tell the two boxes
      // apart, so assert this one genuinely has some.
      const padding = await page.evaluate(() => {
        const st = getComputedStyle(
          document.querySelector("#static-btn") as Element,
        );
        return {
          x: Number.parseFloat(st.paddingLeft),
          y: Number.parseFloat(st.paddingTop),
        };
      });
      expect(padding.x).toBeGreaterThan(0);
      expect(padding.y).toBeGreaterThan(0);

      const doc = scene({ anchorIds: ["static-btn"] });
      const result = await runReplay(doc, {
        cdp,
        page: selectorPageAgent(page, { "static-btn": "#static-btn" }),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      const live = await page.evaluate(() => {
        const r = (
          document.querySelector("#static-btn") as Element
        ).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      const measured = result.bundle?.anchorRects.find(
        (r) => r.anchorId === "static-btn",
      )?.rect;

      expect(measured?.x).toBeCloseTo(live.x, 1);
      expect(measured?.y).toBeCloseTo(live.y, 1);
      expect(measured?.width).toBeCloseTo(live.width, 1);
      expect(measured?.height).toBeCloseTo(live.height, 1);
    });
  });

  // The correction must stay a correction. `block: "nearest"` is a no-op for
  // an element already in view, so a run over on-screen targets leaves the
  // page exactly where it found it — otherwise every action would nudge the
  // page under itself and every keyframe would show a different scroll.
  it("does not move a page whose targets are already on screen", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      const store = createMemoryFrameStore();

      const doc = scene({ anchorIds: ["static-btn", "mid-btn"] });
      const result = await runReplay(doc, {
        cdp,
        page: selectorPageAgent(page, {
          "static-btn": "#static-btn",
          "mid-btn": "#mid-btn",
        }),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });

      expect(result.outcome).toBe("complete");
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      // The control, and the reason `#mid-btn` exists. The target has to be
      // fully visible *and* low enough that centring it would have to scroll:
      // against a button near the top, `block: "center"` cannot move the page
      // either (it is already at scroll 0) and this test would pass under the
      // over-reach it is here to forbid.
      //
      // Read *after* the run, on purpose. The engine emulates 1280x800 over a
      // context of 1024x640, so "fully visible" and "past the midpoint" are
      // only meaningful in the emulated viewport — and the override outlives
      // the run. The page has just been asserted not to have moved, so this
      // is the geometry the engine saw.
      const box = await page.evaluate(() => {
        const r = (
          document.querySelector("#mid-btn") as Element
        ).getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });
      expect(await page.evaluate(() => window.innerHeight)).toBe(
        SCENE_VIEWPORT.height,
      );
      expect(box.bottom).toBeLessThanOrEqual(SCENE_VIEWPORT.height);
      expect(box.top).toBeGreaterThan(SCENE_VIEWPORT.height / 2);
    });
  });
});
