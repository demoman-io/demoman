// apps/runner/test/executor-closed-shadow.slow.test.ts
//
// DEM-102 end to end: a run whose target is inside a closed shadow root
// stops, and its stop's detail names the known limitation; one whose target
// is simply missing, on the same page, does not. Slow by its time: each
// stop waits out the 10 s a step waits for its target.
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

const lines: string[] = [];
const log = (line: string) => void lines.push(line);
let server: Server;
let url: string;
let home: string;
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
const PAGE = `<!doctype html><html><body>
<button>Outside</button>
<div id="h"></div>
<script>document.getElementById("h").attachShadow({ mode: "closed" }).innerHTML = "<button>Inside</button>";</script>
</body></html>`;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-closed-shadow-"));
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}, 30_000);
afterAll(async () => {
  await session.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});

const run = (text: string) =>
  runScript(
    {
      scriptVersion: 6,
      name: "closed shadow",
      target: url,
      viewport: { width: 1280, height: 800 },
      steps: [
        { do: "waitForLoad" },
        { do: "click", on: { text: "Outside" } },
        { do: "click", on: { text } },
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
      sessionsContext: {} as BrowserContext,
    },
    () => undefined,
  );

// Red if playOnStage stops asking, asks only when the page is closed, or
// blames a closed root for a target it does not hold.
describe("a run whose target is in a closed shadow root", () => {
  it("names the limitation in the stop's detail", async () => {
    const report = await run("Inside");
    expect(report.stopped?.reason, JSON.stringify({ report, lines })).toBe(
      "unresolvedAnchor",
    );
    // Premise: the step before it, in the light DOM, was found and played.
    expect(report.stopped?.at?.scriptStep, JSON.stringify(report.stopped)).toBe(
      3,
    );
    expect(report.stopped?.detail, JSON.stringify(lines)).toContain(
      "this page has a closed shadow root",
    );
  }, 90_000);

  it("says nothing of it for a target the closed root does not hold", async () => {
    const report = await run("Nowhere");
    expect(report.stopped?.reason, JSON.stringify({ report, lines })).toBe(
      "unresolvedAnchor",
    );
    expect(report.stopped?.detail ?? "").not.toContain("closed shadow root");
  }, 90_000);
});
