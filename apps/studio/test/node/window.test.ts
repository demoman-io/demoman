import { EventEmitter } from "node:events";
import { request } from "node:http";
import type { StudioEvent } from "@demoman/studio-protocol";
import type { BrowserContext } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStudioServer,
  type StudioHandlers,
  type StudioServer,
} from "../../src/server.js";
import { createStudioWindow, type LaunchOptions } from "../../src/window.js";

// The window against a stand-in context: pages are event emitters, and
// `Target.createTarget` makes a page that arrives later, as a real browser's
// does. Each new window's page arrives after `arrivalMs` — later for the
// earlier window — so two windows opened together arrive in the reverse
// order, which is what a "take the next page event" window would get wrong.

class FakePage extends EventEmitter {
  closed = false;
  gotos: string[] = [];
  fronted = 0;
  gotoFails: string | null = null;
  frontFails: string | null = null;
  constructor(
    readonly ctx: FakeContext,
    readonly id: string,
    private address: string,
    readonly background: boolean,
  ) {
    super();
  }
  isClosed() {
    return this.closed;
  }
  url() {
    return this.address;
  }
  async goto(url: string) {
    if (this.gotoFails !== null) throw new Error(this.gotoFails);
    this.gotos.push(url);
    this.address = url;
  }
  async bringToFront() {
    if (this.frontFails !== null) throw new Error(this.frontFails);
    this.fronted += 1;
  }
  async close() {
    this.closed = true;
    this.emit("close", this);
  }
}

class FakeContext extends EventEmitter {
  all: FakePage[] = [];
  created = 0;
  /** Per window created: how long until its page arrives. */
  arrivalMs: number[] = [];
  pages() {
    return this.all.filter((p) => !p.closed);
  }
  add(page: FakePage, emit: boolean) {
    this.all.push(page);
    if (emit) this.emit("page", page);
  }
  async newPage() {
    this.created += 1;
    const page = new FakePage(this, `np${this.created}`, "about:blank", false);
    this.add(page, true);
    return page;
  }
  async newCDPSession(page: FakePage) {
    return {
      send: async (method: string, params?: Record<string, unknown>) => {
        if (method === "Target.getTargetInfo") {
          return { targetInfo: { targetId: page.id } };
        }
        if (method === "Target.createTarget") {
          const n = this.created;
          this.created += 1;
          const made = new FakePage(
            this,
            `target-${n}`,
            String(params?.url),
            params?.background === true,
          );
          setTimeout(() => this.add(made, true), this.arrivalMs[n] ?? 0);
          return { targetId: made.id };
        }
        throw new Error(`the fake does not answer ${method}`);
      },
      detach: async () => {},
    };
  }
  async close() {
    for (const p of this.all) p.closed = true;
    this.emit("close");
  }
}

const ORIGIN = "http://127.0.0.1:5555";

function harness(o: { listening?: number } = {}) {
  let ctx: FakeContext | null = null;
  const launches: LaunchOptions[] = [];
  const sent: StudioEvent[] = [];
  const logs: string[] = [];
  let minted = 0;
  const window = createStudioWindow({
    home: "/tmp/studio-window-test",
    origin: ORIGIN,
    entryUrl: (takeId) => {
      minted += 1;
      return `${ORIGIN}/?t=ticket-${minted}${takeId === undefined ? "" : `&take=${takeId}`}`;
    },
    events: { send: (e) => sent.push(e), size: () => o.listening ?? 1 },
    log: (l) => logs.push(l),
    pageWaitMs: 2_000,
    launchContext: async (_dir, options) => {
      launches.push(options);
      const made = new FakeContext();
      const app = String(options.args?.find((a) => a.startsWith("--app=")));
      made.add(
        new FakePage(made, "app", app.slice("--app=".length), false),
        false,
      );
      ctx = made;
      return made as unknown as BrowserContext;
    },
  });
  return {
    window,
    launches,
    sent,
    logs,
    ctx: () => {
      if (ctx === null) throw new Error("nothing launched yet");
      return ctx;
    },
  };
}

const appPage = (ctx: FakeContext) => {
  const page = ctx.all.find((p) => p.id === "app");
  if (page === undefined) throw new Error("no app page");
  return page;
};

describe("open on a live window (fix 1: never ok when it did not move)", () => {
  it("with a page listening, sends `open` and brings the window forward", async () => {
    const h = harness({ listening: 1 });
    expect(await h.window.open({})).toEqual({ ok: true, path: "/" });
    const answer = await h.window.open({ takeId: "t1" });
    expect(answer).toEqual({ ok: true, path: "/editor.html?scene=t1" });
    expect(h.sent).toEqual([{ type: "open", path: "/editor.html?scene=t1" }]);
    expect(appPage(h.ctx()).fronted).toBe(1);
    expect(appPage(h.ctx()).gotos).toEqual([]);
  });

  it("with no page listening, navigates the window through a fresh entry link", async () => {
    const h = harness({ listening: 0 });
    await h.window.open({});
    const answer = await h.window.open({ takeId: "t1" });
    // Red: send the SSE `open` to nobody and answer ok.
    expect(appPage(h.ctx()).gotos).toEqual([`${ORIGIN}/?t=ticket-2&take=t1`]);
    expect(answer).toEqual({ ok: true, path: "/editor.html?scene=t1" });
    expect(h.sent).toEqual([]);
  });

  it("a navigation that fails is refused windowDidNotOpen, naming the page", async () => {
    const h = harness({ listening: 0 });
    await h.window.open({});
    appPage(h.ctx()).gotoFails = "net::ERR_ABORTED";
    const answer = await h.window.open({ takeId: "t1" });
    expect(answer).toEqual({
      reason: "windowDidNotOpen",
      detail:
        "the studio's window could not be sent to /editor.html?scene=t1 (net::ERR_ABORTED)",
    });
  });

  it("a window that will not come forward is refused windowDidNotOpen", async () => {
    const h = harness({ listening: 1 });
    await h.window.open({});
    appPage(h.ctx()).frontFails = "Target closed";
    const answer = await h.window.open({ takeId: "t1" });
    // Red: log the bringToFront failure and answer ok.
    expect(answer).toMatchObject({ reason: "windowDidNotOpen" });
    expect((answer as { detail: string }).detail).toContain(
      "could not be brought forward (Target closed)",
    );
  });
});

describe("new windows are matched by target id (fix 2)", () => {
  it("a render's work page and a window reopened during a drain get their own pages", async () => {
    const h = harness();
    let closedAll = 0;
    h.window.onAllClosed(() => {
      closedAll += 1;
    });
    await h.window.open({});
    const ctx = h.ctx();
    // A render already under way: its work page is the session anchor once
    // the person closes the app window.
    const first = await h.window.workPage();
    if (!first.ok) throw new Error(first.detail);
    await appPage(ctx).close();
    expect(closedAll).toBe(1);

    // The next two windows, opened together: the earlier one's page
    // arrives last.
    ctx.arrivalMs[ctx.created] = 40;
    ctx.arrivalMs[ctx.created + 1] = 5;
    const [work, reopened] = await Promise.all([
      h.window.workPage(),
      h.window.open({ takeId: "t1" }),
    ]);
    if (!work.ok) throw new Error(work.detail);
    expect(reopened).toEqual({ ok: true, path: "/editor.html?scene=t1" });

    const workPage = work.page as unknown as FakePage;
    const firstPage = first.page as unknown as FakePage;
    const person = ctx.pages().find((p) => p !== workPage && p !== firstPage);
    // Premise: both windows were made, in that order, and arrived reversed
    // (waited for: a window that took the wrong page answers before the
    // later page arrives).
    await vi.waitFor(() => expect(ctx.all).toHaveLength(4));
    expect(ctx.all.map((p) => p.id)).toEqual([
      "app",
      "target-0",
      "target-2",
      "target-1",
    ]);
    // Red: take the first page that arrives instead of matching its id.
    expect(workPage.id).toBe("target-1");
    expect(workPage.background).toBe(true);
    expect(workPage.url()).toBe("about:blank");
    expect(person?.id).toBe("target-2");
    expect(person?.background).toBe(false);
    expect(person?.url()).toBe(`${ORIGIN}/?t=ticket-2&take=t1`);
  });
});

describe("the launch (R12)", () => {
  let studio: StudioServer;
  beforeEach(async () => {
    const none = async () => ({ status: 200, json: {} });
    studio = await createStudioServer({
      handlers: new Proxy({}, { get: () => none }) as StudioHandlers,
      pages: {
        async serve(_req, res) {
          res.writeHead(200);
          res.end();
        },
      },
    });
  });
  afterEach(async () => {
    await studio.close();
  });

  it("puts a single-use ticket in the browser's argv, never the session token", async () => {
    let args: string[] = [];
    const window = createStudioWindow({
      home: "/tmp/studio-window-test",
      origin: studio.origin,
      entryUrl: (takeId) => studio.entryUrl(takeId),
      events: { send: () => {}, size: () => 1 },
      log: () => {},
      pageWaitMs: 2_000,
      launchContext: async (_dir, options) => {
        args = options.args ?? [];
        const ctx = new FakeContext();
        const app = String(args.find((a) => a.startsWith("--app=")));
        ctx.add(new FakePage(ctx, "app", app.slice(6), false), false);
        return ctx as unknown as BrowserContext;
      },
    });
    expect(await window.open({ takeId: "t1" })).toMatchObject({ ok: true });
    // Red: build the entry URL from the session token (server.ts entryUrl).
    expect(args.join(" ")).not.toContain(studio.token);
    expect(args).toContain("--use-mock-keychain");
    const app = new URL(
      String(args.find((a) => a.startsWith("--app="))).slice(6),
    );
    expect(app.searchParams.get("take")).toBe("t1");
    // The argv's ticket is real: it lets the window in, once.
    const enter = () =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: studio.port,
            path: `${app.pathname}${app.search}`,
            headers: { Host: `127.0.0.1:${studio.port}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    expect(await enter()).toBe(302);
    expect(await enter()).toBe(403);
    await window.close();
  });
});
