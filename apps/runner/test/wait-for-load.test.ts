import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrandKitsRead } from "@demoman/run-core";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../src/executor/browser.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import { runScript } from "../src/executor/run.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { installResolver } from "../src/page-agent.js";

/**
 * `waitForLoad` after a click that navigates waits for the page the click
 * went to, not the one it left.
 *
 * Measured 2026-10-13 on Wikipedia's "Go", CLI, headed: the release went
 * out, the page asked to navigate, and the very next `document.readyState`
 * read answered `complete` — from the Main Page, which stays the document
 * until the new one commits. The walk counted the load as done and took its
 * still as the commit landed: "Not attached to an active page", and the run
 * stopped as `portFailure` in 4 of 6 runs. When the new page is slower than
 * the settle (500 ms of quiet), nothing fails at all: the still is simply of
 * the page being left, and the run says `complete`.
 *
 * That slow shape is the one this file builds, because it is deterministic:
 * a red page whose button navigates to a blue page the server holds back.
 * The wait's still must be blue. Each case asserts the timing that makes
 * it the case it says it is.
 *
 * Timeouts: one headless launch, then one run of about five seconds each
 * (measured locally 2026-10-13); CI is ~5x slower at browser work
 * (`fff4505`). Ceilings on a hang, not budgets.
 */
const HOOK_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 90_000;

const RED = [200, 30, 30] as const;
const BLUE = [30, 30, 200] as const;
const page = (rgb: readonly number[], body: string) =>
  `<!doctype html><meta charset=utf-8><style>html,body{margin:0;height:100%;background:rgb(${rgb.join(",")})}</style>${body}`;

const lines: string[] = [];
const log = (line: string) => void lines.push(line);
const kits: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
  migrationPending: false,
};
const session = createBrowserSession({
  headless: true,
  log,
  onLaunched: async ({ context }) => {
    await installResolver(context);
    await installExecutorEntry(context);
  },
});

let server: Server;
let origin: string;
let home: string;
/** When the server was asked for the blue page, and when it answered. */
const held: { askedAt: number; answeredAt: number }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/arrived") {
      const askedAt = Date.now();
      setTimeout(
        () => {
          held.push({ askedAt, answeredAt: Date.now() });
          res.writeHead(200, { "content-type": "text/html" });
          res.end(page(BLUE, "<h1>Arrived</h1>"));
        },
        Number(url.searchParams.get("hold")),
      );
      return;
    }
    const hold = url.searchParams.get("hold");
    // `later`: the button navigates by script `later` ms after the click;
    // otherwise it is a plain form submit, which starts at once.
    const later = url.searchParams.get("later");
    const go = `style="margin:200px;font-size:24px"`;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      page(
        RED,
        later === null
          ? `<form action="/arrived"><input type=hidden name=hold value="${hold}"><button ${go}>Go</button></form>`
          : `<button ${go} onclick="setTimeout(() => { location.href = '/arrived?hold=${hold}'; }, ${later})">Go</button>`,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = await mkdtemp(join(tmpdir(), "demoman-wait-load-"));
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await session.close();
  server?.close();
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});

/** What the stage's CDP was asked, timed: every `document.readyState` read
 *  and its answer, and the click check's read — the click's last call. */
type Heard = {
  reads: { sentAt: number; value: unknown }[];
  clickReadAt: number | null;
  /** Settle probes the page refused — a page that went away mid-probe. */
  settlesRefused: number;
  /** Click-check reads the page refused, likewise. */
  clickReadsRefused: number;
};
/** `holdClickReads`: each click-check read is sent only once the top frame
 *  has navigated after it was asked for — what Chromium did on its own
 *  after a form submit to a slow page (measured 2026-10-13: the read did not
 *  answer until the new page committed), made certain here because on a
 *  loaded machine the read sometimes went out and answered first. */
function recordingSession(
  heard: Heard,
  holdClickReads = false,
): typeof session {
  return {
    ...session,
    stage: async () => {
      const staged = await session.stage();
      if (staged.ok) {
        const { cdp } = staged.stage;
        const send = cdp.send.bind(cdp);
        let navigated = 0;
        cdp.on("Page.frameNavigated", (p) => {
          if ((p.frame as { parentId?: string }).parentId === undefined) {
            navigated++;
          }
        });
        const nextNavigation = async (): Promise<void> => {
          const from = navigated;
          while (navigated === from) {
            await new Promise((r) => setTimeout(r, 10));
          }
        };
        cdp.send = async (method, params) => {
          if (
            holdClickReads &&
            method === "Runtime.callFunctionOn" &&
            params?.returnByValue === true &&
            String(params?.functionDeclaration).includes("__demomanClickProbe")
          ) {
            await nextNavigation();
          }
          const sentAt = Date.now();
          const reply = await send(method, params).catch((error) => {
            if (
              method === "Runtime.evaluate" &&
              String(params?.expression).includes("__demomanSettlePaint")
            ) {
              heard.settlesRefused++;
            }
            if (
              method === "Runtime.callFunctionOn" &&
              params?.returnByValue === true &&
              String(params?.functionDeclaration).includes(
                "__demomanClickProbe",
              )
            ) {
              heard.clickReadsRefused++;
            }
            throw error;
          });
          if (
            method === "Runtime.evaluate" &&
            params?.expression === "document.readyState"
          ) {
            heard.reads.push({
              sentAt,
              value: (reply.result as { value?: unknown } | undefined)?.value,
            });
          }
          // Each placement and read of the click check, as it answers: the
          // last is the click's last call.
          if (
            method === "Runtime.callFunctionOn" &&
            String(params?.functionDeclaration).includes("__demomanClickProbe")
          ) {
            heard.clickReadAt = Date.now();
          }
          return reply;
        };
      }
      return staged;
    },
  };
}

/** The centre pixel of the keyframe tagged with `actionId`, decoded in the
 *  browser. */
async function centreOf(
  library: ReturnType<typeof createLibrary>,
  takeId: string,
  actionId: string,
): Promise<number[]> {
  const store = library.frameStore(takeId);
  const bundle = await store.getBundle(takeId);
  const ref = bundle?.keyframes.find((k) => k.actionId === actionId)?.ref;
  expect(
    ref,
    `no keyframe for ${actionId}: ${JSON.stringify(bundle?.keyframes.map((k) => k.actionId))}`,
  ).toBeDefined();
  const bytes = await store.load(ref as string);
  const ok = await session.ensure();
  if (!ok.ok) throw new Error(JSON.stringify(ok));
  const probe = await ok.launched.context.newPage();
  try {
    return await probe.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${data}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      g.drawImage(img, 0, 0);
      const x = Math.floor(c.width / 2);
      const y = Math.floor((c.height * 3) / 4);
      return Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    }, Buffer.from(bytes).toString("base64"));
  } finally {
    await probe.close();
  }
}

const near = (got: number[], want: readonly number[]) =>
  got.every((v, i) => Math.abs(v - (want[i] as number)) <= 24);

/** Runs the red-to-blue script and asserts the wait's still is of the blue
 *  page; hands back what the stage heard and what the server held. */
async function runRedToBlue(options: {
  hold: number;
  later?: number;
  pauseMs?: number;
  holdClickReads?: boolean;
}): Promise<{
  heard: Heard;
  held: { askedAt: number; answeredAt: number };
  degradations: string[];
  unconfirmedClicks: unknown[];
}> {
  held.length = 0;
  const heard: Heard = {
    reads: [],
    clickReadAt: null,
    settlesRefused: 0,
    clickReadsRefused: 0,
  };
  const library = createLibrary(home);
  const query = `hold=${options.hold}${options.later === undefined ? "" : `&later=${options.later}`}`;
  const report = await runScript(
    {
      scriptVersion: 1,
      name: "a slow navigation",
      target: `${origin}/?${query}`,
      viewport: { width: 800, height: 600 },
      steps: [
        { do: "waitForLoad" },
        { do: "click", on: { text: "Go" } },
        ...(options.pauseMs === undefined
          ? []
          : [{ do: "pause", ms: options.pauseMs }]),
        { do: "waitForLoad" },
      ],
    } as never,
    {
      session: recordingSession(heard, options.holdClickReads === true),
      library,
      kits,
      log,
      sessions: [],
      sessionStore: createSessionStore(home),
      signinCommand: "npx demoman signin",
      loadSessions: async () => ({ ok: true as const, files: [] }),
      // Not the staged context: the run reloads into it, harmlessly.
      sessionsContext: {} as BrowserContext,
    },
    () => undefined,
  );
  const evidence = JSON.stringify({ report, lines, held, heard });
  expect(report.outcome, evidence).toBe("complete");
  expect(held.length, evidence).toBe(1);
  expect(heard.clickReadAt, evidence).not.toBeNull();

  const takeId = report.provenance.takeId as string;
  const doc = await library.getScene(takeId);
  const actions = doc?.actions ?? [];
  expect(
    actions.map((a) => a.kind),
    evidence,
  ).toEqual(["waitFor", "click", "waitFor"]);
  // The fixture: the page being left is red in a still of its own, so
  // the colour below tells the two pages apart.
  const before = await centreOf(library, takeId, actions[0]?.id as string);
  expect(near(before, RED), `first wait's still ${before}`).toBe(true);
  const after = await centreOf(library, takeId, actions[2]?.id as string);
  expect(near(after, BLUE), `second wait's still ${after} ${evidence}`).toBe(
    true,
  );
  return {
    heard,
    held: held[0] as { askedAt: number; answeredAt: number },
    degradations: report.frames?.degradations ?? [],
    unconfirmedClicks: report.frames?.unconfirmedClicks ?? [],
  };
}

/** A stale read and the settle after it take ~550 ms; this is how much
 *  sooner than the blue page they must be able to finish for a case to
 *  catch a wait that accepted the red one. */
const SETTLE_ROOM_MS = 1000;

describe("waitForLoad after a click that navigates", () => {
  // The page starts navigating 150 ms after the click — after the wait's
  // first read, during the settle that follows it. Only the count of
  // navigations seen across the read and the settle can tell.
  it(
    "waits for the page the click went to when it starts navigating after the wait's read",
    async () => {
      const { heard, held: h } = await runRedToBlue({ hold: 1200, later: 150 });
      const evidence = JSON.stringify({ heard, h });
      // The premise: a read after the click said `complete` before the
      // navigation had even asked the server — the red page, read in time
      // for a settle on it to finish well before the blue one arrived.
      const stale = heard.reads.filter(
        (r) =>
          r.sentAt >= (heard.clickReadAt as number) &&
          r.sentAt < h.askedAt &&
          r.value === "complete",
      );
      expect(stale.length, evidence).toBeGreaterThan(0);
      expect(
        h.answeredAt - (stale[0]?.sentAt as number),
        evidence,
      ).toBeGreaterThan(SETTLE_ROOM_MS);
    },
    TEST_TIMEOUT_MS,
  );

  // Wikipedia's timing: the blue page commits while the wait is settling
  // the red one, so the settle probe is refused as its page goes away. That
  // refusal is about the page being left, and the take's page did settle:
  // the report must not say it never did.
  it(
    "does not report the page it left as a page that never settled",
    async () => {
      const {
        heard,
        held: h,
        degradations,
      } = await runRedToBlue({ hold: 200, later: 150 });
      const evidence = JSON.stringify({ heard, h, degradations });
      // The premise: a settle really was refused mid-way, after a read of
      // the red page.
      expect(heard.settlesRefused, evidence).toBeGreaterThan(0);
      expect(
        heard.reads.some(
          (r) =>
            r.sentAt >= (heard.clickReadAt as number) &&
            r.sentAt < h.askedAt &&
            r.value === "complete",
        ),
        evidence,
      ).toBe(true);
      expect(degradations, evidence).not.toContain("pageNeverSettled");
    },
    TEST_TIMEOUT_MS,
  );

  // The navigation is already under way when the wait begins: it starts
  // 100 ms after the click, during a pause, so nothing new starts during
  // the wait. Red if the top frame's loading never clears (the wait would
  // time out). It does not pin the walk's skipped read while loading: a
  // read sent here does not answer until the blue page commits (measured
  // 2026-10-13), so the walk lands on the blue page with or without it.
  // Not a form submit: the click check's read does not answer while one is
  // pending either, so the click step itself would outlast the navigation
  // and the wait would never begin inside it.
  it(
    "waits for it when the navigation began before the wait did",
    async () => {
      const PAUSE_MS = 400;
      const { heard, held: h } = await runRedToBlue({
        hold: 3000,
        later: 100,
        pauseMs: PAUSE_MS,
      });
      const evidence = JSON.stringify({ heard, h });
      // The premise: the wait began — the click's last call, then the pause
      // — after the server was asked, and soon enough that a read and a
      // settle of the red page would have finished before the blue one.
      const waitBegan = (heard.clickReadAt as number) + PAUSE_MS;
      expect(h.askedAt, evidence).toBeLessThan(waitBegan);
      expect(h.answeredAt - waitBegan, evidence).toBeGreaterThan(
        SETTLE_ROOM_MS,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

// Measured 2026-10-13: the click check's read does not answer while a form
// submission is pending, and fails once the new page commits — so every
// navigating click to a slow page was reported `clickUnconfirmed`. The
// probe's listeners now report each event as it arrives, and a read the
// page went away from is judged on those.
describe("a click that navigates to a slow page", () => {
  it(
    "is judged on what the page reported before it went away",
    async () => {
      const { heard, degradations, unconfirmedClicks } = await runRedToBlue({
        hold: 1200,
        holdClickReads: true,
      });
      const evidence = JSON.stringify({
        heard,
        degradations,
        unconfirmedClicks,
      });
      // The premise: the read really was refused, so it was not what
      // judged the click.
      expect(heard.clickReadsRefused, evidence).toBe(1);
      expect(degradations, evidence).not.toContain("clickUnconfirmed");
      expect(unconfirmedClicks, evidence).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
