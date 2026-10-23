import type { ResolveEnv } from "@demoman/resolver";
import {
  computeName,
  computeRole,
  isTextLeaf,
  NO_PATCH,
  NO_SHADOW,
  normalizeText,
} from "@demoman/resolver";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotTargets } from "../../src/page.js";

/**
 * `notExamined` under `contains`.
 *
 * The tool description (apps/mcp/src/tools.ts) tells the agent:
 * "notExamined above 0 means the page had more; pass contains … to ask for one
 * part of it." With `contains` already passed, the agent reads a positive count
 * as "more of what I asked for is on the page". The walk counts EVERY candidate
 * left when the cap or budget runs out — including ones the `contains` filter
 * would have dropped without examining them at all — so it can say "more"
 * when nothing else on the page matches.
 *
 * Red today; green once the remainder is counted through the same filter.
 */
const FIXTURE = `
  <button type="button" data-testid="pay-btn">Pay now</button>
  <p>Shipping is free.</p>
  <p>Returns within thirty days.</p>
  <button type="button" data-testid="help-btn">Help</button>
`;

const env = (): ResolveEnv => ({
  root: document,
  shadow: NO_SHADOW,
  patch: NO_PATCH,
});

/** The walk's own candidate rule, restated so the premise can be asserted. */
const candidates = (): Element[] =>
  Array.from(document.body.querySelectorAll("*")).filter(
    (el) =>
      computeRole(el) !== null ||
      (isTextLeaf(el) && normalizeText(el.textContent) !== null),
  );
const matches = (el: Element, wanted: string): boolean =>
  `${computeName(el) ?? ""} ${normalizeText(el.textContent) ?? ""}`
    .toLowerCase()
    .includes(wanted);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("notExamined with contains", () => {
  it("does not report unexamined matches when nothing after the cap matches", async () => {
    document.body.innerHTML = FIXTURE;

    // Premises: exactly one candidate matches "pay", it comes first, and
    // there ARE candidates after it — so the cap of 1 fires with a non-empty
    // remainder, none of which matches.
    const all = candidates();
    const matching = all.filter((el) => matches(el, "pay"));
    expect(matching).toHaveLength(1);
    expect(all[0]).toBe(matching[0]);
    expect(all.length).toBeGreaterThan(1);

    const w = await snapshotTargets(
      env(),
      { contains: "PAY", maxTargets: 1, budgetMs: 60_000 },
      () => performance.now(),
    );
    // Premise: the one match was listed, so the cap really was reached.
    expect(w.targets.map((t) => t.target)).toEqual([{ stableId: "pay-btn" }]);

    expect(
      w.notExamined,
      `notExamined counts ${all.length - 1} candidates "pay" never matches`,
    ).toBe(0);
  });

  // Positive controls for the case above: without them, a fix that zeroed
  // `notExamined` whenever `contains` was given would pass it. Here the
  // remainder holds one more match among non-matches, so the count must be
  // exactly the matches — not zero, and not the whole remainder.
  const TWO_MATCHES = `
    <button type="button" data-testid="pay-btn">Pay now</button>
    <p>Shipping is free.</p>
    <button type="button" data-testid="pay-later-btn">Pay later</button>
    <p>Returns within thirty days.</p>
  `;

  /** Premises shared by both controls: the first candidate is a match, and
   *  the remainder after it holds exactly one match and some non-matches. */
  function assertTwoMatchPremises(): void {
    const all = candidates();
    expect(all[0]?.getAttribute("data-testid")).toBe("pay-btn");
    const rest = all.slice(1);
    expect(rest.filter((el) => matches(el, "pay"))).toHaveLength(1);
    expect(rest.length).toBeGreaterThan(1);
  }

  it("counts exactly the unexamined matches when the cap runs out", async () => {
    document.body.innerHTML = TWO_MATCHES;
    assertTwoMatchPremises();
    const w = await snapshotTargets(
      env(),
      { contains: "pay", maxTargets: 1, budgetMs: 60_000 },
      () => performance.now(),
    );
    expect(w.targets.map((t) => t.target)).toEqual([{ stableId: "pay-btn" }]);
    expect(w.notExamined).toBe(1);
  });

  it("counts exactly the unexamined matches when the budget runs out", async () => {
    document.body.innerHTML = TWO_MATCHES;
    assertTwoMatchPremises();
    // The walk reads the clock once to start and once before each candidate:
    // the first two reads are inside the budget, every later one past it, so
    // the first candidate is examined and the budget stops the walk at the
    // second.
    let reads = 0;
    const clock = (): number => (reads++ < 2 ? 0 : 1_000);
    const w = await snapshotTargets(
      env(),
      { contains: "pay", maxTargets: 250, budgetMs: 500 },
      clock,
    );
    // Premise: it was the budget, not the cap, that stopped the walk.
    expect(w.targets.map((t) => t.target)).toEqual([{ stableId: "pay-btn" }]);
    expect(reads).toBeGreaterThan(2);
    expect(w.notExamined).toBe(1);
  });
});
