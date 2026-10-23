// apps/runner/test/signin.test.ts
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSessionStore,
  type SessionFile,
} from "../src/executor/sessions.js";
import { signin } from "../src/signin.js";
import { type LoginApp, serveLoginApp } from "./login-app.js";

let app: LoginApp;
let home: string;
beforeAll(async () => {
  app = await serveLoginApp();
}, 30_000);
beforeEach(async () => {
  if (home !== undefined) await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), "demoman-signin-"));
});
afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

/** signin's output, collected; a line asking for the sign-in releases the
 *  fixture's `?auto=1` form, so it submits only after signin read the page. */
function collect(lines: string[]) {
  return (l: string) => {
    lines.push(l);
    if (l.includes("press Enter here")) app.releaseSignIn();
  };
}

/** Enter, pressed once `ready` says so: never a fixed sleep. */
function enterWhen(ready: () => boolean) {
  let stop = false;
  return () => ({
    done: (async () => {
      const giveUp = Date.now() + 30_000;
      while (!stop && !ready()) {
        if (Date.now() > giveUp) throw new Error("the fixture never signed in");
        await new Promise((r) => setTimeout(r, 50));
      }
    })(),
    cancel: () => {
      stop = true;
    },
  });
}

it("records the sign-in page, saves the session, verifies it, and exits 0", async () => {
  const lines: string[] = [];
  const before = app.signIns();
  const code = await signin(`${app.url}/app?auto=1`, {
    home,
    headless: true,
    out: collect(lines),
    // The fixture's /login?auto=1 submits itself; Enter once it has.
    enter: enterWhen(() => app.signIns() > before),
  });
  expect(code, lines.join("\n")).toBe(0);
  const path = createSessionStore(home).pathOf("localhost");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const file = JSON.parse(await readFile(path, "utf8"));
  expect(file.signInUrl).toBe(`${app.url}/login`);
  expect(file.state.cookies.map((c: { value: string }) => c.value)).toContain(
    app.validCookie(),
  );
  expect(lines.at(-1)).toBe(`Signed in to localhost; saved ${path}`);
}, 120_000);

it("saves on the window closing, as on Enter", async () => {
  const lines: string[] = [];
  const before = app.signIns();
  let launches = 0;
  const code = await signin(`${app.url}/app?auto=1`, {
    home,
    headless: true,
    out: collect(lines),
    enter: () => ({
      done: new Promise<void>(() => undefined),
      cancel: () => undefined,
    }),
    launchFn: async (o) => {
      const { launch } = await import("../src/launch.js");
      const launched = await launch(o);
      launches += 1;
      // Only the first launch is the signing-in window; the second is the
      // verify browser, which must never be closed.
      if (launches === 1) {
        void (async () => {
          while (app.signIns() <= before)
            await new Promise((r) => setTimeout(r, 50));
          await launched.page.waitForURL(`${app.url}/app`);
          await launched.page.close();
        })();
      }
      return launched;
    },
  });
  expect(code, lines.join("\n")).toBe(0);
  expect(launches, "the window and the verify browser").toBe(2);
  expect(lines.join("\n")).not.toContain("could not be read");
}, 120_000);

it("says it is not signed in, and exits 1, when Enter comes before any sign-in", async () => {
  const lines: string[] = [];
  const code = await signin(`${app.url}/app`, {
    home,
    headless: true,
    out: collect(lines),
    enter: enterWhen(() => true),
  });
  expect(code).toBe(1);
  expect(lines.at(-1)).toBe(
    `demoman signin: saved, but ${app.url}/app still lands on ${app.url}/login?return_to=%2Fapp: not signed in`,
  );
}, 120_000);

// Final review 3: an app that shows its sign-in form at the URL asked for,
// with no redirect, has no other page to recognise; the sign-in is verified
// by the password field going away there.
it("signs in to an app whose sign-in form is the page asked for", async () => {
  const lines: string[] = [];
  const before = app.signIns();
  const code = await signin(`${app.url}/inplace?auto=1`, {
    home,
    headless: true,
    out: collect(lines),
    enter: enterWhen(() => app.signIns() > before),
  });
  // Premise: it asked for a sign-in (the form was there) and one happened.
  expect(lines.join("\n")).toContain("Sign in to localhost in the window");
  expect(app.signIns()).toBeGreaterThan(before);
  expect(code, lines.join("\n")).toBe(0);
  const file = JSON.parse(
    await readFile(createSessionStore(home).pathOf("localhost"), "utf8"),
  );
  expect(file.signInUrl).toBeNull();
}, 120_000);

// Final review 4: a sign-in page reached from script after `load`, not by
// an HTTP redirect, is still the sign-in page.
it("records a sign-in page the app sends the browser to from script", async () => {
  const lines: string[] = [];
  const before = app.signIns();
  const code = await signin(`${app.url}/late?auto=1`, {
    home,
    headless: true,
    out: collect(lines),
    // Enter at once if signin missed the sign-in page: the failure then
    // arrives as its own output rather than as a wait that never ends.
    enter: enterWhen(
      () =>
        app.signIns() > before ||
        lines.some((l) => l.includes("may already be signed in")),
    ),
  });
  expect(code, lines.join("\n")).toBe(0);
  expect(lines.join("\n")).not.toContain("may already be signed in");
  const file = JSON.parse(
    await readFile(createSessionStore(home).pathOf("localhost"), "utf8"),
  );
  expect(file.signInUrl).toBe(`${app.url}/login`);
}, 120_000);

it("does not say signed in when the app sends the check to sign-in from script", async () => {
  const lines: string[] = [];
  const code = await signin(`${app.url}/late`, {
    home,
    headless: true,
    out: collect(lines),
    enter: enterWhen(() => true),
  });
  expect(code, lines.join("\n")).toBe(1);
  expect(lines.at(-1)).toBe(
    `demoman signin: saved, but ${app.url}/late still lands on ${app.url}/login?return_to=%2Flate: not signed in`,
  );
}, 120_000);

it("refuses what is not an http(s) URL with exit 2", async () => {
  const lines: string[] = [];
  expect(
    await signin("file:///etc/hosts", {
      home,
      out: collect(lines),
      enter: enterWhen(() => true),
    }),
  ).toBe(2);
  expect(lines[0]).toContain("not an http(s) URL");
});

it("names the install command when the browser is missing", async () => {
  const lines: string[] = [];
  const code = await signin(`${app.url}/app`, {
    home,
    headless: true,
    executablePath: "/nonexistent/chrome",
    installCommand: "npx demoman@9.9.9 setup",
    out: collect(lines),
    enter: enterWhen(() => true),
  });
  expect(code).toBe(1);
  expect(lines.join("\n")).toContain("npx demoman@9.9.9 setup");
});

it("keeps the session file when it says not signed in", async () => {
  const lines: string[] = [];
  await signin(`${app.url}/app`, {
    home,
    headless: true,
    out: collect(lines),
    enter: enterWhen(() => true),
  });
  const path = createSessionStore(home).pathOf("localhost");
  expect((await stat(path)).isFile(), lines.join("\n")).toBe(true);
});

it("fails, naming the sign-in page itself, when given the sign-in page", async () => {
  const lines: string[] = [];
  const code = await signin(`${app.url}/login`, {
    home,
    headless: true,
    out: collect(lines),
    enter: enterWhen(() => true),
  });
  expect(code, lines.join("\n")).toBe(1);
  expect(lines.at(-1)).toBe(
    `demoman signin: saved, but ${app.url}/login still lands on ${app.url}/login: not signed in — give signin a page behind the login (the app's home, say), not the sign-in page itself`,
  );
}, 120_000);

it("says when the page could not be checked for a sign-in form", async () => {
  const lines: string[] = [];
  await signin(`${app.url}/hostile`, {
    home,
    headless: true,
    out: collect(lines),
    enter: enterWhen(() => true),
  });
  expect(lines.join("\n")).toContain("could not be checked for a sign-in form");
}, 120_000);

it("carries on from a fresh browser when the saved sessions cannot be loaded", async () => {
  const bad: SessionFile = {
    sessionVersion: 1,
    site: "example.org",
    savedAt: "2026-10-15T10:00:00.000Z",
    refreshedAt: null,
    startUrl: "https://example.org/",
    signInUrl: null,
    state: {
      cookies: [
        {
          name: "a",
          value: "b",
          domain: "example.org",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Sometimes" as unknown as "Lax",
        },
      ],
      origins: [],
    },
  };
  await createSessionStore(home).save(bad);
  const lines: string[] = [];
  const before = app.signIns();
  const code = await signin(`${app.url}/app?auto=1`, {
    home,
    headless: true,
    out: collect(lines),
    enter: enterWhen(() => app.signIns() > before),
  });
  expect(code, lines.join("\n")).toBe(0);
  expect(lines.join("\n")).toContain("could not be loaded");
}, 120_000);

it("never copies an account's signInUrl into the site's manual session", async () => {
  const store = createSessionStore(home);
  await store.save({
    sessionVersion: 1,
    site: "localhost",
    savedAt: "2026-10-15T10:00:00.000Z",
    refreshedAt: null,
    startUrl: "http://localhost:4000/app",
    signInUrl: "http://localhost:4000/account-login",
    account: { origin: "http://localhost:4000", name: "seller" },
    state: { cookies: [], origins: [] },
  });
  // Premise: the only saved file for the site is the account's, with a sign-in page.
  const premise = await store.read();
  expect(premise.files.map((f) => [f.account?.name, f.signInUrl])).toEqual([
    ["seller", "http://localhost:4000/account-login"],
  ]);
  const lines: string[] = [];
  // /hostile cannot be checked, so signin keeps an existing manual signInUrl:
  // there is none, so it must be null, not the account's.
  await signin(`${app.url}/hostile`, {
    home,
    headless: true,
    out: collect(lines),
    enter: enterWhen(() => true),
  });
  expect(lines.join("\n")).toContain("could not be checked for a sign-in form");
  const manual = JSON.parse(await readFile(store.pathOf("localhost"), "utf8"));
  expect(manual.signInUrl, lines.join("\n")).toBeNull();
}, 120_000);
