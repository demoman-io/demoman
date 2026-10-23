import { describe, expect, it } from "vitest";
import type { CdpSession } from "../../src/index.js";
import { createOcclusionGuard } from "../../src/index.js";
import { FIXTURE_URL, withReplayBrowser } from "../helpers/cdp-playwright";

/**
 * Why the runner opens the replay window blank and navigates it *after*
 * attaching, rather than opening it at the scene's URL.
 *
 * The occlusion guard installs its heartbeat with
 * `Page.addScriptToEvaluateOnNewDocument`, which runs on documents created
 * after the call and never reaches back into one already loaded. A window
 * opened at the scene's URL and attached afterwards therefore leaves the
 * heartbeat silent for the whole run of any scene that does not navigate —
 * which is most of them — and once the construction grace expired the guard
 * would pause a perfectly healthy run for want of a beat it never wired up.
 *
 * That is a claim about a browser, so a browser answers it. Both orderings
 * are exercised here against the same session: the wrong one produces no
 * beat at all, which is what makes the right one's beats mean something.
 */

const BINDING = "__demomanHeartbeat";
const WAIT_MS = 500;

const clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

function beats(cdp: CdpSession): string[] {
  const seen: string[] = [];
  cdp.on("Runtime.bindingCalled", (params) => {
    if (params.name === BINDING) seen.push(String(params.payload));
  });
  return seen;
}

describe("the occlusion guard's install ordering", () => {
  it("stays silent on a document that was already loaded, and beats on the one created after it", async () => {
    await withReplayBrowser(async ({ cdp, page }) => {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      const seen = beats(cdp);

      const guard = createOcclusionGuard({ cdp, clock });
      await guard.install();

      // The brief's ordering, as the control: the fixture is already loaded
      // by the time the heartbeat is registered, so no beat arrives. If this
      // ever starts beating, the ordering below stops being load-bearing
      // and this whole test is proving nothing.
      await clock.sleep(WAIT_MS);
      expect(seen).toEqual([]);

      // The runner's ordering: the scene's own document is created after
      // the heartbeat is registered, so the very first document is covered —
      // and a real, visible browser beats more than once per WAIT_MS at the
      // ~250ms cadence, which is also what proves rAF is genuinely driving
      // the loop rather than a single startup tick.
      await cdp.send("Page.navigate", { url: FIXTURE_URL });
      await page.waitForSelector("#static-btn");
      await clock.sleep(WAIT_MS);
      expect(seen.length).toBeGreaterThanOrEqual(2);
    });
  });
});
