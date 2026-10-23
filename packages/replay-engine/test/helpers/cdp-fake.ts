import type { CdpFrameNode, CdpSession } from "../../src/index.js";
import {
  CLICK_PROBE_MARKER,
  type ClickSeen,
  SCROLL_MARKER,
  SETTLE_MARKER,
  type SettleReport,
} from "../../src/index.js";

/** A 4x4 JPEG's worth of bytes: SOI, APP0, SOF0 declaring 800x600. Enough
 *  for jpegSize to read a real size out of a real marker walk. */
/**
 * A marker-only JPEG whose SOF0 declares the size asked for.
 *
 * The default is the fixture viewport at 1x, and that is not decoration: the
 * engine refuses a harvested frame that is not a uniform scale of the
 * emulated viewport (see `coversViewport`), so a fixture frame of some
 * unrelated shape would be refused by every test that emits one. This used
 * to be a fixed 800x600 against a 1280x800 fixture viewport — a frame no
 * real harvest could produce, and one this guard would now throw away.
 */
export function fakeScreenshotBase64(width = 1280, height = 800): string {
  const bytes = [
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ];
  return btoa(String.fromCharCode(...bytes));
}

export interface CdpFake extends CdpSession {
  calls: { method: string; params: Record<string, unknown> }[];
  emit(event: string, params: Record<string, unknown>): void;
  /** Anchors whose parked element should evaluate to nothing. */
  missing: Set<string>;
  /**
   * Anchors whose parked element resolves but has **no layout box** — a
   * `display:none` panel, the mainstream shape of a `waitFor` condition.
   * `DOM.getBoxModel` rejects for such a node rather than returning an empty
   * model, which is what this reproduces. Mutate the set mid-run to make an
   * element render (or stop rendering) between polls.
   */
  boxless: Set<string>;
  /** What `Page.getFrameTree` reports. Mutate it (push onto `childFrames`)
   *  to hang a child document off the top frame and exercise the cross-frame
   *  lookup; the fake reads this object, so reassigning it does nothing. */
  frameTree: CdpFrameNode;
  /**
   * What the settle probe reports back. Mutate it to make the page one that
   * never finished painting. Defaults to a page that settled, because that
   * is what a page does.
   */
  settle: SettleReport;
  /**
   * Make the settle probe reject instead of answering — what CDP does when
   * the page navigates out from under an in-flight evaluate.
   */
  settleThrows: string | null;
  /**
   * What the corrective scroll reports back. Defaults to a scroll that
   * settled, because that is what a scroll does — a fake that defaulted to
   * unsettled would put a `scrollUnsettled` degradation in every bundle
   * every test builds, and drown the one the test is actually about.
   */
  scroll: { settled: boolean; movedPx: number };
  /**
   * The visual viewport's scale `Page.getLayoutMetrics` reports. Defaults to
   * 1, a page that is not zoomed, because that is what most pages are; set
   * it to 393/980 for a phone showing a page with no meta viewport.
   */
  layoutScale: number;
  /**
   * What the page's click check reads back (`click-probe.ts`). Defaults to a
   * click delivered as sent — press and release at the target's centre, in a
   * page whose client rect for it is the box `DOM.getBoxModel` answers here,
   * so the two spaces coincide; the target focused — because that is what a
   * click almost always is, and a fake
   * that defaulted to anything else would stop or degrade every run every
   * test builds. Set it to a miss, or to `"unreadable"` for a page that went
   * away before the read, to exercise the other verdicts. `"unplaceable"`
   * makes placing the check itself reject.
   */
  click: ClickSeen | "unreadable" | "unplaceable";
}

export function createCdpFake(): CdpFake {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const handlers = new Map<
    string,
    Set<(params: Record<string, unknown>) => void>
  >();
  const missing = new Set<string>();
  const boxless = new Set<string>();
  const frameTree: CdpFrameNode = {
    frame: { id: "top", url: "https://app.example.com/" },
    childFrames: [],
  };
  const fake = {
    settle: {
      settled: true,
      pending: 0,
      fonts: "ok",
      ready: "complete",
      quiet: true,
    },
    settleThrows: null as string | null,
    scroll: { settled: true, movedPx: 0 },
    layoutScale: 1,
    click: {
      own: { x: 10, y: 20, width: 100, height: 40 },
      viewport: { width: 1280, height: 800 },
      down: { x: 60, y: 40 },
      up: { x: 60, y: 40 },
      cancelled: false,
      focused: true,
    } as ClickSeen | "unreadable" | "unplaceable",
  };

  return {
    calls,
    missing,
    boxless,
    frameTree,
    get settle() {
      return fake.settle;
    },
    set settle(next) {
      fake.settle = next;
    },
    get settleThrows() {
      return fake.settleThrows;
    },
    set settleThrows(next) {
      fake.settleThrows = next;
    },
    get scroll() {
      return fake.scroll;
    },
    set scroll(next) {
      fake.scroll = next;
    },
    get layoutScale() {
      return fake.layoutScale;
    },
    set layoutScale(next) {
      fake.layoutScale = next;
    },
    get click() {
      return fake.click;
    },
    set click(next) {
      fake.click = next;
    },
    async send(method, params = {}) {
      calls.push({ method, params });
      switch (method) {
        case "Page.captureScreenshot":
          return { data: fakeScreenshotBase64() };
        case "Page.getFrameTree":
          return { frameTree };
        case "Page.getLayoutMetrics":
          return {
            cssVisualViewport: {
              offsetX: 0,
              offsetY: 0,
              pageX: 0,
              pageY: 0,
              clientWidth: 1280 / fake.layoutScale,
              clientHeight: 800 / fake.layoutScale,
              scale: fake.layoutScale,
              zoom: 1,
            },
          };
        case "Runtime.evaluate": {
          const expression = String(params.expression ?? "");
          const gone = [...missing].some((id) => expression.includes(id));
          // The settle probe returns by value, so its reply is shaped like a
          // real `returnByValue: true` one rather than like an objectId.
          if (expression.includes(SETTLE_MARKER)) {
            if (fake.settleThrows !== null) throw new Error(fake.settleThrows);
            return { result: { type: "object", value: fake.settle } };
          }
          if (expression.includes("readyState")) {
            return { result: { value: "complete" } };
          }
          // The anchor id is carried in the objectId so that `boxless` can be
          // stated per anchor: the engine measures by objectId and never
          // mentions the anchor again.
          const anchorId = /\["([^"]*)"\]$/.exec(expression)?.[1] ?? "";
          return gone
            ? { result: { type: "undefined" } }
            : {
                result: {
                  type: "object",
                  objectId: `obj:${anchorId}:${calls.length}`,
                },
              };
        }
        case "Runtime.callFunctionOn": {
          // The corrective scroll and the click check are the `callFunctionOn`
          // calls whose replies the engine reads; the rest fall through to
          // the empty reply below.
          const declaration = String(params.functionDeclaration ?? "");
          if (declaration.includes(SCROLL_MARKER)) {
            return { result: { type: "object", value: fake.scroll } };
          }
          if (declaration.includes(CLICK_PROBE_MARKER)) {
            // Placed by object id, read back by value.
            if (params.returnByValue !== true) {
              if (fake.click === "unplaceable")
                throw new Error("Cannot find context with specified id");
              return {
                result: { type: "object", objectId: `probe:${calls.length}` },
              };
            }
            if (fake.click === "unreadable")
              throw new Error("Cannot find context with specified id");
            return { result: { type: "object", value: fake.click } };
          }
          return {};
        }
        case "DOM.getBoxModel":
          if (boxless.has(String(params.objectId ?? "").split(":")[1] ?? "")) {
            // Chromium's own wording. A node with no layout box has no box
            // model, and CDP says so by rejecting the command — it does not
            // reply with an empty one.
            throw new Error("Could not compute box model.");
          }
          // Both quads, and deliberately *different* ones — a padded control,
          // the shape a real one has. `border` is the element as
          // `getBoundingClientRect` reports it and as capture recorded it;
          // `content` is inset by 20px/12px of padding. Returning one value
          // for both would let the engine read the wrong key and no test
          // could tell, which is how this defect survived until a real
          // browser was asked.
          return {
            model: {
              border: [10, 20, 110, 20, 110, 60, 10, 60],
              content: [30, 32, 90, 32, 90, 48, 30, 48],
            },
          };
        default:
          return {};
      }
    },
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    emit(event, params) {
      for (const handler of handlers.get(event) ?? []) handler(params);
    },
    async detach() {},
  };
}
