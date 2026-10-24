import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  nameWords,
  normaliseName,
  phraseHits,
  sameName,
  similarNames,
  startPageOf,
} from "../src/executor/video-match.js";

interface Entry {
  name: string;
  originUrl: string | null;
  createdAt: string;
}
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/library-names.json", import.meta.url),
    "utf8",
  ),
) as Entry[];
const names = new Set(fixture.map((e) => e.name));

const FLOWS = [
  [
    "Create an invoice",
    "Create a new invoice",
    "Create a Northwind invoice",
    "Create an invoice in Nylon",
  ],
  [
    "Searching invoices",
    "Searching the invoices",
    "Northwind invoice search",
    "Northwind invoice lookup",
  ],
  ["Filter invoices by customer", "Filter invoices by customer (Maple)"],
  ["Filter and draft a new invoice", "Filter invoices and draft a new invoice"],
];
const DISTINCT = [
  "Excalidraw — Draw a rectangle",
  "Excalidraw — Pick a tool",
  "Overdue badge on past-due invoices",
  "Seller orders page tour",
  "KitchenLink orders (launch C check)",
  "Actual Budget — Demo budget",
  "Tremor — Usage overview",
  "Chatbot — Ask about the weather",
  "Search Wikipedia for Ada Lovelace",
];
// Known misses: a later rule that catches one turns this red, and the list is updated.
// The FLOWS pairs below are ones whole-word containment cannot reach (each side has a word the other lacks).
const KNOWN_MISSES: [string, string][] = [
  ["Nylon — New Invoice", "Create an invoice"],
  ["Create a new invoice", "Create a Northwind invoice"],
  ["Create a new invoice", "Create an invoice in Nylon"],
  ["Create a Northwind invoice", "Create an invoice in Nylon"],
  ["Searching invoices", "Northwind invoice search"],
  ["Searching invoices", "Northwind invoice lookup"],
  ["Searching the invoices", "Northwind invoice search"],
  ["Searching the invoices", "Northwind invoice lookup"],
  ["Northwind invoice search", "Northwind invoice lookup"],
];
const isMiss = (a: string, b: string) =>
  KNOWN_MISSES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
const pairs = <T>(xs: T[]) =>
  xs.flatMap((x, i) => xs.slice(i + 1).map((y) => [x, y] as const));

describe("video name matching", () => {
  it("holds the library's duplicates", () => {
    expect(
      fixture.filter(
        (e) =>
          e.name === "Create an invoice" &&
          startPageOf(e.originUrl ?? "") === "https://demoman.io/sample/",
      ),
    ).toHaveLength(10);
    for (const flow of FLOWS)
      for (const n of flow) expect(names.has(n), n).toBe(true);
    for (const n of DISTINCT) expect(names.has(n), n).toBe(true);
    for (const [a, b] of KNOWN_MISSES) {
      expect(names.has(a), a).toBe(true);
      expect(names.has(b), b).toBe(true);
    }
  });

  it("matches each flow's names to each other", () => {
    let checked = 0;
    for (const flow of FLOWS)
      for (const [a, b] of pairs(flow)) {
        if (isMiss(a, b)) continue;
        checked++;
        expect(similarNames(a, b), `${a} / ${b}`).toBe(true);
      }
    expect(checked).toBe(6); // premise: 14 pairs in FLOWS, 8 of them known misses
  });

  it("never matches two distinct flows", () => {
    for (const [a, b] of pairs(DISTINCT))
      expect(similarNames(a, b), `${a} / ${b}`).toBe(false);
  });

  it("still misses the known misses", () => {
    for (const [a, b] of KNOWN_MISSES)
      expect(similarNames(a, b), `${a} / ${b}`).toBe(false);
  });

  it("keeps same-page actions apart", () => {
    expect(
      similarNames("Filter invoices by customer", "Filter invoices by date"),
    ).toBe(false);
    expect(
      similarNames("Create an invoice", "Create an invoice with a discount"),
    ).toBe(true);
  });

  it("never matches a name made only of stop words", () => {
    expect(nameWords("A in the")).toEqual([]); // premise: it normalises to nothing
    expect(similarNames("A in the", "Create an invoice")).toBe(false);
    expect(similarNames("Create an invoice", "The")).toBe(false);
    expect(sameName("The", "A in the")).toBe(true);
  });

  it("compares whole words", () =>
    expect(similarNames("Invoiced totals", "Invoice")).toBe(false));

  it("counts singular and plural as one word", () => {
    expect(sameName("Search invoices", "search invoice")).toBe(true);
    expect(normaliseName("Nylon — New Invoice")).toBe("nylon new invoice");
  });

  it("counts whole-word phrase hits", () => {
    const h = {
      name: "Create an invoice",
      pages: ["https://demoman.io/sample/"],
      steps: ["Click Save"],
    };
    expect(phraseHits("invoices save", h)).toBe(2);
    expect(phraseHits("invoiced", h)).toBe(0);
  });

  it("drops query and hash from a start page", () =>
    expect(startPageOf("https://demoman.io/sample/?a=1#x")).toBe(
      "https://demoman.io/sample/",
    ));
});
