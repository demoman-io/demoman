import type { ResolveEnv } from "@demoman/resolver";
import { NO_PATCH, NO_SHADOW } from "@demoman/resolver";
import { afterEach, describe, expect, it } from "vitest";
import {
  END_PAGE_MAX_FIELDS,
  END_PAGE_TEXT_MAX,
  readEndPage,
} from "../../src/page.js";

/** `readEndPage` against a real Chromium layout (spec 2026-10-30 A2). */
const env = (): ResolveEnv => ({
  root: document,
  shadow: NO_SHADOW,
  patch: NO_PATCH,
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readEndPage", () => {
  it("lists each field's value, a box's state, and no credential, hidden or button value", async () => {
    document.body.innerHTML = `
      <p>Checkout</p>
      <input aria-label="Amount" value="4,800">
      <label><input type="checkbox" checked> Gift wrap</label>
      <input type="hidden" name="csrf" value="h1dden">
      <input type="submit" value="Pay">
      <input type="password" aria-label="Password" value="hunter2">
      <select aria-label="Card expiry month" autocomplete="cc-exp-month"><option selected>04</option></select>
    `;
    const end = await readEndPage(env());
    expect(end.url).toBe(location.href);
    expect(end.text).toContain("Checkout");
    expect(end.fields.map((f) => f.value)).toEqual(["4,800", "checked"]);
    // The premise: the page holds each value left out.
    const said = JSON.stringify(end);
    for (const hidden of ["h1dden", "Pay", "hunter2", "04"]) {
      expect(document.body.innerHTML).toContain(hidden);
      expect(said).not.toContain(`"value":"${hidden}"`);
    }
  });

  it("cuts the text at END_PAGE_TEXT_MAX and says it was cut", async () => {
    document.body.innerHTML = `<p>${"word ".repeat(1000)}</p>`;
    // The premise: the page's text is longer than the cut.
    expect(document.body.innerText.length).toBeGreaterThan(END_PAGE_TEXT_MAX);
    const { text } = await readEndPage(env());
    expect(text).toHaveLength(END_PAGE_TEXT_MAX);
    expect(text.endsWith("…")).toBe(true);
  });

  it("lists at most END_PAGE_MAX_FIELDS fields and says how many it left out", async () => {
    const n = END_PAGE_MAX_FIELDS + 5;
    document.body.innerHTML = Array.from(
      { length: n },
      (_, i) => `<input aria-label="Field ${i}" value="v${i}">`,
    ).join("");
    const end = await readEndPage(env());
    expect(end.fields).toHaveLength(END_PAGE_MAX_FIELDS);
    expect(end.fields[0]?.value).toBe("v0");
    expect(end.fieldsNotListed).toBe(5);
  });

  it("says nothing of fields left out when none were", async () => {
    document.body.innerHTML = `<input aria-label="Only" value="1">`;
    expect(await readEndPage(env())).not.toHaveProperty("fieldsNotListed");
  });
});
