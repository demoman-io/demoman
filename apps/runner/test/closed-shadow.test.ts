import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closedShadowHolds,
  targetWords,
} from "../src/executor/closed-shadow.js";

describe("targetWords", () => {
  it("takes a text, an accessible name and a stableId, and no tree path", () => {
    expect(targetWords({ do: "click", on: { text: " Save  Draft " } })).toEqual(
      ["save draft"],
    );
    expect(
      targetWords({
        do: "type",
        into: { role: "textbox", name: "Email" },
        text: "x",
      }),
    ).toEqual(["email"]);
    expect(
      targetWords({
        do: "drag",
        from: { on: { stableId: "card-1" } },
        to: { on: { text: "Done" } },
      } as never),
    ).toEqual(["card-1", "done"]);
    expect(targetWords({ do: "click", on: { treePath: "body:1" } })).toEqual(
      [],
    );
  });
});

// DEM-102. Red if the check reads the page's own JS view (a closed root is
// invisible there), counts an open root or a light-DOM custom element, or
// blames a closed root that does not hold the target.
describe("closedShadowHolds", () => {
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
    `<div id="h"></div><script>document.getElementById("h").attachShadow({ mode: "${mode}" }).innerHTML = "<button aria-label='Send it'>Inside</button>";</script>`;

  it("finds the target's words in a closed root, and no others", async () => {
    const page = await pageWith(host("closed"));
    // Premise: the page's own JS cannot see the root.
    expect(
      await page.evaluate(() => document.getElementById("h")?.shadowRoot),
    ).toBeNull();
    expect(await closedShadowHolds(page, ["inside"], () => {})).toBe(true);
    expect(await closedShadowHolds(page, ["send it"], () => {})).toBe(true);
    expect(await closedShadowHolds(page, ["elsewhere"], () => {})).toBe(false);
    // A tree path names no words: any closed root answers.
    expect(await closedShadowHolds(page, [], () => {})).toBe(true);
    await page.close();
  });

  it("does not count an open root, or a custom element with no root", async () => {
    const page = await pageWith(`${host("open")}<my-widget>Inside</my-widget>`);
    // Premise: the open root is there, holding the words.
    expect(
      await page.evaluate(
        () => document.getElementById("h")?.shadowRoot?.textContent ?? null,
      ),
    ).toBe("Inside");
    expect(await closedShadowHolds(page, ["inside"], () => {})).toBe(false);
    expect(await closedShadowHolds(page, [], () => {})).toBe(false);
    await page.close();
  });

  it("answers null and says why when the page cannot be read", async () => {
    const page = await pageWith("");
    await page.close();
    const lines: string[] = [];
    expect(await closedShadowHolds(page, [], (l) => lines.push(l))).toBeNull();
    expect(lines.join("\n")).toMatch(/closed shadow root/);
  });
});
