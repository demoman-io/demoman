// apps/runner/test/executor-accounts.test.ts
//
// Launch C2, task 6: the CLI executor signs in as the script's account on
// demand, and nothing it sends or writes carries a secret value.
import { readFile, stat } from "node:fs/promises";
import { expect, it } from "vitest";
import { createSessionStore } from "../src/executor/sessions.js";
import {
  app,
  CUSTOMER,
  customerEntry,
  executor,
  home,
  lastServed,
  NEXT,
  type Report,
  run,
  SELLER,
  script,
  seller,
  sellerAndCustomer,
  servedSince,
  signedInSince,
  snap,
  takes,
  useExecutor,
  writeAccounts,
} from "./accounts-harness.js";
import { ownVideo } from "./fixture.js";
import { sessionFor } from "./login-app.js";

it("signs in before the first run and films as the account", async () => {
  await writeAccounts(seller());
  const report = await run(NEXT);
  expect(report.outcome, JSON.stringify(report)).toBe("complete");
  expect(report.account).toBe("seller");
  expect(report.signedIn?.account).toBe("seller");
  expect(signedInSince(SELLER)).toBe(1);
  // The film is the seller's: the dashboard was served to them.
  expect(lastServed()).toBe(SELLER);
}, 120_000); // 5.7 s here; 5x is 29 s

it("reuses the saved session on the next run, signing in no more", async () => {
  await writeAccounts(seller());
  await run(NEXT);
  const again = await run(NEXT);
  expect(again.outcome).toBe("complete");
  expect(again.signedIn).toBeUndefined();
  expect(signedInSince(SELLER)).toBe(1);
}, 120_000); // 9.4 s here; 5x is 47 s

it("signs in again silently when the saved session expired, then films", async () => {
  await writeAccounts(seller());
  await run(NEXT);
  expect(signedInSince(SELLER)).toBe(1);
  app.expireAll();
  const report = await run(NEXT);
  expect(report.outcome, JSON.stringify(report)).toBe("complete");
  expect(report.signedIn?.account).toBe("seller");
  expect(signedInSince(SELLER)).toBe(2);
}, 180_000); // 12 s here; 5x is 59 s

it("signs in again when an expired session lands on a magic-link page with no password field (C2 check, 2026-10-16)", async () => {
  // KitchenLink's shape: the steps are one dev route, and a signed-out
  // browser is sent to a page that is neither that route nor a password form.
  await writeAccounts({
    accountsVersion: 1,
    sites: {
      [app.url]: {
        default: "seller",
        accounts: {
          seller: {
            about: "a demo seller",
            checkUrl: "/magic",
            signIn: [{ do: "goto", url: `/dev/sign-in-as?email=${SELLER}` }],
          },
        },
      },
    },
  });
  const first = await snap(`${app.url}/magic`);
  expect(first.value.signedIn?.account, JSON.stringify(first)).toBe("seller");
  expect(signedInSince(SELLER)).toBe(1);
  app.expireAll();
  // Premise: a browser the app does not know is sent to the magic-link
  // page, which shows no password field.
  const probe = await fetch(`${app.url}/magic`, { redirect: "manual" });
  expect(probe.headers.get("location")).toContain("/magic-login");
  const wall = await (await fetch(`${app.url}/magic-login`)).text();
  expect(wall).not.toContain('type="password"');
  const again = (await snap(`${app.url}/magic`)) as unknown as {
    ok: boolean;
    value: { landedUrl: string; signedIn?: { account: string } };
  };
  expect(again.ok, JSON.stringify(again)).toBe(true);
  expect(again.value.signedIn?.account, JSON.stringify(again)).toBe("seller");
  expect(again.value.landedUrl).toBe(`${app.url}/magic`);
  expect(signedInSince(SELLER)).toBe(2);
}, 180_000); // 5.3 s here; 5x is 26 s

it("signs in again when the agent changed the account in accounts.json (review 2026-10-16)", async () => {
  await writeAccounts(seller());
  const first = await snap(`${app.url}/app`);
  expect(first.value.signedIn?.account, JSON.stringify(first)).toBe("seller");
  expect(lastServed()).toBe(SELLER);
  // The same name, another person: the customer's email and secret.
  await writeAccounts({
    accountsVersion: 1,
    sites: {
      [app.url]: {
        default: "seller",
        accounts: { seller: { ...customerEntry, about: "now the customer" } },
      },
    },
  });
  const status = (await executor.request("status", {})) as {
    value: { accounts: { sites: { accounts: { session: string }[] }[] } };
  };
  expect(status.value.accounts.sites[0]?.accounts[0]?.session).toBe("changed");
  const again = await snap(`${app.url}/app`);
  expect(again.value.signedIn?.account, JSON.stringify(again)).toBe("seller");
  expect(lastServed()).toBe(CUSTOMER);
}, 120_000); // 4.9 s here; 5x is 24 s

it("refuses signInFailed after one attempt when the account cannot see the page", async () => {
  // checkUrl passes, but the target is a page this fixture always sends to
  // the sign-in page (an app whose seller cannot open the admin area).
  await writeAccounts(seller());
  const out = (await executor.request("run", {
    video: ownVideo(),
    script: script(`${app.url}/admin-only`, NEXT),
  })) as { value: Report };
  expect(out.value.outcome).toBe("refusedBeforeRun");
  expect(out.value.reason, JSON.stringify(out)).toBe("signInFailed");
  expect(signedInSince(SELLER)).toBe(1);
  expect(await takes()).toEqual([]);
}, 120_000); // 2.5 s here; 5x is 12 s

it("re-signs in after a mid-run lapse and says so, keeping no take", async () => {
  await writeAccounts(seller());
  const report = await run([
    { do: "waitForLoad" },
    { do: "click", on: { text: "Sign out" } },
    { do: "waitForLoad" },
    { do: "click", on: { text: "Next" } },
  ]);
  expect(report.stopped?.reason, JSON.stringify(report)).toBe("signedOut");
  expect(report.stopped?.detail).toContain("Demoman signed in again as seller");
  expect(report.stopped?.detail).toContain("The take was not kept");
  expect(await takes()).toEqual([]);
  const next = await run(NEXT);
  expect(next.outcome).toBe("complete");
  expect(next.signedIn).toBeUndefined();
}, 180_000); // 12 s here; 5x is 59 s

it("writes the account's session back after a run, and only that file", async () => {
  await writeAccounts(seller());
  await run(NEXT);
  const store = createSessionStore(home);
  const saved = JSON.parse(
    await readFile(store.pathOfAccount(app.url, "seller"), "utf8"),
  ) as { refreshedAt: string | null; account?: { name: string } };
  expect(saved.account?.name).toBe("seller");
  expect(saved.refreshedAt).not.toBeNull();
  // No manual file was created for the site by the write-back.
  await expect(stat(store.pathOf("localhost"))).rejects.toThrow();
}, 120_000); // 5.6 s here; 5x is 28 s

it("snapshot signs in on demand and answers the account", async () => {
  await writeAccounts(seller());
  const out = await snap(`${app.url}/app`);
  expect(out.ok, JSON.stringify(out)).toBe(true);
  expect(out.value.session).toBe("saved");
  expect(out.value.account).toBe("seller");
  expect(out.value.signedIn?.account).toBe("seller");
}, 120_000); // 2.4 s here; 5x is 12 s

it("keeps seller and customer sessions apart", async () => {
  await writeAccounts(sellerAndCustomer());
  await run(NEXT, { account: "seller" });
  expect(lastServed()).toBe(SELLER);
  await run(NEXT, { account: "customer" });
  // Premise: the second run was the customer's, so the check below is not
  // satisfied by the seller's pages alone.
  expect(lastServed()).toBe(CUSTOMER);
  const back = await run(NEXT, { account: "seller" });
  expect(back.signedIn).toBeUndefined();
  expect(lastServed()).toBe(SELLER);
  expect(signedInSince(SELLER)).toBe(1);
}, 240_000); // 15 s here; 5x is 75 s

it("films as the account, not a manual session for the same site (Review Focus 5)", async () => {
  await createSessionStore(home).save(
    sessionFor(app, app.validCookieFor(CUSTOMER)),
  );
  await writeAccounts(seller());
  const store = createSessionStore(home);
  const manualPath = store.pathOf("localhost");
  const manualBefore = await readFile(manualPath, "utf8");
  await run(NEXT);
  expect(lastServed()).toBe(SELLER);
  const account = JSON.parse(
    await readFile(store.pathOfAccount(app.url, "seller"), "utf8"),
  ) as { refreshedAt: string | null };
  expect(account.refreshedAt).not.toBeNull();
  expect(await readFile(manualPath, "utf8")).toBe(manualBefore);
  expect(servedSince().length).toBeGreaterThan(0); // premise: pages were served
  expect(servedSince()).not.toContain(CUSTOMER);
}, 120_000); // 5.7 s here; 5x is 29 s

it("reads accounts.json fresh on every call (Review Focus 3)", async () => {
  await writeAccounts(sellerAndCustomer({ default: "seller" }));
  expect((await snap(`${app.url}/app`)).value.account).toBe("seller");
  await writeAccounts(sellerAndCustomer({ default: "customer" }));
  expect((await snap(`${app.url}/app`)).value.account).toBe("customer");
}, 180_000); // 4.9 s here; 5x is 24 s

it.each([
  ["a relative path", "repo"],
  ["a folder that does not exist", "/no/such/folder/anywhere"],
])(
  "refuses a project that is %s, naming project (Review Focus 4)",
  async (_l, project) => {
    const out = await snap(`${app.url}/app`, { project });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("invalidProject");
    expect(out.detail).toContain("project");
  },
);

it("refuses a missing secret before opening the page", async () => {
  await executor.close();
  useExecutor({ env: {} });
  await writeAccounts(seller());
  const gets = app.gets("/app");
  const out = (await executor.request("run", {
    video: ownVideo(),
    script: script(`${app.url}/app`, NEXT),
  })) as { value: Report };
  expect(out.value.reason, JSON.stringify(out)).toBe("secretMissing");
  expect(app.gets("/app")).toBe(gets);
}, 60_000); // 0.1 s here; 5x is 0.5 s
