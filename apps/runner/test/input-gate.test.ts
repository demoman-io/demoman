import { createInputGate } from "@demoman/replay-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Launched, launch } from "../src/launch.js";

/**
 * Why the engine never sends input while it captures a still, in a real
 * Chromium (`input-gate.ts`).
 *
 * Measured 2026-10-13: with the engine's emulated scale (`REPLAY_DPR`, 3) and
 * a `Page.captureScreenshot` in flight, Chromium converts dispatched pointer
 * events with the display's scale instead, so they land at display / 3 of the
 * point they were sent to — 1/3 here, headless, where the display is 1x. The
 * first case is that premise, asserted, so the second cannot pass on a
 * Chromium that stopped doing it without saying so: if the first goes red,
 * the browser no longer has the defect and the gate may be removable.
 *
 * Timeouts: one headless launch in `beforeAll`, then twenty screenshot and
 * click pairs per case. Measured locally (2026-10-13): hook ~0.6 s, each case
 * ~1 s. CI is ~5x slower at browser work (`fff4505`); the bounds below are a
 * ceiling on a hang, not a budget.
 */
const HOOK_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 30_000;

/** The sample app's "Create invoice", where the defect was found. */
const SENT = { x: 1491, y: 1021 };
const ROUNDS = 20;

const PAGE = `<!doctype html><meta charset=utf-8>
<style>body{margin:0} #b{position:fixed;left:1295px;top:1003px;width:391px;height:36px}</style>
<button id=b>Create invoice</button>
<script>
window.arrived = [];
window.clicked = 0;
for (const type of ["pointerdown", "pointerup"])
  addEventListener(type, (e) => arrived.push({ x: e.clientX, y: e.clientY }), true);
document.getElementById("b").addEventListener("click", () => clicked++);
</script>`;

let launched: Launched;

beforeAll(async () => {
  launched = await launch();
  await launched.page.setContent(PAGE);
  await launched.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1710,
    height: 1107,
    deviceScaleFactor: 3,
    mobile: false,
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await launched?.close();
});

const shoot = () =>
  launched.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });

async function click(): Promise<void> {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await launched.cdp.send("Input.dispatchMouseEvent", {
      type,
      ...SENT,
      button: "left",
      clickCount: 1,
    });
  }
}

/** Every pointer event the page saw since the last call, and how many of
 *  them arrived more than a pixel from where they were sent. */
async function arrivals(): Promise<{ events: number; elsewhere: number }> {
  const seen = await launched.page.evaluate(() => {
    const w = window as unknown as { arrived: { x: number; y: number }[] };
    const all = w.arrived;
    w.arrived = [];
    return all;
  });
  const elsewhere = seen.filter(
    (p) => Math.abs(p.x - SENT.x) > 1 || Math.abs(p.y - SENT.y) > 1,
  ).length;
  return { events: seen.length, elsewhere };
}

describe("input while a still is captured, in a real Chromium", () => {
  it(
    "lands elsewhere when nothing keeps the two apart (the premise)",
    async () => {
      await arrivals();
      for (let i = 0; i < ROUNDS; i++) {
        const shot = shoot();
        await click();
        await shot;
      }
      const { events, elsewhere } = await arrivals();
      expect(events).toBe(ROUNDS * 2);
      // Measured 39 of 40. Most, not all: the first event of a pair can go
      // out before the capture takes hold.
      expect(elsewhere, `${elsewhere} of ${events}`).toBeGreaterThan(
        events / 2,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lands where it was sent when the gate keeps them apart",
    async () => {
      const gate = createInputGate();
      await arrivals();
      for (let i = 0; i < ROUNDS; i++) {
        const shot = gate.capture(shoot);
        await gate.section(click);
        await shot;
      }
      const { events, elsewhere } = await arrivals();
      expect(events).toBe(ROUNDS * 2);
      expect(elsewhere, `${elsewhere} of ${events}`).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  // Second review, Minor 5: the direction the engine actually takes. A still
  // asked for while input is going out — the recorder's settled still, as the
  // page goes quiet mid-step — waits for the section to end and then starts
  // at once, with the next input right behind it. The button's own `click`
  // count is read too: the events landing where they were sent is the
  // mechanism, the button activating is the point.
  it(
    "lands where it was sent when a still is asked for during the input",
    async () => {
      const gate = createInputGate();
      await arrivals();
      await launched.page.evaluate(() => {
        (window as unknown as { clicked: number }).clicked = 0;
      });
      let previous: Promise<unknown> = Promise.resolve();
      for (let i = 0; i < ROUNDS; i++) {
        await gate.section(async () => {
          previous = gate.capture(shoot);
          await click();
        });
      }
      await previous;
      const { events, elsewhere } = await arrivals();
      expect(events).toBe(ROUNDS * 2);
      expect(elsewhere, `${elsewhere} of ${events}`).toBe(0);
      expect(
        await launched.page.evaluate(
          () => (window as unknown as { clicked: number }).clicked,
        ),
      ).toBe(ROUNDS);
    },
    TEST_TIMEOUT_MS,
  );
});
