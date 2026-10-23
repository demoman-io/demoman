// apps/runner/test/executor-snapshot.test.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXECUTOR_ENTRY_GLOBAL } from "../src/entry-globals.js";
import { createBrowserSession } from "../src/executor/browser.js";
import {
  installExecutorEntry,
  pageCapture,
  readScreen,
} from "../src/executor/page-ops.js";
import { snapshotOp } from "../src/executor/snapshot.js";
import { installResolver } from "../src/page-agent.js";
import { serveFixtureApp } from "./fixture.js";

const log = (_: string) => undefined;
let app: { url: string; close(): void };
let home: string;
const session = createBrowserSession({
  headless: true,
  log,
  onLaunched: async ({ context }) => {
    await installResolver(context);
    await installExecutorEntry(context);
  },
});

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-snap-"));
}, 30_000);
afterAll(async () => {
  await session.close();
  app.close();
  await rm(home, { recursive: true, force: true });
});

describe("snapshotOp", () => {
  it("lists the fixture's targets, including the Place order button", async () => {
    const out = await snapshotOp(
      { url: app.url },
      {
        session,
        home,
        log,
        loadSessions: async () => ({ ok: true, files: [] }),
        signinCommand: "npx demoman signin",
      },
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    const value = out.value as {
      landedElsewhere: boolean;
      targets: Array<{ target: Record<string, unknown>; text: string | null }>;
      kits: unknown;
      size: { width: number; height: number } | null;
    };
    // The fixture premise: the page has the button the cases below name.
    expect(
      value.targets.some((t) => t.text?.includes("Place order") === true),
    ).toBe(true);
    expect(value.landedElsewhere).toBe(false);
    expect(value.kits).toEqual({ ok: true, kits: [] });
    expect(value.size).not.toBeNull();
  }, 60_000);

  it("says pageDidNotLoad for an address nothing answers", async () => {
    const out = await snapshotOp(
      { url: "http://127.0.0.1:1/" },
      {
        session,
        home,
        log,
        loadSessions: async () => ({ ok: true, files: [] }),
        signinCommand: "npx demoman signin",
      },
    );
    expect(out).toMatchObject({ ok: false, reason: "pageDidNotLoad" });
  }, 60_000);

  it("refuses a non-http url as nonHttpTarget without opening anything", async () => {
    const out = await snapshotOp(
      { url: "file:///etc/hosts" },
      {
        session,
        home,
        log,
        loadSessions: async () => ({ ok: true, files: [] }),
        signinCommand: "npx demoman signin",
      },
    );
    expect(out).toMatchObject({ ok: false, reason: "nonHttpTarget" });
  });

  it("refuses an unknown device as invalidDevice", async () => {
    const out = await snapshotOp(
      { url: app.url, device: "toaster" },
      {
        session,
        home,
        log,
        loadSessions: async () => ({ ok: true, files: [] }),
        signinCommand: "npx demoman signin",
      },
    );
    expect(out).toMatchObject({ ok: false, reason: "invalidDevice" });
  });

  it("says the kits could not be read rather than listing none", async () => {
    await writeFile(join(home, "kits.json"), "{ broken");
    const out = await snapshotOp(
      { url: app.url },
      {
        session,
        home,
        log,
        loadSessions: async () => ({ ok: true, files: [] }),
        signinCommand: "npx demoman signin",
      },
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect((out.value as { kits: { ok: boolean } }).kits.ok).toBe(false);
    await rm(join(home, "kits.json"));
  }, 60_000);

  it("names a page with no Demoman entry when a capture is asked of it", async () => {
    const ok = await session.ensure();
    if (!ok.ok) throw new Error(JSON.stringify(ok));
    // A page in a second context: the init scripts are on the session's
    // context only, so this one has no entry. The premise is asserted, not
    // assumed.
    const other = await ok.launched.browser.newContext();
    const bare = await other.newPage();
    try {
      await bare.goto(app.url);
      expect(
        await bare.evaluate(
          (global) => typeof (globalThis as Record<string, unknown>)[global],
          EXECUTOR_ENTRY_GLOBAL,
        ),
      ).toBe("undefined");
      const said: string[] = [];
      const capture = await pageCapture(bare, (line) => {
        said.push(line);
      })({} as never);
      expect(capture.failureReason).toBe("pageFaulted");
      expect(said.join("\n")).toContain("the page has no Demoman entry");
    } finally {
      await other.close();
    }
  }, 60_000);

  it("says why the screen could not be read before answering undefined", async () => {
    const ok = await session.ensure();
    if (!ok.ok) throw new Error(JSON.stringify(ok));
    const gone = await ok.launched.context.newPage();
    await gone.close();
    const said: string[] = [];
    const screen = await readScreen(gone, (line) => {
      said.push(line);
    });
    expect(screen).toBeUndefined();
    expect(said.join("\n")).toContain("screen size could not be read");
  }, 60_000);
});
