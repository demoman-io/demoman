import { describe, expect, it } from "vitest";
import { datesIn } from "../src/executor/dates-on-screen.js";

// Red when refresh cannot tell a page that shows dates from one that does
// not: the note it drives must fire only on evidence (DEM-79).
describe("datesIn", () => {
  it.each([
    ["Due Dec 4, 2026", "Dec 4, 2026"],
    ["Due 4 December 2026", "4 December 2026"],
    ["Created 2026-12-04", "2026-12-04"],
    ["Paid 12/4/2026", "12/4/2026"],
    ["Updated 3 days ago", "3 days ago"],
    ["Due in 5 minutes", "in 5 minutes"],
    ["Seen yesterday", "yesterday"],
    ["Starts tomorrow", "tomorrow"],
    ["Saved just now", "just now"],
    ["Replied 45m ago", "45m ago"],
  ])("finds a date in %j", (text, date) => {
    expect(datesIn(text)).toEqual([date]);
  });

  it("finds both ends of a range", () => {
    expect(datesIn("Cycle 24 Oct 31 – Nov 13")).toEqual(["Oct 31", "Nov 13"]);
  });

  it("finds none in ordinary text", () => {
    expect(
      datesIn(
        "INV-1048 Ivory Tower Tutoring $8,315.00 Step 4 of 9 v0.9.1 SUB-161 128 invoices 13.3 days to pay Market 4 Junior 2 Decision 3",
      ),
    ).toEqual([]);
  });

  it("caps at 3, distinct, in order", () => {
    expect(
      datesIn(
        "Dec 4, 2026 · Dec 4, 2026 · 2026-01-02 · yesterday · 3 days ago · Nov 9",
      ),
    ).toEqual(["Dec 4, 2026", "2026-01-02", "yesterday"]);
  });
});
