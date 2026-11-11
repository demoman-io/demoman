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
  runAuthored,
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
  /** Whether the caret style is in the page once the walk has ended. */
  caretStyleLeft: boolean;
  /** Read from the live page once the walk has ended. */
  live: Record<string, Rect>;
  decoded: { width: number; height: number }[];
  /** Luma of each screen inside each live rect, by `after`. */
  luma: Record<string, number[]>[];
}

/**
 * Records `steps` continuously and reads everything the cases need before
 * the browser closes: the screens' bytes, their decoded pixels in the rects
 * the cases ask about, and those rects from the live page.
 */
async function record(
  steps: DemoScript["steps"],
  rectsOf: (page: Page) => Promise<Record<string, Rect>>,
): Promise<Recorded> {
  let out: Recorded | null = null;
  await withReplayBrowser(
    async ({ cdp, page }) => {
      const focusAtHold: (string | null)[] = [];
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
          }
          return cdp.send(method, params);
        },
      };
      const selectors: Record<string, string> = {};
      const store: MemoryFrameStore = createMemoryFrameStore();
      let n = 0;
      const result = await runAuthored(
        { scriptVersion: 1, name: "settled", target: base, steps },
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
      const caretStyleLeft = await page.evaluate(
        () => document.getElementById("__demomanCaretHold") !== null,
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
      out = {
        result,
        screens,
        bytes,
        focusAtHold,
        caretStyleLeft,
        live,
        decoded,
        luma,
      };
    },
    { url: base, readySelector: "#ask" },
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
    b = await record(MAIN, mainRects);
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
    // The debounced search the last key fired, 250 ms after it.
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

  it("two recordings of the same script give byte-identical page screens", () => {
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
    expect(
      differing,
      `sizes a ${a.bytes.map((x) => x.byteLength)} b ${b.bytes.map((x) => x.byteLength)}`,
    ).toEqual([]);
  });

  it("the caret style is gone after the capture", () => {
    expect(a.focusAtHold.length, "premise: HOLD ran for every screen").toBe(7);
    expect(a.caretStyleLeft).toBe(false);
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

  // The request starts 250 ms after the last key, inside the page's quiet
  // beat: only asking about requests again after the page answered sees it.
  it("the screen after typing shows the search's results", () => {
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
        /^the page after step \S+: 1 request open since an earlier step was not waited for$/,
      );
    }
    expect(new Set(said).size, "two steps, two names").toBe(2);
  });
});
