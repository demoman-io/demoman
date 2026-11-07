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
    res.end(
      req.url === "/other"
        ? '<!doctype html><title>Other</title><button id="reply">Reply</button>'
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

const run = (steps: unknown[]) =>
  runScript(
    {
      scriptVersion: 6,
      name: "same document",
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
    // Premise: the second document was loaded.
    expect(requested, said).toContain("/other");
    expect(report.outcome, said).toBe("stopped");
    expect(report.stopped?.reason, said).toBe("pageWentElsewhere");
  }, 120_000);
});
