import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type CDPSession, chromium, type Frame, type Page } from "playwright";
import type { CdpSession, PageAgent, ResolveReport } from "../../src/index.js";
import { REPLAY_TARGETS } from "../../src/index.js";

export const FIXTURE_URL = pathToFileURL(
  join(import.meta.dirname, "..", "fixtures", "replay-app.html"),
).href;

/** The device fixture (spec 2026-10-10 §7): reads differently as a phone than
 *  as a desktop, and has a button only a touch can press. */
export const DEVICE_FIXTURE_URL = pathToFileURL(
  join(import.meta.dirname, "..", "fixtures", "device-app.html"),
).href;

/** A page with no meta viewport: a phone lays it out 980 wide and shows it
 *  zoomed out (scale 0.401 on an iPhone, probe:tap-space). */
export const ZOOMED_FIXTURE_URL = pathToFileURL(
  join(import.meta.dirname, "..", "fixtures", "clicks-app.html"),
).href;

/** A form that submits on Enter, and a pad that records where it was clicked. */
export const PRESS_FIXTURE_URL = pathToFileURL(
  join(import.meta.dirname, "..", "fixtures", "press-app.html"),
).href;

/**
 * What the browser context is created with — and deliberately **not** what
 * the engine emulates.
 *
 * `Emulation.setDeviceMetricsOverride` is the first thing this lane claims to
 * prove, and it can only prove it if the numbers can disagree. Created at
 * `SCENE_VIEWPORT` and `REPLAY_DPR`, the keyframe would come back 3840x2400
 * because the *context* was 1280x800 at DPR 3, and deleting the override from
 * the engine would leave the test green: the lane's headline claim, checked
 * against a coincidence.
 *
 * So the context is smaller and unscaled. Measured against real Chromium:
 * with the context at 1024x640 DPR 1 and the engine overriding to 1280x800
 * DPR 3, `Page.captureScreenshot` returns 3840x2400 and `window.innerWidth`
 * reads 1280. Nothing but the override can produce those.
 */
export const CONTEXT_VIEWPORT = { width: 1024, height: 640 };
export const CONTEXT_DPR = 1;

/**
 * The engine's `CdpSession` over a Playwright one. `on` returns an
 * unsubscribe, the contract the engine's listeners rely on.
 */
export function wrapCdp(session: CDPSession): CdpSession {
  return {
    send: (method, params) =>
      session.send(method as never, params as never) as Promise<
        Record<string, unknown>
      >,
    on: (event, handler) => {
      const wrapped = (params: unknown): void =>
        handler((params ?? {}) as Record<string, unknown>);
      session.on(event as never, wrapped as never);
      return () => session.off(event as never, wrapped as never);
    },
    detach: async () => {
      await session.detach().catch(() => undefined);
    },
  };
}

/**
 * The same CdpSession port the engine takes in production, backed by a
 * Playwright CDP session instead of chrome.debugger. This is the whole
 * reason the port exists: one engine, two transports, and the risky half of
 * SP5 gets tested against a real browser rather than against a fake that
 * agrees with us.
 */
export async function withReplayBrowser(
  fn: (ctx: { cdp: CdpSession; page: Page }) => Promise<void>,
  /** Another fixture page, and the selector that says it is ready. The
   *  default is `replay-app.html` and its `#static-btn`. */
  opts: { url?: string; readySelector?: string } = {},
): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: CONTEXT_VIEWPORT,
      deviceScaleFactor: CONTEXT_DPR,
    });
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    await page.goto(opts.url ?? FIXTURE_URL);
    await page.waitForSelector(opts.readySelector ?? "#static-btn");

    const cdp = wrapCdp(session);

    await fn({ cdp, page });
  } finally {
    await browser.close();
  }
}

/**
 * Where an anchor's element lives: a CSS selector in the top document, or a
 * selector inside the document a named iframe holds. The sensor parks in
 * whichever frame it ran in, so the shim has to be able to park in one too —
 * otherwise the cross-frame case would resolve against the top window and
 * quietly prove nothing.
 */
export type SelectorSpec = string | { frame: string; selector: string };

/**
 * Parks elements the way the sensor does, by selector rather than by
 * fingerprint. Resolution is SP3's subject and Task 8's; this lane's subject
 * is what CDP does with an element once something has found it.
 */
export function selectorPageAgent(
  page: Page,
  selectors: Record<string, SelectorSpec>,
): PageAgent {
  return {
    async resolve(anchors): Promise<ResolveReport[]> {
      return Promise.all(
        anchors.map(async (anchor) => {
          const spec = selectors[anchor.id] ?? `#${anchor.id}`;
          const css = typeof spec === "string" ? spec : spec.selector;
          const target =
            typeof spec === "string"
              ? page.mainFrame()
              : await childFrame(page, spec.frame);
          const resolved =
            target === null
              ? false
              : await park(target, anchor.id, css, REPLAY_TARGETS);
          return {
            anchorId: anchor.id,
            strategy: "stableId" as const,
            resolved,
            // This shim parks by selector; there is no ladder here to have a
            // verdict about. Resolution is SP3's subject and Task 8's.
            failureReason: null,
          };
        }),
      );
    },
  };
}

async function childFrame(page: Page, frameCss: string): Promise<Frame | null> {
  const handle = await page.$(frameCss);
  if (handle === null) return null;
  return handle.contentFrame();
}

function park(
  frame: Frame,
  anchorId: string,
  css: string,
  globalName: string,
): Promise<boolean> {
  return frame.evaluate(
    ([key, selector, parkedOn]) => {
      const scope = window as unknown as Record<
        string,
        Record<string, Element> | undefined
      >;
      let parked = scope[parkedOn];
      if (parked === undefined) {
        parked = {};
        scope[parkedOn] = parked;
      }
      const el = document.querySelector(selector);
      if (el === null) {
        delete parked[key];
        return false;
      }
      parked[key] = el;
      return true;
    },
    [anchorId, css, globalName] as const,
  );
}
