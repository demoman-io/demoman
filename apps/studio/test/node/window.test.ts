import { EventEmitter } from "node:events";
import { request } from "node:http";
import type { StudioEvent } from "@demoman/studio-protocol";
import type { BrowserContext } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createStudioServer,
  type StudioHandlers,
  type StudioServer,
} from "../../src/server.js";
import { createStudioWindow, type LaunchOptions } from "../../src/window.js";

// The window against a stand-in context: pages are event emitters.

class FakePage extends EventEmitter {
  closed = false;
  gotos: string[] = [];
  fronted = 0;
  gotoFails: string | null = null;
  /** The status the entry door answers a goto with. */
  answers = 200;
  frontFails: string | null = null;
  constructor(
    readonly ctx: FakeContext,
    readonly id: string,
    private address: string,
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
    const status = this.answers;
    return { ok: () => status < 400, status: () => status };
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
  pages() {
    return this.all.filter((p) => !p.closed);
  }
  add(page: FakePage, emit: boolean) {
    this.all.push(page);
    if (emit) this.emit("page", page);
  }
  async newPage() {
    this.created += 1;
    const page = new FakePage(this, `np${this.created}`, "about:blank");
    this.add(page, true);
    return page;
  }
  async close() {
    for (const p of this.all) p.closed = true;
    this.emit("close");
  }
}

const ORIGIN = "http://127.0.0.1:5555";

function harness(o: { listening?: number; answers?: number } = {}) {
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
      const page = new FakePage(made, "app", app.slice("--app=".length));
      page.answers = o.answers ?? 200;
      made.add(page, false);
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
    // The launch's own entry, and no other.
    expect(appPage(h.ctx()).gotos).toEqual([`${ORIGIN}/?t=ticket-1`]);
  });

  it("with no page listening, navigates the window through a fresh entry link", async () => {
    const h = harness({ listening: 0 });
    await h.window.open({});
    const answer = await h.window.open({ takeId: "t1" });
    // Red: send the SSE `open` to nobody and answer ok.
    expect(appPage(h.ctx()).gotos).toEqual([
      `${ORIGIN}/?t=ticket-1`,
      `${ORIGIN}/?t=ticket-2&take=t1`,
    ]);
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
        "the Studio's window could not be sent to /editor.html?scene=t1 (net::ERR_ABORTED)",
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

describe("the launch's window", () => {
  // Red: answer ok from a window the door refused (`enter` ignoring the
  // response), which shows "This Studio link has expired".
  it("is refused windowDidNotOpen when the entry door refuses it", async () => {
    const h = harness({ answers: 403 });
    expect(await h.window.open({ takeId: "t1" })).toEqual({
      reason: "windowDidNotOpen",
      detail:
        "the Studio's window opened but could not be sent to /editor.html?scene=t1 (the Studio answered 403)",
    });
    expect(appPage(h.ctx()).gotos).toEqual([`${ORIGIN}/?t=ticket-1&take=t1`]);
  });
});

describe("a window reopened after the person closed every one", () => {
  it("opens a new page on a fresh entry link, counted as theirs", async () => {
    const h = harness();
    let closedAll = 0;
    h.window.onAllClosed(() => {
      closedAll += 1;
    });
    await h.window.open({});
    const ctx = h.ctx();
    await appPage(ctx).close();
    // Premise: the browser is still running with no window left.
    expect(closedAll).toBe(1);
    expect(ctx.pages()).toEqual([]);

    const answer = await h.window.open({ takeId: "t1" });
    expect(answer).toEqual({ ok: true, path: "/editor.html?scene=t1" });
    const [reopened] = ctx.pages();
    // Red: answer ok without sending the new page anywhere.
    expect(reopened?.gotos).toEqual([`${ORIGIN}/?t=ticket-2&take=t1`]);
    // Red: count it as nobody's, so closing it never fires onAllClosed.
    await reopened?.close();
    expect(closedAll).toBe(2);
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

  it("puts no ticket and no token in the browser's argv, and enters through the pipe", async () => {
    let args: string[] = [];
    let page: FakePage | null = null;
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
        page = new FakePage(ctx, "app", app.slice(6));
        ctx.add(page, false);
        return ctx as unknown as BrowserContext;
      },
    });
    expect(await window.open({ takeId: "t1" })).toMatchObject({ ok: true });
    // Red: `--app=${entryUrl}` — argv is readable by any local user, who can
    // redeem the ticket before the window does (audit run 1, the high).
    expect(args).toContain("--app=about:blank");
    expect(args.join(" ")).not.toContain("t=");
    expect(args.join(" ")).not.toContain(studio.token);
    expect(args).toContain("--use-mock-keychain");
    // The window was sent to a real entry link instead: it lets in once.
    const gotos = (page as FakePage | null)?.gotos ?? [];
    expect(gotos).toHaveLength(1);
    const entry = new URL(String(gotos[0]));
    expect(entry.searchParams.get("take")).toBe("t1");
    const enter = () =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: studio.port,
            path: `${entry.pathname}${entry.search}`,
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
