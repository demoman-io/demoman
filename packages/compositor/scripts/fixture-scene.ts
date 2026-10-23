import { CURSOR_DEFAULTS, type SceneDocument } from "@demoman/scene-schema";
import { CAMERA_DEFAULTS } from "../src/plan/camera";

/**
 * The scene document that matches `fixture-app.html`.
 *
 * Structurally this is `test/fixtures/scene.ts`'s `readonlyScene()` — same
 * three anchors, same three actions — but the bounding rects are the ones
 * the real page actually lays out, measured once at 1280x800. That matters:
 * `planScene` is frameless, so `planCursorSegments` has nothing but these
 * rects to aim at, and the harvest dispatches the planned path into the live
 * page. A rect that disagrees with the DOM sends the pointer to empty space
 * and no amount of easing rescues that. `harvest-fixture.ts` re-measures
 * every anchor and fails loudly if the page has drifted away from them.
 *
 * The fingerprints are the page's real ones, not placeholders. They were
 * placeholders until 2026-09-08 — every anchor claimed role "button" and its
 * own id as its name — which nothing noticed because `harvest-fixture.ts`
 * locates elements through FIXTURE_SELECTORS and never asks the resolver.
 * `apps/runner` replays this scene with the real resolver, so they have to
 * be true; its lane re-checks them (test/fixture-guard.test.ts).
 */
export function fixtureScene(): SceneDocument {
  return {
    schemaVersion: 12,
    meta: {
      id: "scene-fixture-app",
      name: "Northwind invoices walkthrough",
      createdAt: "2026-08-25T05:00:00.000Z",
      toolchain: {
        resolverVersion: "1.0.0",
        compositorVersion: null,
        captureVersion: null,
      },
      capture: {
        originUrl: "https://northwind.example.com/invoices",
        originClass: "published",
        buildSha: "abc1234def",
        buildShaSource: null,
        viewport: { width: 1280, height: 800 },
        dpr: 3,
        mode: "record",
      },
    },
    anchors: [
      // <input id="search" data-testid="search" placeholder="Search
      // invoices" />. No <label>, no aria-label — the accname algorithm
      // this resolver runs does not fall back to placeholder, so the real
      // accessible name is null, not the placeholder text.
      anchor(
        "a-search",
        "search",
        "textbox",
        null,
        null,
        { x: 164, y: 18, width: 320, height: 36 },
        0,
      ),
      // <tr data-testid="row-8891"> inside the invoices table. Rows have no
      // implicit role in this resolver's (deliberately partial) role table,
      // so role is null. It has children (<td>s), and captureAnchor only
      // records textContent for leaves, so textContent is null too — only
      // its computed accessible name (name-from-content) is real.
      anchor(
        "a-row",
        "row-8891",
        null,
        "INV-8891 Northwind Traders Paid $1,200.00",
        null,
        { x: 248, y: 186, width: 1004, height: 56 },
        1,
      ),
      // <button id="checkout-btn" data-testid="checkout-btn">Place order</button>
      anchor(
        "a-checkout",
        "checkout-btn",
        "button",
        "Place order",
        "Place order",
        { x: 980, y: 620, width: 160, height: 44 },
        2,
      ),
      // <a href="#reports" data-testid="nav-reports">Reports</a>
      anchor(
        "a-nav-reports",
        "nav-reports",
        "link",
        "Reports",
        "Reports",
        { x: 12, y: 237, width: 196, height: 36 },
        3,
      ),
    ],
    actions: [
      {
        id: "act-1",
        anchorId: "a-search",
        timestamp: 400,
        marker: "type:a-search",
        kind: "type",
        text: "northwind",
        redacted: false,
      },
      {
        id: "act-2",
        anchorId: "a-row",
        timestamp: 3200,
        marker: "scrollTo:a-row",
        kind: "scrollTo",
      },
      {
        id: "act-3",
        anchorId: "a-checkout",
        timestamp: 9000,
        marker: "click:a-checkout",
        kind: "click",
        button: "left",
      },
      // The second click, and the reason it is here: a one-beat fixture has
      // no consecutive camera beats and cannot show the camera returning to
      // 1.0 *between* two of them, only at the end. This one sits in the
      // opposite corner of the page from the checkout button — 1026 of the
      // viewport's 1509 diagonal px away — so the pull-out between them is
      // as visible as it gets.
      {
        id: "act-4",
        anchorId: "a-nav-reports",
        timestamp: 12000,
        marker: "click:a-nav-reports",
        kind: "click",
        button: "left",
      },
    ],
    // Authored, because nothing generates a zoom any more: the auto-camera
    // used to put one on every click, which is what this fixture rendered.
    // Both clicks carry one so the render still shows a push-in, a hold, and
    // the pull-out back to full frame.
    camera: [
      {
        id: "cam-checkout",
        kind: "zoom",
        anchorId: "a-checkout",
        marker: { actionId: "act-3", offsetMs: CAMERA_DEFAULTS.leadInMs },
        scale: CAMERA_DEFAULTS.defaultZoomScale,
      },
      {
        id: "cam-nav-reports",
        kind: "zoom",
        anchorId: "a-nav-reports",
        marker: { actionId: "act-4", offsetMs: CAMERA_DEFAULTS.leadInMs },
        scale: CAMERA_DEFAULTS.defaultZoomScale,
      },
    ],
    edits: {
      masks: [],
      holds: [],
      gaps: [],
      splits: [],
      removed: [],
    },
    sideChannels: {
      network: [],
      consoleExcerpt: [],
      urlTrace: [],
      uncoveredOrigins: [],
    },
    flags: { mutating: false, hoverSensitive: false },
    // The app's own accent, so the presented background reads as the product's.
    // v5 `primaryColor: "#3B5BDB"`, as the v5 -> v6 migration converts it:
    // the pale tint v5 painted. Not the brand colour as a solid — #3b5bdb is
    // fixture-app.html's accent, and the runner's acceptance test counts
    // exactly that colour to find the checkout button.
    branding: {
      background: {
        kind: "gradient",
        from: "#daebff",
        to: "#a8c2ff",
        angle: 150,
      },
      logo: null,
      padding: 0.08,
    },
    cursor: CURSOR_DEFAULTS,
    canvas: { aspect: "16:9" },
  };
}

/** The `data-testid` each anchor resolves to in `fixture-app.html`. */
export const FIXTURE_SELECTORS: Record<string, string> = {
  "a-search": '[data-testid="search"]',
  "a-row": '[data-testid="row-8891"]',
  "a-checkout": '[data-testid="checkout-btn"]',
  "a-nav-reports": '[data-testid="nav-reports"]',
};

/**
 * The one action whose click animates something. `fixture-app.html`'s panel
 * is its only transition, so it is the only click the harvest screencasts —
 * every other click changes the page instantly and the next keyframe carries
 * the result.
 */
export const MOTION_CLICK_ACTION_ID = "act-3";

function anchor(
  id: string,
  stableId: string,
  role: string | null,
  accessibleName: string | null,
  textContent: string | null,
  rect: { x: number; y: number; width: number; height: number },
  actionIndex: number,
): SceneDocument["anchors"][number] {
  return {
    id,
    fingerprint: {
      stableId,
      role,
      accessibleName,
      textContent,
      treePath: `body:1/main:1/*:${actionIndex + 1}`,
      boundingRect: rect,
      imagePatchRef: null,
      dataKey: null,
    },
    resolution: {
      url: "https://northwind.example.com/invoices",
      actionIndex,
      entryState: actionIndex === 0,
      strategy: "stableId",
      failureReason: null,
      candidates: 1,
    },
  };
}
