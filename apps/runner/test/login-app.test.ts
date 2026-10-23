// apps/runner/test/login-app.test.ts
import { afterAll, beforeAll, expect, it } from "vitest";
import { launch } from "../src/launch.js";
import { type LoginApp, SESSION_COOKIE, serveLoginApp } from "./login-app.js";

let app: LoginApp;
let browser: Awaited<ReturnType<typeof launch>>;
beforeAll(async () => {
  app = await serveLoginApp();
  browser = await launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser.close();
  await app.close();
});

const passwordShown = () =>
  browser.page.evaluate(() =>
    [...document.querySelectorAll('input[type="password"]')].some((el) =>
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    ),
  );

it("redirects a signed-out /app to /login with return_to, showing a password field", async () => {
  await browser.context.clearCookies();
  await browser.page.goto(`${app.url}/app`);
  expect(browser.page.url()).toBe(`${app.url}/login?return_to=%2Fapp`);
  expect(await passwordShown()).toBe(true);
});

it("signs in with the form and lands on /app, which shows no password field", async () => {
  await browser.context.clearCookies();
  await browser.page.goto(`${app.url}/app`);
  await browser.page.click("text=Sign in >> nth=-1");
  await browser.page.waitForURL(`${app.url}/app`);
  expect(await passwordShown()).toBe(false);
  const cookie = (await browser.context.cookies()).find(
    (c) => c.name === SESSION_COOKIE,
  );
  // A browser-session cookie, as KitchenLink's: no expiry.
  expect(cookie?.expires).toBe(-1);
  expect(cookie?.value).toBe(app.validCookie());
});

it("stops honouring every issued cookie after expireAll", async () => {
  await browser.page.goto(`${app.url}/app`);
  expect(browser.page.url()).toBe(`${app.url}/app`);
  app.expireAll();
  await browser.page.goto(`${app.url}/app`);
  expect(browser.page.url()).toContain("/login");
});

it("serves /signup with a password field and no redirect", async () => {
  await browser.page.goto(`${app.url}/signup`);
  expect(browser.page.url()).toBe(`${app.url}/signup`);
  expect(await passwordShown()).toBe(true);
});

// The premises signin.test.ts's final-review cases rely on.
it("shows /inplace's sign-in form at /inplace, and its content there once signed in", async () => {
  await browser.context.clearCookies();
  await browser.page.goto(`${app.url}/inplace`);
  expect(browser.page.url()).toBe(`${app.url}/inplace`);
  expect(await passwordShown()).toBe(true);
  await browser.page.click("text=Sign in >> nth=-1");
  await browser.page.waitForURL(`${app.url}/inplace`);
  await browser.page.waitForSelector("text=Signed in");
  expect(await passwordShown()).toBe(false);
});

it("sends a signed-out /late to /login from script after load, not by an HTTP redirect", async () => {
  await browser.context.clearCookies();
  await browser.page.goto(`${app.url}/late`, { waitUntil: "load" });
  // Still on /late at load, with no password field: a read here misses it.
  expect(browser.page.url()).toBe(`${app.url}/late`);
  expect(await passwordShown()).toBe(false);
  await browser.page.waitForURL(`${app.url}/login?return_to=%2Flate`);
  expect(await passwordShown()).toBe(true);
});

// The premises account-signin.test.ts relies on (launch C2).
it("with accounts: a wrong password sets no cookie and echoes what was typed; a right one signs in", async () => {
  const named = await serveLoginApp({
    accounts: { "a@demo.test": "right-password" },
  });
  try {
    await browser.context.clearCookies();
    await browser.page.goto(`${named.url}/login`);
    await browser.page.fill("#user_email", "a@demo.test");
    await browser.page.fill("#user_password", "wrong-password");
    await browser.page.click("text=Sign in >> nth=-1");
    await browser.page.waitForSelector("#error");
    expect(await browser.page.textContent("#error")).toContain(
      "wrong-password",
    );
    expect(
      (await browser.context.cookies()).some((c) => c.name === SESSION_COOKIE),
    ).toBe(false);
    expect(named.signInsAs("a@demo.test")).toBe(0);
    await browser.page.fill("#user_email", "a@demo.test");
    await browser.page.fill("#user_password", "right-password");
    await browser.page.click("text=Sign in >> nth=-1");
    await browser.page.waitForURL(`${named.url}/app`);
    expect(await browser.page.textContent("#whoami")).toBe("a@demo.test");
    expect(named.signInsAs("a@demo.test")).toBe(1);
    expect(named.bodies()).toHaveLength(2);
  } finally {
    await named.close();
  }
});

it("/login-late has not submitted 100 ms after the click and has after 1 s", async () => {
  await browser.context.clearCookies();
  await browser.page.goto(`${app.url}/login-late`);
  const before = app.signIns();
  await browser.page.click("#go");
  await browser.page.waitForTimeout(100);
  expect(app.signIns()).toBe(before);
  await browser.page.waitForTimeout(900);
  expect(app.signIns()).toBe(before + 1);
});

it("/vanishing-login drops its password field when the email is typed, and /bounce redirects off-origin", async () => {
  await browser.page.goto(`${app.url}/vanishing-login`);
  expect(await passwordShown()).toBe(true);
  await browser.page.fill("#user_email", "x@demo.test");
  expect(await browser.page.locator("#user_password").count()).toBe(0);
  expect(await passwordShown()).toBe(false);
  const other = await serveLoginApp();
  try {
    await browser.page.goto(
      `${app.url}/bounce?to=${encodeURIComponent(`${other.url}/goodbye`)}`,
    );
    expect(browser.page.url()).toBe(`${other.url}/goodbye`);
  } finally {
    await other.close();
  }
});
