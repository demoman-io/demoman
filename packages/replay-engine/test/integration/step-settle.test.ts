import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HELD_FRAMES_SCRIPT,
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

  // Traced 2026-11-16, twice: a window in milliseconds was met a frame
  // apart by where on the frame grid it began (400 ms from a frame, 383 ms
  // from half a frame), because the page reads whole milliseconds. Red if
  // the held window is read off the page's clock again: the frames it takes
  // then differ between these starts.
  it("counts a held clock's quiet window in frames, wherever on the grid it began", async () => {
    await withPage(async (page) => {
      // A held page: frames a frame of page time apart, run by the test,
      // and a clock that reads whole milliseconds. `changeAt`: a frame on
      // which the page changes.
      const framesToQuiet = (
        startMs: number,
        changeAt = -1,
        firstMs = 1000 / 30,
      ) =>
        page.evaluate(`(async () => {
          let t = ${startMs};
          Date.now = () => Math.floor(t);
          let asked = [];
          window.requestAnimationFrame = (cb) => { asked.push(cb); return 0; };
          let answer = null;
          ${stepSettleExpression(400, CAP, 12)}.then((r) => { answer = r; });
          let frames = 0;
          while (answer === null && frames < 60) {
            frames++;
            t += frames === 1 ? ${firstMs} : 1000 / 30;
            if (frames === ${changeAt}) document.body.setAttribute("data-n", String(frames));
            await new Promise((r) => setTimeout(r, 0));
            const run = asked; asked = [];
            for (const cb of run) cb();
            await new Promise((r) => setTimeout(r, 0));
          }
          return { frames, quiet: answer && answer.quiet };
        })()`) as Promise<{ frames: number; quiet: boolean }>;
      for (const start of [1000, 1000 + 100 / 3, 1016.67, 1011, 999.9999])
        expect(await framesToQuiet(start), `from ${start}`).toEqual({
          frames: 12,
          quiet: true,
        });
      // The question a third of a millisecond before a frame, in the same
      // whole millisecond or the next: that frame counts either way.
      for (const start of [1000.1, 1000.8])
        expect(await framesToQuiet(start, -1, 0.33), `from ${start}`).toEqual({
          frames: 12,
          quiet: true,
        });
      // A change before frame 5 is drawn: 12 frames of quiet from that one.
      expect(await framesToQuiet(1000, 5)).toEqual({ frames: 16, quiet: true });
    });
  });

  // Inside a server stretch frames come as fast as the machine
  // captures them. Red if one counts toward the quiet window or the cap.
  it("counts no frame that followed the server, toward quiet or the cap", async () => {
    await withPage(async (page) => {
      // Frames 1 to `server` follow the server; the page changes on each
      // frame up to `changing`.
      const run = (server: number, changing: number) =>
        page.evaluate(`(async () => {
          let asked = [];
          window.requestAnimationFrame = (cb) => { asked.push(cb); return 0; };
          let answer = null;
          ${stepSettleExpression(400, CAP, 12, 20)}.then((r) => { answer = r; });
          let frames = 0;
          while (answer === null && frames < 100) {
            frames++;
            window.__demomanServerFrame = frames <= ${server};
            if (frames <= ${changing}) document.body.setAttribute("data-n", String(frames));
            await new Promise((r) => setTimeout(r, 0));
            const run = asked; asked = [];
            for (const cb of run) cb();
            await new Promise((r) => setTimeout(r, 0));
          }
          return { frames, stopped: answer && answer.stopped };
        })()`) as Promise<{ frames: number; stopped: string }>;
      // Quiet: 12 frames after the server's 30.
      expect(await run(30, 0)).toEqual({ frames: 42, stopped: "quiet" });
      // The cap: 20 frames after the server's 30, on a page always changing.
      expect(await run(30, 100)).toEqual({ frames: 50, stopped: "cap" });
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
      const pin = (v: number) => page.evaluate(`(${PIN_ANIMATIONS})(${v})`);
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.getContext("2d")?.fillRect(0, 0, 10, 10);
        const video = document.createElement("video");
        video.id = "clip";
        video.muted = true;
        video.srcObject = canvas.captureStream();
        document.body.append(video);
      });
      // Not autoplay: a paused one is neither said nor paced.
      expect(await pin(0), "premise: not yet playing").toEqual({
        said: [],
        video: false,
      });
      await page.evaluate(() =>
        (document.getElementById("clip") as HTMLVideoElement).play(),
      );
      expect(await pin(33)).toEqual({
        said: ["a playing video runs on its own clock: it was not held"],
        video: true,
      });
      expect(await pin(66)).toEqual({ said: [], video: true });
    });
  });

  /** The fixture with the held frames script in every document, put there
   *  as a held recording puts it (play.ts), over CDP with Page enabled. */
  async function withHeldPage(fn: (page: Page) => Promise<void>) {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.enable");
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: HELD_FRAMES_SCRIPT,
      });
      await page.goto(FIXTURE, { waitUntil: "load" });
      await fn(page);
    } finally {
      await page.close();
    }
  }
  const saidAt = async (page: Page, v: number) =>
    (await page.evaluate(`(${PIN_ANIMATIONS})(${v})`)) as {
      said: string[];
      video: boolean;
    };

  // A script's pause() of a spinner the pin holds read as the pin's own,
  // so it played on and the take said nothing. Red if the page's call is
  // unsaid, or if the screen's own hold (PAGE_CAPTURE_HOLD) is said as it.
  it("the held clock's pin says an animation the page's script paused, which played on", async () => {
    await withHeldPage(async (page) => {
      await page.click("#spinbtn");
      expect(await saidAt(page, 1000)).toEqual({ said: [], video: false });
      await saidAt(page, 1033);
      const spin = () =>
        page.evaluate(() => {
          const a = document.getElementById("spin")?.getAnimations()[0];
          return { at: a?.currentTime, state: a?.playState };
        });
      // Premise: the pin holds it, paused already, so the page's pause
      // changes nothing the pin can read.
      expect(await spin(), "premise: pinned 33 ms in").toEqual({
        at: 33,
        state: "paused",
      });
      await page.evaluate(PAGE_CAPTURE_HOLD);
      await page.evaluate(PAGE_CAPTURE_RELEASE);
      expect(await saidAt(page, 1066)).toEqual({ said: [], video: false });
      // The page's own pause, by its script.
      const paused = await page.evaluate(() => {
        const a = document.getElementById("spin")?.getAnimations()[0];
        a?.pause();
        return a?.playState;
      });
      expect(paused, "premise: the page paused it").toBe("paused");
      expect(await saidAt(page, 1100)).toEqual({
        said: [
          "spin on div: the page paused it, and it played on: the held clock does not see a script's pause",
        ],
        video: false,
      });
      // It played on, as said.
      expect(await spin()).toEqual({ at: 100, state: "paused" });
      expect((await saidAt(page, 1133)).said).toEqual([]);
    });
  });

  // The pin reads this document's own videos: one in a shadow root or in a
  // same-origin frame was neither held nor said, and the take read as held.
  it("the held clock says a playing video in a shadow root and in a same-origin frame", async () => {
    await withHeldPage(async (page) => {
      await page.evaluate(async () => {
        const stream = () => {
          const canvas = document.createElement("canvas");
          canvas.getContext("2d")?.fillRect(0, 0, 10, 10);
          return canvas.captureStream();
        };
        const host = document.createElement("div");
        host.id = "host";
        document.body.append(host);
        const shadowed = document.createElement("video");
        shadowed.muted = true;
        shadowed.srcObject = stream();
        host.attachShadow({ mode: "open" }).append(shadowed);
        const f = document.createElement("iframe");
        f.id = "embed";
        f.srcdoc = "<!doctype html><body></body>";
        const loaded = new Promise((r) => f.addEventListener("load", r));
        document.body.append(f);
        await loaded;
        const doc = f.contentDocument;
        if (!doc) throw new Error("the frame is not same-origin");
        const framed = doc.createElement("video");
        framed.muted = true;
        framed.srcObject = stream();
        doc.body.append(framed);
        await Promise.all([shadowed.play(), framed.play()]);
      });
      const where = await page.evaluate(() => {
        const f = document.getElementById("embed") as HTMLIFrameElement;
        const w = f.contentWindow as unknown as Record<string, unknown>;
        return {
          ownVideos: document.querySelectorAll("video").length,
          shadowPlaying:
            document.getElementById("host")?.shadowRoot?.querySelector("video")
              ?.paused === false,
          framePlaying:
            f.contentDocument?.querySelector("video")?.paused === false,
          frameHeld: typeof w.__demomanFlushFrames === "function",
        };
      });
      // Premise: neither is the document's own, both play, and the frame
      // has the held frames script, so its parent runs it.
      expect(where).toEqual({
        ownVideos: 0,
        shadowPlaying: true,
        framePlaying: true,
        frameHeld: true,
      });
      // Not paced either (`video` is the pin's own), which the words say.
      expect(await saidAt(page, 1000)).toEqual({
        said: [
          "a video in a shadow root plays, or waits to start, on its own clock: it was not held, nor the take kept to real time for it",
          "a video in a frame plays, or waits to start, on its own clock: it was not held, nor the take kept to real time for it",
        ],
        video: false,
      });
      expect((await saidAt(page, 1033)).said).toEqual([]);
    });
  });

  // Review: an iframe with no src, filled by the page, was thought to miss
  // the held frames script, leaving its video unsaid. Chrome runs it there
  // (measured 2026-11-28), and the frame says its own video. Red if the
  // frame's look is lost.
  it("the held clock says a playing video in a frame the page filled itself", async () => {
    await withHeldPage(async (page) => {
      const held = await page.evaluate(async () => {
        const f = document.createElement("iframe");
        f.id = "blank";
        document.body.append(f);
        const doc = f.contentDocument;
        if (!doc) throw new Error("the frame is not same-origin");
        const canvas = doc.createElement("canvas");
        canvas.getContext("2d")?.fillRect(0, 0, 10, 10);
        const v = doc.createElement("video");
        v.muted = true;
        v.srcObject = canvas.captureStream();
        doc.body.append(v);
        await v.play();
        return {
          playing: !v.paused,
          frameHeld:
            typeof (f.contentWindow as unknown as Record<string, unknown>)
              .__demomanFlushFrames === "function",
        };
      });
      // Premise: it plays, and the frame ran the held frames script, as
      // production installs it.
      expect(held).toEqual({ playing: true, frameHeld: true });
      expect(await saidAt(page, 1000)).toEqual({
        said: [
          "a video in a frame plays, or waits to start, on its own clock: it was not held, nor the take kept to real time for it",
        ],
        video: false,
      });
    });
  });

  // Review of 2026-11-16: the pin reset and played every animation, also one
  // the page holds paused (a progress ring scrubbed by a negative delay).
  // Red if such an animation moves, or the screen's hold resets it.
  it("the held clock's pin leaves an animation the page paused where it is, and plays it on from there", async () => {
    await withPage(async (page) => {
      const pin = async (v: number) =>
        (
          (await page.evaluate(`(${PIN_ANIMATIONS})(${v})`)) as {
            said: string[];
          }
        ).said;
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
      const said = async (v: number) =>
        (
          (await page.evaluate(`(${PIN_ANIMATIONS})(${v})`)) as {
            said: string[];
          }
        ).said;
      expect(await said(1000)).toEqual([
        "spin on div: plays at rate -1, which the held clock does not play",
      ]);
      expect(await said(1033)).toEqual([]);
    });
  });

  // Measured 2026-11-16: under the held clock's pin every animation is
  // paused, the probe counted only running ones, and a toast was pictured
  // half slid in. Red if a finite animation the pin holds mid-way reads as
  // settled.
  it("does not call the page settled while the held clock's pin holds a finite animation mid-way", async () => {
    await withPage(async (page) => {
      await page.click("#toastbtn");
      await page.evaluate(`(${PIN_ANIMATIONS})(1000)`);
      await page.evaluate(`(${PIN_ANIMATIONS})(1033)`);
      const report = await ask(page, QUIET, 700);
      expect(report, JSON.stringify(report)).toMatchObject({
        quiet: false,
        stopped: "cap",
      });
      expect(report.animations).toBeGreaterThan(0);
    });
  });
});
