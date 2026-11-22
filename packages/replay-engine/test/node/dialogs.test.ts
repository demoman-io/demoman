import type { AnchorIntent } from "@demoman/resolver";
import { BRANDING_DEFAULTS, type DemoScript } from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthoredDeps,
  CdpSession,
  EngineDeps,
  IntentCapture,
} from "../../src/index.js";
import { createDialogAnswerer, runAuthored } from "../../src/index.js";
import { type CdpFake, createCdpFake } from "../helpers/cdp-fake";
import { createMemoryFrameStore } from "../helpers/frame-store";

/** DEM-161: the walk answers every JavaScript dialog as the step asks, OK by
 *  default, and says so. */

const OPENING = "Page.javascriptDialogOpening";

/** A session whose `on` keeps the handler and whose `send` records the call
 *  (and rejects when told to). */
function fakeSession(fails: string | null = null) {
  const handlers = new Map<string, (p: Record<string, unknown>) => void>();
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const cdp: CdpSession = {
    send: async (method, params = {}) => {
      sent.push({ method, params });
      if (fails !== null) throw new Error(fails);
      return {};
    },
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    detach: async () => undefined,
  };
  const open = (params: Record<string, unknown>): void => {
    const handler = handlers.get(OPENING);
    if (handler === undefined)
      throw new Error(`nothing listens for ${OPENING}`);
    handler({ url: "http://localhost:8130/x?token=1", ...params });
  };
  const answers = () =>
    sent
      .filter((s) => s.method === "Page.handleJavaScriptDialog")
      .map((s) => s.params);
  return { cdp, open, answers, listening: () => handlers.has(OPENING) };
}

describe("createDialogAnswerer", () => {
  it("answers a confirm OK by default and records it", async () => {
    const s = fakeSession();
    const dialogs = createDialogAnswerer(s.cdp, 1500);
    dialogs.arm("ac-1", undefined);
    s.open({ type: "confirm", message: "Delete Northwind?" });
    // Answered inside the event, before the step is over: the page's click
    // waits on this answer.
    expect(s.answers()).toEqual([{ accept: true }]);
    const { records, unfit, failed } = dialogs.disarm();
    expect(records).toEqual([
      {
        kind: "confirm",
        host: "localhost:8130",
        message: "Delete Northwind?",
        answer: "accept",
        by: "default",
        beatMs: 1500,
      },
    ]);
    expect(unfit).toBeUndefined();
    expect(failed).toBeUndefined();
    expect(dialogs.answered()).toEqual([{ ...records[0], actionId: "ac-1" }]);
  });

  it("answers dismiss and text as asked", async () => {
    const s = fakeSession();
    const dialogs = createDialogAnswerer(s.cdp, 1500);
    dialogs.arm("ac-1", "dismiss");
    s.open({ type: "confirm", message: "Delete?" });
    const dismissed = dialogs.disarm();
    dialogs.arm("ac-2", { text: "Acme" });
    s.open({ type: "prompt", message: "Name?", defaultPrompt: "x" });
    const named = dialogs.disarm();
    expect(s.answers()).toEqual([
      { accept: false },
      { accept: true, promptText: "Acme" },
    ]);
    expect(dismissed.records[0]).toMatchObject({
      kind: "confirm",
      answer: "dismiss",
      by: "script",
    });
    expect(dismissed.records[0]?.text).toBeUndefined();
    expect(named.records[0]).toMatchObject({
      kind: "prompt",
      answer: "accept",
      text: "Acme",
      by: "script",
    });
  });

  it("a default prompt gets its default value", async () => {
    const s = fakeSession();
    const dialogs = createDialogAnswerer(s.cdp, 1500);
    dialogs.arm("ac-1", undefined);
    s.open({ type: "prompt", message: "Name?", defaultPrompt: "x" });
    expect(s.answers()).toEqual([{ accept: true, promptText: "x" }]);
    const { records } = dialogs.disarm();
    expect(records[0]).toMatchObject({
      answer: "accept",
      text: "x",
      by: "default",
    });
  });

  it("the script's answer covers the first dialog only", async () => {
    const s = fakeSession();
    const dialogs = createDialogAnswerer(s.cdp, 1500);
    dialogs.arm("ac-1", "dismiss");
    s.open({ type: "confirm", message: "Sure?" });
    s.open({ type: "confirm", message: "Really sure?" });
    const { records } = dialogs.disarm();
    expect(s.answers()).toEqual([{ accept: false }, { accept: true }]);
    expect(records.map((r) => [r.message, r.answer, r.by])).toEqual([
      ["Sure?", "dismiss", "script"],
      ["Really sure?", "accept", "default"],
    ]);
  });

  it("an unfit answer still unblocks the page and is reported", async () => {
    const s = fakeSession();
    const dialogs = createDialogAnswerer(s.cdp, 1500);
    dialogs.arm("ac-1", "dismiss");
    s.open({ type: "alert", message: "Saved" });
    const alert = dialogs.disarm();
    dialogs.arm("ac-2", { text: "Acme" });
    s.open({ type: "confirm", message: "Delete?" });
    const confirm = dialogs.disarm();
    // OK both times: an alert has nothing else, and a page left waiting on
    // a dialog stops the run with nothing said.
    expect(s.answers()).toEqual([{ accept: true }, { accept: true }]);
    expect(alert.unfit).toEqual({ kind: "alert", intent: "dismiss" });
    expect(confirm.unfit).toEqual({
      kind: "confirm",
      intent: { text: "Acme" },
    });
    expect(alert.records[0]).toMatchObject({ answer: "accept", by: "default" });
  });

  it("a dialog with nothing armed is answered OK and listed as unowned", async () => {
    const s = fakeSession();
    const dialogs = createDialogAnswerer(s.cdp, 1500);
    s.open({ type: "beforeunload", message: "" });
    expect(s.answers()).toEqual([{ accept: true }]);
    expect(dialogs.answered()).toEqual([
      {
        kind: "beforeunload",
        host: "localhost:8130",
        message: "",
        answer: "accept",
        by: "default",
        beatMs: 1500,
        actionId: null,
      },
    ]);
    // A step armed afterwards does not claim it.
    dialogs.arm("ac-1", undefined);
    expect(dialogs.disarm().records).toEqual([]);
  });

  it("an answer the browser refused is said, not swallowed", async () => {
    const s = fakeSession("No dialog is showing");
    const dialogs = createDialogAnswerer(s.cdp, 1500);
    dialogs.arm("ac-1", undefined);
    s.open({ type: "confirm", message: "Delete Northwind?" });
    // Every pending microtask, the refusal's among them, runs first.
    await new Promise((r) => setImmediate(r));
    const { failed } = dialogs.disarm();
    expect(failed).toContain("No dialog is showing");
    expect(failed).toContain("confirm");
    // Said once: the stop has nothing more.
    expect(await dialogs.stop()).toBeNull();
  });

  it("a refusal that arrives after the step is said when the answerer stops", async () => {
    const s = fakeSession("No dialog is showing");
    const dialogs = createDialogAnswerer(s.cdp, 1500);
    dialogs.arm("ac-1", undefined);
    s.open({ type: "alert", message: "Bye" });
    // The premise: the step was over before the refusal came back.
    expect(dialogs.disarm().failed).toBeUndefined();
    expect(await dialogs.stop()).toContain("alert");
    expect(s.listening()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Through the walk, on a fake page whose click or key opens a dialog.

const PAGE = "https://app.example.com/";

function deps(cdp: CdpFake): AuthoredDeps {
  let n = 0;
  let clock = 0;
  const encoder: EngineDeps["encoder"] = {
    openSpan: vi.fn(),
    push: vi.fn(async () => undefined),
    closeSpan: vi.fn(async () => null),
    queueDepth: () => 0,
    heapFraction: () => 0.1,
  };
  return {
    cdp,
    page: {
      resolve: async (anchors) =>
        anchors.map((a) => ({
          anchorId: a.id,
          strategy: "stableId" as const,
          resolved: true,
          failureReason: null,
        })),
    },
    encoder,
    store: createMemoryFrameStore(),
    clock: {
      now: () => (clock += 10),
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
    mayReplay: true,
    captureResolved: async (intent: AnchorIntent): Promise<IntentCapture> => ({
      anchor: {
        id: intent.id,
        fingerprint: {
          ...intent.fingerprint,
          treePath: "button:1",
          boundingRect: { x: 10, y: 20, width: 100, height: 40 },
        },
        resolution: {
          url: PAGE,
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
      pageUrl: null,
    }),
    newId: (prefix) => `${prefix}-${++n}`,
    sceneId: "dialogs",
    createdAt: "2026-11-21T09:00:00.000Z",
    viewport: { width: 1280, height: 800 },
    startingBranding: BRANDING_DEFAULTS,
    cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
  };
}

/** The fake page opens a confirm on the n-th mouse release or key down (from
 *  1), and counts what it opened. */
function opensConfirm(
  cdp: CdpFake,
  on: "mouseReleased" | "keyDown",
  nth = 1,
): { opened: () => number } {
  const send = cdp.send.bind(cdp);
  let seen = 0;
  let opened = 0;
  cdp.send = async (method, params) => {
    const event =
      method === "Input.dispatchMouseEvent"
        ? params?.type
        : method === "Input.dispatchKeyEvent" &&
            (params?.type === "keyDown" || params?.type === "rawKeyDown")
          ? "keyDown"
          : null;
    if (event === on && ++seen === nth) {
      opened++;
      cdp.emit(OPENING, {
        url: PAGE,
        type: "confirm",
        message: "Delete Northwind?",
      });
    }
    return send(method, params);
  };
  return { opened: () => opened };
}

const script = (steps: DemoScript["steps"]): DemoScript => ({
  scriptVersion: 9,
  name: "dialogs",
  target: PAGE,
  steps,
});

const answersSent = (cdp: CdpFake) =>
  cdp.calls
    .filter((c) => c.method === "Page.handleJavaScriptDialog")
    .map((c) => c.params);

describe("the walk answers dialogs", () => {
  it("a click's dialog lands in its action, the step and the result", async () => {
    const cdp = createCdpFake();
    const page = opensConfirm(cdp, "mouseReleased");
    const result = await runAuthored(
      script([{ do: "click", on: { stableId: "delete" }, dialog: "dismiss" }]),
      deps(cdp),
    );
    expect(page.opened()).toBe(1);
    expect(result.reason).toBeNull();
    expect(answersSent(cdp)).toEqual([{ accept: false }]);
    const record = {
      kind: "confirm",
      host: "app.example.com",
      message: "Delete Northwind?",
      answer: "dismiss",
      by: "script",
      beatMs: 1500,
    };
    expect(result.steps[0]?.dialogs).toEqual([record]);
    const action = result.document?.actions[0];
    expect(action?.kind).toBe("click");
    expect(action && "dialogs" in action ? action.dialogs : null).toEqual([
      record,
    ]);
    expect(result.dialogs).toEqual([
      { ...record, actionId: result.steps[0]?.actionId },
    ]);
  });

  it("a dialog a type's focusing click opens lands in the type", async () => {
    const cdp = createCdpFake();
    const page = opensConfirm(cdp, "mouseReleased");
    const result = await runAuthored(
      script([{ do: "type", into: { stableId: "name" }, text: "Acme" }]),
      deps(cdp),
    );
    expect(page.opened()).toBe(1);
    expect(result.reason).toBeNull();
    const action = result.document?.actions[0];
    expect(answersSent(cdp)).toEqual([{ accept: true }]);
    expect(action?.kind).toBe("type");
    expect(action && "dialogs" in action ? action.dialogs : null).toEqual([
      expect.objectContaining({ kind: "confirm", by: "default" }),
    ]);
  });

  it("a dialog a press opens lands in the press", async () => {
    const cdp = createCdpFake();
    const page = opensConfirm(cdp, "keyDown");
    const result = await runAuthored(
      script([{ do: "press", key: "Enter" }]),
      deps(cdp),
    );
    expect(page.opened()).toBe(1);
    expect(result.reason).toBeNull();
    const action = result.document?.actions[0];
    expect(answersSent(cdp)).toEqual([{ accept: true }]);
    expect(action?.kind).toBe("press");
    expect(action && "dialogs" in action ? action.dialogs : null).toEqual([
      expect.objectContaining({ kind: "confirm", answer: "accept" }),
    ]);
  });

  it("a click that asks how to answer and opens nothing stops dialogNotOpened", async () => {
    const cdp = createCdpFake();
    const result = await runAuthored(
      script([{ do: "click", on: { stableId: "save" }, dialog: "accept" }]),
      deps(cdp),
    );
    // The premise: the fake page opened nothing.
    expect(answersSent(cdp)).toEqual([]);
    expect(result.reason).toBe("dialogNotOpened");
    expect(result.completed).toBe(0);
  });

  it("an answer that does not fit stops dialogAnswerUnfit, after answering OK", async () => {
    const cdp = createCdpFake();
    const page = opensConfirm(cdp, "mouseReleased");
    const result = await runAuthored(
      script([
        { do: "click", on: { stableId: "delete" }, dialog: { text: "Acme" } },
      ]),
      deps(cdp),
    );
    expect(page.opened()).toBe(1);
    expect(answersSent(cdp)).toEqual([{ accept: true }]);
    expect(result.reason).toBe("dialogAnswerUnfit");
    expect(result.dialogs).toHaveLength(1);
  });

  it("an answer the browser refused stops the run and says which dialog", async () => {
    const cdp = createCdpFake();
    opensConfirm(cdp, "mouseReleased");
    const send = cdp.send.bind(cdp);
    cdp.send = async (method, params) => {
      if (method === "Page.handleJavaScriptDialog")
        throw new Error("No dialog is showing");
      return send(method, params);
    };
    const notes: (string | null)[] = [];
    const result = await runAuthored(
      script([{ do: "click", on: { stableId: "delete" } }]),
      { ...deps(cdp), onProgress: (p) => notes.push(p.note) },
    );
    expect(result.reason).toBe("portFailure");
    expect(notes.join(" ")).toContain("No dialog is showing");
  });

  it("a refused answer is said even when the click's own check fails too", async () => {
    const cdp = createCdpFake();
    const page = opensConfirm(cdp, "mouseReleased");
    // The click check reads a press and release that landed off the target.
    const off = { x: 40, y: 26.67 };
    const sent = cdp.click;
    if (typeof sent === "string") throw new Error("premise: a read click");
    cdp.click = { ...sent, down: off, up: off };
    const send = cdp.send.bind(cdp);
    cdp.send = async (method, params) => {
      if (method === "Page.handleJavaScriptDialog")
        throw new Error("No dialog is showing");
      return send(method, params);
    };
    const notes: (string | null)[] = [];
    const result = await runAuthored(
      script([{ do: "click", on: { stableId: "delete" } }]),
      { ...deps(cdp), onProgress: (p) => notes.push(p.note) },
    );
    expect(page.opened()).toBe(1);
    const said = JSON.stringify({ reason: result.reason, notes });
    // The refusal is the cause, said as such, and the step keeps its record.
    expect(result.reason, said).toBe("portFailure");
    expect(notes.join(" "), said).toContain(
      'the confirm "Delete Northwind?" could not be answered',
    );
    expect(result.steps[0]?.dialogs, said).toEqual([
      expect.objectContaining({ message: "Delete Northwind?" }),
    ]);
    // Control: the same miss with the answer accepted stops on the click.
    const control = createCdpFake();
    opensConfirm(control, "mouseReleased");
    control.click = { ...sent, down: off, up: off };
    const missed = await runAuthored(
      script([{ do: "click", on: { stableId: "delete" } }]),
      deps(control),
    );
    expect(missed.reason).toBe("clickNotDelivered");
  });
});

/** The fake page opens a confirm after the click has come back: on the walk's
 *  first screenshot after the release, as a page's timer or fetch would. */
function opensConfirmLate(cdp: CdpFake): { opened: () => number } {
  const send = cdp.send.bind(cdp);
  let released = false;
  let opened = 0;
  cdp.send = async (method, params) => {
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mouseReleased"
    )
      released = true;
    else if (released && opened === 0 && method === "Page.captureScreenshot") {
      opened++;
      cdp.emit(OPENING, {
        url: PAGE,
        type: "confirm",
        message: "Delete account?",
      });
    }
    return send(method, params);
  };
  return { opened: () => opened };
}

describe("a dialog the page opens after the step's verb", () => {
  it("is answered as the step asks and recorded on its action", async () => {
    const cdp = createCdpFake();
    const page = opensConfirmLate(cdp);
    const result = await runAuthored(
      script([{ do: "click", on: { stableId: "delete" }, dialog: "dismiss" }]),
      deps(cdp),
    );
    const said = JSON.stringify({
      reason: result.reason,
      dialogs: result.dialogs,
    });
    expect(page.opened(), said).toBe(1);
    // The premise: it opened after the verb, past the click's last call.
    const methods = cdp.calls.map((c) => c.method);
    expect(
      methods.indexOf("Page.handleJavaScriptDialog"),
      said,
    ).toBeGreaterThan(methods.lastIndexOf("Runtime.callFunctionOn"));
    expect(answersSent(cdp), said).toEqual([{ accept: false }]);
    expect(result.reason, said).toBeNull();
    expect(result.dialogs, said).toEqual([
      expect.objectContaining({
        message: "Delete account?",
        answer: "dismiss",
        by: "script",
        actionId: result.steps[0]?.actionId,
      }),
    ]);
    const action = result.document?.actions[0];
    expect(action && "dialogs" in action ? action.dialogs : null, said).toEqual(
      [expect.objectContaining({ message: "Delete account?", by: "script" })],
    );
  });

  it("a step that asked for one stops dialogNotOpened at the next step's arming, as itself", async () => {
    const cdp = createCdpFake();
    const result = await runAuthored(
      script([
        { do: "click", on: { stableId: "save" }, dialog: "accept" },
        { do: "press", key: "Enter" },
      ]),
      deps(cdp),
    );
    // The premise: the page opened nothing.
    expect(answersSent(cdp)).toEqual([]);
    expect(result.reason).toBe("dialogNotOpened");
    // Counted as the click's stop, not the press's: the report names the
    // step at `completed`.
    expect(result.completed).toBe(0);
    expect(result.document?.actions.map((a) => a.kind)).toEqual(["click"]);
    // The press was taken back before its key went out.
    const enterSent = (c: CdpFake) =>
      c.calls.some(
        (call) =>
          call.method === "Input.dispatchKeyEvent" &&
          call.params?.key === "Enter",
      );
    expect(enterSent(cdp)).toBe(false);
    // Control: the same script without `dialog` sends the key.
    const control = createCdpFake();
    const done = await runAuthored(
      script([
        { do: "click", on: { stableId: "save" } },
        { do: "press", key: "Enter" },
      ]),
      deps(control),
    );
    expect(done.reason).toBeNull();
    expect(enterSent(control)).toBe(true);
  });

  it("one that opens while the walk tears down is still answered", async () => {
    const cdp = createCdpFake();
    const send = cdp.send.bind(cdp);
    let opened = 0;
    cdp.send = async (method, params) => {
      // Teardown's first call, after the last step and the walk's end.
      if (method === "Page.stopScreencast" && opened++ === 0)
        cdp.emit(OPENING, { url: PAGE, type: "alert", message: "Saved" });
      return send(method, params);
    };
    const result = await runAuthored(
      script([{ do: "click", on: { stableId: "save" } }]),
      deps(cdp),
    );
    expect(opened).toBe(1);
    expect(answersSent(cdp)).toEqual([{ accept: true }]);
    expect(result.reason).toBeNull();
    expect(result.dialogs).toEqual([
      expect.objectContaining({
        kind: "alert",
        message: "Saved",
        actionId: null,
      }),
    ]);
  });

  it("a refusal that arrives at teardown is said, as every refusal is", async () => {
    const cdp = createCdpFake();
    const send = cdp.send.bind(cdp);
    let opened = 0;
    cdp.send = async (method, params) => {
      if (method === "Page.stopScreencast" && opened++ === 0) {
        cdp.emit(OPENING, { url: PAGE, type: "alert", message: "Saved" });
        cdp.emit(OPENING, { url: PAGE, type: "alert", message: "Synced" });
      }
      if (method === "Page.handleJavaScriptDialog")
        throw new Error("No dialog is showing");
      return send(method, params);
    };
    const notes: (string | null)[] = [];
    const result = await runAuthored(
      script([{ do: "click", on: { stableId: "save" } }]),
      { ...deps(cdp), onProgress: (p) => notes.push(p.note) },
    );
    const said = notes.join(" ");
    expect(opened, said).toBe(1);
    // The premise: every step was performed; the stop is the teardown's.
    expect(result.completed, said).toBe(1);
    expect(result.reason, said).toBe("portFailure");
    expect(said).toContain('the alert "Saved" could not be answered');
    expect(said).toContain('the alert "Synced" could not be answered');
  });
});
