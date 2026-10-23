import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fileForLanding,
  fileIsForLanding,
  landingVerdict,
  readLandingFacts,
} from "../src/executor/landing.js";
import type { SessionFile } from "../src/executor/sessions.js";
import { launch } from "../src/launch.js";
import { type LoginApp, serveLoginApp } from "./login-app.js";

const CMD = "npx demoman signin";
const kl = (over: Partial<SessionFile> = {}): SessionFile => ({
  sessionVersion: 1,
  site: "kitchenlink.com",
  savedAt: "2026-10-14T09:00:00.000Z",
  refreshedAt: null,
  startUrl: "https://app.kitchenlink.com/",
  signInUrl: "https://app.kitchenlink.com/users/log-in?return_to=%2F",
  state: { cookies: [], origins: [] },
  ...over,
});

describe("landingVerdict", () => {
  it("stops on the recorded sign-in page, query and all, as an expired session", () => {
    const v = landingVerdict(
      {
        askedUrl: "https://app.kitchenlink.com/orders",
        landedUrl:
          "https://app.kitchenlink.com/users/log-in?return_to=%2Forders",
        passwordFieldVisible: false,
      },
      [kl()],
      CMD,
    );
    expect(v.kind).toBe("signedOut");
    if (v.kind !== "signedOut") return;
    expect(v.detail).toContain(
      "app.kitchenlink.com sent this browser to /users/log-in",
    );
    expect(v.detail).toContain(
      "the session saved 2026-10-14 for kitchenlink.com has expired",
    );
    expect(v.detail).toContain(
      "Run `npx demoman signin https://app.kitchenlink.com/orders`",
    );
  });

  it("counts an identity provider's recorded sign-in page, on another site, as an expired session", () => {
    const v = landingVerdict(
      {
        askedUrl: "https://app.kitchenlink.com/orders",
        landedUrl: "https://accounts.google.com/v3/signin/identifier?y=2",
        passwordFieldVisible: false,
      },
      [
        kl({
          signInUrl: "https://accounts.google.com/v3/signin/identifier?x=1",
        }),
      ],
      CMD,
    );
    expect(v.kind).toBe("signedOut");
    if (v.kind !== "signedOut") return;
    expect(v.detail).toContain("has expired");
    expect(v.detail).toContain("for kitchenlink.com");
  });

  it("stops on a redirect to a password form for a site never signed in, and says so", () => {
    const v = landingVerdict(
      {
        askedUrl: "https://shop.example.com/admin",
        landedUrl: "https://shop.example.com/login",
        passwordFieldVisible: true,
      },
      [kl()],
      CMD,
    );
    expect(v.kind).toBe("signedOut");
    if (v.kind !== "signedOut") return;
    expect(v.detail).toContain("no session was ever saved for example.com");
  });

  it("does not stop on a sign-up page asked for directly, password field and all", () => {
    const v = landingVerdict(
      {
        askedUrl: "https://shop.example.com/signup",
        landedUrl: "https://shop.example.com/signup",
        passwordFieldVisible: true,
      },
      [],
      CMD,
    );
    expect(v).toEqual({
      kind: "go",
      site: "example.com",
      saved: false,
      startedElsewhere: false,
    });
  });

  it("films on, noting it, after a redirect to a page that is not a sign-in page", () => {
    const v = landingVerdict(
      {
        askedUrl: "http://app.kitchenlink.com/",
        landedUrl: "https://app.kitchenlink.com/en/",
        passwordFieldVisible: false,
      },
      [kl()],
      CMD,
    );
    expect(v).toEqual({
      kind: "go",
      site: "kitchenlink.com",
      saved: true,
      startedElsewhere: true,
    });
  });

  it("does not stop on the recorded sign-in page when the script asked for it", () => {
    const v = landingVerdict(
      {
        askedUrl: "https://app.kitchenlink.com/users/log-in",
        landedUrl: "https://app.kitchenlink.com/users/log-in",
        passwordFieldVisible: true,
      },
      [kl()],
      CMD,
    );
    expect(v.kind).toBe("go");
  });

  // Review focus 1: a localhost session saved on one port does not vouch for
  // another app on another port.
  it("still stops a second local app's sign-in redirect when a session was saved for another port", () => {
    const v = landingVerdict(
      {
        askedUrl: "http://localhost:5173/app",
        landedUrl: "http://localhost:5173/login",
        passwordFieldVisible: true,
      },
      [
        kl({
          site: "localhost",
          startUrl: "http://localhost:4000/",
          signInUrl: "http://localhost:4000/users/log-in",
        }),
      ],
      CMD,
    );
    expect(v.kind).toBe("signedOut");
    if (v.kind !== "signedOut") return;
    expect(v.detail).toContain("does not sign it in");
    expect(v.detail).toContain("(at http://localhost:4000/)");
    expect(v.detail).not.toContain("has expired");
  });

  // Final review residual 2: an app that shows its sign-in form at the page
  // asked for, with no redirect.
  describe("a session whose sign-in form was shown in place", () => {
    const inPlace = kl({
      startUrl: "https://app.kitchenlink.com/",
      signInUrl: null,
    });
    const at = (url: string, passwordFieldVisible: boolean) => ({
      askedUrl: url,
      landedUrl: url,
      passwordFieldVisible,
    });

    it("stops its start page showing a password field as an expired session", () => {
      const v = landingVerdict(
        at("https://app.kitchenlink.com/", true),
        [inPlace],
        CMD,
      );
      if (v.kind !== "signedOut")
        throw new Error(`expected signedOut, got ${v.kind}`);
      expect(v.detail).toBe(
        "app.kitchenlink.com shows its sign-in form at /: the session saved 2026-10-14 for kitchenlink.com has expired. Run `npx demoman signin https://app.kitchenlink.com/`, then run again.",
      );
    });

    it("films its start page showing no password field", () => {
      expect(
        landingVerdict(
          at("https://app.kitchenlink.com/", false),
          [inPlace],
          CMD,
        ).kind,
      ).toBe("go");
    });

    // The rule is the page `signin` checked, and no other: an in-app page
    // with a password field (change password) is asked for directly too.
    it("films another of its pages showing a password field", () => {
      expect(
        landingVerdict(
          at("https://app.kitchenlink.com/account/password", true),
          [inPlace],
          CMD,
        ).kind,
      ).toBe("go");
    });

    it("films the same page on another port, which the session never checked", () => {
      const local = kl({
        site: "localhost",
        startUrl: "http://localhost:4000/",
        signInUrl: null,
      });
      expect(
        landingVerdict(at("http://localhost:5173/", true), [local], CMD).kind,
      ).toBe("go");
      // Premise: the same page on the session's own port does stop.
      expect(
        landingVerdict(at("http://localhost:4000/", true), [local], CMD).kind,
      ).toBe("signedOut");
    });

    it("films the start page of a session that recorded a sign-in page", () => {
      expect(
        landingVerdict(at("https://app.kitchenlink.com/", true), [kl()], CMD)
          .kind,
      ).toBe("go");
    });
  });

  it("single-quotes an asked URL a shell would split or glob", () => {
    const v = landingVerdict(
      {
        askedUrl: "https://shop.example.com/admin?a=1&b=2",
        landedUrl: "https://shop.example.com/login",
        passwordFieldVisible: true,
      },
      [],
      CMD,
    );
    if (v.kind !== "signedOut")
      throw new Error(`expected signedOut, got ${v.kind}`);
    expect(v.detail).toContain(
      "`npx demoman signin 'https://shop.example.com/admin?a=1&b=2'`",
    );
  });

  it("answers, rather than throws, for an unparseable landed URL", () => {
    const v = landingVerdict(
      {
        askedUrl: "https://a.example.com/",
        landedUrl: "not a url",
        passwordFieldVisible: true,
      },
      [],
      CMD,
    );
    expect(v.kind).toBe("signedOut");
  });
});

// Final review minor c: two apps signed in through one identity provider
// record the same sign-in page.
describe("a sign-in page two files share", () => {
  const GOOGLE = "https://accounts.google.com/v3/signin/identifier";
  const other = kl({
    site: "otherapp.io",
    startUrl: "https://otherapp.io/",
    signInUrl: GOOGLE,
    savedAt: "2026-10-01T09:00:00.000Z",
  });
  const mine = kl({ signInUrl: GOOGLE });
  const landing = (askedUrl: string) => ({
    askedUrl,
    landedUrl: `${GOOGLE}?continue=x`,
    passwordFieldVisible: false,
  });

  it("belongs to the asked site's file, whichever is listed first", () => {
    const facts = landing("https://app.kitchenlink.com/orders");
    // Premise: both files record this page, and the other is listed first.
    expect([other, mine].every((f) => f.signInUrl === GOOGLE)).toBe(true);
    expect(fileForLanding(facts, [other, mine])?.site).toBe("kitchenlink.com");
    expect(fileForLanding(facts, [mine, other])?.site).toBe("kitchenlink.com");
    const v = landingVerdict(facts, [other, mine], CMD);
    if (v.kind !== "signedOut")
      throw new Error(`expected signedOut, got ${v.kind}`);
    expect(v.detail).toContain(
      "the session saved 2026-10-14 for kitchenlink.com has expired",
    );
  });

  it("does not make another app's file this site's session", () => {
    const facts = landing("https://shop.example.com/admin");
    // Premise: the only file that matches the page is another app's.
    expect(fileForLanding(facts, [other])?.site).toBe("otherapp.io");
    // So it does not speak for this site: run.ts's mid-run re-label asks
    // this, and never re-labels a site with no file through it.
    expect(fileIsForLanding(facts, other)).toBe(false);
    const v = landingVerdict(facts, [other], CMD);
    if (v.kind !== "signedOut")
      throw new Error(`expected signedOut, got ${v.kind}`);
    expect(v.detail).toContain("no session was ever saved for example.com");
    expect(v.detail).not.toContain("otherapp.io");
  });
});

describe("readLandingFacts", () => {
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

  it("reads the landed URL and a visible password field off the sign-in redirect", async () => {
    await browser.page.goto(`${app.url}/app`);
    const facts = await readLandingFacts(browser.page, `${app.url}/app`);
    expect(facts).toEqual({
      askedUrl: `${app.url}/app`,
      landedUrl: `${app.url}/login?return_to=%2Fapp`,
      passwordFieldVisible: true,
    });
  });

  it("sees no password field on a page with a hidden one", async () => {
    await browser.page.setContent(
      `<input type="password" style="visibility:hidden"><input type="password" style="opacity:0"><input type="password" style="display:none"><input type="password" style="position:absolute;top:-500px">`,
    );
    const facts = await readLandingFacts(browser.page, "about:blank");
    expect(facts.passwordFieldVisible).toBe(false);
  });

  it("throws, rather than answering no field, when the page is gone", async () => {
    const gone = await browser.context.newPage();
    await gone.close();
    await expect(readLandingFacts(gone, `${app.url}/app`)).rejects.toThrow();
  });
});
