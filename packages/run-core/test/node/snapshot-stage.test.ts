import type { CdpSession } from "@demoman/replay-engine";
import { describe, expect, it, vi } from "vitest";
import type { RunSizePlan } from "../../src/replay/run-size.js";
import {
  landedElsewhere,
  type SnapshotReply,
  type SnapshotStage,
  snapshotOnStage,
} from "../../src/replay/snapshot.js";

/** A stage whose page is already complete and settled, landed on `href`. */
function stage(
  href: unknown,
  reply: SnapshotReply,
): SnapshotStage & { sent: string[] } {
  const sent: string[] = [];
  const cdp: CdpSession = {
    on: () => () => undefined,
    detach: async () => undefined,
    send: async (method, params) => {
      sent.push(
        method === "Runtime.evaluate"
          ? String(params?.expression).slice(0, 30)
          : method,
      );
      const expression = String(params?.expression ?? "");
      if (expression === "document.readyState")
        return { result: { value: "complete" } };
      if (expression === "location.href") {
        if (href instanceof Error) throw href;
        return { result: { value: href } };
      }
      return {
        result: {
          value: {
            settled: true,
            pending: 0,
            fonts: "ok",
            ready: "complete",
            quiet: true,
          },
        },
      };
    },
  };
  return {
    sent,
    cdp,
    occlusion: { install: vi.fn(async () => undefined) },
    sleep: async () => undefined,
    snapshotTargets: vi.fn(async () => reply),
    // The hidden stage window's own page, as `REPLAY_WINDOW` gives it.
    measureViewport: vi.fn(async () => ({ width: 900, height: 519 })),
  };
}

/** The author's screen at its own size — what a run with no viewport films. */
const SCREEN: RunSizePlan = {
  kind: "fixed",
  size: { width: 1512, height: 982, from: "screen", error: null },
};
const WALK = {
  title: "KitchenLink",
  targets: [],
  unresolvable: 3,
  notExamined: 0,
  walkMs: 12,
};

describe("landedElsewhere", () => {
  // Plan 2, Review Focus 1. Red if strings are compared: a trailing slash
  // or a hash would read as a redirect and send the agent to ask for a
  // sign-in nobody needs.
  it("ignores a trailing slash and a hash, and catches a redirect", () => {
    expect(
      landedElsewhere("http://localhost:4000", "http://localhost:4000/"),
    ).toBe(false);
    expect(
      landedElsewhere("http://localhost:4000/#faq", "http://localhost:4000/"),
    ).toBe(false);
    expect(
      landedElsewhere(
        "http://localhost:4000/",
        "http://localhost:4000/login?next=%2F",
      ),
    ).toBe(true);
  });
});

describe("landedElsewhere, final review", () => {
  // Final review, finding 1. Red if a trailing slash counts only at the root:
  // a static host's `/faq` → `/faq/` would send the agent to ask the user to
  // sign in when nothing is signed out.
  it("ignores a trailing slash on any path", () => {
    expect(landedElsewhere("http://x/faq", "http://x/faq/")).toBe(false);
    expect(landedElsewhere("http://x/a/b/", "http://x/a/b")).toBe(false);
    // Premise: the path itself is still compared.
    expect(landedElsewhere("http://x/faq", "http://x/login")).toBe(true);
  });

  // Final review, finding 1. Red if every hash is dropped: a hash router's
  // sign-in redirect (`#/dashboard` → `#/login`) would read as the same page.
  it("counts a hash the app changed to, and not one it dropped or kept", () => {
    expect(landedElsewhere("http://x/#/dashboard", "http://x/#/login")).toBe(
      true,
    );
    expect(landedElsewhere("http://x/", "http://x/#/login")).toBe(true);
    expect(landedElsewhere("http://x/#faq", "http://x/")).toBe(false);
    expect(landedElsewhere("http://x/#faq", "http://x/#faq")).toBe(false);
  });
});

describe("snapshotOnStage", () => {
  // Red if the walk is asked before the page loads (Page.enable and the
  // navigation must come first, or loadEventFired never fires and the walk
  // reads about:blank).
  it("enables Page, navigates, waits, reads where it landed, then walks", async () => {
    const s = stage("http://localhost:4000/login", { walk: WALK });
    const outcome = await snapshotOnStage(
      s,
      "http://localhost:4000/",
      null,
      null,
      SCREEN,
    );
    expect(s.sent[0]).toBe("Page.enable");
    expect(s.occlusion.install).toHaveBeenCalledTimes(1);
    expect(s.snapshotTargets).toHaveBeenCalledWith({
      contains: null,
      maxTargets: 250,
      budgetMs: 8000,
    });
    expect(outcome).toEqual({
      ok: true,
      value: {
        url: "http://localhost:4000/",
        landedUrl: "http://localhost:4000/login",
        landedElsewhere: true,
        title: "KitchenLink",
        settled: true,
        settleNote: null,
        targets: [],
        unresolvable: 3,
        notExamined: 0,
        containsNote: null,
        walkMs: 12,
        device: null,
        size: { width: 1512, height: 982, from: "screen", error: null },
      },
    });
  });

  // Red if an unreadable URL reads as "not redirected": null is "could not
  // tell", which the recipe says is not an all-clear.
  it("answers landedUrl and landedElsewhere null when the URL cannot be read", async () => {
    const outcome = await snapshotOnStage(
      stage(new Error("gone"), { walk: WALK }),
      "http://a/",
      null,
      null,
      SCREEN,
    );
    expect(outcome).toMatchObject({
      ok: true,
      value: { landedUrl: null, landedElsewhere: null },
    });
  });

  // Red if a page fault or silence is answered as an empty snapshot.
  it("answers the page's failure as a refusal with its reason", async () => {
    const outcome = await snapshotOnStage(
      stage("http://a/", {
        failed: "pageSilent",
        detail: "the page did not answer within 20 s",
      }),
      "http://a/",
      "pay",
      null,
      SCREEN,
    );
    expect(outcome).toEqual({
      ok: false,
      reason: "pageSilent",
      detail: "the page did not answer within 20 s",
    });
  });

  // Final review, finding 2. Red if a page that never loaded is walked: the
  // browser's own error page has no Demoman sensor, so the agent was told
  // pageSilent, "reload the page", when the app is simply not running.
  it("refuses pageDidNotLoad, naming the url, when the browser showed its own error page", async () => {
    const s = stage("chrome-error://chromewebdata/", { walk: WALK });
    const outcome = await snapshotOnStage(
      s,
      "http://localhost:4000/",
      null,
      null,
      SCREEN,
    );
    expect(outcome).toMatchObject({ ok: false, reason: "pageDidNotLoad" });
    if (!outcome.ok) expect(outcome.detail).toContain("http://localhost:4000/");
    expect(s.snapshotTargets).not.toHaveBeenCalled();
  });
});

// Spec 2026-10-10 §3: a snapshot as a phone lists the phone's targets, so the
// device goes on the page before the navigation the occlusion guard makes.
describe("snapshotOnStage with a device", () => {
  /** A stage whose `install` and every CDP call land in one ordered log. */
  function ordered(failOn: string | null = null) {
    const s = stage("http://a/", { walk: WALK });
    const log: string[] = [];
    const send = s.cdp.send;
    s.cdp.send = async (method, params) => {
      log.push(method);
      if (method === failOn) throw new Error("Not allowed");
      return send(method, params);
    };
    s.occlusion.install = vi.fn(async () => {
      log.push("install");
    });
    return { s, log };
  }

  it("emulates the device before the page is loaded, and says which", async () => {
    const { s, log } = ordered();
    const outcome = await snapshotOnStage(
      s,
      "http://a/",
      null,
      "phone",
      SCREEN,
    );
    const install = log.indexOf("install");
    expect(install, log.join(",")).toBeGreaterThan(-1);
    for (const m of [
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setUserAgentOverride",
    ]) {
      expect(log.indexOf(m), `${m} in ${log.join(",")}`).toBeGreaterThan(-1);
      expect(log.indexOf(m)).toBeLessThan(install);
    }
    expect(outcome).toMatchObject({ ok: true, value: { device: "phone" } });
  });

  it("refuses as deviceFailed, naming the device, and loads nothing", async () => {
    const { s } = ordered("Emulation.setUserAgentOverride");
    const outcome = await snapshotOnStage(
      s,
      "http://a/",
      null,
      "phone",
      SCREEN,
    );
    expect(outcome).toMatchObject({ ok: false, reason: "deviceFailed" });
    expect(outcome.ok ? "" : outcome.detail).toMatch(/could not emulate Phone/);
    expect(s.occlusion.install).not.toHaveBeenCalled();
    expect(s.snapshotTargets).not.toHaveBeenCalled();
  });

  it("says the device's size as the size it laid the page out at", async () => {
    const { s } = ordered();
    const outcome = await snapshotOnStage(
      s,
      "http://a/",
      null,
      "phone",
      SCREEN,
    );
    expect(outcome).toMatchObject({
      ok: true,
      value: { size: { width: 393, height: 852, from: "device", error: null } },
    });
  });
});

// 2026-10-11: a snapshot with no device lays the page out at the size a run
// with no `viewport` films, so `inFirstViewport` describes the video the agent
// will get rather than the hidden stage window's 900x519.
describe("snapshotOnStage on the desktop", () => {
  function ordered(failOn: string | null = null) {
    const s = stage("http://a/", { walk: WALK });
    const log: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const send = s.cdp.send;
    s.cdp.send = async (method, params) => {
      log.push({ method, params });
      if (method === failOn) throw new Error("Not allowed");
      return send(method, params);
    };
    s.occlusion.install = vi.fn(async () => {
      log.push({ method: "install" });
    });
    return { s, log };
  }

  it("lays the page out at the run's size before it loads, and says so", async () => {
    const { s, log } = ordered();
    const outcome = await snapshotOnStage(s, "http://a/", null, null, SCREEN);
    const methods = log.map((c) => c.method);
    const override = methods.indexOf("Emulation.setDeviceMetricsOverride");
    expect(override, methods.join(",")).toBeGreaterThan(-1);
    expect(override).toBeLessThan(methods.indexOf("install"));
    expect(log[override]?.params).toMatchObject({
      width: 1512,
      height: 982,
      mobile: false,
    });
    // No touch and no user agent: a desktop is only a size.
    expect(methods.filter((m) => m.startsWith("Emulation."))).toEqual([
      "Emulation.setDeviceMetricsOverride",
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        size: { width: 1512, height: 982, from: "screen", error: null },
      },
    });
    expect(s.measureViewport).not.toHaveBeenCalled();
  });

  // The fallback the run takes too: no override, the window measured, and
  // the reason on the answer.
  it("lays it out at the window's own size, measured and with the reason, when the screen is unreadable", async () => {
    const { s, log } = ordered();
    const outcome = await snapshotOnStage(s, "http://a/", null, null, {
      kind: "measure",
      error: "the screen reported 0x0, which no page can be recorded at",
    });
    expect(log.filter((c) => c.method.startsWith("Emulation."))).toEqual([]);
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        size: {
          width: 900,
          height: 519,
          from: "window",
          error: "the screen reported 0x0, which no page can be recorded at",
        },
      },
    });
  });

  // Forgiven, because a list of targets is still worth having — but the
  // answer says the layout is the window's and why, so the agent is never
  // told it saw the run's size when it did not.
  it("says a refused size and lists the window's layout", async () => {
    const { s } = ordered("Emulation.setDeviceMetricsOverride");
    const outcome = await snapshotOnStage(s, "http://a/", null, null, SCREEN);
    expect(outcome).toMatchObject({
      ok: true,
      value: { size: { width: 900, height: 519, from: "window" } },
    });
    const error = outcome.ok ? outcome.value.size?.error : null;
    expect(error).toMatch(/1512x982/);
    expect(error).toMatch(/Not allowed/);
    expect(s.snapshotTargets).toHaveBeenCalled();
  });
});

describe("containsNote", () => {
  const ask = (contains: string | null, walk: object) =>
    snapshotOnStage(
      stage("http://a/", { walk: { ...WALK, ...walk } }),
      "http://a/",
      contains,
      null,
      SCREEN,
    );

  // Red if an empty answer to `contains` reads like "absent": the note is the
  // only thing that says the question was asked of every field.
  it("says nothing matched when contains finds nothing", async () => {
    const outcome = await ask("zzz", { targets: [], notExamined: 0 });
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        containsNote:
          'Nothing on the page matched "zzz" (name, text, stableId, kind or value).',
      },
    });
  });

  // Red if the note is said when more matches were left unexamined, or when
  // nothing was asked.
  it("says nothing of the kind when notExamined > 0 or contains was not given", async () => {
    const more = await ask("zzz", { targets: [], notExamined: 4 });
    expect(more).toMatchObject({ ok: true, value: { containsNote: null } });
    const none = await ask(null, { targets: [], notExamined: 0 });
    expect(none).toMatchObject({ ok: true, value: { containsNote: null } });
  });
});
