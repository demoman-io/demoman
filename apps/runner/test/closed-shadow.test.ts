import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasClosedShadowRoot } from "../src/executor/closed-shadow.js";

// DEM-102. Red if the check reads the page's own JS view (a closed root is
// invisible there) or counts any custom element as one.
describe("hasClosedShadowRoot", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  }, 30_000);
  afterAll(async () => {
    await browser.close();
  });

  const pageWith = async (body: string) => {
    const page = await browser.newPage();
    await page.setContent(`<body>${body}</body>`);
    return page;
  };
  const host = (mode: "open" | "closed") =>
    `<div id="h"></div><script>document.getElementById("h").attachShadow({ mode: "${mode}" }).innerHTML = "<button>Inside</button>";</script>`;

  it("finds a closed shadow root", async () => {
    const page = await pageWith(host("closed"));
    // Premise: the page's own JS cannot see it.
    expect(
      await page.evaluate(() => document.getElementById("h")?.shadowRoot),
    ).toBeNull();
    expect(await hasClosedShadowRoot(page, () => {})).toBe(true);
    await page.close();
  });

  it("does not count an open root, or a custom element with no root", async () => {
    const page = await pageWith(`${host("open")}<my-widget>x</my-widget>`);
    // Premise: the open root is there.
    expect(
      await page.evaluate(
        () => document.getElementById("h")?.shadowRoot?.mode ?? null,
      ),
    ).toBe("open");
    expect(await hasClosedShadowRoot(page, () => {})).toBe(false);
    await page.close();
  });

  it("answers null and says why when the page cannot be read", async () => {
    const page = await pageWith("");
    await page.close();
    const lines: string[] = [];
    expect(await hasClosedShadowRoot(page, (l) => lines.push(l))).toBeNull();
    expect(lines.join("\n")).toMatch(/closed shadow root/);
  });
});
