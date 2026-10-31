// apps/runner/test/probe.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrandKitsRead, checkScript } from "@demoman/run-core";
import type { BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBrowserSession } from "../src/executor/browser.js";
import { readLandingFacts } from "../src/executor/landing.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import {
  discardingFilm,
  type ProbeDeps,
  type ProbeReply,
  probeEntry,
  probeOp,
} from "../src/executor/probe.js";
import { runScript } from "../src/executor/run.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { snapshotOp } from "../src/executor/snapshot.js";
import { installResolver } from "../src/page-agent.js";

/**
 * `probeOp` against a page whose menu exists only once a button is clicked
 * (a portal, mounted on open): the probe plays the steps through the run's
 * own walk and lists the page they end on.
 */
const lines: string[] = [];
const log = (line: string) => void lines.push(line);
let server: Server;
let url: string;
let home: string;
let sessionsContext: BrowserContext;
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
    new URL("./fixtures/portal-app.html", import.meta.url),
    "utf8",
  );
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      req.url === "/security"
        ? '<!doctype html><title>Security</title><input type="password" aria-label="New password"><button>Change password</button>'
        : html,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-probe-"));
  const first = await session.stage();
  if (!first.ok) throw new Error(JSON.stringify(first));
  sessionsContext = first.stage.context;
}, 60_000);
afterAll(async () => {
  await session.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  lines.length = 0;
});

const script = (steps: unknown[]) => ({
  scriptVersion: 6,
  name: "p",
  target: url,
  viewport: { width: 1280, height: 800 },
  steps: [{ do: "waitForLoad" }, ...steps],
});
const deps = (over: Partial<ProbeDeps> = {}): ProbeDeps => ({
  session,
  log,
  sessions: [],
  sessionsContext,
  loadSessions: async () => ({ ok: true as const, files: [] }),
  signinCommand: "npx demoman signin",
  home,
  kits,
  ...over,
});
/** The script past the run door's checks, or a throw saying why not. */
const enter = (raw: unknown) => {
  const entry = probeEntry(raw, [], kits);
  if (!entry.ok) throw new Error(JSON.stringify(entry));
  return entry;
};
/** The probe's ok value, or a throw carrying what it answered instead. */
const probe = async (raw: unknown, over: Partial<ProbeDeps> = {}) => {
  const out = await probeOp(enter(raw), null, deps(over));
  if (!out.ok) throw new Error(JSON.stringify({ out, lines }));
  return out.value as ProbeReply;
};
const run = (raw: unknown, lib = createLibrary(home)) =>
  runScript(
    raw as never,
    {
      session,
      library: lib,
      kits,
      log,
      sessions: [],
      sessionStore: createSessionStore(home),
      signinCommand: "npx demoman signin",
      loadSessions: async () => ({ ok: true as const, files: [] }),
      sessionsContext,
    },
    () => undefined,
  );

/** The last call's own page, still open until the next call stages another. */
const stagePage = async (path: string): Promise<Page> => {
  const launched = await session.ensure();
  if (!launched.ok) throw new Error(JSON.stringify(launched));
  const pages = launched.launched.context.pages().map((p) => p.url());
  const page = launched.launched.context
    .pages()
    .filter((p) => p.url() === url + path.replace(/^\//, ""))
    .at(-1);
  if (page === undefined) throw new Error(`no page at ${path}: ${pages}`);
  return page;
};

const openFilters = {
  do: "click",
  on: { role: "button", name: "Open filters" },
};
const live = { role: "menuitem", name: "Live" };
const hasLive = (reply: ProbeReply) =>
  reply.targets.some((t) => JSON.stringify(t.target) === JSON.stringify(live));

describe("probeOp", () => {
  it("lists the menu a click creates", async () => {
    const reply = await probe(script([openFilters]));
    expect(reply.stopped, JSON.stringify({ reply, lines })).toBeNull();
    expect(reply.steps).toEqual({ played: 2, of: 2 });
    expect(hasLive(reply), JSON.stringify(reply.targets)).toBe(true);
  }, 120_000);

  it("a plain snapshot does not list that menu", async () => {
    const out = await snapshotOp(
      { url },
      {
        session,
        home,
        log,
        loadSessions: async () => ({ ok: true, files: [] }),
        signinCommand: "npx demoman signin",
      },
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    const { targets } = out.value as ProbeReply;
    // The control: the snapshot listed the page, and the button is on it.
    expect(
      targets.some((t) => t.text === "Open filters"),
      JSON.stringify(targets),
    ).toBe(true);
    expect(
      targets.filter((t) => t.kind === "menuitem"),
      JSON.stringify(targets),
    ).toEqual([]);
  }, 120_000);

  it("a target the probe listed is found by a run of the same steps", async () => {
    const reply = await probe(script([openFilters]));
    const listed = reply.targets.find(
      (t) => JSON.stringify(t.target) === JSON.stringify(live),
    );
    expect(listed, JSON.stringify(reply.targets)).toBeDefined();
    const report = await run(
      script([openFilters, { do: "click", on: listed?.target }]),
    );
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    const page = await stagePage("");
    expect(await page.locator("#shown").textContent()).toBe("Showing Live");
  }, 240_000);

  it("says which step stopped, with the run's reason, and lists the page where it stopped", async () => {
    const raw = script([
      openFilters,
      { do: "click", on: { role: "menuitem", name: "Nope" } },
    ]);
    const reply = await probe(raw);
    expect(reply.stopped, JSON.stringify({ reply, lines })).toMatchObject({
      at: 2,
      reason: "unresolvedAnchor",
    });
    expect(reply.steps.played).toBe(2);
    // The menu is still open where it stopped.
    expect(hasLive(reply), JSON.stringify(reply.targets)).toBe(true);
    const report = await run(raw);
    expect(report.stopped?.at.index, JSON.stringify(report.stopped)).toBe(
      reply.stopped?.at,
    );
    expect(report.stopped?.reason).toBe(reply.stopped?.reason);
  }, 240_000);

  it("counts as the run counts: pauses are not steps", async () => {
    const reply = await probe(script([{ do: "pause", ms: 100 }, openFilters]));
    expect(reply.steps.of, JSON.stringify(reply.steps)).toBe(2);
  }, 120_000);

  it("refuses a bad script as run would", async () => {
    const raw = { ...script([]), steps: [{ do: "pause", ms: 10 }] };
    const checked = checkScript(raw, []);
    // The premise: the run door refuses this script.
    expect(checked.ok).toBe(false);
    expect(probeEntry(raw, [], kits)).toEqual(checked);
  });

  it("refuses a script whose brand kit is not there, as run would", () => {
    const entry = probeEntry(
      { ...script([]), look: { kit: "nope" } },
      [],
      kits,
    );
    expect(entry, JSON.stringify(entry)).toMatchObject({
      ok: false,
      refusal: { reason: "unknownKit", field: "look.kit" },
    });
  });

  it("ends on a password page without reading as signed out", async () => {
    const reply = await probe(
      script([
        { do: "click", on: { role: "link", name: "Security" } },
        { do: "waitForLoad" },
      ]),
    );
    expect(reply.session, JSON.stringify({ reply, lines })).not.toBe(
      "signedOut",
    );
    expect(reply.stopped).toBeNull();
    expect(reply.landedElsewhere).toBe(false);
    expect(reply.endedUrl).toMatch(/\/security$/);
    // The premise: the page it ended on shows a password field, the thing
    // the sign-in check reads as a sign-in wall.
    const page = await stagePage("/security");
    expect(
      (await readLandingFacts(page, url)).passwordFieldVisible,
      page.url(),
    ).toBe(true);
  }, 120_000);

  it("a last click that navigates ends on the new page, named and listed", async () => {
    const reply = await probe(
      script([{ do: "click", on: { role: "link", name: "Security" } }]),
    );
    expect(reply.stopped, JSON.stringify({ reply, lines })).toBeNull();
    expect(reply.endedUrl).toMatch(/\/security$/);
    // The premise: the listing is the new page's, not the one clicked on.
    const texts = JSON.stringify(reply.targets);
    expect(texts).toContain("Change password");
    expect(texts).not.toContain("Open filters");
  }, 120_000);

  it("a filming fault after the last step is not a stopped step", async () => {
    const reply = await probe(script([openFilters]), {
      film: () => {
        const film = discardingFilm();
        return {
          ...film,
          store: {
            ...film.store,
            putBundle: () => Promise.reject(new Error("disk full")),
          },
        };
      },
    });
    expect(reply.stopped, JSON.stringify({ reply, lines })).toBeNull();
    expect(reply.targets.length).toBeGreaterThan(0);
    // The premise: the fault reached the walk, so this cannot pass because
    // the store was never asked.
    expect(
      lines.some((l) => l.includes("filming said")),
      JSON.stringify(lines),
    ).toBe(true);
  }, 120_000);

  it("says pageDidNotLoad when the steps end on a page that did not load", async () => {
    const out = await probeOp(
      enter(script([{ do: "click", on: { role: "link", name: "Down" } }])),
      null,
      deps(),
    );
    expect(out, JSON.stringify({ out, lines })).toMatchObject({
      ok: false,
      reason: "pageDidNotLoad",
    });
    expect(out.ok ? "" : out.detail).toContain("127.0.0.1:1");
  }, 120_000);

  it("a step that stopped is still said when its page then did not load", async () => {
    const out = await probeOp(
      enter(
        script([
          { do: "click", on: { role: "link", name: "Down" } },
          openFilters,
        ]),
      ),
      null,
      deps(),
    );
    const said = JSON.stringify({ out, lines });
    // The step's own stop, not the end page's failure in its place.
    expect(out, said).toMatchObject({ ok: true, value: { targets: [] } });
    const reply = (out.ok ? out.value : null) as ProbeReply;
    expect(reply.stopped, said).not.toBeNull();
    expect(reply.stopped?.reason, said).toBe("pageDidNotLoad");
    expect(reply.settleNote, said).not.toContain("pageDidNotLoad");
    // The premise: the page it stopped on is the one that did not load.
    expect(reply.stopped?.detail, said).toContain("127.0.0.1:1");
  }, 120_000);

  it("a probe whose target never loads stops with pageDidNotLoad, not unresolvedAnchor", async () => {
    const down = "http://127.0.0.1:1/";
    const out = await probeOp(
      enter({
        ...script([
          { do: "click", on: { role: "button", name: "Open filters" } },
        ]),
        target: down,
      }),
      null,
      deps(),
    );
    const said = JSON.stringify({ out, lines });
    const reply = (out.ok ? out.value : null) as ProbeReply;
    expect(reply, said).not.toBeNull();
    // The premise: the page it ended on is the one that did not load.
    expect(reply.endedUrl, said).toContain("chrome-error:");
    expect(reply.stopped?.reason, said).toBe("pageDidNotLoad");
    expect(reply.stopped?.detail, said).toContain("127.0.0.1:1");
    expect(reply.stopped?.detail, said).toContain("ERR_");
    expect(reply.settleNote, said).not.toContain("pageDidNotLoad");
  }, 120_000);

  it("a step that stopped is still said when its page is gone", async () => {
    const launched = await session.ensure();
    if (!launched.ok) throw new Error(JSON.stringify(launched));
    const { context } = launched.launched;
    const before = new Set(context.pages());
    const probed = probeOp(
      enter(script([openFilters, { do: "pause", ms: 3000 }, openFilters])),
      null,
      deps(),
    );
    // Closed once its menu is open: mid-pause, after one step played.
    let closed = false;
    for (let tries = 0; !closed && tries < 400; tries++) {
      const page = context.pages().find((p) => !before.has(p));
      if (
        page !== undefined &&
        (await page.$('[role="menu"]').catch(() => null))
      ) {
        await page.close();
        closed = true;
      } else {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const out = await probed;
    const said = JSON.stringify({ out, lines });
    // The premise: the page was closed under the probe.
    expect(closed, said).toBe(true);
    expect(out, said).toMatchObject({ ok: true, value: { targets: [] } });
    const reply = (out.ok ? out.value : null) as ProbeReply;
    expect(reply.stopped, said).not.toBeNull();
    expect(reply.settleNote, said).toContain(
      "could not be listed (probeThrew)",
    );
    expect(reply.endedUrl, said).toBeNull();
  }, 120_000);

  it("leaves no take behind", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "demoman-probe-home-"));
    try {
      await probe(script([openFilters]), { home: fresh });
      expect(await createLibrary(fresh).list()).toEqual([]);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  }, 120_000);
});
