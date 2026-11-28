// apps/runner/test/pins.test.ts
//
// `pinStage` on a real headless page: what the page and its server see
// once a stage is pinned, against an unpinned page of the same browser.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pinStage, type RegionPlan } from "../src/executor/pins.js";
import { type Launched, launch, openCdpSession } from "../src/launch.js";

let launched: Launched;
let server: Server;
let origin: string;
/** The Accept-Language of every request the server answered, by path. */
const heard: Record<string, string | undefined> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    heard[req.url ?? ""] = req.headers["accept-language"];
    res.setHeader("content-type", "text/html");
    res.end(
      '<body style="margin:0"><div style="width:3000px;height:3000px"></div></body>',
    );
  }).listen(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  launched = await launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await launched?.close();
  server?.close();
});

/** A fresh page, pinned by `plan` (or not at all), at `path`: what it sees. */
async function seen(plan: RegionPlan | null, path: string) {
  const page = await launched.context.newPage();
  const cdp = await openCdpSession(launched.context, page);
  const pinned = plan === null ? null : await pinStage(cdp, plan);
  await page.goto(`${origin}${path}`);
  const looks = await page.evaluate(() => ({
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    intl: Intl.DateTimeFormat().resolvedOptions().locale,
    language: navigator.language,
    languages: [...navigator.languages],
    number: (1234.5).toLocaleString(),
    scrollbar: innerWidth - document.documentElement.clientWidth,
    random: [Math.random(), Math.random(), Math.random()],
  }));
  await page.close();
  return { pinned, looks, acceptLanguage: heard[path] };
}

// Far from any machine this runs on, so a pass is the pin, not the machine.
const chathamGerman = { timeZone: "Pacific/Chatham", locale: "de-DE" };

describe("a pinned stage", () => {
  // Red when pinStage stops sending any one of the overrides: each line
  // below is a different one.
  it("has the flow's time zone and locale everywhere a page or its server reads them", async () => {
    const machine = await seen(null, "/machine");
    // Premise: this machine is in neither, so the pin is what moved them.
    expect(machine.looks.timeZone).not.toBe(chathamGerman.timeZone);
    expect(machine.looks.language).not.toBe(chathamGerman.locale);

    const { pinned, looks, acceptLanguage } = await seen(
      { pin: chathamGerman },
      "/pinned",
    );
    expect(pinned).toEqual({
      ok: true,
      region: { ...chathamGerman, from: "flow" },
    });
    expect(looks.timeZone).toBe("Pacific/Chatham");
    expect(looks.intl).toBe("de-DE");
    expect(looks.number).toBe("1.234,5");
    expect(looks.language).toBe("de-DE");
    expect(looks.languages).toEqual(["de-DE"]);
    expect(acceptLanguage).toBe("de-DE");
  }, 30_000);

  it("records this machine's for a first run, and leaves an unpinned flow's alone", async () => {
    const machine = await seen(null, "/machine-2");
    const first = await seen({ pin: "thisMachine" }, "/first");
    expect(first.pinned).toEqual({
      ok: true,
      region: {
        timeZone: machine.looks.timeZone,
        locale: machine.looks.language,
        from: "thisMachine",
      },
    });
    const none = await seen({ pin: "none", why: "old" }, "/none");
    expect(none.pinned).toMatchObject({
      ok: true,
      region: { from: "notPinned" },
    });
    // Unpinned: the machine's own header, not one Demoman set.
    expect(none.acceptLanguage).toBe(machine.acceptLanguage);
    expect(none.looks.languages).toEqual(machine.looks.languages);
  }, 30_000);

  // Red when the seed script is not installed: an unseeded Math.random
  // deals different numbers on every page.
  it("deals the same Math.random at one address on every run, and others at another", async () => {
    const plan: RegionPlan = { pin: "none", why: "old" };
    const a = await seen(plan, "/seeded");
    const again = await seen(plan, "/seeded");
    const other = await seen(plan, "/seeded-elsewhere");
    expect(again.looks.random).toEqual(a.looks.random);
    expect(other.looks.random).not.toEqual(a.looks.random);
    for (const n of a.looks.random) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
    // Premise: unseeded pages differ, so equality above is the seed.
    const u = await seen(null, "/seeded");
    const v = await seen(null, "/seeded");
    expect(u.looks.random).not.toEqual(v.looks.random);
  }, 30_000);

  // Headless already hides them (Playwright's --hide-scrollbars), so this
  // cannot tell the pin from the flag; it holds the invariant either way.
  it("shows no scrollbar on a page that overflows", async () => {
    expect(
      (await seen({ pin: "none", why: "old" }, "/wide")).looks.scrollbar,
    ).toBe(0);
  }, 30_000);

  // Report before you forgive: a time zone Chrome refuses stops the run in
  // words that name it, never a take in the machine's own.
  it("refuses a time zone Chrome does not know, naming it", async () => {
    const { pinned } = await seen(
      { pin: { timeZone: "Mars/Olympus", locale: "de-DE" } },
      "/bad",
    );
    expect(pinned?.ok).toBe(false);
    expect(pinned && !pinned.ok && pinned.detail).toContain("Mars/Olympus");
  }, 30_000);
});
