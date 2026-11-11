import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PAGE_CAPTURE_HOLD,
  PAGE_CAPTURE_RELEASE,
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

  it("waits out a toast's slide-in", async () => {
    await withPage(async (page) => {
      await page.click("#toastbtn");
      const running = await page.evaluate(
        () =>
          document.getAnimations().filter((a) => a.playState === "running")
            .length,
      );
      expect(running, "premise: the slide is running after the click").toBe(1);
      const report = await ask(page);
      expect(report.animations, JSON.stringify(report)).toBe(0);
      const transform = await page.evaluate(
        () =>
          getComputedStyle(document.getElementById("toast") as Element)
            .transform,
      );
      expect(
        ["none", "matrix(1, 0, 0, 1, 0, 0)"],
        `transform ${transform}`,
      ).toContain(transform);
    });
  });

  it("answers unsettled at the cap on a page that never stops", async () => {
    await withPage(async (page) => {
      await page.click("#never");
      const report = await ask(page, QUIET, 800);
      expect(report.quiet, JSON.stringify(report)).toBe(false);
      expect(
        Math.abs(report.waitedMs - 800),
        JSON.stringify(report),
      ).toBeLessThan(100);
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
});
