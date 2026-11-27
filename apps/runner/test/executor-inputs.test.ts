// apps/runner/test/executor-inputs.test.ts
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
 * End to end: every page Demoman opens presents as macOS, so a
 * script's `Mod+K` and an app's "⌘K" agree on any machine, and what a script
 * pressed and clicked is in the take and in the page's own log.
 */
const lines: string[] = [];
const log = (line: string) => void lines.push(line);
const popupPlatforms: string[] = [];
/** Every URL each new page's main frame was seen at, for the failure
 *  message: Demoman's own pages (the mux's loopback page) are in here too. */
const pageUrls: string[][] = [];
let server: Server;
let url: string;
let home: string;
const session = createBrowserSession({
  headless: true,
  log,
  onLaunched: async ({ context }) => {
    // Only a page that reaches the fixture's origin is the app's: Demoman's
    // own pages start at about:blank and move to a loopback origin of their
    // own (the mux), and reading one mid-navigation destroys the read.
    context.on("page", (popup) => {
      const seen = [popup.url()];
      pageUrls.push(seen);
      popup.on("framenavigated", (frame) => {
        if (frame === popup.mainFrame()) seen.push(frame.url());
      });
      const fixture = new URL(url).origin;
      let reached = false;
      void popup
        .waitForURL((at) => at.origin === fixture, {
          waitUntil: "domcontentloaded",
        })
        .then(() => {
          reached = true;
          return popup.evaluate(
            () =>
              `${navigator.platform} ${location.search} ${navigator.userAgent}`,
          );
        })
        .then((platform) => popupPlatforms.push(platform))
        .catch((error: unknown) => {
          // A page that closed before reaching the fixture was not the app's.
          if (reached) popupPlatforms.push(`unread: ${error}`);
        });
    });
    await installResolver(context);
    await installExecutorEntry(context);
  },
});
const kits: BrandKitsRead = { state: "ready", kits: [], defaultId: null };

beforeAll(async () => {
  const html = await readFile(
    new URL("./fixtures/inputs-app.html", import.meta.url),
    "utf8",
  );
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-inputs-"));
}, 30_000); // a server and a temp dir, no browser: a few ms here; 5x is still ms.
afterAll(async () => {
  await session.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  lines.length = 0;
  popupPlatforms.length = 0;
  pageUrls.length = 0;
});

const run = (steps: Record<string, unknown>[]) =>
  runScript(
    {
      scriptVersion: 10,
      name: "inputs",
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

describe("a run's pages present as macOS", () => {
  it("a run presents as macOS", async () => {
    const report = await run([{ do: "pause", ms: 300 }]);
    const text = endText(report);
    const said = JSON.stringify({ report, lines });
    expect(report.outcome, said).toBe("complete");
    expect(text, `#platform: ${said}`).toContain("MacIntel | macOS");
    // The app picked Cmd from what it saw.
    expect(text, `#hint: ${text}`).toContain("⌘K");
    expect(text, text).not.toContain("Ctrl K");
  }, 120_000); // a launch and a short take: ~4 s here; 5x is 20 s.

  it("a popup presents as macOS too", async () => {
    const report = await run([
      { do: "click", on: { stableId: "popup" } },
      { do: "pause", ms: 1000 },
    ]);
    const said = JSON.stringify({ report, popupPlatforms, pageUrls, lines });
    expect(report.outcome, said).toBe("complete");
    // Premise: the click's popup (?popup) was opened and read. The engine may
    // open pages of its own in the context; every one reads MacIntel.
    expect(popupPlatforms, said).toContainEqual(
      expect.stringMatching(/^MacIntel \?popup /),
    );
    for (const seen of popupPlatforms) expect(seen, said).toMatch(/^MacIntel /);
  }, 120_000); // ~5 s here; 5x is 25 s.
});

describe("the take records what the script pressed and clicked", () => {
  it("is in the actions and in the page's own log", async () => {
    const report = await run([
      { do: "press", key: "Mod+K" },
      { do: "click", on: { stableId: "row2" }, clicks: 2 },
      { do: "click", on: { stableId: "row4" }, button: "right" },
      { do: "click", on: { stableId: "row3" }, holding: "Shift" },
      { do: "pause", ms: 300 },
    ]);
    const id = report.provenance.takeId;
    const said = JSON.stringify({ report, lines });
    expect(report.outcome, said).toBe("complete");
    if (id === null) throw new Error(said);
    const scene = await createLibrary(home).getScene(id);
    if (scene === null) throw new Error(`no take ${id}: ${said}`);
    const acts = JSON.stringify(scene.actions);
    expect(scene.actions, acts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "press",
          key: "K",
          modifiers: ["Mod"],
        }),
        expect.objectContaining({ kind: "click", clicks: 2 }),
        expect.objectContaining({ kind: "click", button: "right" }),
        expect.objectContaining({ kind: "click", modifiers: ["Shift"] }),
      ]),
    );
    const text = endText(report);
    // The page agrees, line by line.
    expect(text, text).toContain("keydown k meta");
    expect(text, text).toContain("dblclick button 0 detail 2");
    expect(text, text).toContain("contextmenu button 2 detail 0");
    expect(text, text).toContain("click button 0 detail 1 shift");
    expect(text, `palette: ${text}`).toContain("Command palette");
  }, 120_000); // ~6 s here; 5x is 30 s.
});
