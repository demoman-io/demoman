// apps/runner/test/pinned-clock.slow.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrandKitsRead } from "@demoman/run-core";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBrowserSession } from "../src/executor/browser.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import { runScript } from "../src/executor/run.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { installResolver } from "../src/page-agent.js";

/**
 * DEM-79 in a real browser: a run given `pinnedNow` starts the page's clock
 * at that instant and lets it run, across a navigation, without stopping a
 * debounce that measures time with Date.now(). The page reports what its
 * clock reads to the server, so the test reads the page's own answers.
 */
const PINNED = "2026-11-06T09:00:00Z";
const lines: string[] = [];
const log = (line: string) => void lines.push(line);
let server: Server;
let url: string;
let home: string;
/** What the pages reported, by label, as epoch milliseconds. */
let reported: { label: string; t: number }[] = [];

// A debounce that measures elapsed time with Date.now(), as lodash's does:
// under a frozen clock the gap is always 0 and it never fires.
const PAGE = `<!doctype html><title>Clock</title>
<input id="search" aria-label="Search" />
<a id="next" href="/second">Next</a>
<script>
const report = (label, t) => fetch("/report?label=" + label + "&t=" + t);
report("first", Date.now());
report("constructed", new Date().getTime());
setTimeout(() => report("later", Date.now()), 300);
// A subclass of Date, as date-fns v4's TZDate is: its own methods must survive.
class Zoned extends Date { zone() { return "UTC"; } }
try { const z = new Zoned(); report("subclass", z.zone() === "UTC" ? z.getTime() : -1); }
catch { report("subclass", -2); }
let last = 0, timer = null;
const settle = () => {
  if (Date.now() - last >= 200) report("fired", Date.now());
  else timer = setTimeout(settle, 200 - (Date.now() - last));
};
document.getElementById("search").addEventListener("input", () => {
  last = Date.now();
  clearTimeout(timer);
  timer = setTimeout(settle, 200);
});
</script>`;
const SECOND = `<!doctype html><title>Second</title><p id="done">Due Dec 4, 2026</p>
<script>fetch("/report?label=second&t=" + Date.now());</script>`;

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

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/report") {
      reported.push({
        label: u.searchParams.get("label") ?? "",
        t: Number(u.searchParams.get("t")),
      });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(u.pathname === "/second" ? SECOND : PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-pinned-clock-"));
}, 30_000);
afterAll(async () => {
  await session.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  lines.length = 0;
  reported = [];
});

const run = (steps: unknown[], pinnedNow?: string, readDates = false) =>
  runScript(
    {
      scriptVersion: 6,
      name: "pinned clock",
      target: url,
      viewport: { width: 1280, height: 800 },
      steps: [{ do: "waitForLoad" }, ...steps],
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
      sessionsContext: {} as BrowserContext,
      ...(pinnedNow === undefined ? {} : { pinnedNow }),
      ...(readDates ? { readDates } : {}),
    },
    () => undefined,
  );
const at = (label: string) => reported.find((r) => r.label === label)?.t;
const pin = Date.parse(PINNED);

describe("a run with pinnedNow", () => {
  it("starts the page's Date at pinnedNow and lets it run, and completes", async () => {
    const report = await run([{ do: "pause", ms: 800 }], PINNED);
    const said = JSON.stringify({ outcome: report.outcome, reported, lines });
    const first = at("first");
    const later = at("later");
    // Premise: the page reported both readings.
    expect(first, said).toBeTypeOf("number");
    expect(later, said).toBeTypeOf("number");
    expect((first as number) - pin, said).toBeGreaterThanOrEqual(0);
    expect((first as number) - pin, said).toBeLessThan(30_000);
    expect(
      Math.abs((at("constructed") as number) - (first as number)),
      said,
    ).toBeLessThan(1000);
    const ran = (later as number) - (first as number);
    expect(ran, said).toBeGreaterThanOrEqual(250);
    expect(ran, said).toBeLessThan(2000);
    // Demoman's own settle and scroll waits finished under the pin.
    expect(report.outcome, said).toBe("complete");
  }, 120_000);

  // Final review, Important 1: a subclass of Date lost its prototype.
  it("keeps a subclass of Date working", async () => {
    const report = await run([{ do: "pause", ms: 300 }], PINNED);
    const said = JSON.stringify({ outcome: report.outcome, reported, lines });
    const sub = at("subclass");
    expect(sub, said).toBeTypeOf("number");
    expect(sub as number, said).toBeGreaterThanOrEqual(pin);
    expect((sub as number) - pin, said).toBeLessThan(30_000);
  }, 120_000);

  // Final review, Important 3: the run records the pin it installed, which
  // refresh's receipt is written from.
  it("records pinnedNow in its report", async () => {
    const report = await run([{ do: "pause", ms: 300 }], PINNED);
    expect(report.pinnedNow).toBe(PINNED);
  }, 120_000);

  it("keeps the flow's clock across a navigation", async () => {
    const report = await run(
      [{ do: "click", on: { stableId: "next" } }],
      PINNED,
    );
    const said = JSON.stringify({ outcome: report.outcome, reported, lines });
    const first = at("first");
    const second = at("second");
    expect(second, said).toBeTypeOf("number");
    // Continues the first page's clock: never back at the instant itself.
    expect(second as number, said).toBeGreaterThanOrEqual(first as number);
    expect((second as number) - pin, said).toBeLessThan(30_000);
  }, 120_000);

  it("a Date.now debounce still fires", async () => {
    const report = await run(
      [
        { do: "type", into: { stableId: "search" }, text: "invoice" },
        { do: "pause", ms: 800 },
      ],
      PINNED,
    );
    const said = JSON.stringify({ outcome: report.outcome, reported, lines });
    expect(at("fired"), said).toBeTypeOf("number");
    expect((at("fired") as number) - pin, said).toBeLessThan(60_000);
  }, 120_000);
});

// Red when refresh has no evidence of dates on screen, or evidence where
// there were none (DEM-79).
describe("the dates a run's last screen shows", () => {
  it("are in the report when the last page shows one", async () => {
    const report = await run(
      [{ do: "click", on: { stableId: "next" } }],
      undefined,
      true,
    );
    const said = JSON.stringify({ outcome: report.outcome, lines });
    // Premise: the run ended on the page that shows the date.
    expect(report.outcome, said).toBe("complete");
    expect(report.datesOnScreen, said).toEqual(["Dec 4, 2026"]);
  }, 120_000);

  // Code review #2: every run and probe paid for a read only refresh uses.
  it("are not read unless the run is asked to", async () => {
    const report = await run([{ do: "click", on: { stableId: "next" } }]);
    const said = JSON.stringify({ outcome: report.outcome, lines });
    // Premise: the run ended on the page that shows the date.
    expect(report.outcome, said).toBe("complete");
    expect("datesOnScreen" in report, said).toBe(false);
  }, 120_000);

  // Code review #2: a run that stopped must not wait on the page again.
  it("are not read after a run that stopped", async () => {
    const report = await run(
      [
        { do: "click", on: { stableId: "next" } },
        { do: "click", on: { stableId: "missing" } },
      ],
      undefined,
      true,
    );
    const said = JSON.stringify({ outcome: report.outcome, lines });
    expect(report.outcome, said).not.toBe("complete");
    expect("datesOnScreen" in report, said).toBe(false);
  }, 120_000);

  it("are absent when it shows none", async () => {
    const report = await run([{ do: "pause", ms: 300 }], undefined, true);
    expect(report.outcome).toBe("complete");
    expect("datesOnScreen" in report).toBe(false);
  }, 120_000);
});

describe("a run without pinnedNow", () => {
  it("reads the machine's clock", async () => {
    const before = Date.now();
    const report = await run([{ do: "pause", ms: 300 }]);
    const said = JSON.stringify({ outcome: report.outcome, reported, lines });
    expect(at("first"), said).toBeTypeOf("number");
    expect(at("first") as number, said).toBeGreaterThanOrEqual(before - 2000);
    expect(at("first") as number, said).toBeLessThanOrEqual(Date.now());
    expect("pinnedNow" in report, said).toBe(false);
  }, 120_000);
});
