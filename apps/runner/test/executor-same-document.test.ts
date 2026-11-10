// apps/runner/test/executor-same-document.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
 * DEM-61 end to end, in a real browser: an address the app changes inside
 * one document (a search writing `?q=`, a row opening its detail with
 * `pushState`) is part of the step, and a real page load is not.
 */
const lines: string[] = [];
const log = (line: string) => void lines.push(line);
let server: Server;
let url: string;
let home: string;
/** Every path the page asked the server for: a load, not a pushState. */
let requested: string[] = [];
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
  const html = await readFile(
    new URL("./fixtures/same-document-app.html", import.meta.url),
    "utf8",
  );
  server = createServer((req, res) => {
    requested.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // Another document with a Reply button of its own: a target found
    // after a real load must still stop the run.
    const record = RECORDS.indexOf(req.url?.slice("/orders/".length) ?? "");
    res.end(
      req.url === "/other"
        ? '<!doctype html><title>Other</title><button id="reply">Reply</button>'
        : record !== -1
          ? // Two records on one route, each linking to the other.
            `<!doctype html><title>Order</title><button id="reply">Reply</button><a id="next" href="/orders/${RECORDS[1 - record]}">Next</a>`
          : html,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-same-document-"));
}, 30_000);
afterAll(async () => {
  await session.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  lines.length = 0;
  requested = [];
});

/** Two Mongo-style ids: each scrubs to `redacted` on disk (DEM-130). */
const RECORDS = ["507f1f77bcf86cd799439011", "507f191e810c19729de860ea"];

const run = (steps: unknown[], target = url) =>
  runScript(
    {
      scriptVersion: 6,
      name: "same document",
      target,
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
    },
    () => undefined,
  );

describe("an address the app changes inside one document", () => {
  it("is part of the step: search, open a row, reply", async () => {
    const report = await run([
      { do: "type", into: { stableId: "search" }, text: "grinder" },
      { do: "click", on: { stableId: "ticket" } },
      { do: "click", on: { stableId: "reply" } },
    ]);
    const said = JSON.stringify({ report, lines, requested });
    // Premise: the address changed and no other document was loaded. (A
    // recorded address carries its query's names, not its values.)
    const pages = (report.steps ?? []).map((s) => s.pageUrl);
    expect(
      pages.some((p) => p?.includes("?q=")),
      said,
    ).toBe(true);
    expect(
      pages.some((p) => p?.endsWith("/tickets/1036")),
      said,
    ).toBe(true);
    expect(
      requested.filter((r) => r !== "/favicon.ico"),
      said,
    ).toEqual(["/"]);
    expect(report.outcome, said).toBe("complete");
  }, 120_000);

  it("still stops on a real load, even where the next target is there too", async () => {
    const report = await run([
      { do: "click", on: { stableId: "away" } },
      { do: "click", on: { stableId: "reply" } },
    ]);
    const said = JSON.stringify({ report, lines, requested });
    // Premise: the second document was loaded, and the next step FOUND its
    // target there: the stop is the new-document rule, not a failed look.
    expect(requested, said).toContain("/other");
    const reply = report.steps?.at(-1);
    expect(reply?.pageUrl, said).toMatch(/\/other$/);
    expect(reply?.failureReason, said).toBeNull();
    expect(report.outcome, said).toBe("stopped");
    expect(report.stopped?.reason, said).toBe("pageWentElsewhere");
  }, 120_000);

  // DEM-143: a record id scrubs to `redacted` on disk, so the stored address
  // cannot tell two records apart; the run compares the raw path instead.
  it("stops on a load of another record on the same route", async () => {
    const report = await run(
      [
        { do: "click", on: { stableId: "reply" } },
        { do: "click", on: { stableId: "next" } },
        { do: "click", on: { stableId: "reply" } },
      ],
      `${url}orders/${RECORDS[0]}`,
    );
    const said = JSON.stringify({ report, lines, requested });
    // Premise: the second record was loaded, both read alike on disk, and
    // the last step FOUND its target: only the raw path can stop the run.
    expect(requested, said).toContain(`/orders/${RECORDS[1]}`);
    const pages = (report.steps ?? []).map((s) => s.pageUrl);
    expect(pages[1], said).toMatch(/\/orders\/redacted$/);
    const reply = report.steps?.at(-1);
    expect(reply?.pageUrl, said).toBe(pages[1]);
    expect(reply?.failureReason, said).toBeNull();
    expect(JSON.stringify(report), said).not.toContain(RECORDS[1]);
    expect(report.stopped?.reason, said).toBe("pageWentElsewhere");
  }, 120_000);
});
