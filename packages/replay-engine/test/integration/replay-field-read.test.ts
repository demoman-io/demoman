import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BRANDING_DEFAULTS, type DemoScript } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { runAuthored } from "../../src/index.js";
import {
  selectorPageAgent,
  withReplayBrowser,
} from "../helpers/cdp-playwright";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import { createMemoryFrameStore } from "../helpers/frame-store";

/**
 * `type` reads its field back. Real Chromium, because what a page does to
 * the characters as they go in (reformats them, throws them away) is the
 * thing a fake CDP cannot answer.
 */
const FIELD_URL = pathToFileURL(
  join(import.meta.dirname, "..", "fixtures", "field-app.html"),
).href;

const clock = () => ({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
});

type Result = Awaited<ReturnType<typeof runAuthored>>;

/** Runs `steps` against the fixture page and hands the result over. */
async function runTypes(
  steps: DemoScript["steps"],
  then: (result: Result, page: import("playwright").Page) => Promise<void>,
  /** Recorded continuously, with a room policy: each act's end is stamped
   *  on its marker. */
  continuous = false,
): Promise<void> {
  await withReplayBrowser(
    async ({ cdp, page }) => {
      const selectors: Record<string, string> = {};
      const script: DemoScript = {
        scriptVersion: 1,
        name: "fields",
        target: FIELD_URL,
        steps,
      };
      const store = createMemoryFrameStore();
      let n = 0;
      const result = await runAuthored(script, {
        cdp,
        page: selectorPageAgent(page, selectors),
        encoder: createNodeFrameEncoder(store, "field-read"),
        store,
        clock: clock(),
        mayReplay: true,
        captureResolved: async (intent) => {
          const id = intent.fingerprint.stableId ?? "";
          selectors[intent.id] = `#${id}`;
          const box = await page.locator(`#${id}`).boundingBox();
          if (box === null) throw new Error(`#${id} has no box`);
          return {
            anchor: {
              id: intent.id,
              fingerprint: { ...intent.fingerprint, boundingRect: box },
              resolution: {
                url: FIELD_URL,
                actionIndex: 0,
                entryState: false,
                strategy: "stableId",
                failureReason: null,
                candidates: 1,
              },
            },
            failureReason: null,
            intentResolution: {
              strategy: "stableId",
              candidates: 1,
              failureReason: null,
            },
            pageUrl: FIELD_URL,
          };
        },
        newId: (prefix) => `${prefix}-${++n}`,
        sceneId: "field-read",
        createdAt: "2026-10-30T00:00:00.000Z",
        viewport: { width: 1024, height: 640 },
        startingBranding: BRANDING_DEFAULTS,
        cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
        // Continuous, with a room policy that zooms nothing: the walk then
        // stamps each act's end on its marker (`pendingAct`).
        ...(continuous
          ? {
              recording: "continuous" as const,
              roomFor: () => ({
                neededMs: () => 0,
                returnShortMs: () => 0,
                arrives: () => "return" as const,
                zooms: () => false,
                settledAfterMs: (heldUntilMs: number) => heldUntilMs,
              }),
            }
          : {}),
      });
      expect(result.reason, String(result.reason)).toBeNull();
      await then(result, page);
    },
    { url: FIELD_URL, readySelector: "#fmt" },
  );
}

describe("a typed field, against a real page", () => {
  it("a type aimed at a label wrapping its input holds what the input holds", async () => {
    await runTypes(
      [{ do: "type", into: { stableId: "wrap" }, text: "hello" }],
      async (result, page) => {
        // The premise: the text went into the input, not into the label.
        expect(await page.inputValue("#inner")).toBe("hello");
        expect(result.steps[0]?.fieldHolds).toEqual({
          value: "hello",
          holds: true,
        });
        // A page that paints its keys says nothing about the paint.
        expect(result.steps[0]?.lastKeyPaint).toBeUndefined();
      },
    );
  });

  it("holds what a formatting field shows, and does not hold what a clearing field shows", async () => {
    await runTypes(
      [
        { do: "type", into: { stableId: "fmt" }, text: "4800" },
        { do: "type", into: { stableId: "wipe" }, text: "4800" },
      ],
      async (result, page) => {
        // The premises: the page really does reformat and really does clear.
        await page.fill("#fmt", "4800");
        expect(await page.inputValue("#fmt")).toBe("4,800");
        await page.fill("#wipe", "4800");
        expect(await page.inputValue("#wipe")).toBe("");
        expect(result.steps.map((s) => s.fieldHolds)).toEqual([
          { value: "4,800", holds: true },
          { value: "", holds: false },
        ]);
      },
    );
  });
});

describe("the editing keys, against a real page", () => {
  // What a press does to a field. Measured 2026-10-31 on macOS with
  // Playwright's Chromium (headless shell and headed alike), these pass with
  // or without the editor commands `pressKey` sends there; Playwright sends
  // them for the Chromium builds that need them, and so does `pressKey`
  // (`keys.test.ts` fails without them). This is the behaviour they guard.
  it("ArrowLeft then Backspace deletes the character before the caret", async () => {
    await runTypes(
      [
        { do: "type", into: { stableId: "plain" }, text: "helo" },
        { do: "press", key: "ArrowLeft" },
        { do: "press", key: "Backspace" },
      ],
      async (_result, page) => {
        expect(await page.inputValue("#plain")).toBe("heo");
      },
    );
  });

  it("two ArrowLefts then Delete deletes the character after the caret", async () => {
    await runTypes(
      [
        { do: "type", into: { stableId: "plain" }, text: "helo" },
        { do: "press", key: "ArrowLeft" },
        { do: "press", key: "ArrowLeft" },
        { do: "press", key: "Delete" },
      ],
      async (_result, page) => {
        expect(await page.inputValue("#plain")).toBe("heo");
      },
    );
  });
});

describe("a field whose last key is never seen painted", () => {
  // The step's end waits for the last key's paint, bounded; a page
  // that draws no frame inside the bound is said, not taken as painted.
  it("says so on the step rather than reporting the key painted", async () => {
    await runTypes(
      [{ do: "type", into: { stableId: "frozen" }, text: "ab" }],
      async (result, page) => {
        // The premise: the keys went in; only the frames were withheld.
        expect(await page.inputValue("#frozen")).toBe("ab");
        expect(result.steps[0]?.lastKeyPaint).toEqual({
          unconfirmed: "the page drew no frame within 1000 ms of the last key",
        });
      },
    );
  });
});

describe("a field whose last key paints late", () => {
  // The type's act ends only once the page has drawn the frames after the last
  // key; this field holds them until 700 ms after it. Read off the act's own
  // end, not the film, so a starved screencast cannot fake it (unhurried-beats
  // skips on that). Red, in most runs, if the walk stops waiting for the
  // frames (`lastKeyPainted`): the act then ends at the key, before them.
  it("ends the type's act after the page drew the frames after the last key", async () => {
    await runTypes(
      [{ do: "type", into: { stableId: "slowpaint" }, text: "a" }],
      async (result, page) => {
        expect(await page.inputValue("#slowpaint")).toBe("a");
        const marker = result.bundle?.markers.find(
          (x) => x.actionId === result.steps[0]?.actionId,
        );
        const acted =
          (marker?.actEndSourceTimeMs ?? Number.NaN) -
          (marker?.sourceTimeMs ?? Number.NaN);
        // Wall-clock ms: the page's Date.now() and the walk's clock here are
        // this machine's one clock. Pressed, keyed, and the first held frame.
        const times = await page.evaluate(
          () =>
            (window as { slowPaint?: Record<string, number> }).slowPaint ?? {},
        );
        const {
          pressedAt = Number.NaN,
          keyAt = Number.NaN,
          drawnAt = Number.NaN,
        } = times;
        const said = JSON.stringify({ acted, marker, times });
        // The premises: the field was pressed, then keyed, and its frames
        // came at least the 700 ms after the key the page holds them for.
        expect(Number.isFinite(acted), said).toBe(true);
        expect(keyAt - pressedAt, said).toBeGreaterThanOrEqual(0);
        expect(drawnAt - keyAt, said).toBeGreaterThanOrEqual(700);
        // The marker is stamped before the press, so an act that ends after
        // the late frame lasts at least from the press to that frame, however
        // slow the machine. Without the wait it ends at the key's read, or at
        // the last motion the recorder saw after it, which can carry it past
        // the frames: red without the wait in 9 of 12 runs (2026-11-28, 6 of
        // them under 6 background burners), so a removed wait shows within
        // a run or two, not on every one.
        expect(acted, said).toBeGreaterThanOrEqual(drawnAt - pressedAt);
        expect(result.steps[0]?.lastKeyPaint, said).toBeUndefined();
      },
      true,
    );
  });
});

describe("a field whose key takes the page away", () => {
  // The document the key went into is gone, so there is
  // no paint left to confirm; the step is not reported as unpainted.
  it("says nothing about the last key's paint", async () => {
    await runTypes(
      [{ do: "type", into: { stableId: "leave" }, text: "a" }],
      async (result, page) => {
        // The premise: the key did navigate.
        await page.waitForURL(/\?left=1$/);
        expect(result.steps[0]?.lastKeyPaint).toBeUndefined();
      },
    );
  });
});

describe("a field that moves focus as it fills", () => {
  it("is not judged when focus left it after typing", async () => {
    await runTypes(
      [{ do: "type", into: { stableId: "code1" }, text: "12" }],
      async (result, page) => {
        // The premises: the page really did move focus, so the second
        // character went into the next box and the target holds only "1".
        expect(await page.inputValue("#code1")).toBe("1");
        expect(await page.inputValue("#code2")).toBe("2");
        expect(
          await page.evaluate(() => document.activeElement?.id ?? null),
        ).toBe("code2");
        expect(result.steps[0]?.fieldHolds).toBeUndefined();
        expect(result.steps[0]?.fieldRead).toEqual({
          unavailable: "focus moved to another element after typing",
        });
      },
    );
  });
});
