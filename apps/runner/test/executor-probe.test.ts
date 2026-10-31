// apps/runner/test/executor-probe.test.ts
//
// The executor's `probe` op: its turn in the slot, its sign-in on demand,
// and the next call starting from the saved sessions, not from what the
// probe's steps left in the browser.
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { checkScript } from "@demoman/run-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  app,
  CUSTOMER,
  executor,
  lastServed,
  NEXT,
  SELLER,
  script,
  seller,
  sellerAndCustomer,
  signedInSince,
  writeAccounts,
} from "./accounts-harness.js";
import { ownVideo } from "./fixture.js";

let portal: Server;
let portalUrl: string;
beforeAll(async () => {
  const html = await readFile(
    new URL("./fixtures/portal-app.html", import.meta.url),
    "utf8",
  );
  portal = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => portal.listen(0, "127.0.0.1", r));
  portalUrl = `http://127.0.0.1:${(portal.address() as AddressInfo).port}/`;
}, 30_000);
afterAll(() => {
  portal.close();
});

type Answer = {
  ok: boolean;
  reason?: string;
  detail?: string;
  value: {
    session: string;
    account: string | null;
    signedIn?: { account: string };
    targets: unknown[];
    stopped: unknown;
  };
};
const probe = (raw: unknown, extra: Record<string, unknown> = {}) =>
  executor.request("probe", { script: raw, ...extra }) as Promise<Answer>;
const portalScript = (steps: unknown[]) =>
  script(portalUrl, [{ do: "waitForLoad" }, ...steps]);

it("the next call starts from the saved session, not from what a probe left", async () => {
  const probed = await probe(
    portalScript([
      { do: "click", on: { role: "button", name: "Open filters" } },
      { do: "click", on: { role: "menuitem", name: "Live" } },
    ]),
  );
  expect(probed.ok, JSON.stringify(probed)).toBe(true);
  expect(probed.value.stopped, JSON.stringify(probed)).toBeNull();
  // The premise: Live was clicked, which is also what wrote the filter to
  // the page's localStorage.
  expect(JSON.stringify(probed.value.targets)).toContain("Showing Live");
  const snap = (await executor.request("snapshot", {
    url: portalUrl,
  })) as Answer;
  expect(snap.ok, JSON.stringify(snap)).toBe(true);
  const listed = JSON.stringify(snap.value.targets);
  expect(listed).toContain("Saved: none");
  expect(listed).not.toContain("Saved: live");
}, 120_000);

it("the next call starts from the saved session, not from what a snapshot left", async () => {
  const first = (await executor.request("snapshot", {
    url: `${portalUrl}?stamp`,
  })) as Answer;
  expect(first.ok, JSON.stringify(first)).toBe(true);
  // The premise: the page wrote the key while the snapshot was on it.
  expect(JSON.stringify(first.value.targets)).toContain("Saved: stamped");
  const next = await probe(portalScript([]));
  expect(next.ok, JSON.stringify(next)).toBe(true);
  const listed = JSON.stringify(next.value.targets);
  expect(listed).toContain("Saved: none");
  expect(listed).not.toContain("Saved: stamped");
}, 120_000);

it("a probe while a run holds the slot is alreadyRunning", async () => {
  const running = executor.request("run", {
    video: ownVideo(),
    script: portalScript([{ do: "pause", ms: 3000 }]),
  });
  const out = await probe(portalScript([]));
  expect(out, JSON.stringify(out)).toMatchObject({
    ok: false,
    reason: "alreadyRunning",
  });
  // The premise: the run held the slot, so it was a run that answered.
  const ran = (await running) as { ok: boolean; value: { outcome: string } };
  expect(ran.value.outcome, JSON.stringify(ran)).toBe("complete");
}, 120_000);

it("a probe as an account whose session lapsed signs in once and probes again", async () => {
  await writeAccounts(seller());
  const first = await probe(script(`${app.url}/app`, NEXT));
  expect(first.value?.signedIn?.account, JSON.stringify(first)).toBe("seller");
  expect(signedInSince(SELLER)).toBe(1);
  app.expireAll();
  const again = await probe(script(`${app.url}/app`, NEXT));
  expect(again.ok, JSON.stringify(again)).toBe(true);
  expect(again.value.signedIn?.account, JSON.stringify(again)).toBe("seller");
  expect(again.value.session).not.toBe("signedOut");
  expect(again.value.account).toBe("seller");
  expect(again.value.stopped, JSON.stringify(again)).toBeNull();
  expect(signedInSince(SELLER)).toBe(2);
}, 180_000);

it("a probe plays as the account its script names, as the run would", async () => {
  await writeAccounts(sellerAndCustomer());
  const out = await probe(
    script(`${app.url}/app`, NEXT, { account: "customer" }),
  );
  expect(out.ok, JSON.stringify(out)).toBe(true);
  // The premise: the site's default is seller, so this is the script's word.
  expect(out.value.account, JSON.stringify(out)).toBe("customer");
  expect(lastServed()).toBe(CUSTOMER);
}, 120_000);

it("refuses a malformed script before signing in or opening anything", async () => {
  await writeAccounts(seller());
  const raw = {
    ...script(`${app.url}/app`, []),
    steps: [{ do: "pause", ms: 10 }],
  };
  // The premise: the run door refuses this script.
  const checked = checkScript(raw, []);
  expect(checked.ok).toBe(false);
  const out = await probe(raw);
  expect(out).toEqual({ ok: true, value: checked.ok ? null : checked.refusal });
  expect(signedInSince(SELLER)).toBe(0);
}, 120_000);

it("refuses a missing brand kit before signing in or opening anything", async () => {
  await writeAccounts(seller());
  const out = await probe(
    script(`${app.url}/app`, NEXT, { scriptVersion: 2, look: { kit: "nope" } }),
  );
  expect(out, JSON.stringify(out)).toMatchObject({
    ok: true,
    value: { outcome: "refusedBeforeRun", reason: "unknownKit" },
  });
  expect(signedInSince(SELLER)).toBe(0);
}, 120_000);

it("a probe makes no take", async () => {
  const before = await executor.request("takes", {});
  expect(before.ok, JSON.stringify(before)).toBe(true);
  const out = await probe(
    portalScript([
      { do: "click", on: { role: "button", name: "Open filters" } },
    ]),
  );
  expect(out.ok, JSON.stringify(out)).toBe(true);
  expect(await executor.request("takes", {})).toEqual(before);
}, 120_000);
