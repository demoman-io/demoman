// apps/runner/test/executor-signed-out.test.ts
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reasonSentence } from "@demoman/replay-engine";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createSessionStore } from "../src/executor/sessions.js";
import type { LocalExecutor } from "../src/executor/types.js";
import {
  type LoginApp,
  SESSION_COOKIE,
  serveLoginApp,
  sessionFor,
} from "./login-app.js";

let app: LoginApp;
let home: string;
let executor: LocalExecutor;
beforeAll(async () => {
  app = await serveLoginApp();
}, 30_000);
beforeEach(async () => {
  await executor?.close();
  if (home !== undefined) await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), "demoman-signed-out-"));
  executor = createLocalExecutor({
    home,
    headless: true,
    log: () => undefined,
  });
});
afterAll(async () => {
  await executor.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
});

type Report = {
  outcome: string;
  stopped?: { reason: string; detail?: string; at?: { index: number } };
  frames?: { keyframes: number };
  steps?: { pageUrl: string | null }[];
  provenance?: { takeId: string | null };
  landing?: unknown;
  notStored?: { what: string; error: string }[];
};
const run = async (steps: unknown[], extra: Record<string, unknown> = {}) => {
  const out = (await executor.request("run", {
    script: {
      scriptVersion: extra.device === undefined ? 1 : 4,
      name: "behind the login",
      target: `${app.url}/app`,
      ...(extra.device === undefined
        ? { viewport: { width: 1024, height: 640 } }
        : {}),
      steps,
      ...extra,
    },
  })) as { ok: boolean; value: Report };
  expect(out.ok, JSON.stringify(out)).toBe(true);
  return out.value;
};
const takes = async () =>
  readdir(join(home, "takes")).catch(() => [] as string[]);
const NEXT = [{ do: "waitForLoad" }, { do: "click", on: { text: "Next" } }];

it("films behind the login with a valid saved session (positive control)", async () => {
  await createSessionStore(home).save(sessionFor(app, app.validCookie()));
  const report = await run(NEXT);
  expect(report.outcome, JSON.stringify(report)).toBe("complete");
  expect(report.provenance?.takeId).toBeTruthy();
}, 120_000);

it("stops an expired session as signedOut before any frame, keeping no take", async () => {
  await createSessionStore(home).save(sessionFor(app, "stale"));
  const report = await run(NEXT);
  expect(report.stopped?.reason, JSON.stringify(report)).toBe("signedOut");
  expect(report.stopped?.detail).toContain("has expired");
  expect(report.stopped?.detail).toContain(
    `npx --prefix ~/ demoman signin ${app.url}/app`,
  );
  expect(report.stopped?.detail).toContain("Nothing was recorded.");
  expect(report.stopped?.at?.index).toBe(0);
  expect(report.frames?.keyframes).toBe(0);
  expect(report.provenance?.takeId ?? null).toBeNull();
  expect(await takes()).toEqual([]);
}, 120_000);

// Final review residual 2: an app that shows its sign-in form in place has
// no redirect for the check to see.
it("stops an expired in-place session as signedOut before any frame, and films a valid one", async () => {
  const inPlace = (value: string) => ({
    ...sessionFor(app, value),
    startUrl: `${app.url}/inplace`,
    signInUrl: null,
  });
  const ask = (steps: unknown[]) =>
    run(steps, { target: `${app.url}/inplace` });
  await createSessionStore(home).save(inPlace(app.validCookie()));
  const good = await ask([{ do: "waitForLoad" }]);
  // Positive control: the same page, signed in, shows no form and films.
  expect(good.outcome, JSON.stringify(good)).toBe("complete");
  expect(good.provenance?.takeId).toBeTruthy();
  const before = await takes();
  await createSessionStore(home).save(inPlace("stale"));
  const asked = app.gets("/inplace");
  const logins = app.gets("/login");
  const report = await ask([{ do: "waitForLoad" }]);
  // Premise: no redirect — the browser asked for the page itself, and never
  // for the sign-in page.
  expect(app.gets("/inplace")).toBeGreaterThan(asked);
  expect(app.gets("/login")).toBe(logins);
  expect(report.stopped?.reason, JSON.stringify(report)).toBe("signedOut");
  expect(report.stopped?.detail).toContain(
    "shows its sign-in form at /inplace",
  );
  expect(report.stopped?.detail).toContain("has expired");
  expect(report.stopped?.detail).toContain("Nothing was recorded.");
  expect(report.frames?.keyframes).toBe(0);
  expect(await takes()).toEqual(before);
}, 120_000);

it("stops a site never signed in, saying so", async () => {
  const report = await run(NEXT);
  expect(report.stopped?.reason).toBe("signedOut");
  expect(report.stopped?.detail).toContain(
    "no session was ever saved for localhost",
  );
  // Stopped before filming, not caught after the run by the post-run check.
  expect(report.stopped?.detail).toContain("Nothing was recorded.");
  expect(await takes()).toEqual([]);
}, 120_000);

it("re-labels a run that stopped on a sign-in page mid-run as signedOut, keeping no take", async () => {
  await createSessionStore(home).save(sessionFor(app, app.validCookie()));
  const report = await run([
    { do: "waitForLoad" },
    { do: "click", on: { text: "Sign out" } },
    { do: "waitForLoad" },
    { do: "click", on: { text: "Next" } },
  ]);
  // Premise: the run got as far as signing out — it stopped at the last
  // step, after the sign-out and its waitForLoad, not before filming.
  expect(report.outcome, JSON.stringify(report)).toBe("stopped");
  expect(report.stopped?.at?.index, JSON.stringify(report)).toBe(3);
  expect(report.steps?.[3]?.pageUrl).toContain("/login");
  expect(report.stopped?.reason).toBe("signedOut");
  expect(report.stopped?.detail).not.toContain("Nothing was recorded.");
  expect(report.stopped?.detail).toContain("The take was not kept");
  // The run's own stop is not erased by the re-label.
  expect(report.stopped?.detail).toContain(
    `The run itself stopped at script step 4: ${reasonSentence("unresolvedAnchor")}.`,
  );
  expect(await takes()).toEqual([]);
}, 120_000);

// Review focus 4: a demo that ends by signing out is kept.
it("keeps a run that completes on the sign-in page, and its saved session as it was", async () => {
  const valid = app.validCookie();
  await createSessionStore(home).save(sessionFor(app, valid));
  const loginsBefore = app.gets("/login");
  const report = await run([
    { do: "waitForLoad" },
    { do: "click", on: { text: "Sign out" } },
    { do: "waitForLoad" },
  ]);
  expect(report.outcome, JSON.stringify(report)).toBe("complete");
  expect(report.provenance?.takeId).toBeTruthy();
  // Premise: the run really ended on the sign-in page. The report does not
  // carry the last URL; the server saw the browser fetch it.
  expect(app.gets("/login")).toBeGreaterThan(loginsBefore);
  // A sign-out demo does not overwrite the session it signed out of.
  expect(report.notStored, JSON.stringify(report)).toBeUndefined();
  const saved = JSON.parse(
    await readFile(createSessionStore(home).pathOf("localhost"), "utf8"),
  ) as {
    refreshedAt: string | null;
    state: { cookies: { name: string; value: string }[] };
  };
  expect(saved.refreshedAt).toBeNull();
  expect(
    saved.state.cookies.find((c) => c.name === SESSION_COOKIE)?.value,
  ).toBe(valid);
}, 120_000);

// Final review 2: a sign-out demo leaves the context signed out and its file
// untouched (write-back skipped), so nothing on disk changes — and the next
// run must still start from the saved session, not be told it expired.
it("starts the run after a sign-out demo from the saved session again", async () => {
  await createSessionStore(home).save(sessionFor(app, app.validCookie()));
  const loginsBefore = app.gets("/login");
  const signOut = await run([
    { do: "waitForLoad" },
    { do: "click", on: { text: "Sign out" } },
    { do: "waitForLoad" },
  ]);
  // Premise: the demo completed on the sign-in page and left the file as
  // it was — the case where no file change would trigger a reload.
  expect(signOut.outcome, JSON.stringify(signOut)).toBe("complete");
  expect(app.gets("/login")).toBeGreaterThan(loginsBefore);
  const saved = JSON.parse(
    await readFile(createSessionStore(home).pathOf("localhost"), "utf8"),
  ) as { refreshedAt: string | null };
  expect(saved.refreshedAt).toBeNull();
  const next = await run(NEXT);
  expect(next.outcome, JSON.stringify(next)).toBe("complete");
  expect(next.stopped?.reason).toBeUndefined();
  expect(next.provenance?.takeId).toBeTruthy();
}, 120_000);

// Final review minor a: a sign-out that ends on a public page is not caught
// by the sign-in page check, and must not write its signed-out state over a
// session that may still be good.
it("keeps the saved session when a run ends without a cookie the session held", async () => {
  const valid = app.validCookie();
  const store = createSessionStore(home);
  await store.save(sessionFor(app, valid));
  const goodbyes = app.gets("/goodbye");
  const report = await run([
    { do: "waitForLoad" },
    { do: "click", on: { text: "Leave" } },
    { do: "waitForLoad" },
  ]);
  // Premise: the run completed on the public page, not the sign-in page.
  expect(report.outcome, JSON.stringify(report)).toBe("complete");
  expect(app.gets("/goodbye")).toBeGreaterThan(goodbyes);
  expect(report.notStored, JSON.stringify(report)).toBeUndefined();
  const saved = JSON.parse(
    await readFile(store.pathOf("localhost"), "utf8"),
  ) as {
    refreshedAt: string | null;
    state: { cookies: { name: string; value: string }[] };
  };
  expect(saved.refreshedAt).toBeNull();
  expect(
    saved.state.cookies.find((c) => c.name === SESSION_COOKIE)?.value,
  ).toBe(valid);
}, 120_000);

// Final review residual 1: a short-lived cookie (OAuth state, CSRF) that
// lapsed in the file is not a sign-out, and must not stop every later
// write-back.
it("still writes the session back when a cookie in the file had already expired", async () => {
  const store = createSessionStore(home);
  const file = sessionFor(app, app.validCookie());
  const lapsedAt = Math.floor(Date.now() / 1000) - 60;
  const [live] = file.state.cookies;
  if (live === undefined) throw new Error("sessionFor holds no cookie");
  file.state.cookies.push({
    ...live,
    name: "oauth_state",
    value: "spent",
    expires: lapsedAt,
  });
  await store.save(file);
  // Premise: the file holds a cookie past its own expiry, beside a live one.
  const held = JSON.parse(
    await readFile(store.pathOf("localhost"), "utf8"),
  ) as {
    state: { cookies: { name: string; expires: number }[] };
  };
  expect(held.state.cookies.map((c) => [c.name, c.expires])).toEqual([
    [SESSION_COOKIE, -1],
    ["oauth_state", lapsedAt],
  ]);
  expect(lapsedAt * 1000).toBeLessThan(Date.now());
  const report = await run(NEXT);
  expect(report.outcome, JSON.stringify(report)).toBe("complete");
  expect(report.notStored, JSON.stringify(report)).toBeUndefined();
  const saved = JSON.parse(
    await readFile(store.pathOf("localhost"), "utf8"),
  ) as {
    refreshedAt: string | null;
    state: { cookies: { name: string }[] };
  };
  expect(saved.refreshedAt).not.toBeNull();
  expect(saved.state.cookies.map((c) => c.name)).toEqual([SESSION_COOKIE]);
}, 120_000);

// Final review minor d: a redirect's query (a token, an invite) stays out
// of the report's note.
it("notes where the start URL went as origin and path only", async () => {
  const out = (await executor.request("run", {
    script: {
      scriptVersion: 1,
      name: "moved",
      target: `${app.url}/moved`,
      viewport: { width: 1024, height: 640 },
      steps: [{ do: "waitForLoad" }],
    },
  })) as { value: Report };
  expect(out.value.outcome, JSON.stringify(out.value)).toBe("complete");
  expect(out.value.landing).toEqual({ startedElsewhere: `${app.url}/goodbye` });
}, 120_000);

// An in-app page with a password field (change password, sudo mode) is not a
// sign-in page: a run that stops there keeps its own reason and its take.
it("does not re-label a run that stopped on an in-app password page", async () => {
  await createSessionStore(home).save(sessionFor(app, app.validCookie()));
  const report = await run([
    { do: "waitForLoad" },
    { do: "click", on: { text: "Change password" } },
    { do: "waitForLoad" },
    { do: "click", on: { text: "No such button" } },
  ]);
  // Premise: it stopped on the password page, after reaching it.
  expect(report.outcome, JSON.stringify(report)).toBe("stopped");
  expect(report.stopped?.at?.index, JSON.stringify(report)).toBe(3);
  expect(report.steps?.[3]?.pageUrl).toContain("/account/password");
  expect(report.stopped?.reason).not.toBe("signedOut");
  expect(report.provenance?.takeId).toBeTruthy();
  expect(await takes()).toEqual([report.provenance?.takeId]);
}, 120_000);

// Report before you forgive: a run that stopped on a page the check could
// not read says so, rather than reading as "checked, not a sign-in page".
it("says landing.unchecked when a stopped run's page cannot be checked", async () => {
  await createSessionStore(home).save(sessionFor(app, app.validCookie()));
  const report = await run([
    { do: "waitForLoad" },
    { do: "click", on: { text: "Hostile page" } },
    { do: "waitForLoad" },
    { do: "click", on: { text: "No such button" } },
  ]);
  // Premise: the start page was readable (no note from the start check),
  // and the run stopped on the hostile page.
  expect(report.outcome, JSON.stringify(report)).toBe("stopped");
  expect(report.stopped?.at?.index, JSON.stringify(report)).toBe(3);
  expect(report.steps?.[3]?.pageUrl).toContain("/hostile");
  expect(report.landing, JSON.stringify(report)).toMatchObject({
    unchecked: expect.stringMatching(
      /^the page the run stopped on could not be checked for a sign-in page: .*hostile page/,
    ),
  });
  expect(report.stopped?.reason).not.toBe("signedOut");
}, 120_000);

// A site with no saved session cannot lapse mid-run: a public page with a
// password field (sign-up) that a run stops on keeps the run's own reason.
it("does not re-label a stop on a password page of a site with no saved session", async () => {
  // Premise: no session file at all.
  expect((await createSessionStore(home).read()).files).toEqual([]);
  const out = (await executor.request("run", {
    script: {
      scriptVersion: 1,
      name: "sign up",
      target: `${app.url}/login`,
      viewport: { width: 1024, height: 640 },
      steps: [
        { do: "waitForLoad" },
        { do: "click", on: { text: "Create account" } },
        { do: "waitForLoad" },
        { do: "click", on: { text: "No such button" } },
      ],
    },
  })) as { ok: boolean; value: Report };
  const report = out.value;
  // Premise: it stopped on /signup, after reaching it.
  expect(report.outcome, JSON.stringify(out)).toBe("stopped");
  expect(report.stopped?.at?.index, JSON.stringify(report)).toBe(3);
  expect(report.steps?.[3]?.pageUrl).toContain("/signup");
  expect(report.stopped?.reason).not.toBe("signedOut");
  expect(report.provenance?.takeId).toBeTruthy();
  expect(await takes()).toEqual([report.provenance?.takeId]);
}, 120_000);

// Review focus 5: a phone run on a lapsed session is signedOut, not a script fault.
it("stops a phone run on the sign-in page as signedOut", async () => {
  await createSessionStore(home).save(sessionFor(app, "stale"));
  const report = await run(NEXT, { device: "phone" });
  expect(report.stopped?.reason, JSON.stringify(report)).toBe("signedOut");
  expect(report.stopped?.detail).toContain("Nothing was recorded.");
  expect(await takes()).toEqual([]);
}, 120_000);

it("writes the session back after a signed-in run", async () => {
  const store = createSessionStore(home);
  await store.save(sessionFor(app, app.validCookie()));
  const report = await run(NEXT);
  expect(report.outcome).toBe("complete");
  const saved = JSON.parse(await readFile(store.pathOf("localhost"), "utf8"));
  expect(saved.refreshedAt).not.toBeNull();
  expect(saved.savedAt).toBe("2026-10-15T09:00:00.000Z");
}, 120_000);

// Root ignores a read-only folder, so the write cannot be made to fail
// there (a container CI job runs as root); GitHub's hosted runners do not.
it.skipIf(process.getuid?.() === 0)(
  "says in notStored when the write-back fails, and keeps the take",
  async () => {
    const store = createSessionStore(home);
    await store.save(sessionFor(app, app.validCookie()));
    const { chmod } = await import("node:fs/promises");
    await chmod(store.dir, 0o500);
    try {
      const report = await run(NEXT);
      expect(report.outcome).toBe("complete");
      expect(report.provenance?.takeId).toBeTruthy();
      expect(report.notStored?.map((n) => n.what)).toContain("session");
    } finally {
      await chmod(store.dir, 0o700);
    }
  },
  120_000,
);

it("says landing.unchecked when the page cannot be checked, and films on", async () => {
  const out = (await executor.request("run", {
    script: {
      scriptVersion: 1,
      name: "hostile page",
      target: `${app.url}/hostile`,
      viewport: { width: 1024, height: 640 },
      steps: [{ do: "waitForLoad" }],
    },
  })) as { value: Report };
  expect(out.value.landing, JSON.stringify(out.value)).toMatchObject({
    unchecked: expect.stringContaining("hostile page"),
  });
  // Films on: the start check's failure costs nothing but the note.
  expect(out.value.outcome).toBe("complete");
  expect(out.value.provenance?.takeId).toBeTruthy();
  expect(out.value.stopped?.reason).not.toBe("signedOut");
}, 120_000);

it("stops a re-film as signedOut once the session has lapsed", async () => {
  await createSessionStore(home).save(sessionFor(app, app.validCookie()));
  const first = await run(NEXT);
  const takeId = first.provenance?.takeId;
  expect(takeId).toBeTruthy();
  app.expireAll();
  const out = (await executor.request("run", { takeId })) as { value: Report };
  expect(out.value.stopped?.reason, JSON.stringify(out.value)).toBe(
    "signedOut",
  );
  expect(out.value.stopped?.detail).toContain("Nothing was recorded.");
  // The take it re-filmed stays; the re-film leaves nothing beside it.
  expect(await takes()).toEqual([takeId]);
}, 120_000);
