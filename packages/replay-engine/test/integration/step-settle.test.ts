import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PAGE_CAPTURE_HOLD,
  PAGE_CAPTURE_RELEASE,
  PIN_ANIMATIONS,
  type StepSettleReport,
  stepSettleExpression,
} from "../../src/index.js";

/**
 * The step-settle probe against a real page. The fake CDP answers it with a
 * canned report, so only a browser can say whether it waits for what it
 * claims to wait for. Cases are the fixture's buttons.
 */
const FIXTURE = pathToFileURL(
  fileURLToPath(new URL("../fixtures/settle-app.html", import.meta.url)),
).href;
const QUIET = 300;
const CAP = 3000;

describe("the step-settle probe in a real page", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  async function withPage(fn: (page: Page) => Promise<void>): Promise<void> {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    try {
      await page.goto(FIXTURE, { waitUntil: "load" });
      await fn(page);
    } finally {
      await page.close();
    }
  }
  const ask = (page: Page, quietMs = QUIET, capMs = CAP) =>
    page.evaluate(
      stepSettleExpression(quietMs, capMs),
    ) as Promise<StepSettleReport>;
  const text = (page: Page, sel: string) =>
    page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);

  it("waits for the stream to finish before it answers settled", async () => {
    await withPage(async (page) => {
      await page.click("#stream");
      const early = await text(page, "#out");
      const report = await ask(page);
      const full = await text(page, "#out");
      expect(full.split(" ").length, `final text ${full}`).toBe(15);
      expect(
        early.split(" ").length,
        `premise: early text ${early}`,
      ).toBeLessThan(15);
      expect(report.quiet, JSON.stringify(report)).toBe(true);
      expect(report.painted, JSON.stringify(report)).toBe(true);
    });
  }, 15_000);

  // A short quietMs against a slide longer than it, so only the animation
  // clause can hold the reply open: with the default 300 ms quiet window the
  // window alone outlasts the 300 ms slide and the clause is never tested.
  it.each([
    ["#toastbtn", "slide-in"],
    ["#hoverbtn", "hover transition"],
  ])("waits out a finite animation (%s, %s)", async (button) => {
    await withPage(async (page) => {
      await page.click(button);
      const running = await page.evaluate(
        () =>
          document.getAnimations().filter((a) => a.playState === "running")
            .length,
      );
      expect(running, "premise: an animation is running when asked").toBe(1);
      const report = await ask(page, 30, CAP);
      expect(report.animations, JSON.stringify(report)).toBe(0);
      expect(report.quiet, JSON.stringify(report)).toBe(true);
      const left = await page.evaluate(
        () =>
          document.getAnimations().filter((a) => a.playState === "running")
            .length,
      );
      expect(
        left,
        `animations left after answer: ${JSON.stringify(report)}`,
      ).toBe(0);
      expect(report.waitedMs, JSON.stringify(report)).toBeGreaterThan(100);
    });
  });

  it("answers unsettled, not quiet, when the animation read throws", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        document.getAnimations = () => {
          throw new Error("stubbed");
        };
      });
      const report = await ask(page, 0, CAP);
      expect(report.quiet, JSON.stringify(report)).toBe(false);
      expect(report.stopped, JSON.stringify(report)).toBe(
        "animationReadFailed",
      );
    });
  });

  // Red when the reply reads the page again after the loop saw it settled:
  // a change in the moment between made it answer unsettled early, which
  // the walk said as "the page's animations could not be read" (close
  // review 7). A finite animation keeps the loop from seeing quiet until
  // the stub lets go, and in that same read the stub queues a change.
  it("answers quiet from what the loop saw, not from a change just after", async () => {
    await withPage(async (page) => {
      const Q = 100;
      const report = (await page.evaluate(`(() => {
        const T = Date.now();
        window.__late = 0;
        document.getAnimations = () => {
          if (Date.now() - T < ${Q + 5}) {
            return [{ playState: "running",
              effect: { getComputedTiming: () => ({ iterations: 1 }) } }];
          }
          if (window.__late++ === 0) {
            queueMicrotask(() => document.body.setAttribute("data-late", "1"));
          }
          return [];
        };
        return ${stepSettleExpression(Q, CAP)};
      })()`)) as StepSettleReport;
      const late = await page.evaluate(() =>
        document.body.getAttribute("data-late"),
      );
      expect(late, "premise: the change came as the loop let go").toBe("1");
      expect(report.quiet, JSON.stringify(report)).toBe(true);
      expect(report.stopped, JSON.stringify(report)).toBe("quiet");
      expect(report.waitedMs, JSON.stringify(report)).toBeLessThan(CAP);
    });
  });

  it("answers unsettled at the cap on a page that never stops", async () => {
    await withPage(async (page) => {
      await page.click("#never");
      const report = await ask(page, QUIET, 800);
      expect(report.quiet, JSON.stringify(report)).toBe(false);
      expect(report.stopped, JSON.stringify(report)).toBe("cap");
      expect(
        Math.abs(report.waitedMs - 800),
        JSON.stringify(report),
      ).toBeLessThan(100);
    });
  });

  // Red without the `done` flag: the loop the backstop beat keeps reading
  // the page's animations every frame for the rest of the take.
  it("stops reading the page once it has answered at the cap", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        const w = window as unknown as { reads: number };
        w.reads = 0;
        // One finite animation that never ends: only the cap answers.
        document.getAnimations = () => {
          w.reads++;
          return [
            {
              playState: "running",
              effect: { getComputedTiming: () => ({ iterations: 1 }) },
            } as unknown as Animation,
          ];
        };
      });
      const report = await ask(page, 0, 300);
      expect(report.animations, JSON.stringify(report)).toBe(1);
      const reads = () =>
        page.evaluate(() => (window as unknown as { reads: number }).reads);
      const atAnswer = await reads();
      expect(atAnswer, "premise: the loop read every frame").toBeGreaterThan(5);
      await page.waitForTimeout(300);
      expect(await reads(), "reads after the answer").toBeLessThanOrEqual(
        atAnswer + 1,
      );
    });
  });

  it("does not wait for an endless spinner", async () => {
    await withPage(async (page) => {
      await page.click("#spinbtn");
      const infinite = await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (a) =>
                a.playState === "running" &&
                a.effect?.getComputedTiming().iterations === Infinity,
            ).length,
      );
      expect(infinite, "premise: the spinner is an endless animation").toBe(1);
      const report = await ask(page);
      expect(report.quiet, JSON.stringify(report)).toBe(true);
      expect(report.animations, JSON.stringify(report)).toBe(0);
      expect(report.waitedMs, JSON.stringify(report)).toBeLessThan(CAP);
    });
  });

  // Red if HOLD answers a caret it could not hide as hidden: the screen
  // would be compared with a blinking caret in it.
  it("HOLD says a focused field's caret it could not hide is shown", async () => {
    await withPage(async (page) => {
      await page.focus("#q");
      const hidden = (await page.evaluate(PAGE_CAPTURE_HOLD)) as {
        caretShown: boolean;
      };
      await page.evaluate(PAGE_CAPTURE_RELEASE);
      expect(hidden.caretShown, "the hold's own rule wins").toBe(false);
      await page.evaluate(() =>
        document
          .getElementById("q")
          ?.style.setProperty("caret-color", "red", "important"),
      );
      const shown = (await page.evaluate(PAGE_CAPTURE_HOLD)) as {
        caretShown: boolean;
      };
      await page.evaluate(PAGE_CAPTURE_RELEASE);
      expect(shown.caretShown).toBe(true);
    });
  });

  it("HOLD hides the caret and holds endless animations, RELEASE puts both back", async () => {
    await withPage(async (page) => {
      await page.click("#spinbtn");
      await page.click("#finishedbtn");
      await ask(page); // lets the finished box end
      await page.focus("#q");
      const finishedBefore = await page.evaluate(
        () => document.getElementById("fin")?.getAnimations()[0]?.currentTime,
      );
      expect(
        finishedBefore,
        "premise: the box's animation has ended at 200ms",
      ).toBe(200);
      const spinnerBefore = await page.evaluate(
        () => document.getElementById("spin")?.getAnimations()[0]?.currentTime,
      );
      expect(
        Number(spinnerBefore),
        "premise: spinner has advanced",
      ).toBeGreaterThan(0);

      const held = (await page.evaluate(PAGE_CAPTURE_HOLD)) as {
        held: number;
        width: number;
        height: number;
        dpr: number;
      };
      expect(held.held, JSON.stringify(held)).toBe(1);
      expect(held.width, JSON.stringify(held)).toBe(800);
      const after = await page.evaluate(() => ({
        spin: document.getElementById("spin")?.getAnimations()[0]?.currentTime,
        spinState: document.getElementById("spin")?.getAnimations()[0]
          ?.playState,
        fin: document.getElementById("fin")?.getAnimations()[0]?.currentTime,
        style: !!document.getElementById("__demomanCaretHold"),
      }));
      expect(after, JSON.stringify(after)).toMatchObject({
        spin: 0,
        spinState: "paused",
        fin: 200,
        style: true,
      });

      const restored = await page.evaluate(PAGE_CAPTURE_RELEASE);
      expect(restored).toBe(1);
      const back = await page.evaluate(() => ({
        style: !!document.getElementById("__demomanCaretHold"),
        state: document.getElementById("spin")?.getAnimations()[0]?.playState,
      }));
      expect(back, JSON.stringify(back)).toEqual({
        style: false,
        state: "running",
      });
    });
  });

  // A held recording's pin leaves every animation paused where the held time
  // puts it, and that is a frame further for every frame the server took:
  // red if the screen shows the spinner there instead of at 0, or if RELEASE
  // sets it running under a held clock.
  it("HOLD also holds an endless animation the held clock paused, and RELEASE leaves it paused", async () => {
    await withPage(async (page) => {
      await page.click("#spinbtn");
      await page.evaluate(`(${PIN_ANIMATIONS})(1000)`);
      await page.evaluate(`(${PIN_ANIMATIONS})(1400)`);
      const spin = () =>
        page.evaluate(() => {
          const a = document.getElementById("spin")?.getAnimations()[0];
          return { at: a?.currentTime, state: a?.playState };
        });
      expect(await spin(), "premise: pinned 400 ms in, paused").toEqual({
        at: 400,
        state: "paused",
      });
      const held = (await page.evaluate(PAGE_CAPTURE_HOLD)) as { held: number };
      expect(held.held).toBe(1);
      expect(await spin()).toEqual({ at: 0, state: "paused" });
      expect(await page.evaluate(PAGE_CAPTURE_RELEASE)).toBe(1);
      expect(await spin()).toEqual({ at: 400, state: "paused" });
    });
  });

  // Red if a spinner the page itself stopped is moved to 0 for the screen:
  // where it stopped is the page's picture.
  it("HOLD leaves an endless animation the page paused where it is", async () => {
    await withPage(async (page) => {
      await page.click("#spinbtn");
      await page.evaluate(() => {
        const a = document.getElementById("spin")?.getAnimations()[0];
        if (!a) throw new Error("no spinner");
        a.pause();
        a.currentTime = 250;
      });
      const held = (await page.evaluate(PAGE_CAPTURE_HOLD)) as { held: number };
      await page.evaluate(PAGE_CAPTURE_RELEASE);
      expect(held.held).toBe(0);
      expect(
        await page.evaluate(
          () =>
            document.getElementById("spin")?.getAnimations()[0]?.currentTime,
        ),
      ).toBe(250);
    });
  });

  // A playing video is not held (measured 2026-11-15: every frame of one
  // apart between two held recordings). Red if the pin says nothing, so the
  // report reads as if the whole page were on the video's clock.
  it("the held clock's pin says a playing video once, and not a paused one", async () => {
    await withPage(async (page) => {
      const pin = (v: number) =>
        page.evaluate(`(${PIN_ANIMATIONS})(${v})`) as Promise<string[]>;
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.getContext("2d")?.fillRect(0, 0, 10, 10);
        const video = document.createElement("video");
        video.id = "clip";
        video.muted = true;
        video.srcObject = canvas.captureStream();
        document.body.append(video);
      });
      expect(await pin(0), "premise: not yet playing").toEqual([]);
      await page.evaluate(() =>
        (document.getElementById("clip") as HTMLVideoElement).play(),
      );
      expect(await pin(33)).toEqual([
        "a playing video runs on its own clock: it was not held",
      ]);
      expect(await pin(66)).toEqual([]);
    });
  });

  // Review of 2026-11-16: the pin reset and played every animation, also one
  // the page holds paused (a progress ring scrubbed by a negative delay).
  // Red if such an animation moves, or the screen's hold resets it.
  it("the held clock's pin leaves an animation the page paused where it is, and plays it on from there", async () => {
    await withPage(async (page) => {
      const pin = (v: number) =>
        page.evaluate(`(${PIN_ANIMATIONS})(${v})`) as Promise<string[]>;
      await page.evaluate(() => {
        const style = document.createElement("style");
        style.textContent =
          "@keyframes fill{to{width:100px}}#ring{width:0;height:4px;background:#06c;animation:fill 10s linear infinite;animation-delay:-4s;animation-play-state:paused}";
        document.head.append(style);
        const ring = document.createElement("div");
        ring.id = "ring";
        document.body.append(ring);
      });
      // How far through its 10 s the ring is drawn (its delay counts).
      const at = () =>
        page.evaluate(() =>
          Math.round(
            1000 *
              (document
                .getElementById("ring")
                ?.getAnimations()[0]
                ?.effect?.getComputedTiming().progress ?? -1),
          ),
        );
      expect(await at(), "premise: scrubbed to 4 s by its delay").toBe(400);
      expect(await pin(1000)).toEqual([]);
      await pin(1500);
      expect(await at()).toBe(400);
      const held = (await page.evaluate(PAGE_CAPTURE_HOLD)) as { held: number };
      await page.evaluate(PAGE_CAPTURE_RELEASE);
      expect(held.held).toBe(0);
      expect(await at()).toBe(400);
      // The page plays it: it goes on from 4 s on the held clock.
      await page.evaluate(() => {
        (
          document.getElementById("ring") as HTMLElement
        ).style.animationPlayState = "running";
      });
      await pin(2000);
      await pin(2300);
      expect(await at()).toBe(430);
      // And pauses it again by its style: it stays, whatever the held time.
      await page.evaluate(() => {
        (
          document.getElementById("ring") as HTMLElement
        ).style.animationPlayState = "paused";
      });
      await pin(3000);
      expect(await at()).toBe(430);
    });
  });

  // Red if a reversed animation is played forward by the pin (it ran to its
  // end and snapped back) without a word.
  it("the held clock's pin says an animation at another rate, and does not play it", async () => {
    await withPage(async (page) => {
      await page.click("#spinbtn");
      await page.evaluate(() => {
        const a = document.getElementById("spin")?.getAnimations()[0];
        if (a) a.playbackRate = -1;
      });
      const said = (await page.evaluate(
        `(${PIN_ANIMATIONS})(1000)`,
      )) as string[];
      expect(said).toEqual([
        "spin on div: plays at rate -1, which the held clock does not play",
      ]);
      expect(await page.evaluate(`(${PIN_ANIMATIONS})(1033)`)).toEqual([]);
    });
  });
});
