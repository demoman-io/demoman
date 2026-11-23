// apps/runner/test/executor-dialog.test.ts
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
 * DEM-161 end to end, in a real browser: a click that opens `confirm()` is
 * answered once, by the engine (OK unless the step says otherwise), and the
 * run report lists it. The page says which answer it got: Playwright's own
 * auto-dismiss would make it `false` on a run that asked for OK.
 */
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
const kits: BrandKitsRead = { state: "ready", kits: [], defaultId: null };

beforeAll(async () => {
  const html = await readFile(
    new URL("./fixtures/confirm-dialog-app.html", import.meta.url),
    "utf8",
  );
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-dialog-"));
}, 30_000); // a server and a temp dir, no browser: a few ms here; 5x is still ms.
afterAll(async () => {
  await session.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  lines.length = 0;
});

const run = (deleteStep: Record<string, unknown>) =>
  runScript(
    {
      scriptVersion: 9,
      name: "confirm dialog",
      target: url,
      viewport: { width: 1280, height: 800 },
      steps: [{ do: "waitForLoad" }, deleteStep],
    } as never,
    {
      session,
      library: createLibrary(home),
      kits,
      log,
      sessions: [],
      sessionStore: createSessionStore(home),
      signinCommand: "npx demoman signin",
      recordingFrameRate: { value: 30, from: "default" } as const,
      loadSessions: async () => ({ ok: true as const, files: [] }),
      sessionsContext: {} as BrowserContext,
    },
    () => undefined,
  );

const endText = (report: Awaited<ReturnType<typeof run>>): string =>
  report.endPage !== undefined && "text" in report.endPage
    ? report.endPage.text
    : "";

describe("a click that opens confirm()", () => {
  it("is answered OK once, by default, and the report lists it", async () => {
    const report = await run({ do: "click", on: { stableId: "delete" } });
    const said = JSON.stringify({ dialogs: report.dialogs, lines, report });
    expect(report.outcome, said).toBe("complete");
    expect(report.dialogs, said).toEqual([
      {
        step: 2,
        kind: "confirm",
        message: "Delete Northwind?",
        answer: "accept",
        by: "default",
        drawn: true,
      },
    ]);
    // The one-answer check: Playwright's dismiss would read `false`.
    expect(endText(report), said).toContain("confirm() answered true");
  }, 120_000); // 3.9 s here (first run, launches the browser); 5x is 19 s.

  it("is answered Cancel when the step says so", async () => {
    const report = await run({
      do: "click",
      on: { stableId: "delete" },
      dialog: "dismiss",
    });
    const said = JSON.stringify({ dialogs: report.dialogs, lines, report });
    expect(report.outcome, said).toBe("complete");
    expect(report.dialogs?.[0], said).toMatchObject({
      step: 2,
      answer: "dismiss",
      by: "script",
      drawn: true,
    });
    expect(endText(report), said).toContain("confirm() answered false");
  }, 120_000); // 3.6 s here; 5x is 18 s.
});

describe("an alert the page opens after its last click", () => {
  it("is answered, and the run completes and lists it", async () => {
    // `#save` alerts 300 ms after its click: late, near the walk's end.
    const report = await run({ do: "click", on: { stableId: "save" } });
    const said = JSON.stringify({ dialogs: report.dialogs, lines, report });
    expect(report.outcome, said).toBe("complete");
    expect(report.dialogs, said).toEqual([
      expect.objectContaining({ kind: "alert", message: "Saved" }),
    ]);
  }, 120_000); // 3.4 s here; 5x is 17 s.
});
