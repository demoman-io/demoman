import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { PageScreen } from "@demoman/compositor";
import { BRANDING_DEFAULTS, type DemoScript } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CdpSession,
  PAGE_CAPTURE_HOLD,
  PAGE_CAPTURE_RELEASE,
  runAuthored,
  STEP_QUIET_MS,
  STEP_REQUEST_CAP_MS,
} from "../../src/index.js";
import {
  selectorPageAgent,
  withReplayBrowser,
} from "../helpers/cdp-playwright";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import {
  createMemoryFrameStore,
  type MemoryFrameStore,
} from "../helpers/frame-store";

/**
 * The walk settles each step and captures its page (spec 2026-11-10
 * decisions 1 and 2), against a real Chromium: only a browser can say
 * whether the screen shows the result or the moment before it.
 *
 * The fixture is served over http, because the answer is a real streamed
 * fetch: its first word comes `ANSWER_PAUSE_MS` after the request, longer
 * than the quiet beat, so a settle that did not count requests in flight
 * would capture the page with no answer at all.
 */
const FIXTURE = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "settle-app.html"),
  "utf8",
);
/** The fixture's search debounce, as its page declares it. A debounce made
 *  by a timer alone must be shorter than the walk's quiet beat, or the
 *  screen is taken before it fires (`STEP_QUIET_MS`); the typing cases
 *  assert it. */
const DEBOUNCE_MS = Number(/const DEBOUNCE_MS = (\d+);/.exec(FIXTURE)?.[1]);
const ANSWER_PAUSE_MS = 700;
const ANSWER_WORDS = 15;
/** Longer than the quiet beat: the page being left goes quiet long before
 *  the next one arrives, so only waiting for the new document finds it. */
const NEXT_PAUSE_MS = 600;
/** How long the search answers after it is asked: longer than the quiet
 *  beat, so a screen taken without re-checking requests has no results. */
const SEARCH_PAUSE_MS = 500;
/** Far from everything on the first page, so the old page has no ink there. */
const NEXT_PAGE = `<!doctype html><meta charset=utf-8><title>next</title>
<h1 id="heading" style="position:absolute;left:420px;top:420px;margin:0;font:32px sans-serif">The next page</h1>`;
const VIEWPORT = { width: 800, height: 600 };

let server: Server;
let base = "";
/** The long polls the server is holding: answered only when it closes. */
let polls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/poll") {
      polls++;
      res.writeHead(200, { "content-type": "text/plain" });
      return; // never ended: the walk's browser closes it
    }
    if (req.url === "/csp") {
      // No 'unsafe-inline': a <style> the page did not load is refused.
      res.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "style-src 'self'",
      });
      res.end(FIXTURE);
      return;
    }
    if (req.url === "/answer") {
      res.writeHead(200, { "content-type": "text/plain" });
      let i = 0;
      setTimeout(function word() {
        res.write(`${i ? " " : ""}w${i}`);
        if (++i < ANSWER_WORDS) setTimeout(word, 40);
        else res.end();
      }, ANSWER_PAUSE_MS);
      return;
    }
    if (req.url?.startsWith("/search?")) {
      const q = new URL(req.url, "http://x").searchParams.get("q");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`results:${q}`);
      }, SEARCH_PAUSE_MS);
      return;
    }
    const page = (): void => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(req.url === "/next" ? NEXT_PAGE : FIXTURE);
    };
    if (req.url === "/next") setTimeout(page, NEXT_PAUSE_MS);
    else page();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const clock = () => ({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
});

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Recorded {
  result: Awaited<ReturnType<typeof runAuthored>>;
  screens: PageScreen[];
  bytes: Uint8Array[];
  /** The focused element's id as each page capture began. */
  focusAtHold: (string | null)[];
  /** The same, followed into open shadow roots and same-origin frames:
   *  ids joined with ">". */
  deepFocusAtHold: string[];
  /** The page's count of CSP violations as each page capture began. */
  violationsAtHold: number[];
  /** Whether a caret style is in the page once the walk has ended. */
  caretStyleLeft: boolean;
  /** Read from the live page once the walk has ended. */
  live: Record<string, Rect>;
  decoded: { width: number; height: number }[];
  /** Luma of each screen inside each live rect, by `after`. */
  luma: Record<string, number[]>[];
  /** Against `against`'s screens, by index: which pixels differ, so a
   *  byte mismatch says where and how much. Empty when none was given. */
  against: PixelDiff[];
}

type PixelDiff = {
  pixels: number;
  maxDelta: number;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** The share of the picture each of refresh's looks counts changed, and
   *  whether it is over that look's allowance (refresh's "changed"). */
  looks: { name: string; share: number; over: boolean }[];
};

/**
 * Records `steps` continuously and reads everything the cases need before
 * the browser closes: the screens' bytes, their decoded pixels in the rects
 * the cases ask about, and those rects from the live page.
 */
async function record(
  steps: DemoScript["steps"],
  rectsOf: (page: Page) => Promise<Record<string, Rect>>,
  path = "",
  againstBytes: Uint8Array[] = [],
  /** Called with each CDP call the walk made, once it has answered. */
  afterSend?: (
    method: string,
    params: Record<string, unknown> | undefined,
    ctx: { cdp: CdpSession; page: Page },
  ) => Promise<void>,
): Promise<Recorded> {
  let out: Recorded | null = null;
  await withReplayBrowser(
    async ({ cdp, page }) => {
      const focusAtHold: (string | null)[] = [];
      const deepFocusAtHold: string[] = [];
      const violationsAtHold: number[] = [];
      const watched: CdpSession = {
        ...cdp,
        send: async (method, params) => {
          if (
            method === "Runtime.evaluate" &&
            params?.expression === PAGE_CAPTURE_HOLD
          ) {
            // Instrumentation only: a page leaving under the read must not
            // fail the capture it watches, so it says so in the log instead.
            focusAtHold.push(
              await page
                .evaluate(() => document.activeElement?.id ?? null)
                .catch((e: Error) => `unreadable: ${e.message}`),
            );
            const read = await page
              .evaluate(() => {
                const ids: string[] = [];
                let f: Element | null = document.activeElement;
                while (f !== null) {
                  ids.push(f.id);
                  f =
                    f.shadowRoot?.activeElement ??
                    (f as HTMLIFrameElement).contentDocument?.activeElement ??
                    null;
                  if (f?.tagName === "BODY") f = null;
                }
                return {
                  deep: ids.join(">"),
                  violations: (window as unknown as { __violations: number })
                    .__violations,
                };
              })
              .catch((e: Error) => ({
                deep: `unreadable: ${e.message}`,
                violations: -1,
              }));
            deepFocusAtHold.push(read.deep);
            violationsAtHold.push(read.violations);
          }
          const reply = await cdp.send(method, params);
          await afterSend?.(method, params, { cdp, page });
          return reply;
        },
      };
      const selectors: Record<string, string> = {};
      const store: MemoryFrameStore = createMemoryFrameStore();
      let n = 0;
      const result = await runAuthored(
        { scriptVersion: 1, name: "settled", target: base + path, steps },
        {
          cdp: watched,
          page: selectorPageAgent(page, selectors),
          encoder: createNodeFrameEncoder(store, "settled"),
          store,
          clock: clock(),
          mayReplay: true,
          recording: "continuous",
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
                  url: base,
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
              pageUrl: base,
            };
          },
          newId: (prefix) => `${prefix}-${++n}`,
          sceneId: "settled",
          createdAt: "2026-11-10T00:00:00.000Z",
          viewport: VIEWPORT,
          startingBranding: BRANDING_DEFAULTS,
          cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
        },
      );
      const screens = result.bundle?.pageScreens ?? [];
      const bytes = await Promise.all(
        screens.map((s) =>
          s.ref === "" ? new Uint8Array() : store.load(s.ref),
        ),
      );
      // The `<style>`, or the constructed sheet a CSP page gets instead.
      const caretStyleLeft = await page.evaluate(
        () =>
          document.getElementById("__demomanCaretHold") !== null ||
          document.adoptedStyleSheets.length > 0,
      );
      const live = await rectsOf(page);
      const decoder = await page.context().newPage();
      const decoded: { width: number; height: number }[] = [];
      const luma: Record<string, number[]>[] = [];
      for (const b of bytes) {
        const read = await pixels(decoder, b, live);
        decoded.push(read.size);
        luma.push(read.luma);
      }
      const against: PixelDiff[] = [];
      for (const [i, other] of againstBytes.entries())
        against.push(
          await pixelDiff(decoder, bytes[i] ?? new Uint8Array(), other),
        );
      out = {
        result,
        screens,
        bytes,
        focusAtHold,
        deepFocusAtHold,
        violationsAtHold,
        caretStyleLeft,
        live,
        decoded,
        luma,
        against,
      };
    },
    { url: base + path, readySelector: "#ask" },
  );
  if (out === null) throw new Error("the browser closed before the run");
  return out;
}

/** Decodes a PNG in a page and reads the luma inside each rect. */
async function pixels(
  decoder: Page,
  png: Uint8Array,
  rects: Record<string, Rect>,
): Promise<{
  size: { width: number; height: number };
  luma: Record<string, number[]>;
}> {
  if (png.byteLength === 0) return { size: { width: 0, height: 0 }, luma: {} };
  return decoder.evaluate(
    async ({ b64, rects }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      const luma: Record<string, number[]> = {};
      for (const [name, r] of Object.entries(rects)) {
        const x = Math.round(r.x);
        const y = Math.round(r.y);
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        const d = ctx.getImageData(x, y, w, h).data;
        const row: number[] = [];
        for (let i = 0; i < d.length; i += 4) {
          row.push(
            Math.round(
              0.299 * (d[i] ?? 0) +
                0.587 * (d[i + 1] ?? 0) +
                0.114 * (d[i + 2] ?? 0),
            ),
          );
        }
        luma[name] = row;
      }
      return { size: { width: bitmap.width, height: bitmap.height }, luma };
    },
    { b64: Buffer.from(png).toString("base64"), rects },
  );
}

/** Decodes two PNGs in a page and says which pixels differ, for evidence. */
async function pixelDiff(
  decoder: Page,
  a: Uint8Array,
  b: Uint8Array,
): Promise<PixelDiff> {
  return decoder.evaluate(
    async ({ a, b }) => {
      const read = async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [x, y] = [await read(a), await read(b)];
      if (x.width !== y.width || x.height !== y.height)
        return { pixels: -1, maxDelta: -1, box: null, looks: [] };
      let pixels = 0;
      let maxDelta = 0;
      let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
      for (let i = 0; i < x.data.length; i += 4) {
        let d = 0;
        for (let c = 0; c < 3; c++)
          d = Math.max(
            d,
            Math.abs((x.data[i + c] ?? 0) - (y.data[i + c] ?? 0)),
          );
        if (d === 0) continue;
        pixels++;
        maxDelta = Math.max(maxDelta, d);
        const px = (i / 4) % x.width;
        const py = Math.floor(i / 4 / x.width);
        box =
          box === null
            ? { x0: px, y0: py, x1: px, y1: py }
            : {
                x0: Math.min(box.x0, px),
                y0: Math.min(box.y0, py),
                x1: Math.max(box.x1, px),
                y1: Math.max(box.y1, py),
              };
      }
      // Refresh's own reading of the pair: `STILL_LOOKS`
      // (apps/runner/src/executor/same-picture.ts) over `blockMoves`'s
      // arithmetic (apps/runner/src/picture-diff.ts), which this package
      // cannot import: each channel's a-minus-b averaged over the
      // block-wide square around each pixel, clipped at the edges; a pixel
      // counts when its most-moved channel moved more than `levels`.
      const w = x.width;
      const h = x.height;
      const looks = [
        { name: "sharply", block: 1, levels: 40, allowed: 0.000008 },
        { name: "faintly", block: 8, levels: 13, allowed: 0.00017 },
      ].map(({ name, block, levels, allowed }) => {
        const lo = Math.floor((block - 1) / 2);
        const hi = block - 1 - lo;
        const moves = new Float32Array(w * h);
        for (let c = 0; c < 3; c++) {
          const sum = new Float64Array((w + 1) * (h + 1));
          for (let py = 0; py < h; py++) {
            let row = 0;
            for (let px = 0; px < w; px++) {
              const p = (py * w + px) * 4 + c;
              row += (x.data[p] ?? 0) - (y.data[p] ?? 0);
              sum[(py + 1) * (w + 1) + px + 1] =
                (sum[py * (w + 1) + px + 1] ?? 0) + row;
            }
          }
          for (let py = 0; py < h; py++) {
            const y0 = Math.max(0, py - lo);
            const y1 = Math.min(h, py + hi + 1);
            for (let px = 0; px < w; px++) {
              const x0 = Math.max(0, px - lo);
              const x1 = Math.min(w, px + hi + 1);
              const at = (yy: number, xx: number) =>
                sum[yy * (w + 1) + xx] ?? 0;
              const move = Math.abs(
                (at(y1, x1) - at(y0, x1) - at(y1, x0) + at(y0, x0)) /
                  ((x1 - x0) * (y1 - y0)),
              );
              const i = py * w + px;
              if (move > (moves[i] ?? 0)) moves[i] = move;
            }
          }
        }
        let changed = 0;
        for (const m of moves) if (m > levels) changed++;
        const share = changed / moves.length;
        return { name, share, over: share > allowed };
      });
      return { pixels, maxDelta, box, looks };
    },
    {
      a: Buffer.from(a).toString("base64"),
      b: Buffer.from(b).toString("base64"),
    },
  );
}

/** The rightmost column, from the rect's left, holding a dark pixel; -1 if none. */
function inkRight(luma: number[] | undefined, width: number): number {
  let right = -1;
  for (let i = 0; i < (luma ?? []).length; i++) {
    if ((luma?.[i] ?? 255) < 128) right = Math.max(right, i % width);
  }
  return right;
}

const textRect = (page: Page, sel: string): Promise<Rect> =>
  page.evaluate((s) => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(s) as Node);
    const r = range.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);

const MAIN: DemoScript["steps"] = [
  { do: "click", on: { stableId: "spinbtn" } },
  { do: "click", on: { stableId: "ask" } },
  { do: "click", on: { stableId: "q" } },
  { do: "type", into: { stableId: "q" }, text: "abc" },
  { do: "hover", on: { stableId: "hoverrow" } },
  { do: "click", on: { stableId: "toastbtn" } },
];

const mainRects = async (page: Page): Promise<Record<string, Rect>> => {
  const field = await page.evaluate(() => {
    const q = document.getElementById("q") as HTMLInputElement;
    const r = q.getBoundingClientRect();
    const cs = getComputedStyle(q);
    const left =
      r.x +
      Number.parseFloat(cs.borderLeftWidth) +
      Number.parseFloat(cs.paddingLeft);
    const right =
      r.right -
      Number.parseFloat(cs.borderRightWidth) -
      Number.parseFloat(cs.paddingRight);
    const top =
      r.y +
      Number.parseFloat(cs.borderTopWidth) +
      Number.parseFloat(cs.paddingTop);
    const bottom =
      r.bottom -
      Number.parseFloat(cs.borderBottomWidth) -
      Number.parseFloat(cs.paddingBottom);
    const ctx = document
      .createElement("canvas")
      .getContext("2d") as CanvasRenderingContext2D;
    ctx.font = cs.font;
    return {
      content: { x: left, y: top, width: right - left, height: bottom - top },
      textWidth: ctx.measureText(q.value).width,
    };
  });
  return {
    // Scanned to near the right edge: the line holds nothing else.
    answer: { ...(await textRect(page, "#answer")), width: 700 },
    answerText: await textRect(page, "#answer"),
    list: { ...(await textRect(page, "#list")), width: 700 },
    listText: await textRect(page, "#list"),
    field: field.content,
    // Only `width` is read: the typed text's advance.
    fieldText: { x: 0, y: 0, width: field.textWidth, height: 1 },
  };
};

describe("a continuous walk settles each step and captures its page", () => {
  let a: Recorded;
  let b: Recorded;
  beforeAll(async () => {
    a = await record(MAIN, mainRects);
    b = await record(MAIN, mainRects, "", a.bytes);
    // Two walks of six steps with the settle after each: about 8 s each
    // here, and CI's runner is about 5x slower.
  }, 120_000);

  it("every step has a page screen, plus the opening and the end", () => {
    expect(a.result.reason, String(a.result.reason)).toBeNull();
    expect(a.screens.map((s) => s.after)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      a.screens.filter((s) => s.unsettled !== undefined),
      JSON.stringify(a.screens),
    ).toEqual([]);
    for (const [i, size] of a.decoded.entries()) {
      expect(size, `screen ${i}`).toEqual(VIEWPORT);
      expect(a.screens[i]?.width).toBe(VIEWPORT.width);
      expect(a.screens[i]?.height).toBe(VIEWPORT.height);
    }
  });

  it("the screen after a stream is the finished text", () => {
    const words = a.live.answerText;
    expect(words?.width, "premise: the answer arrived").toBeGreaterThan(50);
    const width = Math.round(a.live.answer?.width ?? 0);
    const before = inkRight(a.luma[1]?.answer, width);
    const after = inkRight(a.luma[2]?.answer, width);
    expect(before, "premise: no answer before the ask").toBe(-1);
    const edge = Math.round(words?.x ?? 0) + (words?.width ?? 0);
    expect(
      Math.abs(Math.round(a.live.answer?.x ?? 0) + after + 1 - edge),
      `ink ends at ${after} in the screen after the ask; the full answer ends at ${edge}; waited ${a.screens[2]?.waitedMs} ms`,
    ).toBeLessThanOrEqual(3);
  });

  it("the screen after typing shows the last character", () => {
    const field = a.live.field as Rect;
    const typed = Math.round(field.width);
    const right = inkRight(a.luma[4]?.field, typed);
    const advance = a.live.fieldText?.width ?? 0;
    expect(advance, "premise: something was typed").toBeGreaterThan(10);
    expect(
      Math.abs(right + 1 - advance),
      `ink ends ${right + 1} px into the field; "abc" is ${advance} px wide`,
    ).toBeLessThanOrEqual(2);
    // The debounced search the last key fired, DEBOUNCE_MS after it.
    expect(
      DEBOUNCE_MS,
      "premise: the debounce is inside the beat",
    ).toBeLessThan(STEP_QUIET_MS);
    const list = a.live.listText as Rect;
    const listRight = inkRight(
      a.luma[4]?.list,
      Math.round(a.live.list?.width ?? 0),
    );
    expect(
      Math.abs(
        Math.round(a.live.list?.x ?? 0) + listRight + 1 - (list.x + list.width),
      ),
      `filtered list ink ends at ${listRight}`,
    ).toBeLessThanOrEqual(3);
  });

  // The empty field before and after a click focuses it: inside the content
  // box (the focus ring is outside the border) only a caret could differ.
  it("hides the caret in the screen of a field it focused", () => {
    expect(a.focusAtHold[3], "premise: the field held focus").toBe("q");
    expect(a.focusAtHold[2], "premise: the field was not focused yet").not.toBe(
      "q",
    );
    const unfocused = a.luma[2]?.field ?? [];
    const focused = a.luma[3]?.field ?? [];
    expect(unfocused.length, "premise: the field was read").toBeGreaterThan(0);
    const differ = focused.filter((v, i) => v !== unfocused[i]).length;
    expect(
      differ,
      "pixels in the empty field's content box that changed on focus",
    ).toBe(0);
  });

  // Two recordings may differ where refresh cannot see it: read with
  // refresh's own looks (`pixelDiff`), no screen may be over either
  // allowance. Measured: 1 px by 2 levels at #q's focus-ring corner
  // (macOS), and 3 px by 40 levels in the column at x=7 on the last screen
  // (ubuntu, 2026-11-11), each read 0 by both looks. A hover lost on
  // #spinbtn (1251 px by up to 39 levels, CI, 2026-11-10) reads changed
  // faintly, so this still fails on it.
  it("two recordings of the same script give page screens refresh reads as the same", () => {
    // The premises: an endless spinner was on screen and held for every
    // screen after the first step, and the field held focus for the
    // screens after the focus, the typing and the hover. The caret itself is
    // pinned by "hides the caret" above, not here: measured 2026-11-10,
    // headless Chromium draws it in the same phase in both recordings, so
    // with the caret style removed these bytes still agree. Without the
    // endless-animation hold they do not: screens 1-6 differ (the spinner).
    expect(
      a.screens.slice(1).map((s) => s.heldAnimations),
      "spinner held",
    ).toEqual([1, 1, 1, 1, 1, 1]);
    expect(a.focusAtHold.slice(3, 6)).toEqual(["q", "q", "q"]);
    expect(b.screens.map((s) => s.after)).toEqual(
      a.screens.map((s) => s.after),
    );
    const differing = a.bytes
      .map((bytes, i) => ({
        i,
        same: Buffer.from(bytes).equals(Buffer.from(b.bytes[i] ?? [])),
      }))
      .filter((x) => !x.same)
      .map((x) => x.i);
    // The premise for the evidence: b was compared with a, screen by screen.
    expect(b.against).toHaveLength(a.bytes.length);
    // And the comparison reads 0 where the bytes agree.
    for (const [i, d] of b.against.entries())
      if (!differing.includes(i)) expect(d.pixels, `screen ${i}`).toBe(0);
    // -1 is two sizes, which no tolerance forgives.
    expect(
      // Every screen, read from the pixels: what refresh would compare.
      b.against
        .map((d, i) => ({ i, d }))
        .filter(({ d }) => d.maxDelta < 0 || d.looks.some((l) => l.over))
        .map(({ i }) => i),
      `sizes a ${a.bytes.map((x) => x.byteLength)} b ${b.bytes.map((x) => x.byteLength)}; pixels ${JSON.stringify(b.against.map((d, i) => ({ i, after: a.screens[i]?.after, ...d })).filter((d) => d.pixels !== 0))}`,
    ).toEqual([]);
  });

  it("the caret style is gone after the capture", () => {
    expect(a.focusAtHold.length, "premise: HOLD ran for every screen").toBe(7);
    expect(a.caretStyleLeft).toBe(false);
  });
});

describe("a layout change as a still is taken, under the resting pointer", () => {
  // Chrome recomputes hover after a layout change, and one that lands while
  // a 3x still is in flight hit-tests at the display's scale, not the
  // emulated one (`input-gate.ts`): the button under the pointer loses its
  // hover and stays that way. In a walk that is a race (#spinbtn, CI
  // 2026-11-10); here the harness loses it on purpose. Once the click's
  // release has answered, it changes the layout and takes a still at once.
  let r: Recorded;
  /** Whether #hoverbtn was hovered right after the harness's still. */
  let hoveredAfterStill: boolean | null = null;
  /** Whether #hoverbtn was hovered as each page capture began. */
  const hoveredAtHold: boolean[] = [];
  /** #hoverbtn's top before the harness changed the layout. */
  let topBefore: number | null = null;
  /** How many layout changes and stills it took to lose the hover. */
  let stillTries = 0;
  const STILL_TRIES = 5;
  beforeAll(async () => {
    const hovered = (page: Page) =>
      page.evaluate(
        () => document.getElementById("hoverbtn")?.matches(":hover") === true,
      );
    r = await record(
      [{ do: "click", on: { stableId: "hoverbtn" } }],
      async (page) => ({
        hoverbtn: await page.evaluate(() => {
          const b = (
            document.getElementById("hoverbtn") as HTMLElement
          ).getBoundingClientRect();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        }),
      }),
      "",
      [],
      async (method, params, { cdp, page }) => {
        if (
          method === "Runtime.evaluate" &&
          params?.expression === PAGE_CAPTURE_HOLD
        ) {
          hoveredAtHold.push(await hovered(page));
        }
        if (
          hoveredAfterStill !== null ||
          method !== "Input.dispatchMouseEvent" ||
          params?.type !== "mouseReleased"
        ) {
          return;
        }
        topBefore = await page.evaluate(
          () =>
            (
              document.getElementById("hoverbtn") as HTMLElement
            ).getBoundingClientRect().y,
        );
        // The race is Chrome's, so a still can miss it (Linux CI,
        // DEM-174): try again, bounded, and say how many tries it took.
        do {
          stillTries++;
          await page.evaluate(() => {
            const d = document.createElement("div");
            d.style.height = "20px";
            document.getElementById("finwrap")?.append(d);
          });
          await cdp.send("Page.captureScreenshot", {
            format: "jpeg",
            quality: 95,
          });
          hoveredAfterStill = await hovered(page);
        } while (hoveredAfterStill && stillTries < STILL_TRIES);
        // A miss on every try is the premise's to say, below.
        if (stillTries > 1 && !hoveredAfterStill)
          console.warn(
            `settled-screens: the hover was lost to the still on try ${stillTries} of ${STILL_TRIES}`,
          );
      },
    );
  }, 60_000);

  // Red without the pointer's move before the settle (`settleAndCapture`):
  // the screen after the click shows the button as the opening does.
  it("the screen after the click shows the button under the pointer hovered", () => {
    // The premises: the opening had nothing hovered, and the harness's
    // still really did lose the hover the click had.
    expect(hoveredAtHold, "hovered as each capture began").toHaveLength(2);
    expect(hoveredAtHold[0], "the opening").toBe(false);
    expect(
      hoveredAfterStill,
      `lost to the still (${stillTries} of ${STILL_TRIES} tries)`,
    ).toBe(false);
    // The layout change is below the button (#finwrap), so the button did
    // not move: the picture below compares the same pixels.
    expect(topBefore, "premise: read before the change").not.toBeNull();
    expect(r.live.hoverbtn?.y, "the button did not move").toBe(topBefore);
    expect(hoveredAtHold[1], "the screen after the click").toBe(true);
    // On the picture: the button's border darkens when hovered (a native
    // button, 39 levels), so the screen after differs from the opening.
    const [before, after] = [r.luma[0]?.hoverbtn, r.luma[1]?.hoverbtn];
    expect(before?.length, "premise: the button was read").toBeGreaterThan(0);
    let most = 0;
    for (let i = 0; i < (before?.length ?? 0); i++)
      most = Math.max(most, Math.abs((before?.[i] ?? 0) - (after?.[i] ?? 0)));
    expect(most, JSON.stringify(r.screens)).toBeGreaterThanOrEqual(20);
  });
});

describe("a search the typing fires", () => {
  let r: Recorded;
  beforeAll(async () => {
    r = await record(
      [{ do: "type", into: { stableId: "search" }, text: "ab" }],
      async (page) => ({
        results: { ...(await textRect(page, "#results")), width: 700 },
        resultsText: await textRect(page, "#results"),
      }),
    );
    // One glide, the typing and a 500 ms answer: about 4 s here.
  }, 60_000);

  // The request starts DEBOUNCE_MS after the last key, inside the page's
  // quiet beat: only asking about requests again after the page answered
  // sees it.
  it("the screen after typing shows the search's results", () => {
    expect(
      DEBOUNCE_MS,
      "premise: the debounce is inside the beat",
    ).toBeLessThan(STEP_QUIET_MS);
    const text = r.live.resultsText as Rect;
    expect(text.width, "premise: the results arrived").toBeGreaterThan(20);
    const right = inkRight(
      r.luma[1]?.results,
      Math.round(r.live.results?.width ?? 0),
    );
    expect(
      r.screens[1]?.unsettled,
      JSON.stringify(r.screens[1]),
    ).toBeUndefined();
    expect(
      Math.abs(
        Math.round(r.live.results?.x ?? 0) + right + 1 - (text.x + text.width),
      ),
      `results ink ends at ${right}; waited ${r.screens[1]?.waitedMs} ms`,
    ).toBeLessThanOrEqual(3);
  });
});

describe("a step that never settles", () => {
  let r: Recorded;
  beforeAll(async () => {
    r = await record(
      [{ do: "click", on: { stableId: "never" } }],
      async () => ({}),
    );
    // The never step costs the whole 2 s cap: about 4 s here.
  }, 60_000);

  it("a page that never settles records the step unsettled and says why", () => {
    expect(r.result.outcome, String(r.result.reason)).toBe("complete");
    expect(r.screens[1]?.unsettled).toMatch(/DOM never went quiet/);
    expect(
      r.result.degradations.filter((d) => d.kind === "stepUnsettled"),
      JSON.stringify(r.result.degradations),
    ).toHaveLength(1);
  });
});

describe("a click that navigates", () => {
  let r: Recorded;
  beforeAll(async () => {
    r = await record(
      [{ do: "click", on: { stableId: "nav" } }],
      async (page) => ({
        heading: await textRect(page, "#heading"),
      }),
    );
    // One glide and a page that answers after 600 ms: about 4 s here.
  }, 60_000);

  it("a navigating click captures the new page", () => {
    const heading = r.live.heading as Rect;
    const width = Math.round(heading.width);
    expect(
      r.screens[1]?.unsettled,
      JSON.stringify(r.screens[1]),
    ).toBeUndefined();
    expect(
      inkRight(r.luma[0]?.heading, width),
      "premise: the first page has no ink where the heading lands",
    ).toBe(-1);
    expect(
      inkRight(r.luma[1]?.heading, width),
      `the screen after the click, where the new page's heading is; waited ${r.screens[1]?.waitedMs} ms`,
    ).toBeGreaterThan(width / 2);
  });
});

describe("a request that never closes (a long poll)", () => {
  let r: Recorded;
  beforeAll(async () => {
    r = await record(
      [
        { do: "click", on: { stableId: "poll" } },
        { do: "click", on: { stableId: "toastbtn" } },
        { do: "click", on: { stableId: "hoverbtn" } },
      ],
      async () => ({}),
    );
    // The poll's own step waits the whole 6 s request cap; the two after it
    // must not: about 10 s here, 30 s if they wait it too.
  }, 90_000);

  it("waits for it on the step that opened it, then leaves it out and says so", () => {
    expect(polls, "premise: the poll reached the server").toBeGreaterThan(0);
    expect(r.result.outcome, String(r.result.reason)).toBe("complete");
    expect(r.screens.map((s) => s.after)).toEqual([0, 1, 2, 3]);
    expect(r.screens[1]?.unsettled, JSON.stringify(r.screens[1])).toMatch(
      /1 request\(s\) in flight/,
    );
    for (const s of r.screens.slice(2)) {
      expect(s.unsettled, JSON.stringify(s)).toBeUndefined();
      expect(s.waitedMs, JSON.stringify(s)).toBeLessThan(
        STEP_REQUEST_CAP_MS / 2,
      );
    }
    const said = r.result.degradations
      .filter((d) => d.kind === "requestNotWaited")
      .map((d) => d.note);
    // One for each step after the poll's own, each naming its step.
    expect(said, JSON.stringify(r.result.degradations)).toHaveLength(2);
    for (const note of said) {
      expect(note).toMatch(
        /^the page after step \S+: 1 request opened more than 6 s before this step's wait began was not waited for$/,
      );
    }
    expect(new Set(said).size, "two steps, two names").toBe(2);
  });
});

describe("a page whose CSP refuses inline styles", () => {
  let r: Recorded;
  /** The focused field's luma in captures taken without the hold. */
  const bare: number[][] = [];
  let ownStyleRefused = false;
  /** The page's CSP violation count once the walk has ended. */
  let violationsAfter = -1;
  beforeAll(async () => {
    r = await record(
      [{ do: "click", on: { stableId: "q" } }],
      async (page) => {
        // The field alone: with the page's own style refused, #answer and
        // #list have no height to read.
        const rects = { field: (await mainRects(page)).field as Rect };
        ownStyleRefused = await page.evaluate(
          () =>
            getComputedStyle(document.getElementById("answer") as Element)
              .height !== "20px",
        );
        const decoder = await page.context().newPage();
        // The caret blinks about every 500 ms: one of six shots 200 ms apart
        // is in its drawn phase.
        for (let i = 0; i < 6; i++) {
          const png = await page.screenshot({ caret: "initial", scale: "css" });
          bare.push(
            (await pixels(decoder, png, { field: rects.field as Rect })).luma
              .field ?? [],
          );
          await new Promise((res) => setTimeout(res, 200));
        }
        await decoder.close();
        violationsAfter = await page.evaluate(
          () => (window as unknown as { __violations: number }).__violations,
        );
        return rects;
      },
      "csp",
    );
    // One click and its settle: about 4 s here.
  }, 60_000);

  // Red when the caret style is refused: the field's screen shows the caret.
  it("still hides the caret in the screen of a focused field", () => {
    expect(
      ownStyleRefused,
      "premise: the page's own inline <style> was refused",
    ).toBe(true);
    expect(r.focusAtHold[1], "premise: the field held focus").toBe("q");
    const unfocused = r.luma[0]?.field ?? [];
    expect(unfocused.length, "premise: the field was read").toBeGreaterThan(0);
    const drawn = bare.map(
      (l) => l.filter((v, i) => v !== unfocused[i]).length,
    );
    expect(
      Math.max(...drawn),
      `premise: a capture without the hold shows a caret (${drawn})`,
    ).toBeGreaterThan(0);
    expect(
      r.screens[1]?.unsettled,
      JSON.stringify(r.screens[1]),
    ).toBeUndefined();
    const focused = r.luma[1]?.field ?? [];
    expect(
      focused.filter((v, i) => v !== unfocused[i]).length,
      "pixels in the empty field's content box that changed on focus",
    ).toBe(0);
    expect(r.caretStyleLeft, "the stand-in sheet is gone after").toBe(false);
  });
  // Red when every capture appends the refused <style> again: each sets off
  // the page's CSP, and its report-uri, once per screen.
  it("sets off the page's CSP at the first capture only", () => {
    const [first, second] = r.violationsAtHold;
    expect(r.violationsAtHold, "premise: one count per capture").toHaveLength(
      2,
    );
    expect(
      (second ?? -1) - (first ?? -1),
      `premise: the first capture's <style> was refused (${r.violationsAtHold})`,
    ).toBe(1);
    expect(
      violationsAfter - (second ?? -1),
      `violations during the second capture (${r.violationsAtHold}, then ${violationsAfter})`,
    ).toBe(0);
  });
});

describe("focus the document's caret rule cannot reach", () => {
  let r: Recorded;
  /** The component field's caret-color with the hold applied. */
  let componentCaret = "";
  beforeAll(async () => {
    r = await record(
      [
        { do: "click", on: { stableId: "frame" } },
        { do: "click", on: { stableId: "shost" } },
      ],
      async (page) => {
        await page.evaluate(PAGE_CAPTURE_HOLD);
        componentCaret = await page.evaluate(() => {
          const field = document
            .getElementById("shost")
            ?.shadowRoot?.getElementById("shin");
          return field ? getComputedStyle(field).caretColor : "no field";
        });
        await page.evaluate(PAGE_CAPTURE_RELEASE);
        return {};
      },
    );
    // Two clicks and their settles: about 4 s here.
  }, 60_000);

  const CARET_WORDS = "a focused field's caret could not be hidden";

  it("says nothing of a caret with nothing focused (control)", () => {
    expect(r.result.reason, String(r.result.reason)).toBeNull();
    expect(r.screens.map((s) => s.after)).toEqual([0, 1, 2]);
    expect(r.screens[0]?.unsettled ?? "").not.toContain(CARET_WORDS);
  });

  // Red when the hold reads only the top document's activeElement: it sees
  // the <iframe>, no field, and the screen is compared with a caret in it.
  it("names the caret of a field focused inside a frame", () => {
    expect(r.deepFocusAtHold[1], "premise: focus is inside the frame").toBe(
      "frame>fin",
    );
    expect(
      r.screens[1]?.unsettled ?? "",
      JSON.stringify(r.screens[1]),
    ).toContain(CARET_WORDS);
  });

  // Red the same way: the top document sees the component, not its field.
  it("names the caret of a component field that sets its own caret-color", () => {
    expect(r.deepFocusAtHold[2], "premise: focus is in the component").toBe(
      "shost>shin",
    );
    expect(
      componentCaret,
      "premise: the component's colour beats the document's rule",
    ).toBe("rgb(255, 0, 0)");
    expect(
      r.screens[2]?.unsettled ?? "",
      JSON.stringify(r.screens[2]),
    ).toContain(CARET_WORDS);
  });
});
