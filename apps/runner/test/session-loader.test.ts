import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSessionLoader } from "../src/executor/session-loader.js";
import {
  createSessionStore,
  type SessionFile,
} from "../src/executor/sessions.js";
import { launch } from "../src/launch.js";

let home: string;
let browser: Awaited<ReturnType<typeof launch>>;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-loader-"));
  browser = await launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser.close();
  await rm(home, { recursive: true, force: true });
});

const file = (name: string, value: string): SessionFile => ({
  sessionVersion: 1,
  site: "localhost",
  savedAt: "2026-10-15T09:00:00.000Z",
  refreshedAt: null,
  startUrl: "http://localhost:4000/a",
  signInUrl: "http://localhost:4000/login",
  account: { origin: "http://localhost:4000", name },
  state: {
    cookies: [
      {
        name: "sid",
        value,
        domain: "localhost",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  },
});

it("loads the chosen account's cookie, and switches when the choice changes", async () => {
  const store = createSessionStore(home);
  await store.save(file("seller", "s1"));
  await store.save(file("customer", "c1"));
  const loader = createSessionLoader(store, () => {});
  const site = { site: "localhost", origin: "http://localhost:4000" };
  const sid = async () =>
    (await browser.context.cookies()).find((c) => c.name === "sid")?.value;
  expect(
    (await loader.load(browser.context, { ...site, name: "seller" })).ok,
  ).toBe(true);
  expect(await sid()).toBe("s1");
  // Same files, another choice: the stamp differs, so it loads again.
  await loader.load(browser.context, { ...site, name: "customer" });
  expect(await sid()).toBe("c1");
});

it("drops an IndexedDB database Playwright saved without a key, says so, and loads the rest", async () => {
  const store = createSessionStore(await mkdtemp(join(home, "idb-")));
  const saved = file("seller", "s2");
  // As Playwright 1.62.1 saves Actual Budget's file blocks: keys -1, 0, 1,
  // with the 0 lost. A variable, since Playwright's types leave IndexedDB out.
  const origin = {
    origin: "http://localhost:4001",
    localStorage: [{ name: "kept", value: "yes" }],
    indexedDB: [
      {
        name: "blocks",
        version: 1,
        stores: [
          {
            name: "data",
            autoIncrement: false,
            records: [
              { key: -1, value: "a" },
              { value: "b" },
              { key: 1, value: "c" },
            ],
            indexes: [],
          },
        ],
      },
    ],
  };
  saved.state.origins = [origin];
  // The premise: the browser refuses this state whole.
  await expect(browser.context.setStorageState(saved.state)).rejects.toThrow(
    /out-of-line keys/,
  );
  await store.save(saved);
  const lines: string[] = [];
  const loaded = await createSessionLoader(store, (l) => lines.push(l)).load(
    browser.context,
    { site: "localhost", origin: "http://localhost:4000", name: "seller" },
  );
  expect(loaded).toMatchObject({ ok: true });
  expect(
    (await browser.context.cookies()).find((c) => c.name === "sid")?.value,
  ).toBe("s2");
  expect(
    (await browser.context.storageState()).origins.find(
      (o) => o.origin === "http://localhost:4001",
    )?.localStorage,
  ).toEqual([{ name: "kept", value: "yes" }]);
  expect(lines).toEqual([
    expect.stringMatching(/http:\/\/localhost:4001.*"blocks"/),
  ]);
});
