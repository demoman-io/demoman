import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createSessionStore } from "../src/executor/sessions.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { type LoginApp, serveLoginApp, sessionFor } from "./login-app.js";

let app: LoginApp;
let home: string;
let executor: LocalExecutor;
beforeAll(async () => {
  app = await serveLoginApp();
  home = await mkdtemp(join(tmpdir(), "demoman-exec-sessions-"));
  executor = createLocalExecutor({
    home,
    headless: true,
    log: () => undefined,
  });
}, 30_000);
afterAll(async () => {
  await executor.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
});

type Snap = {
  value?: { landedUrl: string | null };
  reason?: string;
  detail?: string;
};
const snapshot = async () =>
  (await executor.request("snapshot", {
    url: `${app.url}/app`,
  })) as unknown as Snap & {
    ok: boolean;
  };

// Review focus 3: a session saved while the browser is open is used next.
it("uses a session saved after the browser opened, on the next call", async () => {
  const before = await snapshot();
  // Premise: signed out first, so the browser is open and on the sign-in page.
  expect(before.value?.landedUrl).toContain("/login");
  await createSessionStore(home).save(sessionFor(app, app.validCookie()));
  const after = await snapshot();
  expect(after.value?.landedUrl).toBe(`${app.url}/app`);
}, 120_000);

it("lists saved sessions in status, never a cookie", async () => {
  const out = (await executor.request("status", {})) as {
    value: { sessions: unknown };
  };
  expect(out.value.sessions).toEqual([
    {
      site: "localhost",
      savedAt: "2026-10-15T09:00:00.000Z",
      refreshedAt: null,
      signInUrl: `${app.url}/login?return_to=%2Fapp`,
    },
  ]);
  expect(JSON.stringify(out)).not.toContain(app.validCookie());
});

it("refuses a snapshot and a run with sessionUnreadable when a file is exposed", async () => {
  const store = createSessionStore(home);
  await chmod(store.pathOf("localhost"), 0o644);
  try {
    const snap = await snapshot();
    expect(snap.ok).toBe(false);
    expect(snap.reason).toBe("sessionUnreadable");
    expect(snap.detail).toContain("chmod 600");
    const run = (await executor.request("run", {
      script: {
        scriptVersion: 1,
        name: "x",
        target: `${app.url}/app`,
        steps: [{ do: "click", on: { text: "Next" } }],
      },
    })) as { value: { outcome: string; reason: string } };
    expect(run.value).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "sessionUnreadable",
    });
    const status = (await executor.request("status", {})) as {
      value: { sessions: { unreadable?: string } };
    };
    expect(status.value.sessions.unreadable).toContain("chmod 600");
  } finally {
    await chmod(store.pathOf("localhost"), 0o600);
  }
}, 120_000);

it("refuses with sessionNotLoaded when the browser will not take a saved state", async () => {
  const store = createSessionStore(home);
  const bad = sessionFor(app, app.validCookie());
  // A sameSite Playwright refuses: the file reads, the browser will not set it.
  (bad.state.cookies[0] as { sameSite: string }).sameSite = "Sometimes";
  await store.save({ ...bad, site: "badcookie.test" });
  try {
    const snap = await snapshot();
    expect(snap.ok).toBe(false);
    expect(snap.reason).toBe("sessionNotLoaded");
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(store.pathOf("badcookie.test"));
  }
}, 120_000);

type SessionSnap = {
  value: { session: string; sessionDetail: string | null; targets: unknown[] };
};

it("answers session: signedOut on the sign-in page, and still lists its targets", async () => {
  await createSessionStore(home).save(sessionFor(app, "stale"));
  const snap = (await executor.request("snapshot", {
    url: `${app.url}/app`,
  })) as unknown as SessionSnap;
  expect(snap.value.session, JSON.stringify(snap)).toBe("signedOut");
  expect(snap.value.sessionDetail).toContain("npx --prefix ~/ demoman signin");
  expect(snap.value.targets.length).toBeGreaterThan(0);
}, 120_000);

it("answers session: saved when signed in", async () => {
  await createSessionStore(home).save(sessionFor(app, app.validCookie()));
  const signed = (await executor.request("snapshot", {
    url: `${app.url}/app`,
  })) as unknown as SessionSnap;
  expect(signed.value, JSON.stringify(signed)).toMatchObject({
    session: "saved",
    sessionDetail: null,
  });
}, 120_000);

// Final review minor h: a page the sign-in check cannot read says so, and
// the snapshot is still a snapshot.
it("answers session: unchecked, saying why, when the page cannot be checked", async () => {
  const snap = (await executor.request("snapshot", {
    url: `${app.url}/hostile-check`,
  })) as unknown as SessionSnap & { ok: boolean };
  expect(snap.ok, JSON.stringify(snap)).toBe(true);
  expect(snap.value.session, JSON.stringify(snap)).toBe("unchecked");
  expect(snap.value.sessionDetail).toMatch(
    /^the page could not be checked for a sign-in page \(.*hostile check/,
  );
  // The walk survives the page that breaks the check: its button is listed.
  expect(JSON.stringify(snap.value.targets)).toContain("Next");
}, 120_000);

it.skipIf(process.env.DEMOMAN_OFFLINE === "1")(
  "answers session: none for a site with no session",
  async () => {
    const other = (await executor.request("snapshot", {
      url: "https://example.com/",
    })) as unknown as SessionSnap;
    expect(other.value.session, JSON.stringify(other)).toBe("none");
  },
  120_000,
);

// Audit run 1: a page a recorded page opened outlived its call and kept
// running while the next call loaded another account's sessions, so the
// run's write-back could save what it wrote under the wrong account. Red if
// the executor loads sessions without `session.retire()` first.
it("closes a page an earlier call's site opened before the next call loads sessions", async () => {
  const opened = (await executor.request("snapshot", {
    url: `${app.url}/opener`,
  })) as unknown as { ok: boolean };
  expect(opened.ok).toBe(true);
  // Premise: the pop-out the page opened is alive after its call returned.
  await vi.waitFor(() => expect(app.held()).toBe(1), { timeout: 10_000 });
  const next = await snapshot();
  expect(next.ok).toBe(true);
  await vi.waitFor(() => expect(app.held()).toBe(0), { timeout: 10_000 });
}, 120_000);

it("closes it before a run loads sessions too", async () => {
  await executor.request("snapshot", { url: `${app.url}/opener` });
  // Premise: the pop-out is alive when the run is asked for.
  await vi.waitFor(() => expect(app.held()).toBe(1), { timeout: 10_000 });
  const run = (await executor.request("run", {
    script: {
      scriptVersion: 1,
      name: "x",
      target: `${app.url}/opener`,
      steps: [{ do: "waitFor", on: { text: "Opener" }, until: "visible" }],
    },
  })) as { ok: boolean; value?: { outcome: string } };
  // Premise: the run went past its door, where sessions load. How it ends
  // is not this case's business.
  expect(run.ok, JSON.stringify(run)).toBe(true);
  expect(run.value?.outcome, JSON.stringify(run)).not.toBe("refusedBeforeRun");
  // The run's own page opens one pop-out; the earlier call's is gone.
  await vi.waitFor(() => expect(app.held()).toBe(1), { timeout: 10_000 });
}, 120_000);
