import {
  CLICK_PROBE_INSTALL,
  type ClickVerdict,
  placeClickProbe,
  readClickProbe,
} from "@demoman/replay-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Launched, launch, openCdpSession } from "../src/launch.js";

/**
 * The click check's page side, in a real Chromium (`click-probe.ts`).
 *
 * The engine's own tests answer the probe from a fake, so nothing there runs
 * the function that goes into the page. This does: listeners placed on a
 * real window, real `Input.dispatchMouseEvent` presses and releases, and the
 * verdict read back the way the engine reads it. The defect it exists for —
 * a release Chromium delivered at 2/3 of its press point (2026-10-13) — has
 * never been reproduced outside a real run, so the miss here is made the
 * only way a test can: by sending the release to another point, which is
 * exactly what the page saw happen.
 *
 * Timeouts: one headless launch in `beforeAll`, then a `setContent` and a
 * few CDP round trips per test. Measured locally (2026-10-13): hook ~0.6 s,
 * each test under 100 ms. CI is ~5x slower at browser work (`fff4505`); the
 * bounds below are a ceiling on a hang, not a budget.
 */
const HOOK_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 20_000;
/** The hover-transition test's sixty clicks, each after a 350 ms rest off
 *  the button and up to 150 ms on it: about 26 s of timers, measured
 *  locally (2026-10-13), and the browser work under them is small. */
const HOVER_TEST_TIMEOUT_MS = 120_000;

/**
 * Five targets, each placed where its numbers say: the probe compares where
 * the events arrived with where they were sent, so a test that pressed
 * somewhere unplanned would still pass. `#trap`'s own pointerdown handler
 * dispatches an UNTRUSTED pointerup at (1, 1) before the real release arrives,
 * which the probe must not count. The first iframe sits at (300, 200), so a
 * press inside it reads frame-relative there; the second is drawn at twice its
 * size by a CSS transform, so its page coordinates are half the dispatched
 * ones — the shape a zoomed-out phone page has too.
 */
const PAGE = `<!doctype html><meta charset=utf-8>
<style>body{margin:0} #b,#i,#trap{position:fixed;width:200px;height:40px}
#b{left:100px;top:100px} #i{left:100px;top:200px} #trap{left:100px;top:300px}
iframe{position:fixed;border:0}
#plain{left:300px;top:200px;width:400px;height:200px}
#scaled{left:720px;top:420px;width:100px;height:50px;transform:scale(2);transform-origin:0 0}</style>
<button id=b>b</button><input id=i><button id=trap>trap</button>
<iframe id=plain srcdoc="<style>body{margin:0}</style><button id=f style='position:fixed;left:50px;top:20px;width:100px;height:40px'>f</button>"></iframe>
<iframe id=scaled srcdoc="<style>body{margin:0}</style><button id=g style='position:fixed;left:10px;top:10px;width:40px;height:20px'>g</button>"></iframe>
<script>
document.getElementById("trap").addEventListener("pointerdown", () => {
  window.dispatchEvent(new PointerEvent("pointerup", { clientX: 1, clientY: 1 }));
});
</script>`;

let launched: Launched;

beforeAll(async () => {
  launched = await launch();
  await launched.page.setContent(PAGE);
  await launched.page.frameLocator("#plain").locator("#f").waitFor();
  await launched.page.frameLocator("#scaled").locator("#g").waitFor();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await launched?.close();
});

async function objectIdOf(expression: string): Promise<string> {
  const reply = await launched.cdp.send("Runtime.evaluate", { expression });
  const id = (reply.result as { objectId?: string } | undefined)?.objectId;
  if (id === undefined) throw new Error(`no object for ${expression}`);
  return id;
}

type Point = { x: number; y: number };

/**
 * The engine's click, with the probe placed on `target`: both events claimed
 * to be sent to `sent`, and actually dispatched at `press` and `release` —
 * which default to `sent`, a click the browser delivered. Passing others is
 * how a test makes the browser's defect: the page sees exactly what it saw on
 * 2026-10-13, events at a point other than the one the engine sent.
 */
async function clickWithProbe(
  target: string,
  sent: Point,
  press: Point = sent,
  release: Point = press,
): Promise<ClickVerdict> {
  const { cdp } = launched;
  const probe = await placeClickProbe(cdp, await objectIdOf(target));
  if ("unplaced" in probe) throw new Error(`unplaced: ${probe.unplaced}`);
  for (const [type, at] of [
    ["mousePressed", press],
    ["mouseReleased", release],
  ] as const) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: at.x,
      y: at.y,
      button: "left",
      clickCount: 1,
    });
  }
  return readClickProbe(cdp, probe, sent);
}

/** Counts the probe's re-measurements (`placeClickProbe` brackets a moving
 *  target again) on the shared session until `stop()`. */
function countRemeasures(): { count(): number; stop(): void } {
  const { cdp } = launched;
  const send = cdp.send;
  let count = 0;
  cdp.send = (method, params) => {
    if (
      method === "Runtime.callFunctionOn" &&
      String(params?.functionDeclaration).includes("this.measure()")
    )
      count++;
    return send.call(cdp, method, params);
  };
  return {
    count: () => count,
    stop: () => {
      cdp.send = send;
    },
  };
}

const B = 'document.getElementById("b")';
const B_CENTRE = { x: 200, y: 120 };
/** 2/3 of `B_CENTRE`, the measured shape: on the page, off the button. */
const TWO_THIRDS = { x: 133, y: 80 };

describe("the click check, in a real page", () => {
  it(
    "is delivered when the press and the release arrive where they were sent",
    async () => {
      const v = await clickWithProbe(B, B_CENTRE);
      expect(v).toEqual({
        kind: "delivered",
        seen: {
          own: { x: 100, y: 100, width: 200, height: 40 },
          viewport: { width: 1024, height: 640 },
          down: B_CENTRE,
          up: B_CENTRE,
          cancelled: false,
          focused: true,
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is misdelivered when the release arrives elsewhere, saying where everything went",
    async () => {
      const v = await clickWithProbe(B, B_CENTRE, B_CENTRE, TWO_THIRDS);
      expect(v.kind).toBe("misdelivered");
      expect(v.kind === "misdelivered" && v.why).toBe(
        "sent to (200, 120), the press arrived at (200, 120) and the release arrived at (133, 80)",
      );
    },
    TEST_TIMEOUT_MS,
  );

  // The shape the first version of this check let through: the press and the
  // release agree with each other, and the page saw a real click — just not
  // where it was sent.
  it(
    "is misdelivered when the whole click arrives elsewhere",
    async () => {
      const v = await clickWithProbe(B, B_CENTRE, TWO_THIRDS);
      expect(v.kind).toBe("misdelivered");
      expect(v.kind === "misdelivered" && v.why).toBe(
        "sent to (200, 120), the press arrived at (133, 80) and the release arrived at (133, 80)",
      );
    },
    TEST_TIMEOUT_MS,
  );

  // Red if the probe counts untrusted events: the page's own synthetic
  // pointerup at (1, 1) would be the release it kept. The premise is
  // asserted too — the trap fired — or this would pass on a page that never
  // dispatched it.
  it(
    "ignores a pointerup the page dispatched itself",
    async () => {
      await launched.page.evaluate(() => {
        (window as unknown as { trapped: number }).trapped = 0;
        window.addEventListener(
          "pointerup",
          (e) => {
            if (!e.isTrusted)
              (window as unknown as { trapped: number }).trapped++;
          },
          true,
        );
      });
      const v = await clickWithProbe('document.getElementById("trap")', {
        x: 200,
        y: 320,
      });
      expect(
        await launched.page.evaluate(
          () => (window as unknown as { trapped: number }).trapped,
        ),
      ).toBe(1);
      expect(v.kind).toBe("delivered");
    },
    TEST_TIMEOUT_MS,
  );

  // Inside an iframe the page's coordinates are the frame's own, offset from
  // the top frame's by (300, 200). Judged against the dispatched point
  // unmapped, every click in a frame would be a miss.
  it(
    "is delivered inside an iframe, whose coordinates are its own",
    async () => {
      const v = await clickWithProbe(
        'document.getElementById("plain").contentDocument.getElementById("f")',
        { x: 400, y: 240 },
      );
      expect(v.kind).toBe("delivered");
      expect(v.kind === "delivered" && v.seen.down).toEqual({ x: 100, y: 40 });
    },
    TEST_TIMEOUT_MS,
  );

  // Drawn at twice its size, the frame's page coordinates are half the
  // dispatched ones: `#g`'s centre is (780, 460) to CDP and (30, 20) to the
  // page. Red if the mapping reads the offset and not the scale.
  it(
    "is delivered inside a scaled iframe, and a miss there is still a miss",
    async () => {
      const G =
        'document.getElementById("scaled").contentDocument.getElementById("g")';
      const v = await clickWithProbe(G, { x: 780, y: 460 });
      expect(v.kind).toBe("delivered");
      expect(v.kind === "delivered" && v.seen.down).toEqual({ x: 30, y: 20 });
      const missed = await clickWithProbe(
        G,
        { x: 780, y: 460 },
        { x: 760, y: 450 },
      );
      expect(missed.kind).toBe("misdelivered");
    },
    TEST_TIMEOUT_MS,
  );

  // `focused` is what a type is judged by: the field holds focus after a
  // click that reached it, and not after one that went elsewhere.
  it(
    "says whether the target holds focus afterwards",
    async () => {
      const I = 'document.getElementById("i")';
      const I_CENTRE = { x: 200, y: 220 };
      const own = await clickWithProbe(I, I_CENTRE);
      expect(own.kind === "delivered" && own.seen.focused).toBe(true);
      const astray = await clickWithProbe(I, I_CENTRE, B_CENTRE);
      expect(astray.kind).toBe("misdelivered");
      expect(astray.kind === "misdelivered" && astray.seen.focused).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  // Review 2026-10-13, #1: a label hands its click to its control, so a type
  // aimed at the label types into the control. Red if `focused` asks only
  // whether the target itself holds focus. The premise is asserted first:
  // focus really did go to the control, not the label.
  it(
    "counts a label's control as the field when the label is the target",
    async () => {
      await launched.page.evaluate(() => {
        const label = document.createElement("label");
        label.id = "lab";
        label.htmlFor = "labelled";
        label.textContent = "Name";
        label.style.cssText =
          "position:fixed;left:100px;top:450px;width:150px;height:30px";
        const input = document.createElement("input");
        input.id = "labelled";
        input.style.cssText =
          "position:fixed;left:100px;top:500px;width:150px;height:30px";
        document.body.append(label, input);
      });
      try {
        const v = await clickWithProbe('document.getElementById("lab")', {
          x: 175,
          y: 465,
        });
        expect(
          await launched.page.evaluate(() => document.activeElement?.id),
        ).toBe("labelled");
        expect(v.kind, JSON.stringify(v)).toBe("delivered");
        expect(v.seen?.focused).toBe(true);
        // And not for a click that never reached the label.
        const astray = await clickWithProbe(
          'document.getElementById("lab")',
          { x: 175, y: 465 },
          B_CENTRE,
        );
        expect(astray.seen?.focused).toBe(false);
      } finally {
        await launched.page.evaluate(() => {
          document.getElementById("lab")?.remove();
          document.getElementById("labelled")?.remove();
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The listeners go when the check is read: a click after the read is not
  // seen by it. Driven through the page function itself, on a handle this
  // keeps — `readClickProbe` lets go of its handle once read. Red if
  // `read()` leaves the listeners attached: the second read would then
  // report the later click instead of what the first saw (nothing).
  it(
    "takes its listeners down when it is read",
    async () => {
      const { cdp } = launched;
      const placed = await cdp.send("Runtime.callFunctionOn", {
        objectId: await objectIdOf(B),
        functionDeclaration: CLICK_PROBE_INSTALL,
        returnByValue: false,
      });
      const probeId = (placed.result as { objectId: string }).objectId;
      const read = async () =>
        (
          (
            await cdp.send("Runtime.callFunctionOn", {
              objectId: probeId,
              functionDeclaration: "function(){ return this.read(); }",
              returnByValue: true,
            })
          ).result as { value: { down: unknown; up: unknown } }
        ).value;
      expect(await read()).toMatchObject({ down: null, up: null });
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", {
          type,
          ...B_CENTRE,
          button: "left",
          clickCount: 1,
        });
      }
      expect(await read()).toMatchObject({ down: null, up: null });
    },
    TEST_TIMEOUT_MS,
  );

  // A target past the viewport's edge — a panel that never slid in, its
  // fields still where its transform left them — is clicked where it is, and
  // the events arrive there, on the document. Arrived where sent is not
  // delivered when "where sent" is off the page.
  it(
    "is misdelivered when the target is off screen, though the events arrived where sent",
    async () => {
      await launched.page.evaluate(() => {
        const b = document.createElement("button");
        b.id = "offscreen";
        b.style.cssText =
          "position:fixed;left:1100px;top:100px;width:200px;height:40px";
        document.body.append(b);
      });
      try {
        const v = await clickWithProbe('document.getElementById("offscreen")', {
          x: 1200,
          y: 120,
        });
        expect(v.kind, JSON.stringify(v)).toBe("misdelivered");
        expect(v.kind === "misdelivered" && v.why).toBe(
          "sent to (1200, 120), outside the page's 1024x640 viewport — the target is off screen — so it reached nothing",
        );
      } finally {
        await launched.page.evaluate(() =>
          document.getElementById("offscreen")?.remove(),
        );
      }
    },
    TEST_TIMEOUT_MS,
  );

  // A page whose own window listener, registered before the check's, stops
  // the release: the check never sees it, and that is no evidence of a miss
  // (review I3). Red if a missing event stops a run on such a page.
  it(
    "is unconfirmed, not a miss, when the page's own code hid the release",
    async () => {
      await launched.page.evaluate(() => {
        const stop = (e: Event) => e.stopImmediatePropagation();
        window.addEventListener("pointerup", stop, true);
        (window as unknown as { unstop: () => void }).unstop = () =>
          window.removeEventListener("pointerup", stop, true);
      });
      try {
        const v = await clickWithProbe(B, B_CENTRE);
        expect(v.kind, JSON.stringify(v)).toBe("unconfirmed");
        expect(v.kind === "unconfirmed" && v.why).toMatch(
          /the press arrived at \(200, 120\) and the release was never seen/,
        );
      } finally {
        await launched.page.evaluate(() =>
          (window as unknown as { unstop: () => void }).unstop(),
        );
      }
    },
    TEST_TIMEOUT_MS,
  );

  // A target the page moves between CDP's measurement and its own gives a
  // mapping off by the motion (review I4): a click that arrived where it was
  // sent would read as a miss. The page moves `#drift` at 20 px per ms,
  // re-placed on every task, and jumps it back every 30 ms: a sawtooth, so
  // no bracket shorter than a whole cycle (a bracket is about 0.3 ms) ends
  // where it began. A looping drift of 3 px per task did, and passed the
  // bracket with the page's rect from mid-cycle (second review, Important
  // 2); so did the back-and-forth this replaced, once, at a turn — the same
  // place at 29 ms and 31 ms — in a loaded lane (2026-10-13). The
  // check must never call such a click a miss. A task lands inside a bracket
  // on about 6% of clicks (measured, 400 clicks), so the test clicks until
  // the bracket has caught one — at least 10, at most 200: the chance of no
  // catch in 200 is about 5 in 10 million. A caught bracket is now bracketed
  // again (review 2026-10-13, #5), so the catch is counted by the page's
  // re-measurements, not by a verdict that names the motion.
  it(
    "never misjudges a click on a target that moves while it is measured",
    async () => {
      await launched.page.evaluate(() => {
        const b = document.createElement("button");
        b.id = "drift";
        b.textContent = "drift";
        b.style.cssText =
          "position:fixed;left:100px;top:100px;width:200px;height:40px";
        document.body.append(b);
        const w = window as unknown as { drifting: boolean };
        w.drifting = true;
        const channel = new MessageChannel();
        const t0 = performance.now();
        channel.port1.onmessage = () => {
          if (!w.drifting) return;
          const t = (performance.now() - t0) % 30;
          b.style.left = `${100 + 20 * t}px`;
          channel.port2.postMessage(null);
        };
        channel.port2.postMessage(null);
      });
      const D = 'document.getElementById("drift")';
      const verdicts: string[] = [];
      const remeasures = countRemeasures();
      try {
        const caught = () => remeasures.count() > 0;
        for (let i = 0; i < 200 && (i < 10 || !caught()); i++) {
          // Sent where CDP measures it now, as the engine would.
          const border = (
            (
              await launched.cdp.send("DOM.getBoxModel", {
                objectId: await objectIdOf(D),
              })
            ).model as { border: number[] }
          ).border;
          const sent = {
            x: ((border[0] as number) + (border[2] as number)) / 2,
            y: ((border[1] as number) + (border[5] as number)) / 2,
          };
          const v = await clickWithProbe(D, sent);
          verdicts.push(
            v.kind === "unconfirmed" ? `unconfirmed: ${v.why}` : v.kind,
          );
        }
      } finally {
        remeasures.stop();
        await launched.page.evaluate(() => {
          (window as unknown as { drifting: boolean }).drifting = false;
          document.getElementById("drift")?.remove();
        });
      }
      expect(
        verdicts.filter((v) => v === "misdelivered"),
        verdicts.join("\n"),
      ).toEqual([]);
      // The premise: the motion was there to catch, and was caught.
      expect(remeasures.count(), verdicts.join("\n")).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  // Review 2026-10-13, #5: a button with a hover transition, clicked as the
  // cursor arrives — the transition still running. Measured before the fix:
  // one bracket left 18 of 100 such clicks unconfirmed on a page that did
  // nothing wrong. Re-bracketed, about 2 in 10,000 are; two of 60 is the
  // ceiling on luck, not the expectation. Red with a single bracket (about
  // 11 of 60). The premise: the motion was caught, and bracketed again.
  it(
    "confirms a click on a target whose hover transition is still running",
    async () => {
      await launched.page.evaluate(() => {
        const style = document.createElement("style");
        style.id = "hover-style";
        style.textContent =
          "#hover{position:fixed;left:100px;top:560px;width:200px;height:40px;transition:transform 300ms ease}#hover:hover{transform:scale(1.05)}";
        const b = document.createElement("button");
        b.id = "hover";
        b.textContent = "hover";
        document.head.append(style);
        document.body.append(b);
      });
      const H = { x: 200, y: 580 };
      const verdicts: string[] = [];
      const remeasures = countRemeasures();
      try {
        for (let i = 0; i < 60; i++) {
          // Off the button long enough for the transition to finish going
          // back, then onto it in steps, as a cursor path arrives.
          await launched.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: 5,
            y: 5,
          });
          await new Promise((r) => setTimeout(r, 350));
          for (let s = 0; s <= 10; s++) {
            await launched.cdp.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: 5 + ((H.x - 5) * s) / 10,
              y: 5 + ((H.y - 5) * s) / 10,
            });
          }
          await new Promise((r) => setTimeout(r, (i * 7) % 150));
          const v = await clickWithProbe('document.getElementById("hover")', H);
          verdicts.push(
            v.kind === "unconfirmed" ? `unconfirmed: ${v.why}` : v.kind,
          );
        }
      } finally {
        remeasures.stop();
        await launched.page.evaluate(() => {
          document.getElementById("hover")?.remove();
          document.getElementById("hover-style")?.remove();
        });
      }
      expect(
        verdicts.filter((v) => v === "misdelivered"),
        verdicts.join("\n"),
      ).toEqual([]);
      expect(
        verdicts.filter((v) => v.startsWith("unconfirmed")).length,
        verdicts.join("\n"),
      ).toBeLessThanOrEqual(2);
      expect(remeasures.count(), verdicts.join("\n")).toBeGreaterThan(0);
    },
    HOVER_TEST_TIMEOUT_MS,
  );
});

/**
 * A phone take (review I5): a tap through touch emulation, and a click on a
 * page with no meta viewport, which a phone shows zoomed out. Measured
 * 2026-10-13 before this was written: 20 of 20 of each delivered, headed and
 * headless. A page of its own, so the emulation stays off the one above.
 */
describe("the click check on a phone", () => {
  const PHONE_PAGE = `<!doctype html><style>body{margin:0;width:980px}
#t{position:absolute;left:400px;top:300px;width:200px;height:80px}</style>
<button id=t>t</button>`;

  it(
    "is delivered for a tap, and for a click on a zoomed-out page",
    async () => {
      const page = await launched.context.newPage();
      try {
        const cdp = await openCdpSession(launched.context, page);
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: 393,
          height: 852,
          deviceScaleFactor: 3,
          mobile: true,
        });
        await cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        });
        await page.setContent(PHONE_PAGE);
        // The premise: the page really is shown zoomed out.
        const scale = await page.evaluate(() => visualViewport?.scale ?? 1);
        expect(scale).toBeLessThan(0.5);
        const target = (
          (
            await cdp.send("Runtime.evaluate", {
              expression: 'document.getElementById("t")',
            })
          ).result as { objectId: string }
        ).objectId;
        const border = (
          (await cdp.send("DOM.getBoxModel", { objectId: target })).model as {
            border: number[];
          }
        ).border;
        const centre = {
          x: ((border[0] as number) + (border[2] as number)) / 2,
          y: ((border[1] as number) + (border[5] as number)) / 2,
        };

        const tapProbe = await placeClickProbe(cdp, target);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ ...centre, radiusX: 4, radiusY: 4, force: 1, id: 0 }],
        });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        const tap = await readClickProbe(cdp, tapProbe, centre);
        expect(tap.kind, JSON.stringify(tap)).toBe("delivered");

        const clickProbe = await placeClickProbe(cdp, target);
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            ...centre,
            button: "left",
            clickCount: 1,
          });
        }
        const click = await readClickProbe(cdp, clickProbe, centre);
        expect(click.kind, JSON.stringify(click)).toBe("delivered");
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
