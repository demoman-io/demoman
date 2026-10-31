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
 * `waitFor` asks whether an element can be SEEN, not only whether it is
 * rendered.
 *
 * Found 2026-10-13 in the store-assets sample app: its "Invoice created"
 * toast sits in the DOM at `opacity: 0` until a submit fades it in, and a
 * `waitFor { until: "visible" }` on it passed on a run whose submit never
 * happened — `checkVisibility()` with no options counts a transparent
 * element as visible. This page has that toast, and a badge at
 * `visibility: hidden`, the other way an element is laid out and unseen.
 *
 * Timeouts: one headless launch; the first case waits out the walk's own
 * `WAIT_TIMEOUT_MS` (10 s) on purpose, the second takes about five seconds
 * (measured locally 2026-10-13). CI is ~5x slower at browser work
 * (`fff4505`); ceilings on a hang, not budgets.
 */
const HOOK_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;

const PAGE = `<!doctype html><meta charset=utf-8>
<style>
  body { margin: 0; font: 20px sans-serif; }
  #toast { position: fixed; right: 40px; bottom: 40px; padding: 16px; background: #222; color: #fff; opacity: 0; transition: opacity 150ms; }
  #toast.shown { opacity: 1; }
  #badge { visibility: hidden; }
</style>
<button id="save" style="margin: 100px; font-size: 24px">Save</button>
<span id="badge">Draft badge</span>
<button id="ghost" aria-label="Reveal toast" style="position: fixed; left: 400px; top: 100px; width: 120px; height: 40px; opacity: 0">x</button>
<div id="toast">Invoice created</div>
<p id="gone" style="display: none">Folded note</p>
<script>
  document.getElementById("ghost").addEventListener("click", () => {
    document.getElementById("toast").classList.add("shown");
  });
  document.getElementById("save").addEventListener("click", () => {
    document.getElementById("toast").classList.add("shown");
  });
</script>`;

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

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-wait-visible-"));
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await session.close();
  server?.close();
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});

const TOAST = { text: "Invoice created" };
const BADGE = { text: "Draft badge" };

/** The fixture's claim, asserted: both elements are laid out, and the plain
 *  question — the one the waits used to ask — calls both visible. */
async function plainCheckCallsBothVisible(): Promise<void> {
  const ok = await session.ensure();
  if (!ok.ok) throw new Error(JSON.stringify(ok));
  const probe = await ok.launched.context.newPage();
  try {
    await probe.goto(origin);
    const seen = await probe.evaluate(() =>
      ["toast", "badge"].map((id) => {
        const el = document.getElementById(id) as HTMLElement;
        const box = el.getBoundingClientRect();
        return {
          id,
          laidOut: box.width > 0 && box.height > 0,
          plain: el.checkVisibility(),
        };
      }),
    );
    expect(seen).toEqual([
      { id: "toast", laidOut: true, plain: true },
      { id: "badge", laidOut: true, plain: true },
    ]);
  } finally {
    await probe.close();
  }
}

describe("waitFor on an element that is laid out but cannot be seen", () => {
  it(
    "does not take a transparent toast for a visible one",
    async () => {
      await plainCheckCallsBothVisible();
      const report = await runScript(
        {
          scriptVersion: 1,
          name: "a toast nobody showed",
          target: origin,
          viewport: { width: 800, height: 600 },
          steps: [
            { do: "waitForLoad" },
            { do: "waitFor", on: TOAST, until: "visible" },
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
      const evidence = JSON.stringify({ report, lines });
      expect(report.outcome, evidence).toBe("stopped");
      expect(report.stopped?.reason, evidence).toBe("waitTimeout");
      expect(report.stopped?.at?.index, evidence).toBe(1);
      // What the wait's last look found, not the capture before it: the toast
      // is in the tree, so "never found" would blame the wrong thing.
      expect(report.steps.at(-1)?.waitSaw, evidence).toBe("notVisible");
      expect(report.stopped?.detail, evidence).toContain(
        "found but not visible",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "counts transparent and visibility-hidden elements as hidden, and the toast as visible once shown",
    async () => {
      await plainCheckCallsBothVisible();
      const report = await runScript(
        {
          scriptVersion: 1,
          name: "a toast somebody showed",
          target: origin,
          viewport: { width: 800, height: 600 },
          steps: [
            { do: "waitForLoad" },
            { do: "waitFor", on: TOAST, until: "hidden" },
            { do: "waitFor", on: BADGE, until: "hidden" },
            { do: "click", on: { text: "Save" } },
            { do: "waitFor", on: TOAST, until: "visible" },
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
      const evidence = JSON.stringify({ report, lines });
      expect(report.outcome, evidence).toBe("complete");
    },
    TEST_TIMEOUT_MS,
  );

  // A click target may be transparent on purpose (a file input laid over a
  // styled button): clicks keep the plain question, only waits ask "seen".
  it(
    "still clicks a transparent control, and the wait then sees what it showed",
    async () => {
      await plainCheckCallsBothVisible();
      const probe = await (
        (await session.ensure()) as {
          ok: true;
          launched: { context: BrowserContext };
        }
      ).launched.context.newPage();
      try {
        await probe.goto(origin);
        // The fixture's claim: the control really paints at opacity 0.
        expect(
          await probe.evaluate(
            () =>
              getComputedStyle(document.getElementById("ghost") as Element)
                .opacity,
          ),
        ).toBe("0");
      } finally {
        await probe.close();
      }
      const report = await runScript(
        {
          scriptVersion: 1,
          name: "a transparent control",
          target: origin,
          viewport: { width: 800, height: 600 },
          steps: [
            { do: "waitForLoad" },
            { do: "click", on: { role: "button", name: "Reveal toast" } },
            { do: "waitFor", on: TOAST, until: "visible" },
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
      expect(report.outcome, JSON.stringify({ report, lines })).toBe(
        "complete",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "calls a display:none element found-but-not-visible, not absent",
    async () => {
      const ok = await session.ensure();
      if (!ok.ok) throw new Error(JSON.stringify(ok));
      const probe = await ok.launched.context.newPage();
      try {
        await probe.goto(origin);
        // The fixture's claim: it is in the tree and has no box.
        expect(
          await probe.evaluate(() => {
            const el = document.getElementById("gone") as Element;
            return [el.isConnected, el.getClientRects().length];
          }),
        ).toEqual([true, 0]);
      } finally {
        await probe.close();
      }
      const report = await runScript(
        {
          scriptVersion: 1,
          name: "a folded note",
          target: origin,
          viewport: { width: 800, height: 600 },
          steps: [
            { do: "waitForLoad" },
            { do: "waitFor", on: { text: "Folded note" }, until: "visible" },
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
      const evidence = JSON.stringify({ report, lines });
      expect(report.stopped?.reason, evidence).toBe("waitTimeout");
      expect(report.steps.at(-1)?.waitSaw, evidence).toBe("notVisible");
    },
    TEST_TIMEOUT_MS,
  );
});
