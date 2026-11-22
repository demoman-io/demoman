import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { madeFromOf } from "@demoman/compositor";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  type DialogRecord,
  type SceneDocument,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { type CdpSession, runAuthored, runReplay } from "../../src/index.js";
import {
  selectorPageAgent,
  withReplayBrowser,
} from "../helpers/cdp-playwright";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { scene } from "../helpers/replay-scene";

/**
 * DEM-161: a click that opens `confirm()`, against real Chromium, because
 * what the browser does while a dialog is open (blocks the page, holds the
 * click that opened it) is the thing a fake CDP cannot answer. The fixture
 * is the runner's (`compare/scripts/confirm-dialog.json` serves it too).
 */
const DIALOG_URL = pathToFileURL(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "apps",
    "runner",
    "test",
    "fixtures",
    "confirm-dialog-app.html",
  ),
).href;

const clock = () => ({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
});

type Result = Awaited<ReturnType<typeof runAuthored>>;

/** When each CDP call went out and came back, in one order. */
type Log = string[];

/** The session, logging the dialog's answer and the click's release. */
function logged(cdp: CdpSession, log: Log): CdpSession {
  return {
    ...cdp,
    send: async (method, params, options) => {
      const name =
        method === "Page.handleJavaScriptDialog"
          ? "answer"
          : method === "Input.dispatchMouseEvent" &&
              params?.type === "mouseReleased"
            ? "release"
            : null;
      if (name !== null) log.push(`${name} sent`);
      const reply = await cdp.send(method, params, options);
      if (name !== null) log.push(`${name} acked`);
      return reply;
    },
  };
}

/** Runs `steps` against the fixture page and hands the result over. */
async function runDialogs(
  steps: DemoScript["steps"],
  then: (
    result: Result,
    page: import("playwright").Page,
    log: Log,
  ) => Promise<void>,
): Promise<void> {
  await withReplayBrowser(
    async ({ cdp, page }) => {
      // Playwright dismisses a dialog nobody listens for, which would race
      // the engine's answer: a listener that does nothing leaves it the
      // engine's (the runner does the same, Task 3).
      page.on("dialog", () => undefined);
      // The premise: the button that asks is there, and neither answer's
      // button shows before the click.
      expect(await page.isVisible("#delete")).toBe(true);
      expect(await page.isHidden("#undo")).toBe(true);
      expect(await page.isHidden("#kept")).toBe(true);
      const selectors: Record<string, string> = {};
      const script: DemoScript = {
        scriptVersion: 9,
        name: "dialogs",
        target: DIALOG_URL,
        steps,
      };
      const store = createMemoryFrameStore();
      const log: Log = [];
      let n = 0;
      const result = await runAuthored(script, {
        cdp: logged(cdp, log),
        page: selectorPageAgent(page, selectors),
        encoder: createNodeFrameEncoder(store, "dialogs"),
        store,
        clock: clock(),
        mayReplay: true,
        captureResolved: async (intent) => {
          const id = intent.fingerprint.stableId ?? "";
          const css = id === "heading" ? "h1" : `#${id}`;
          selectors[intent.id] = css;
          const box = await page.locator(css).boundingBox();
          // Hidden (a `waitFor` before what it waits for shows): nothing to
          // capture yet, which the run asks again after the wait.
          if (box === null)
            return {
              anchor: null,
              failureReason: "unresolved",
              intentResolution: null,
              pageUrl: DIALOG_URL,
            };
          return {
            anchor: {
              id: intent.id,
              fingerprint: { ...intent.fingerprint, boundingRect: box },
              resolution: {
                url: DIALOG_URL,
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
            pageUrl: DIALOG_URL,
          };
        },
        newId: (prefix) => `${prefix}-${++n}`,
        sceneId: "dialogs",
        createdAt: "2026-11-21T00:00:00.000Z",
        viewport: { width: 1024, height: 640 },
        startingBranding: BRANDING_DEFAULTS,
        cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
      });
      await then(result, page, log);
    },
    { url: DIALOG_URL, readySelector: "#delete" },
  );
}

/** What the run and the page say, for a failure message. */
const evidence = async (
  result: Result,
  page: import("playwright").Page,
  log: Log,
): Promise<string> =>
  JSON.stringify({
    reason: result.reason,
    dialogs: result.dialogs,
    page: await page.innerText("body"),
    log,
  });

describe("a click that opens confirm(), against a real page", () => {
  it("is answered OK by default, recorded, and the page goes on", async () => {
    await runDialogs(
      [
        { do: "waitForLoad" },
        { do: "click", on: { stableId: "delete" } },
        { do: "click", on: { stableId: "undo" } },
      ],
      async (result, page, log) => {
        const said = await evidence(result, page, log);
        expect(result.reason, said).toBeNull();
        expect(result.dialogs, said).toEqual([
          {
            kind: "confirm",
            host: "",
            message: "Delete Northwind?",
            answer: "accept",
            by: "default",
            beatMs: 1500,
            actionId: expect.any(String),
          },
        ]);
        expect(await page.innerText("#answer"), said).toBe(
          "confirm() answered true",
        );
        // Chrome holds the release that opened the dialog until it is
        // answered: the answer goes out from inside the event, before the
        // click comes back. Answered after the verb, the run would wait on
        // itself (measured 2026-11-21 with the answer removed: the release
        // never came back). The two replies may arrive in either order.
        expect(log.slice(0, 2), said).toEqual(["release sent", "answer sent"]);
        expect(log.slice(2, 4).sort(), said).toEqual([
          "answer acked",
          "release acked",
        ]);
        // `undo`'s click opens nothing.
        expect(log.slice(4), said).toEqual(["release sent", "release acked"]);
        const action = result.document?.actions.find(
          (a) => a.id === result.dialogs?.[0]?.actionId,
        );
        expect(action?.kind, said).toBe("click");
        expect(action && "dialogs" in action ? action.dialogs : null).toEqual([
          expect.objectContaining({ message: "Delete Northwind?" }),
        ]);
      },
    );
  });

  it("is dismissed when the step says so", async () => {
    await runDialogs(
      [
        { do: "waitForLoad" },
        { do: "click", on: { stableId: "delete" }, dialog: "dismiss" },
        { do: "click", on: { stableId: "kept" } },
      ],
      async (result, page, log) => {
        const said = await evidence(result, page, log);
        expect(result.reason, said).toBeNull();
        expect(result.dialogs, said).toEqual([
          expect.objectContaining({
            kind: "confirm",
            answer: "dismiss",
            by: "script",
          }),
        ]);
        expect(await page.innerText("#answer"), said).toBe(
          "confirm() answered false",
        );
      },
    );
  });

  it("a confirm the page opens after the click is answered as the step asks", async () => {
    // `#delete-later` asks from a timer, after its click has come back.
    await runDialogs(
      [
        { do: "waitForLoad" },
        { do: "click", on: { stableId: "delete-later" }, dialog: "dismiss" },
        { do: "waitFor", on: { stableId: "kept" }, until: "visible" },
      ],
      async (result, page, log) => {
        const said = await evidence(result, page, log);
        // The premise: the click came back before the dialog was answered,
        // which is what makes it late.
        expect(log.indexOf("release acked"), said).toBeGreaterThanOrEqual(0);
        expect(log.indexOf("release acked"), said).toBeLessThan(
          log.indexOf("answer sent"),
        );
        expect(result.reason, said).toBeNull();
        expect(result.dialogs, said).toEqual([
          expect.objectContaining({
            kind: "confirm",
            message: "Delete account?",
            answer: "dismiss",
            by: "script",
            actionId: result.steps[1]?.actionId,
          }),
        ]);
        expect(await page.innerText("#answer"), said).toBe(
          "confirm() answered false",
        );
        const action = result.document?.actions.find(
          (a) => a.id === result.steps[1]?.actionId,
        );
        expect(
          action && "dialogs" in action ? action.dialogs : null,
          said,
        ).toEqual([expect.objectContaining({ message: "Delete account?" })]);
      },
    );
  });

  it("stops dialogNotOpened when the clicked element asks nothing", async () => {
    await runDialogs(
      [
        { do: "waitForLoad" },
        { do: "click", on: { stableId: "heading" }, dialog: "accept" },
      ],
      async (result, page, log) => {
        const said = await evidence(result, page, log);
        // The premise: the click went out and the page asked nothing.
        expect(log, said).toContain("release acked");
        expect(result.dialogs, said).toEqual([]);
        expect(result.reason, said).toBe("dialogNotOpened");
      },
    );
  });
});

/** What the take recorded: the click's confirm, dismissed by its script.
 *  Another host and message from the fixture's, so a fresh record differs. */
const RECORDED: DialogRecord = {
  kind: "confirm",
  host: "localhost:8130",
  message: "Delete the old Northwind?",
  answer: "dismiss",
  by: "script",
  beatMs: 1500,
};

/** A take whose first click recorded `RECORDED`, against the fixture. */
function recordedTake(anchorIds: string[]): SceneDocument {
  const base = scene({ anchorIds });
  return {
    ...base,
    meta: {
      ...base.meta,
      capture: { ...base.meta.capture, originUrl: DIALOG_URL },
    },
    actions: base.actions.map((a, i) =>
      i === 0 && a.kind === "click" ? { ...a, dialogs: [RECORDED] } : a,
    ),
  } as SceneDocument;
}

/** Re-records `doc` against the fixture page. */
async function rerecord(
  doc: SceneDocument,
  selectors: Record<string, string>,
  then: (
    result: Awaited<ReturnType<typeof runReplay>>,
    said: string,
  ) => Promise<void>,
): Promise<void> {
  await withReplayBrowser(
    async ({ cdp, page }) => {
      page.on("dialog", () => undefined);
      // The premise: the answer's buttons are hidden before the run.
      expect(await page.isHidden("#kept")).toBe(true);
      expect(await page.isHidden("#undo")).toBe(true);
      const store = createMemoryFrameStore();
      const result = await runReplay(doc, {
        cdp,
        page: selectorPageAgent(page, selectors),
        encoder: createNodeFrameEncoder(store, doc.meta.id),
        store,
        clock: clock(),
        mayReplay: true,
        madeFrom: madeFromOf(doc),
      });
      const said = JSON.stringify({
        reason: result.reason,
        dialogs: result.dialogs,
        page: await page.innerText("body"),
      });
      await then(result, said);
    },
    { url: DIALOG_URL, readySelector: "#delete" },
  );
}

describe("a recorded take re-recorded", () => {
  it("answers the way the take did, and keeps this run's answer", async () => {
    const doc = recordedTake(["delete", "kept"]);
    // The premise: the take's click carries the recorded dismiss.
    expect(doc.actions[0]).toMatchObject({
      kind: "click",
      dialogs: [RECORDED],
    });
    await rerecord(
      doc,
      { delete: "#delete", kept: "#kept" },
      async (result, said) => {
        expect(result.reason, said).toBeNull();
        expect(said).toContain("confirm() answered false");
        const fresh = {
          kind: "confirm",
          host: "",
          message: "Delete Northwind?",
          answer: "dismiss",
          by: "script",
          beatMs: 1500,
        };
        expect(result.dialogs, said).toEqual([{ ...fresh, actionId: "act-1" }]);
        const action = doc.actions[0];
        expect(action && "dialogs" in action ? action.dialogs : null).toEqual([
          fresh,
        ]);
      },
    );
  });

  it("does not stop when the app no longer asks, and drops the old record", async () => {
    const doc = recordedTake(["heading"]);
    await rerecord(doc, { heading: "h1" }, async (result, said) => {
      // The premise: the click went in and the page asked nothing.
      expect(result.completed, said).toBe(1);
      expect(result.dialogs, said).toEqual([]);
      expect(result.reason, said).toBeNull();
      expect(doc.actions[0] && "dialogs" in doc.actions[0], said).toBe(false);
    });
  });
});
