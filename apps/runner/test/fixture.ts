import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { SceneAspect } from "@demoman/scene-schema";
import type { Page } from "playwright";
import {
  FIXTURE_SELECTORS,
  fixtureScene,
  MOTION_CLICK_ACTION_ID,
} from "../../../packages/compositor/scripts/fixture-scene.js";
import { bundleEntry } from "../src/bundle-js.js";
import { FINGERPRINT_PROBE_GLOBAL } from "../src/entry-globals.js";
import type { LocalExecutor } from "../src/executor/types.js";
import type {
  FingerprintProbe,
  ProbedFingerprint,
} from "../src/fingerprint-probe-entry.js";
import { createHeadlessPageAgent } from "../src/page-agent.js";

/**
 * Serves `fixture-app.html` over http on the loopback interface, at every
 * path, and hands back the origin and a way to stop.
 *
 * Over http, not opened as `file://`, for two reasons that both bite: the
 * runner's policy gate only admits http(s) targets (`validateTargetUrl`), so
 * a `file://` URL never reaches replay at all; and `file://` is not a secure
 * context, where `VideoDecoder` is undefined and the decode probe cannot
 * run. Loopback IS a secure context, which is why the same origin can serve
 * the app to the pipeline and host the probe that decodes what came out.
 */
export async function serveFixtureApp(): Promise<{
  url: string;
  close(): void;
}> {
  const html = await readFile(
    new URL(
      "../../../packages/compositor/scripts/fixture-app.html",
      import.meta.url,
    ),
    "utf8",
  );
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}

/**
 * The fixture guard's four checks, as functions two test files share.
 *
 * `fixture-guard.test.ts` (Task 9) is the file that exists to run them and
 * say what drifted. They live here rather than there because
 * `acceptance.slow.test.ts` has to run them too, BEFORE it renders anything: the
 * acceptance test asserts on the colour of pixels at fractions of a frame,
 * and if `fixture-app.html` ever stops painting what `fixture-scene.ts`
 * describes, the honest failure is "anchor a-checkout has drifted 31px"
 * and not "expected rgb(247,249,251) to be within 12 of rgb(31,41,55)".
 * Restating the checks in the acceptance test would have been the second
 * copy that goes stale — so: one definition, two callers.
 *
 * Each returns a list of complaints, empty when nothing has drifted. A list
 * rather than a thrown error so a caller sees ALL the drift at once, and so
 * the caller decides whether that is an `expect` or a thrown hook failure.
 *
 * Every one of them needs a page that is already at `fixture-app.html`, laid
 * out at `fixtureScene().meta.capture.viewport` — see
 * `fixture-guard.test.ts`'s own `beforeAll` for why the viewport is not
 * `launch()`'s.
 */

/** The rect a live locator reports, in the same shape the scene records. */
type Box = { x: number; y: number; width: number; height: number };

async function measure(page: Page, selector: string): Promise<Box | null> {
  const box = await page.locator(selector).boundingBox();
  return box === null
    ? null
    : { x: box.x, y: box.y, width: box.width, height: box.height };
}

/**
 * Same drift measure `harvest-fixture.ts`'s `assertNoDrift` uses: the
 * Euclidean distance between the two rects' centers. `planScene` aims the
 * cursor at a center, so a rect that has drifted in every dimension but
 * still shares a center is not the drift that matters here.
 */
function drift(a: Box, b: Box): number {
  const centerA = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const centerB = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  return Math.hypot(centerA.x - centerB.x, centerA.y - centerB.y);
}

/**
 * Every anchor resolves, by the strategy the scene records.
 *
 * Nothing else in the repo asks the REAL resolver whether
 * `fixture-scene.ts`'s fingerprints still describe the page —
 * `harvest-fixture.ts` locates elements through `FIXTURE_SELECTORS` and
 * never calls it. The runner does call it, so this is what says so, naming
 * the anchor.
 */
export async function anchorResolutionComplaints(
  page: Page,
): Promise<string[]> {
  const agent = createHeadlessPageAgent(page, () => undefined);
  const scene = fixtureScene();
  const reports = await agent.resolve(scene.anchors);
  const complaints: string[] = [];
  for (const report of reports) {
    const anchor = scene.anchors.find((a) => a.id === report.anchorId);
    const wanted = anchor?.resolution.strategy;
    if (!report.resolved) {
      complaints.push(
        `anchor ${report.anchorId} did not resolve — fixture-app.html has ` +
          "drifted from fixture-scene.ts's fingerprints",
      );
    } else if (report.strategy !== wanted) {
      complaints.push(
        `anchor ${report.anchorId} resolved by "${report.strategy}", not ` +
          `"${wanted}" — fixture-app.html has drifted from ` +
          "fixture-scene.ts's fingerprints",
      );
    }
  }
  return complaints;
}

/** The same check `harvest-fixture.ts` makes, and for the same reason:
 *  `planScene` is frameless, so a rect that disagrees with the DOM sends the
 *  planned cursor path to empty space. */
export const RECT_DRIFT_PX = 8;

export async function anchorRectComplaints(page: Page): Promise<string[]> {
  const complaints: string[] = [];
  for (const anchor of fixtureScene().anchors) {
    const selector = FIXTURE_SELECTORS[anchor.id];
    if (selector === undefined) {
      complaints.push(`no fixture selector for anchor ${anchor.id}`);
      continue;
    }
    const rect = await measure(page, selector);
    if (rect === null) {
      complaints.push(
        `"${selector}" has no box — fixture-app.html has drifted from ` +
          "fixture-scene.ts (the element is not rendered)",
      );
      continue;
    }
    const boundingRect = anchor.fingerprint.boundingRect;
    if (boundingRect === null) {
      complaints.push(`anchor ${anchor.id} has no boundingRect recorded`);
      continue;
    }
    const measured = drift(rect, boundingRect);
    if (measured > RECT_DRIFT_PX) {
      complaints.push(
        `anchor ${anchor.id} has drifted ${measured.toFixed(1)}px from ` +
          `fixture-scene.ts (page says ${JSON.stringify(rect)})`,
      );
    }
  }
  return complaints;
}

/**
 * No anchor's position may depend on how wide the page's text happens to
 * render.
 *
 * `anchorRectComplaints` above compares the page against numbers measured
 * once, on one machine. That makes it a guard against the fixture being
 * edited — and blind to the fixture laying out differently somewhere else,
 * which is the same complaint with a cause nobody can act on. On 2026-09-10
 * it fired on CI and nowhere else: `#search` follows
 * `<span class="brand">Northwind</span>` in the header's flex row, so its x
 * was 24px of padding plus the *rendered width of that word* plus a 20px
 * gap. That word measures 73.4px in the face macOS resolves `system-ui` to
 * and 84.4px in the ubuntu runner's, which put `a-search` 11.4px off a
 * threshold of 8 — a red CI with nothing wrong in the repo.
 *
 * So this asks the invariant directly rather than restating any platform's
 * numbers: widen every run of text on the page by a fixed, font-independent
 * amount, and assert no anchor moved. It passes only while every anchor rect
 * is arithmetic on CSS lengths, which is the property that makes
 * `fixture-scene.ts`'s recorded rects portable at all.
 *
 * `letter-spacing` rather than longer text: it changes glyph advances and
 * nothing else — no DOM surgery to undo, and the same widening on every
 * platform, unlike swapping in a font family that may not be installed.
 *
 * To see it fail: drop `width` from `header .brand` in `fixture-app.html`.
 * `a-search` complains here; `anchorRectComplaints` stays green on macOS and
 * goes red on CI, which is the whole point of this check existing.
 */
const TEXT_WIDEN_STYLE_ID = "fixture-guard-widen";

/** Exact, not a budget: with the layout driven by CSS lengths these rects
 *  are identical to the bit. 1px only so a subpixel rounding difference
 *  under a changed letter-spacing cannot be reported as coupling. */
export const TEXT_COUPLING_PX = 1;

export async function textWidthCouplingComplaints(
  page: Page,
): Promise<string[]> {
  const complaints: string[] = [];
  const selectors = new Map<string, string>();
  const before = new Map<string, Box>();

  for (const anchor of fixtureScene().anchors) {
    const selector = FIXTURE_SELECTORS[anchor.id];
    if (selector === undefined) {
      complaints.push(`no fixture selector for anchor ${anchor.id}`);
      continue;
    }
    const rect = await measure(page, selector);
    if (rect === null) {
      complaints.push(
        `"${selector}" has no box — fixture-app.html has drifted from ` +
          "fixture-scene.ts (the element is not rendered)",
      );
      continue;
    }
    selectors.set(anchor.id, selector);
    before.set(anchor.id, rect);
  }

  await page.evaluate((id) => {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = "* { letter-spacing: 3px !important; }";
    document.head.append(style);
  }, TEXT_WIDEN_STYLE_ID);

  try {
    for (const [anchorId, selector] of selectors) {
      const widened = await measure(page, selector);
      if (widened === null) {
        complaints.push(
          `anchor ${anchorId} lost its box when the page's text was ` +
            "widened — fixture-app.html's layout does not survive a font " +
            "the recorded rects were not measured in",
        );
        continue;
      }
      const moved = drift(before.get(anchorId) as Box, widened);
      if (moved > TEXT_COUPLING_PX) {
        complaints.push(
          `anchor ${anchorId} moved ${moved.toFixed(1)}px when the page's ` +
            "text was widened, so its position is the width of some " +
            "rendered text and not a CSS length — fixture-scene.ts's " +
            "recorded rect for it holds only on the machine it was " +
            `measured on (widened to ${JSON.stringify(widened)})`,
        );
      }
    }
  } finally {
    // In a `finally` so a complaint above cannot leave the page laid out
    // under this rule for the tests that share it.
    await page.evaluate(
      (id) => document.getElementById(id)?.remove(),
      TEXT_WIDEN_STYLE_ID,
    );
  }

  return complaints;
}

/**
 * The fingerprints themselves: what `packages/resolver` actually computes
 * for each anchor's element on the live page, against what the scene claims.
 *
 * The check `anchorResolutionComplaints` above cannot make (whole-branch
 * review, round 2's finding 3). Every fixture anchor carries a real
 * `stableId`, and `ladder.ts` runs `stableId` as its first tier in strict
 * priority order — so the `roleName` and `text` tiers are never reached, and
 * an anchor whose `role`/`accessibleName`/`textContent` are pure fiction
 * still resolves by `stableId` and still reports `strategy: "stableId"`.
 * That is how those three fields sat fabricated in `fixture-scene.ts` for
 * long enough to be noticed, and how the commit that repaired them passed
 * with and without its own fix.
 *
 * They still matter: a runner replaying this scene against a page whose
 * `data-testid`s have moved falls to the `roleName` tier, and a scene
 * carrying somebody's guess there resolves to the wrong element or to
 * nothing. So this asks the real `captureAnchor` (through
 * `fingerprint-probe-entry.ts`) rather than restating the accname algorithm
 * on the test's side.
 *
 * To see it fail: put `role: "button", accessibleName: id, textContent: id`
 * back in `fixture-scene.ts`'s `anchor()`. Three anchors complain here;
 * nothing else in the branch moves.
 */
export async function anchorFingerprintComplaints(
  page: Page,
): Promise<string[]> {
  await page.addScriptTag({ content: await fingerprintProbeBundle() });
  const complaints: string[] = [];
  for (const anchor of fixtureScene().anchors) {
    const selector = FIXTURE_SELECTORS[anchor.id];
    if (selector === undefined) {
      complaints.push(`no fixture selector for anchor ${anchor.id}`);
      continue;
    }
    const live = await probeFingerprint(page, selector);
    if (live === null) {
      complaints.push(
        `"${selector}" matches nothing — fixture-app.html has drifted from ` +
          `fixture-scene.ts (anchor ${anchor.id} has no element)`,
      );
      continue;
    }
    const recorded = anchor.fingerprint;
    for (const field of FINGERPRINT_FIELDS) {
      // Compared field by field rather than as one object, so a complaint
      // names the field that drifted instead of printing two JSON blobs for
      // a reader to diff by eye.
      if (live[field] !== recorded[field]) {
        complaints.push(
          `anchor ${anchor.id}: fixture-scene.ts records ${field} ` +
            `${JSON.stringify(recorded[field])}, but the resolver computes ` +
            `${JSON.stringify(live[field])} for "${selector}" on the live page`,
        );
      }
    }
  }
  return complaints;
}

/** The fields `ProbedFingerprint` carries, as the keys both sides share. */
const FINGERPRINT_FIELDS = [
  "stableId",
  "role",
  "accessibleName",
  "textContent",
  "dataKey",
] as const satisfies readonly (keyof ProbedFingerprint)[];

const PROBE_ENTRY_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "fingerprint-probe-entry.ts",
);

/** Bundled once per process — esbuild is the slowest thing in this check by
 *  an order of magnitude, and both callers ask for the same bundle. */
let probeBundle: Promise<string> | null = null;
function fingerprintProbeBundle(): Promise<string> {
  probeBundle ??= bundleEntry(PROBE_ENTRY_PATH);
  return probeBundle;
}

function probeFingerprint(
  page: Page,
  selector: string,
): Promise<ProbedFingerprint | null> {
  return page.evaluate(
    ([globalName, wanted]) => {
      const probe = (
        globalThis as unknown as Record<string, FingerprintProbe | undefined>
      )[globalName];
      // Named, never optional-chained into a null: `null` is this probe's
      // answer for "no element matches that selector", and a page the script
      // never reached would otherwise report the same thing — every anchor
      // complaining that the fixture has no elements at all, when what
      // actually happened is that the bundle did not land.
      if (probe === undefined) {
        throw new Error(
          `${globalName} is not installed in this page (${location.href}) — ` +
            "the fingerprint probe bundle was not injected",
        );
      }
      return probe.fingerprintOf(wanted);
    },
    [FINGERPRINT_PROBE_GLOBAL, selector] as const,
  );
}

/**
 * The one animating transition the motion span exists to capture.
 *
 * `MOTION_CLICK_ACTION_ID`'s click opens the panel over 800ms. If that
 * transition ever becomes instant, the acceptance test's motion assertion —
 * "the panel and the checkout button are on screen at once, the panel caught
 * halfway across it" — has nothing to catch, and would fail with a frame
 * count rather than with this sentence.
 */
export async function motionTransitionComplaints(
  page: Page,
): Promise<string[]> {
  const complaints: string[] = [];
  if (!fixtureScene().actions.some((a) => a.id === MOTION_CLICK_ACTION_ID)) {
    complaints.push(
      `fixture-scene.ts no longer has the action ${MOTION_CLICK_ACTION_ID}, ` +
        "which is the only click in the fixture that animates anything",
    );
  }
  const duration = await page.evaluate(() => {
    const panel = document.querySelector("#panel");
    return panel === null ? null : getComputedStyle(panel).transitionDuration;
  });
  if (duration !== "0.8s") {
    const found = duration ?? "absent (there is no #panel)";
    complaints.push(
      `fixture-app.html's #panel transition is ${found}, not 0.8s — the ` +
        "one piece of in-app motion the fixture exists to animate is gone",
    );
  }
  return complaints;
}

/** All four, in one list. */
export async function fixtureDriftComplaints(page: Page): Promise<string[]> {
  return [
    ...(await anchorResolutionComplaints(page)),
    ...(await anchorFingerprintComplaints(page)),
    ...(await anchorRectComplaints(page)),
    ...(await motionTransitionComplaints(page)),
  ];
}

/** A 10x10 flat magenta square: nothing in the fixture app or the kit's green
 *  is near it, so counting magenta pixels counts the logo. Asserted, not
 *  assumed: `executor-export.test.ts`'s missing-logo export counts zero
 *  magenta pixels in the same 9:16 frame where the logo counts over 50. */
export const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff00ff"/></svg>';

/**
 * The export lanes' take: the fixture app's "Place order" click, on a solid
 * green background (#00c853) with a magenta logo at `<home>/acme.svg`
 * (written here) in the bottom-right corner, framed `where.aspect` (16:9
 * when absent). 9:16 renders at 1080x1920; 16:9 and Auto take the 4K tier
 * from this take's keyframes, about 6x slower headless. Run through
 * `executor`, so it lands in that executor's library; its id is the answer.
 * `executor-export.test.ts` asserts what it supplies (a zoom on the click,
 * a cursor that moved) before sampling any picture made from it.
 */
export async function makeFixtureTake(
  executor: LocalExecutor,
  where: { home: string; url: string; aspect?: SceneAspect },
): Promise<string> {
  await writeFile(join(where.home, "acme.svg"), LOGO_SVG);
  const run = await executor.request("run", {
    callId: "make-fixture-take",
    script: {
      scriptVersion: 1,
      name: "Place an order",
      target: where.url,
      viewport: { width: 1280, height: 800 },
      look: {
        branding: {
          background: { kind: "solid", color: "#00c853" },
          logo: {
            ref: "acme.svg",
            corner: "bottom-right",
            size: 0.1,
            opacity: 1,
          },
          padding: 0.08,
        },
        canvas: { aspect: where.aspect ?? "16:9" },
      },
      steps: [
        { do: "waitForLoad" },
        { do: "click", on: { text: "Place order" } },
        { do: "pause", ms: 600 },
      ],
    },
  });
  const takeId = run.ok
    ? (run.value as { provenance?: { takeId?: unknown } }).provenance?.takeId
    : undefined;
  if (typeof takeId !== "string") {
    throw new Error(`the fixture take was not made: ${JSON.stringify(run)}`);
  }
  return takeId;
}
