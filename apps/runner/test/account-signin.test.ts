import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describeStep, signInAccount } from "../src/executor/account-signin.js";
import { accountDefinition, parseAccounts } from "../src/executor/accounts.js";
import { createSecretSweep } from "../src/executor/secrets-env.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { boundTo, type LoginApp, serveLoginApp } from "./login-app.js";

const PASSWORD = "correct-horse-battery";
let app: LoginApp;
let other: LoginApp;
let repo: string;
let home: string;
beforeAll(async () => {
  app = await serveLoginApp({
    accounts: {
      "seller@demo.test": PASSWORD,
      "customer@demo.test": `${PASSWORD}-c`,
    },
  });
  other = await serveLoginApp({ accounts: {} });
}, 30_000); // starts two local HTTP servers: well under 1 s here
afterAll(async () => {
  await app.close();
  await other.close();
});
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "demoman-acct-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await mkdir(join(repo, ".demoman"));
  await writeFile(join(repo, ".gitignore"), ".demoman/secrets.env\n");
  home = await mkdtemp(join(tmpdir(), "demoman-acct-home-"));
});

const steps = (
  start = "/login",
  email = "seller@demo.test",
  secret = "KL_SELLER",
) => [
  { do: "goto", url: start },
  { do: "type", into: { stableId: "user_email" }, text: email },
  {
    do: "type",
    into: { stableId: "user_password" },
    text: `{secret:${secret}}`,
  },
  { do: "click", on: { role: "button", name: "Sign in" } },
];
const chosen = (
  signIn: unknown[],
  name = "seller",
  on: LoginApp = app,
  checkUrl = "/app",
) => {
  const r = parseAccounts(
    join(repo, ".demoman", "accounts.json"),
    JSON.stringify({
      accountsVersion: 1,
      sites: {
        [on.url]: {
          default: name,
          accounts: {
            [name]: { about: "a demo seller", checkUrl, signIn },
          },
        },
      },
    }),
  );
  if (!r.ok) throw new Error(r.detail);
  const site = r.file.sites.get(on.url);
  const account = site?.accounts.get(name);
  if (site === undefined || account === undefined)
    throw new Error("no account");
  return { file: r.file, site, account };
};
/** `env` bound to `on` (the app the account signs in to), unless `raw`. */
const deps = (
  env: NodeJS.ProcessEnv = { DEMOMAN_SECRET_KL_SELLER: PASSWORD },
  on: LoginApp | "raw" = app,
) => {
  const logs: string[] = [];
  return {
    logs,
    deps: {
      store: createSessionStore(home),
      env: on === "raw" ? env : boundTo(env, on.url),
      sweep: createSecretSweep(),
      log: (l: string) => logs.push(l),
    },
  };
};
const everything = async (): Promise<string> => {
  const files = await readdir(home, { recursive: true });
  const texts = await Promise.all(
    files.map((f) => readFile(join(home, f), "utf8").catch(() => "")),
  );
  return texts.join("\n");
};

describe("signInAccount", () => {
  it("signs in, proves it at checkUrl, and saves the account's session", async () => {
    const before = app.signInsAs("seller@demo.test");
    const { deps: d } = deps();
    const r = await signInAccount(chosen(steps()), d);
    if (!r.ok) throw new Error(r.detail);
    expect(app.signInsAs("seller@demo.test")).toBe(before + 1);
    expect(r.path).toBe(
      createSessionStore(home).pathOfAccount(app.url, "seller"),
    );
    expect(r.file.account).toEqual({
      origin: app.url,
      name: "seller",
      definition: accountDefinition(chosen(steps()).account),
    });
    expect(r.file.signInUrl).toBe(`${app.url}/login`);
    expect(r.steps).toBe(4);
    expect(await everything()).not.toContain(PASSWORD);
  }, 60_000); // 1.9 s here; 5x is 9.4 s

  it("reads the secret from secrets.env when the environment has none", async () => {
    await writeFile(
      join(repo, ".demoman", "secrets.env"),
      `DEMOMAN_SECRET_KL_SELLER=${PASSWORD}\nDEMOMAN_SECRET_KL_SELLER_ORIGIN=${app.url}\n`,
    );
    const { deps: d } = deps({});
    const r = await signInAccount(chosen(steps()), d);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 60_000); // 1.8 s here; 5x is 9.1 s

  it("fails a wrong password as signInFailed after one sign-in, without the value", async () => {
    const before = app.signIns();
    const { deps: d, logs } = deps({
      DEMOMAN_SECRET_KL_SELLER: "wrong-password-here",
    });
    const r = await signInAccount(chosen(steps()), d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("signInFailed");
    expect(app.signIns()).toBe(before + 1);
    // Premise: the app echoed the typed value back on its page.
    expect(app.lastPage()).toContain("wrong-password-here");
    expect(r.detail).not.toContain("wrong-password-here");
    expect(logs.join("\n")).not.toContain("wrong-password-here");
    expect(r.detail).toContain("/app");
  }, 60_000); // 1.8 s here; 5x is 8.9 s

  it("does not prove a wrong password when checkUrl shows the form in place (final review I1)", async () => {
    // Premise 1: /inplace answers a signed-out browser with the form at its
    // own URL, no redirect.
    const probe = await fetch(`${app.url}/inplace`, { redirect: "manual" });
    expect(probe.status).toBe(200);
    expect(await probe.text()).toContain('type="password"');
    const before = app.signIns();
    const { deps: d } = deps({
      DEMOMAN_SECRET_KL_SELLER: "wrong-password-here",
    });
    const r = await signInAccount(
      chosen(steps(), "seller", app, "/inplace"),
      d,
    );
    // Premise 2: the steps really posted (the wrong password was tried).
    expect(app.signIns()).toBe(before + 1);
    expect(r.ok, JSON.stringify(r)).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("signInFailed");
    expect(r.detail).toContain("/inplace");
    expect(r.detail).toContain("password field");
    expect(r.detail).not.toContain("wrong-password-here");
    const written = (await readdir(home, { recursive: true })).filter((f) =>
      f.endsWith(".json"),
    );
    expect(written).toEqual([]);
  }, 60_000); // 1.8 s here; 5x is 8.9 s

  it("proves a right password through an in-place checkUrl (the form gone)", async () => {
    const { deps: d } = deps();
    const r = await signInAccount(
      chosen(steps(), "seller", app, "/inplace"),
      d,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 60_000); // 1.8 s here; 5x is 8.9 s

  it("waits for a form that submits after the click (Review Focus 1)", async () => {
    const { deps: d } = deps();
    const r = await signInAccount(chosen(steps("/login-late")), d);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 60_000); // 2.2 s here; 5x is 11 s

  // CI, 2026-10-17: the four late-submit cases failed there with checkUrl's
  // goto "interrupted by another navigation" to the same /app. The wait saw
  // the form's navigation start, asked whether the page was quiet — the OLD
  // page, which long had been, so at once — and went to checkUrl just as
  // the form's navigation committed. A renderer slowed 20x opens that gap
  // here as CI's machine did: red 3 of 3 before the fix, at CI's ~1.8 s.
  it("waits for a late submit on a renderer slowed as CI's was", async () => {
    const { deps: d } = deps();
    const r = await signInAccount(chosen(steps("/login-late")), {
      ...d,
      onSignInPage: async (page) => {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
      },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 120_000);

  it("waits for a late submit even when the page was quiet before the click", async () => {
    const { deps: d } = deps();
    const late = steps("/login-late");
    late.splice(3, 0, { do: "pause", ms: 800 } as never);
    const r = await signInAccount(chosen(late), d);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 60_000); // 3.0 s here; 5x is 15 s

  it("refuses to save a session in which the app stored the password", async () => {
    const leaky = await serveLoginApp({
      accounts: { "seller@demo.test": PASSWORD },
      leakPasswordToStorage: true,
    });
    try {
      const { deps: d } = deps(undefined, leaky);
      const r = await signInAccount(chosen(steps(), "seller", leaky), d);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("signInFailed");
      // Premise: the app really signed in (the refusal is about storage).
      expect(leaky.signInsAs("seller@demo.test")).toBe(1);
      expect(r.detail).toContain("{secret:KL_SELLER}");
      expect(r.detail).toContain("localStorage");
      expect(r.detail).not.toContain(PASSWORD);
      const written = (await readdir(home, { recursive: true })).filter((f) =>
        f.endsWith(".json"),
      );
      expect(written).toEqual([]);
    } finally {
      await leaky.close();
    }
  }, 60_000); // 1.8 s here; 5x is 8.9 s

  it("refuses to save a session in which the app stored the password URL-encoded (review 2026-10-16)", async () => {
    const special = "p@ss w0rd!x-long";
    const leaky = await serveLoginApp({
      accounts: { "seller@demo.test": special },
      leakEncodedPasswordToCookie: true,
    });
    try {
      const { deps: d } = deps({ DEMOMAN_SECRET_KL_SELLER: special }, leaky);
      const r = await signInAccount(chosen(steps(), "seller", leaky), d);
      // Premise: the app really signed in, and the cookie holds a form
      // that is not the value as typed.
      expect(leaky.signInsAs("seller@demo.test")).toBe(1);
      expect(encodeURIComponent(special)).not.toBe(special);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("signInFailed");
      expect(r.detail).toContain("{secret:KL_SELLER} in its cookie remembered");
      const written = (await readdir(home, { recursive: true })).filter((f) =>
        f.endsWith(".json"),
      );
      expect(written).toEqual([]);
    } finally {
      await leaky.close();
    }
  }, 60_000); // 1.8 s here; 5x is 8.8 s

  it("counts the submit's navigation when a wait follows it (review 2026-10-16)", async () => {
    const { deps: d, logs } = deps();
    const r = await signInAccount(
      chosen([...steps(), { do: "waitForLoad" }]),
      d,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // Premise: the line this test looks for is the one the wait writes.
    expect(logs.join("\n")).toContain("signed in as seller");
    expect(logs.join("\n")).not.toContain("no page navigation followed");
  }, 60_000); // 1.8 s here; 5x is 8.8 s

  it("stamps savedAt when it saves, not when the steps ended (review 2026-10-16)", async () => {
    let calls = 0;
    const times = [
      new Date("2026-10-16T10:00:00.000Z"),
      new Date("2026-10-16T10:00:09.000Z"),
    ];
    const { deps: d } = deps();
    const r = await signInAccount(chosen(steps()), {
      ...d,
      now: () => times[Math.min(calls++, times.length - 1)] as Date,
    });
    if (!r.ok) throw new Error(r.detail);
    // Premise: now() was asked for the candidate and again at the save.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(r.file.savedAt).toBe("2026-10-16T10:00:09.000Z");
  }, 60_000); // 1.8 s here; 5x is 8.9 s

  it("ends at its bound when checkUrl never answers, naming it", async () => {
    const { deps: d } = deps();
    const deadlineMs = 8_000;
    const started = Date.now();
    const r = await signInAccount(chosen(steps(), "seller", app, "/hang"), {
      ...d,
      deadlineMs,
    });
    const elapsed = Date.now() - started;
    // Premise: the steps signed in and the check reached the held route.
    expect(app.gets("/hang")).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("signInFailed");
    expect(r.detail).toContain("/hang");
    // Browser start-up and close sit outside the bound: 8 s of slack.
    expect(elapsed, r.detail).toBeLessThan(deadlineMs + 8_000);
  }, 60_000); // 8.0 s here; 5x is 40 s

  it("waits for a late submit on a page that rewrites its URL when the button is clicked", async () => {
    const { deps: d } = deps();
    const late = steps("/login-late-replace");
    late.splice(3, 0, { do: "pause", ms: 800 } as never);
    const loadBefore = app.gets("/rewrote-load");
    const clickBefore = app.gets("/rewrote-click");
    const r = await signInAccount(chosen(late), d);
    // Premise: the page rewrote its URL on load and again at the click (the
    // fixture reports each rewrite with a GET).
    expect(app.gets("/rewrote-load"), "rewrite on load").toBe(loadBefore + 1);
    expect(app.gets("/rewrote-click"), "rewrite at click").toBe(
      clickBefore + 1,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 60_000); // 3.0 s here; 5x is 15 s

  it("waits for a late submit on the second page of a two-page sign-in", async () => {
    const { deps: d } = deps();
    const r = await signInAccount(
      chosen([
        { do: "goto", url: "/login-email" },
        {
          do: "type",
          into: { stableId: "user_email" },
          text: "seller@demo.test",
        },
        { do: "click", on: { role: "button", name: "Next" } },
        {
          do: "type",
          into: { stableId: "user_password" },
          text: "{secret:KL_SELLER}",
        },
        { do: "pause", ms: 800 },
        { do: "click", on: { role: "button", name: "Sign in" } },
      ]),
      d,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 60_000); // 3.0 s here; 5x is 15 s

  it("never types a secret on another origin (secretOffOrigin)", async () => {
    const { deps: d } = deps();
    const bounce = `/bounce?to=${encodeURIComponent(`${other.url}/login`)}`;
    const r = await signInAccount(chosen(steps(bounce)), d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("secretOffOrigin");
    expect(r.detail).toContain(other.url);
    // Premise: the browser did reach the other origin's sign-in page.
    expect(other.gets("/login")).toBeGreaterThan(0);
    expect(other.bodies().join("\n")).not.toContain(PASSWORD);
  }, 60_000); // 0.7 s here; 5x is 3.5 s

  // Red: read the origin with `handle.evaluate((e) =>
  // e.ownerDocument.location.origin)`, which the page's own getter answers.
  it("never types a secret on another origin whose page claims to be the site's", async () => {
    const { deps: d } = deps();
    const forged = `${other.url}/forged-login?claim=${encodeURIComponent(app.url)}`;
    const bounce = `/bounce?to=${encodeURIComponent(forged)}`;
    const bodies = other.bodies().length;
    const r = await signInAccount(chosen(steps(bounce)), d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason, r.detail).toBe("secretOffOrigin");
    // Premise: the browser reached the forging page. That its forgery
    // fools a page-world read is shown by the red run, which leaks.
    expect(other.gets("/forged-login")).toBeGreaterThan(0);
    expect(other.bodies().slice(bodies).join("\n")).not.toContain(PASSWORD);
  }, 60_000); // 0.7 s here; 5x is 3.5 s

  it("names a missing secret before opening anything", async () => {
    const gets = app.gets("/login");
    const { deps: d } = deps({});
    const r = await signInAccount(chosen(steps()), d);
    expect(!r.ok && r.reason).toBe("secretMissing");
    expect(app.gets("/login")).toBe(gets);
  }, 60_000); // 0.0 s here; 5x is 0.1 s

  it("refuses an environment secret with no _ORIGIN before opening anything (rc.3)", async () => {
    const gets = app.gets("/login");
    // Premise: the environment holds the right password, and nothing binds it.
    const env = { DEMOMAN_SECRET_KL_SELLER: PASSWORD };
    const { deps: d } = deps(env, "raw");
    expect(Object.keys(d.env)).toEqual(["DEMOMAN_SECRET_KL_SELLER"]);
    const r = await signInAccount(chosen(steps()), d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("secretUnbound");
    expect(r.detail).toContain("set DEMOMAN_SECRET_KL_SELLER_ORIGIN");
    expect(r.detail).toContain(`this sign-in is for ${app.url}`);
    expect(r.detail).not.toContain(PASSWORD);
    expect(app.gets("/login")).toBe(gets);
  }, 60_000); // 0.0 s here; 5x is 0.1 s

  it("refuses an environment secret bound to another site before opening anything (rc.3)", async () => {
    const gets = app.gets("/login");
    const signIns = app.signIns();
    const { deps: d } = deps({ DEMOMAN_SECRET_KL_SELLER: PASSWORD }, other);
    // Premise: the binding names a real, different site.
    expect(other.url).not.toBe(app.url);
    expect(d.env.DEMOMAN_SECRET_KL_SELLER_ORIGIN).toBe(other.url);
    const r = await signInAccount(chosen(steps()), d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("secretOffOrigin");
    expect(r.detail).toContain(other.url);
    expect(r.detail).not.toContain(PASSWORD);
    expect(app.gets("/login")).toBe(gets);
    expect(app.signIns()).toBe(signIns);
  }, 60_000); // 0.0 s here; 5x is 0.1 s

  it("names a field that vanished without the value (Review Focus 2)", async () => {
    const { deps: d } = deps();
    const r = await signInAccount(chosen(steps("/vanishing-login")), d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("signInFailed");
    expect(r.detail).toContain("step 3");
    expect(r.detail).not.toContain(PASSWORD);
  }, 60_000); // 11 s here; 5x is 54 s

  it("records where checkUrl sends a signed-out browser as the sign-in page, not the first goto (C2 check, 2026-10-16)", async () => {
    // Premise: /magic sends a signed-out browser to a page with no password
    // field, and the steps start somewhere else (a dev route).
    const probe = await fetch(`${app.url}/magic`, { redirect: "manual" });
    expect(probe.headers.get("location")).toContain("/magic-login");
    const wall = await (await fetch(`${app.url}/magic-login`)).text();
    expect(wall).not.toContain('type="password"');
    const { deps: d } = deps({});
    const r = await signInAccount(
      chosen(
        [{ do: "goto", url: "/dev/sign-in-as?email=seller@demo.test" }],
        "seller",
        app,
        "/magic",
      ),
      d,
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.file.signInUrl).toBe(`${app.url}/magic-login`);
  }, 60_000); // 1.7 s here; 5x is 8.5 s

  it("fails a dev route that did not sign in, though the wall has no password field", async () => {
    const before = app.gets("/dev/sign-in-as");
    const { deps: d } = deps({});
    const r = await signInAccount(
      chosen(
        [{ do: "goto", url: "/dev/sign-in-as?email=nobody@demo.test" }],
        "seller",
        app,
        "/magic",
      ),
      d,
    );
    // Premise: the steps really reached the route (it answered 404).
    expect(app.gets("/dev/sign-in-as")).toBe(before + 1);
    expect(r.ok, JSON.stringify(r)).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("signInFailed");
    expect(r.detail).toContain("/magic-login");
    const written = (await readdir(home, { recursive: true })).filter((f) =>
      f.endsWith(".json"),
    );
    expect(written).toEqual([]);
  }, 60_000); // 1.7 s here; 5x is 8.3 s

  it("refuses a checkUrl a signed-out browser can open, before typing anything", async () => {
    const before = app.signIns();
    const { deps: d } = deps();
    const r = await signInAccount(
      chosen(steps(), "seller", app, "/goodbye"),
      d,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("signInFailed");
    expect(r.detail).toContain("/goodbye");
    expect(r.detail).toContain("only a signed-in user can open");
    expect(app.signIns()).toBe(before);
  }, 60_000); // 0.6 s here; 5x is 3.2 s

  it("names a change-password checkUrl as the problem, not the password (C2 residual r1)", async () => {
    const before = app.signInsAs("seller@demo.test");
    const { deps: d } = deps();
    const r = await signInAccount(
      chosen(steps(), "seller", app, "/account/password"),
      d,
    );
    // Premise: the right password signed in.
    expect(app.signInsAs("seller@demo.test")).toBe(before + 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("signInFailed");
    expect(r.detail).toContain("signed in");
    expect(r.detail).toContain("not a change-password page");
    expect(r.detail).not.toContain("its password");
  }, 60_000); // 1.8 s here; 5x is 8.9 s

  it("signs in once for two callers at the same time", async () => {
    const before = app.signInsAs("seller@demo.test");
    const since = new Date();
    const [a, b] = await Promise.all([
      signInAccount(chosen(steps()), {
        ...deps().deps,
        reuseSavedSince: since,
      }),
      signInAccount(chosen(steps()), {
        ...deps().deps,
        reuseSavedSince: since,
      }),
    ]);
    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
    expect(app.signInsAs("seller@demo.test")).toBe(before + 1);
    expect([a, b].filter((r) => r.ok && r.reused)).toHaveLength(1);
  }, 90_000); // 2.0 s here; 5x is 10 s
});

describe("describeStep", () => {
  it("shows a secret by name, never by value", () => {
    expect(
      describeStep({
        do: "type",
        into: { stableId: "user_password" },
        text: "{secret:KL_SELLER}",
      }),
    ).toBe('type {secret:KL_SELLER} into {"stableId":"user_password"}');
  });
});
