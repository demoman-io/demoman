import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { REPLAY_TARGETS } from "@demoman/replay-engine";
import type { SceneAnchor } from "@demoman/scene-schema";
import type { Frame, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Launched, launch } from "../src/launch.js";
import { createHeadlessPageAgent, installResolver } from "../src/page-agent.js";

/**
 * Timeouts.
 *
 * The whole file costs one Chromium launch plus one esbuild bundle, both in
 * `beforeAll`; each test is one navigation and a handful of `evaluate` round
 * trips against an already-running browser. Measured on this machine
 * (Apple silicon, 2026-09-08), over six runs of this file:
 *
 *   beforeAll (two http servers + bundle + launch)   ~0.65 s
 *   each test                                        73-213 ms
 *
 * CI is about 5x slower than this machine at browser work (`fff4505`), which
 * puts the slowest test near 1.1 s and the hook near 3.3 s there. Both bounds
 * below are ~90x the measured local number, so they are a ceiling on a hang
 * rather than a budget — and they are tighter than `vitest.config.ts`'s
 * lane-wide 60 s/120 s, which is the point of setting them: a hung frame
 * evaluate should be reported in seconds, not in a minute. Nothing in this
 * file waits for a duration; every wait is on a condition.
 */
const HOOK_TIMEOUT_MS = 60_000; // ~0.65 s measured, ~90x
const TEST_TIMEOUT_MS = 20_000; // 213 ms measured worst, ~90x

const FIXTURE = new URL("./fixtures/frames-app.html", import.meta.url);

/** The cross-origin child, served by the SECOND http server. */
const CHILD_HTML = `<!doctype html><meta charset=utf-8><title>child</title>
<body style="margin:0;font:14px system-ui">
<button type="button" id="cross-btn" style="display:block;width:100%;height:48px">Cross</button>
<button type="button" style="display:block;width:100%;height:48px">Plain cross</button>
</body>`;

/**
 * An anchor with exactly one usable signal.
 *
 * `stableId` anchors resolve without the leading hop being stripped — the id
 * is found anywhere in the frame's document — so they can only witness WHICH
 * REALM the element parked in. `treePath`-only anchors are the other half:
 * the path is walked from the document root, so a path that still leads with
 * `#frame(...)` matches nothing. Every frame case asserts both.
 */
function anchorOf(
  id: string,
  signal: { stableId?: string; treePath?: string },
): SceneAnchor {
  return {
    id,
    fingerprint: {
      stableId: signal.stableId ?? null,
      role: null,
      accessibleName: null,
      textContent: null,
      treePath: signal.treePath ?? null,
      boundingRect: null,
      imagePatchRef: null,
      dataKey: null,
    },
    resolution: {
      url: "http://127.0.0.1/",
      actionIndex: 0,
      entryState: true,
      strategy: "stableId",
      failureReason: null,
      candidates: 1,
    },
  };
}

let launched: Launched;
let page: Page;
let servers: Server[] = [];
let topUrl = "";
let crossOrigin = "";

async function listen(html: (path: string) => string | null): Promise<string> {
  const server = createServer((req, res) => {
    const body = html(req.url ?? "/");
    if (body === null) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  // A second http origin, which is the only way to get a genuinely
  // cross-origin frame: a different port on 127.0.0.1 is a different origin
  // to Chromium, so `contentDocument` throws exactly as it would for a
  // third-party embed.
  crossOrigin = await listen((path) =>
    path.startsWith("/child.html") ? CHILD_HTML : null,
  );
  const fixture = (await readFile(FIXTURE, "utf8")).replace(
    /__CROSS_ORIGIN__/g,
    crossOrigin,
  );
  // The fixture's placeholder really was substituted: without this, a
  // renamed placeholder would leave the cross-origin iframe pointed at a
  // relative path on the SAME origin, and the cross-origin test would pass
  // while proving nothing about crossing an origin.
  expect(fixture).not.toContain("__CROSS_ORIGIN__");
  expect(fixture).toContain(`${crossOrigin}/child.html`);
  topUrl = await listen(() => fixture);

  launched = await launch();
  page = launched.page;
  // Before the first navigation, so every frame gets it at document start.
  await installResolver(page);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await launched?.close();
  for (const server of servers) server.close();
  servers = [];
});

/** The frame an iframe in `parent` holds, waited for by condition. */
async function childFrame(parent: Frame, selector: string): Promise<Frame> {
  const handle = await parent.waitForSelector(selector);
  try {
    const frame = await handle.contentFrame();
    if (frame === null) {
      throw new Error(
        `"${selector}" in ${parent.url()} has no content frame — the fixture ` +
          "changed, or the frame never attached",
      );
    }
    return frame;
  } finally {
    await handle.dispose();
  }
}

interface Realms {
  top: Frame;
  same: Frame;
  cross: Frame;
  mid: Frame;
  deep: Frame;
}

/**
 * Navigates to the fixture and hands back every realm by name.
 *
 * Waits on conditions only — `load` (which waits for subframes) and then a
 * selector inside the deepest frame. A fixed sleep here is what lost CI
 * three races in one day (`11d3e7a`).
 */
async function openFixture(): Promise<Realms> {
  await page.goto(topUrl, { waitUntil: "load" });
  const top = page.mainFrame();
  const same = await childFrame(top, "#same");
  const cross = await childFrame(top, "#cross");
  const mid = await childFrame(top, "#mid");
  const deep = await childFrame(mid, "#deep");
  await Promise.all([
    same.waitForSelector("#inner-btn"),
    cross.waitForSelector("#cross-btn"),
    deep.waitForSelector("#deep-btn"),
  ]);
  return { cross, deep, mid, same, top };
}

/**
 * What each realm is holding for the engine, and WHICH ELEMENT.
 *
 * The engine evaluates `globalThis[REPLAY_TARGETS][anchorId]` in the frame
 * an anchor's hop names, so "which realm" is the mechanism — but a key alone
 * would go green for an element parked from the wrong document, so each
 * value is the parked element's own id (or its text, for the unlabelled
 * ones) read out of that realm.
 */
async function parkedPerRealm(
  realms: Realms,
): Promise<Record<keyof Realms, Record<string, string>>> {
  const read = (frame: Frame): Promise<Record<string, string>> =>
    frame.evaluate((name) => {
      const parked = (globalThis as unknown as Record<string, unknown>)[name] as
        | Record<string, Element>
        | undefined;
      const out: Record<string, string> = {};
      for (const [id, el] of Object.entries(parked ?? {})) {
        out[id] = el.id === "" ? (el.textContent ?? "").trim() : el.id;
      }
      return out;
    }, REPLAY_TARGETS);
  const [top, same, cross, mid, deep] = await Promise.all([
    read(realms.top),
    read(realms.same),
    read(realms.cross),
    read(realms.mid),
    read(realms.deep),
  ]);
  return { cross, deep, mid, same, top };
}

describe("the headless PageAgent", () => {
  it(
    "resolves an anchor in the top document, and parks it there",
    async () => {
      const realms = await openFixture();
      const agent = createHeadlessPageAgent(page, () => undefined);

      const reports = await agent.resolve([
        anchorOf("top", { stableId: "top-btn" }),
        anchorOf("top-plain", { treePath: "body:1/button:2" }),
      ]);

      expect(reports).toEqual([
        {
          anchorId: "top",
          strategy: "stableId",
          resolved: true,
          failureReason: null,
        },
        {
          anchorId: "top-plain",
          strategy: "treePath",
          resolved: true,
          failureReason: null,
        },
      ]);
      expect(await parkedPerRealm(realms)).toEqual({
        top: { top: "top-btn", "top-plain": "Plain top" },
        same: {},
        cross: {},
        mid: {},
        deep: {},
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "parks a same-origin frame's element in that FRAME, not in the caller's realm",
    async () => {
      // The case the spike was commissioned to answer. `replayResolve` is
      // answered by the top frame, and for a same-origin child the resolver
      // walks `contentDocument` itself rather than going through a broker —
      // "same-origin frames need no broker" is true of RESOLUTION and false
      // of PARKING. Two things have to hold, and the two anchors below see
      // one each:
      //
      //   `same-id`    parks in the child's realm, not the top window. (The
      //                realm half was fixed in `resolveForReplay` on
      //                2026-09-07; this pins it against regression.)
      //   `same-plain` resolves at all, which needs the leading hop STRIPPED
      //                before the child's document is walked. Delete the
      //                same-origin routing and this one goes broken — see
      //                the task report's revert experiment.
      const realms = await openFixture();
      const agent = createHeadlessPageAgent(page, () => undefined);
      const hop = "#frame(origin=,name=,ordinal=1)";

      const reports = await agent.resolve([
        anchorOf("same-id", {
          stableId: "inner-btn",
          treePath: `${hop}/body:1/button:1`,
        }),
        anchorOf("same-plain", { treePath: `${hop}/body:1/button:2` }),
      ]);

      expect(reports).toEqual([
        {
          anchorId: "same-id",
          strategy: "stableId",
          resolved: true,
          failureReason: null,
        },
        {
          anchorId: "same-plain",
          strategy: "treePath",
          resolved: true,
          failureReason: null,
        },
      ]);
      expect(await parkedPerRealm(realms)).toEqual({
        top: {},
        same: { "same-id": "inner-btn", "same-plain": "Plain inner" },
        cross: {},
        mid: {},
        deep: {},
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "parks a cross-origin frame's element in that frame",
    async () => {
      const realms = await openFixture();
      const agent = createHeadlessPageAgent(page, () => undefined);
      const hop = `#frame(origin=${crossOrigin},name=,ordinal=2)`;

      const reports = await agent.resolve([
        anchorOf("cross-id", {
          stableId: "cross-btn",
          treePath: `${hop}/body:1/button:1`,
        }),
        anchorOf("cross-plain", { treePath: `${hop}/body:1/button:2` }),
      ]);

      expect(reports).toEqual([
        {
          anchorId: "cross-id",
          strategy: "stableId",
          resolved: true,
          failureReason: null,
        },
        {
          anchorId: "cross-plain",
          strategy: "treePath",
          resolved: true,
          failureReason: null,
        },
      ]);
      expect(await parkedPerRealm(realms)).toEqual({
        top: {},
        same: {},
        cross: { "cross-id": "cross-btn", "cross-plain": "Plain cross" },
        mid: {},
        deep: {},
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "walks a two-hop chain to a frame inside a frame",
    async () => {
      // The spike was one hop deep and said so; this is the part it did not
      // prove. Both hops are stripped, one per boundary crossed, so the path
      // the deepest document walks is local to it.
      const realms = await openFixture();
      const agent = createHeadlessPageAgent(page, () => undefined);
      const hops =
        "#frame(origin=,name=,ordinal=3)/#frame(origin=,name=,ordinal=1)";

      const reports = await agent.resolve([
        anchorOf("deep-id", {
          stableId: "deep-btn",
          treePath: `${hops}/body:1/button:1`,
        }),
        anchorOf("deep-plain", { treePath: `${hops}/body:1/button:2` }),
      ]);

      expect(reports).toEqual([
        {
          anchorId: "deep-id",
          strategy: "stableId",
          resolved: true,
          failureReason: null,
        },
        {
          anchorId: "deep-plain",
          strategy: "treePath",
          resolved: true,
          failureReason: null,
        },
      ]);
      expect(await parkedPerRealm(realms)).toEqual({
        top: {},
        same: {},
        cross: {},
        mid: {},
        deep: { "deep-id": "deep-btn", "deep-plain": "Plain deep" },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports frameGone — not a resolved anchor — when the hop names a frame that is not there",
    async () => {
      // Report before you forgive. The anchor's `stableId` names an element
      // that really is in the TOP document, so a routing step that gave up
      // and resolved against the top would report a clean `stableId`
      // resolution and park a stranger's element — the engine would then
      // click it. The only correct answer is that the frame the hop names is
      // gone, and nothing parked anywhere.
      const realms = await openFixture();
      const agent = createHeadlessPageAgent(page, () => undefined);

      const reports = await agent.resolve([
        anchorOf("ghost", {
          stableId: "top-btn",
          treePath: "#frame(origin=,name=,ordinal=9)/body:1/button:1",
        }),
      ]);

      expect(reports).toEqual([
        {
          anchorId: "ghost",
          strategy: "broken",
          resolved: false,
          failureReason: "frameGone",
        },
      ]);
      expect(await parkedPerRealm(realms)).toEqual({
        top: {},
        same: {},
        cross: {},
        mid: {},
        deep: {},
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "says why when a malformed tree path sends a framed anchor to the top document",
    async () => {
      // `leadingHop` swallows a `parseTreePath` throw and treats the anchor
      // as unframed — deliberately, to stay in step with the resolver's own
      // `frameHopOf`, which swallows the same throw the same way. That makes
      // this the one path where a framed anchor is resolved against the top
      // document, and it can come back looking like a clean resolution. The
      // control flow is forgiven; the reason is not, so the swallow speaks.
      //
      // The spies are node-side ones and really do see the calls: this is
      // console in the runner's own process, not console inside the page —
      // the surface where `vi.spyOn(console, …)` silently no-ops.
      //
      // Task 12 fix round 1: this line moved from `console.info` (stdout)
      // to `console.error` (stderr) — `cli.ts` treats stdout as the
      // runner's own enumerable result channel, and this diagnostic is not
      // one of its lines. `log` is spied on too, so a regression back onto
      // stdout (`console.info`/`console.log` are the same function) fails
      // this test rather than passing quietly on the wrong stream.
      //
      // Runner audit 2026-09-14, finding 1: the line moved again, off the
      // console entirely and onto the injected reporter — `runPipeline`
      // wires that to the result's `notes`, so the reason reaches an
      // in-process consumer of `main(argv, io, run)` and prints AFTER the
      // sentence it belongs under. Both console spies stay, now asserting
      // that nothing bypasses the port.
      await openFixture();
      const reported: string[] = [];
      const agent = createHeadlessPageAgent(page, (line) =>
        reported.push(line),
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const [wellFormed] = await agent.resolve([
          anchorOf("well-formed", {
            stableId: "top-btn",
            treePath: "body:1/button:1",
          }),
        ]);
        expect(wellFormed?.resolved).toBe(true);
        // Nothing to explain: a path that parses says nothing at all, so the
        // line below cannot be a fallback that fires either way.
        expect(reported).toEqual([]);

        const [bent] = await agent.resolve([
          anchorOf("bent", {
            stableId: "top-btn",
            // A `#frame(` step with no closing paren: `splitSegments` throws.
            treePath: "#frame(origin=,name=,ordinal=1",
          }),
        ]);
        // The limit itself, asserted rather than described. `top-btn` is in
        // the TOP document, so this anchor — which claims to sit behind a
        // frame — comes back indistinguishable from a healthy resolution.
        // That is exactly why the console line has to exist.
        expect(bent).toEqual({
          anchorId: "bent",
          strategy: "stableId",
          resolved: true,
          failureReason: null,
        });
        expect(reported).toHaveLength(1);
        const message = reported[0] ?? "";
        expect(message).toContain('anchor "bent"');

        // Review of the runner audit, finding 7: the engine re-resolves an
        // anchor once per poll inside `awaitCondition` (150ms, up to 10s),
        // and every later action naming it resolves it again — so one
        // malformed path appended the same line dozens of times to
        // `notes`. Once per anchor id, the way the engine's own forgiven
        // failures are once per span.
        await agent.resolve([
          anchorOf("bent", {
            stableId: "top-btn",
            treePath: "#frame(origin=,name=,ordinal=1",
          }),
        ]);
        expect(reported).toHaveLength(1);
        expect(message).toContain("#frame(origin=,name=,ordinal=1");
        expect(message).toContain("top document");
        // Neither stream: the reporter is the channel, and a line that also
        // (or instead) reached the console would be one the pipeline's
        // ordering cannot govern and an in-process caller cannot see.
        expect(error).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
        log.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * A `Page` whose only frame rejects every `evaluate` with `message`.
   *
   * A fake, not a real browser: the thing under test is how ONE rejection
   * is classified, and provoking "Execution context was destroyed" for real
   * means racing a navigation against an in-flight evaluate — a test that
   * would pass for the wrong reason on the day it lost the race. The
   * message is Playwright's own, copied verbatim from a real one.
   */
  function pageWhoseFrameRejects(message: string): Page {
    const frame = {
      evaluate: () => Promise.reject(new Error(message)),
    } as unknown as Frame;
    return { mainFrame: () => frame } as unknown as Page;
  }

  const DESTROYED =
    "Execution context was destroyed, most likely because of a navigation.";

  it("reports notReachable — not an exit-70 internal error — when the frame navigates mid-resolve", async () => {
    // Task 8's deferred minor, triaged into the whole-branch review's
    // finding 2. An unhandled rejection here took the whole
    // `PageAgent.resolve` down, out of `runReplay`, and into cli.ts's
    // "internal error — this is a bug in the runner" bucket, exit 70. A page
    // that navigated under a resolve is not a bug in the runner; it is an
    // anchor that was not reachable when it was asked, which is what
    // `notReachable` already means to replay (re-run, not re-record).
    const reported: string[] = [];
    const agent = createHeadlessPageAgent(
      pageWhoseFrameRejects(DESTROYED),
      (line) => reported.push(line),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reports = await agent.resolve([
        anchorOf("a", { stableId: "top-btn", treePath: "body:1/button:1" }),
        anchorOf("b", { stableId: "top-btn", treePath: "body:1/button:2" }),
      ]);
      expect(reports).toEqual([
        {
          anchorId: "a",
          strategy: "broken",
          resolved: false,
          failureReason: "notReachable",
        },
        {
          anchorId: "b",
          strategy: "broken",
          resolved: false,
          failureReason: "notReachable",
        },
      ]);
      // Forgiving the control flow does not forgive the reason: Chromium's
      // own message survives, through the reporter, so a run that lost its
      // anchors this way does not read like one whose anchors were simply
      // missing — and it does not bypass the port onto the console.
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("Execution context was destroyed");
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("still throws for a rejection that is NOT a navigation race", async () => {
    // The other half, and the reason the classifier is a narrow regex
    // rather than a bare `catch`. This file's own in-page guard — "<global>
    // is not installed in this frame" — is a real fault: `installResolver`
    // ran too late, every anchor in the run is about to be unresolvable,
    // and reporting each one as a merely-unreachable anchor would bury the
    // one message that says what to fix.
    const agent = createHeadlessPageAgent(
      pageWhoseFrameRejects(
        "__demomanReplayEntry is not installed in this frame (http://x/) — " +
          "installResolver must run before the first navigation",
      ),
      () => undefined,
    );
    await expect(
      agent.resolve([
        anchorOf("a", { stableId: "top-btn", treePath: "body:1/button:1" }),
      ]),
    ).rejects.toThrow(/is not installed in this frame/);
  });
});
