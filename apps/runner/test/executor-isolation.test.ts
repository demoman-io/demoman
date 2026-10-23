// apps/runner/test/executor-isolation.test.ts
//
// Final review 2026-10-12, Critical 1 and Important 2: the executor drives
// one browser across calls, and the engine leaves state on whatever page a
// call used — `applyDevice`'s metrics, touch, mouse-as-touch and user agent,
// and the occlusion guard's heartbeat script and binding listener. On one
// reused page a desktop snapshot after a phone one saw the iPhone user agent
// and touch, a desktop run after it stopped `unresolvedAnchor` on the mobile
// site while its report said 1280x800 from "script", and N calls ran N
// heartbeat loops. Each call now gets a page of its own
// (`BrowserSession.stage`); these go red on a reused one.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
import { snapshotOp } from "../src/executor/snapshot.js";
import { installResolver } from "../src/page-agent.js";

const lines: string[] = [];
const log = (line: string) => void lines.push(line);
const session = createBrowserSession({
  headless: true,
  log,
  onLaunched: async ({ context }) => {
    await installResolver(context);
    await installExecutorEntry(context);
  },
});
const kits: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
  migrationPending: false,
};

/** A page that says, as button text, whether the REQUEST carried an iPhone
 *  user agent (what a server serves a phone) and what the page reads for
 *  `navigator.maxTouchPoints`. */
let server: Server;
let url: string;
let home: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const ua = (req.headers["user-agent"] ?? "").includes("iPhone")
      ? "iphone"
      : "desktop";
    res.end(
      `<!doctype html><html><body><button id="ua">ua-${ua}</button><button id="t">touch-pending</button><script>document.getElementById("t").textContent = "touch-" + navigator.maxTouchPoints;</script></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-isolation-"));
}, 30_000);
afterAll(async () => {
  await session.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});

async function snapshotTexts(device?: "phone"): Promise<string[]> {
  const out = await snapshotOp(
    { url, ...(device === undefined ? {} : { device }) },
    {
      session,
      home,
      log,
      loadSessions: async () => ({ ok: true, files: [] }),
      signinCommand: "npx demoman signin",
    },
  );
  if (!out.ok) throw new Error(JSON.stringify({ out, lines }));
  const value = out.value as { targets: Array<{ text: string | null }> };
  return value.targets.flatMap((t) => (t.text === null ? [] : [t.text]));
}

/**
 * How many heartbeat loops the stage's current document runs: every loop
 * the occlusion guard's init script started calls `__demomanHeartbeat` with
 * its frame's rAF timestamp, and every rAF callback in one frame receives
 * the same timestamp — so N loops are N calls per timestamp. Waits for four
 * frames that beat (a condition, not a duration) and answers the count each
 * one got.
 */
async function beatsPerFrame(): Promise<number[]> {
  const ok = await session.ensure();
  if (!ok.ok) throw new Error(JSON.stringify(ok));
  const pages = ok.launched.context.pages();
  // The premise: one page, the latest call's — the one asked below.
  expect(
    pages.map((p) => p.url()),
    "the context should hold only the latest call's page",
  ).toEqual([url]);
  return (pages[0] as (typeof pages)[number]).evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const g = globalThis as unknown as Record<
          string,
          ((s: string) => void) | undefined
        >;
        const beat = g.__demomanHeartbeat;
        if (typeof beat !== "function") {
          reject(new Error("no __demomanHeartbeat binding on this page"));
          return;
        }
        const byFrame = new Map<string, number>();
        g.__demomanHeartbeat = (s: string) => {
          byFrame.set(s, (byFrame.get(s) ?? 0) + 1);
          // The first frame may have been half over when this was set.
          if (byFrame.size >= 5) resolve([...byFrame.values()].slice(1));
          beat(s);
        };
      }),
  );
}

describe("each call starts from a clean page", () => {
  it("a phone snapshot leaves no phone behind for the desktop snapshot and run after it, and the run's page beats once", async () => {
    // The premise: the phone snapshot IS a phone — iPhone UA at the server,
    // touch in the page. Without it the desktop answers below prove nothing.
    expect(await snapshotTexts("phone")).toEqual(
      expect.arrayContaining(["ua-iphone", "touch-5"]),
    );

    const desktop = await snapshotTexts();
    expect(desktop, JSON.stringify(lines)).toEqual(
      expect.arrayContaining(["ua-desktop", "touch-0"]),
    );
    expect(desktop).not.toContain("ua-iphone");

    const report = await runScript(
      {
        scriptVersion: 1,
        name: "desktop after phone",
        target: url,
        viewport: { width: 1280, height: 800 },
        steps: [
          { do: "waitForLoad" },
          { do: "waitFor", on: { text: "touch-0" }, until: "visible" },
          { do: "click", on: { text: "ua-desktop" } },
        ],
      } as never,
      {
        session,
        library: createLibrary(home),
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
    expect(
      report.outcome,
      JSON.stringify({ stopped: report.stopped, lines }),
    ).toBe("complete");
    expect(report.size).toMatchObject({
      width: 1280,
      height: 800,
      from: "script",
    });

    // Three calls in, on the run's own document: one heartbeat loop. Asked
    // of the run's page because the walk enables `Runtime`, which is what
    // puts the binding on the page (a snapshot's page has none to count);
    // a reused page would carry all three calls' init scripts here.
    const beats = await beatsPerFrame();
    expect(beats.length, JSON.stringify(beats)).toBeGreaterThanOrEqual(4);
    expect(
      beats.every((n) => n === 1),
      JSON.stringify(beats),
    ).toBe(true);
  }, 240_000);
});
