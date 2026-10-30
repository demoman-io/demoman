import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureScene } from "../../../packages/compositor/scripts/fixture-scene.js";
import { type Launched, launch } from "../src/launch.js";
import { installResolver } from "../src/page-agent.js";
import {
  anchorFingerprintComplaints,
  anchorRectComplaints,
  anchorResolutionComplaints,
  motionTransitionComplaints,
  RECT_DRIFT_PX,
  serveFixtureApp,
  textWidthCouplingComplaints,
} from "./fixture.js";

/**
 * The fixture guard: this lane's version of `harvest-fixture.ts`'s
 * `RECT_DRIFT_PX` check, one layer up. `fixture-scene.ts`'s fingerprints
 * describe `fixture-app.html`; nothing else in the repo asks the REAL
 * resolver whether that description still holds — `harvest-fixture.ts`
 * locates elements through `FIXTURE_SELECTORS` and never calls it. The
 * runner does call it, so if the page ever drifts from the scene, this file
 * is what says so, naming the anchor, rather than the acceptance test
 * failing three anchors deep with no idea why.
 *
 * The checks themselves live in `fixture.ts`, because Task 13's
 * `acceptance.test.ts` runs them too — before it renders anything, so that a
 * drifted fixture fails with one of their sentences instead of with a colour
 * comparison nobody can act on. This file is the one that exists to run
 * them; that one runs them to protect its own assertions.
 *
 * Timeouts.
 *
 * Same shape as `page-agent.test.ts`'s: one Chromium launch plus one esbuild
 * bundle in `beforeAll`, then a handful of `evaluate`/`locator` round trips
 * per test against an already-running browser. Measured on this machine
 * (Apple silicon, 2026-09-08), over three runs of this file:
 *
 *   beforeAll (http server + bundle + launch + one navigation)   136-158 ms
 *   "resolves every anchor..."                                     9-14 ms
 *   "records the fingerprints..."                                  20-21 ms
 *   "still lays the anchors out..."                                20-26 ms
 *   "still has the one animating transition..."                      1 ms
 *
 * "records the fingerprints..." is the only one that bundles anything of its
 * own (`fingerprint-probe-entry.ts`, through `bundleEntry`), and it is still
 * in the same tens-of-ms band as its neighbours: `beforeAll`'s
 * `installResolver` has already paid esbuild's start-up by the time it runs,
 * and the bundle itself is cached per process. Re-measured over three runs
 * on this machine (2026-09-09) rather than assumed.
 *
 * CI is about 5x slower than this machine at browser work (`fff4505`). The
 * bounds below are ~150-500x the measured local numbers — a ceiling on a
 * hang, not a budget, and comfortably inside `vitest.config.ts`'s lane-wide
 * 60s/120s. Nothing here waits for a duration; the only waits are
 * `page.goto`'s own `load` and Playwright's own condition-based `locator`
 * calls.
 */
const HOOK_TIMEOUT_MS = 20_000; // ~158 ms measured worst, ~125x
const TEST_TIMEOUT_MS = 5_000; // ~26 ms measured worst, ~190x

let launched: Launched;
let page: Page;
let server: { url: string; close(): void };

beforeAll(async () => {
  server = await serveFixtureApp();

  launched = await launch();
  page = launched.page;
  // Before the first navigation, so the injected resolver is present when
  // the page's document starts loading.
  await installResolver(page);

  // `launch()` deliberately creates its context at a viewport that is NOT
  // the scene's own (see launch.ts's docblock) — that is a property of the
  // real replay engine's own emulation call, irrelevant here. This guard
  // instead re-lays the page out at the exact viewport fixture-scene.ts's
  // rects were measured at, because `fixture-app.html`'s checkout button is
  // `position: fixed; bottom: 136px` — its measured y depends on viewport
  // height, and comparing it against a differently-sized viewport would
  // report drift the page never actually has.
  const { width, height } = fixtureScene().meta.capture.viewport;
  await page.setViewportSize({ width, height });
  await page.goto(server.url, { waitUntil: "load" });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await launched?.close();
  server?.close();
});

describe("fixture-app.html still matches fixture-scene.ts", () => {
  it(
    "resolves every anchor, by the strategy the scene records",
    async () => {
      const complaints = await anchorResolutionComplaints(page);
      expect(complaints.join("\n"), complaints.join("\n")).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "records the fingerprints the resolver actually computes for it",
    async () => {
      const complaints = await anchorFingerprintComplaints(page);
      expect(complaints.join("\n"), complaints.join("\n")).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    `still lays the anchors out where the scene says, within ${RECT_DRIFT_PX}px`,
    async () => {
      const complaints = await anchorRectComplaints(page);
      expect(complaints.join("\n"), complaints.join("\n")).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lays every anchor out from CSS lengths, not from rendered text widths",
    async () => {
      const complaints = await textWidthCouplingComplaints(page);
      expect(complaints.join("\n"), complaints.join("\n")).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "still has the one animating transition the motion span exists to capture",
    async () => {
      const complaints = await motionTransitionComplaints(page);
      expect(complaints.join("\n"), complaints.join("\n")).toBe("");
    },
    TEST_TIMEOUT_MS,
  );
});
