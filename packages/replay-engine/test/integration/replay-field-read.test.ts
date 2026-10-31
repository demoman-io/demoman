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

describe("a typed field, against a real page", () => {
  it("holds what a formatting field shows, and does not hold what a clearing field shows", async () => {
    await withReplayBrowser(
      async ({ cdp, page }) => {
        // The premises: the page really does reformat and really does clear.
        await page.fill("#fmt", "4800");
        expect(await page.inputValue("#fmt")).toBe("4,800");
        await page.fill("#wipe", "4800");
        expect(await page.inputValue("#wipe")).toBe("");
        await page.fill("#fmt", "");

        const selectors: Record<string, string> = {};
        const agent = selectorPageAgent(page, selectors);
        const script: DemoScript = {
          scriptVersion: 1,
          name: "fields",
          target: FIELD_URL,
          steps: [
            { do: "type", into: { stableId: "fmt" }, text: "4800" },
            { do: "type", into: { stableId: "wipe" }, text: "4800" },
          ],
        };
        const store = createMemoryFrameStore();
        let n = 0;
        const result = await runAuthored(script, {
          cdp,
          page: agent,
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
        });
        expect(result.reason, String(result.reason)).toBeNull();
        expect(result.steps.map((s) => s.fieldHolds)).toEqual([
          { value: "4,800", holds: true },
          { value: "", holds: false },
        ]);
      },
      { url: FIELD_URL, readySelector: "#fmt" },
    );
  });
});
