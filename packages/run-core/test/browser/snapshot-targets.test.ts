import { fingerprintFromTarget } from "@demoman/replay-engine/page";
import type { ResolveEnv } from "@demoman/resolver";
import {
  computeRole,
  isTextLeaf,
  NO_PATCH,
  NO_SHADOW,
  resolveAnchor,
} from "@demoman/resolver";
import { afterEach, describe, expect, it } from "vitest";
import {
  type SnapshotRequest,
  type SnapshotWalk,
  snapshotTargets,
} from "../../src/page.js";

/**
 * The snapshot's walk against a real Chromium layout (spec §4.1, §7). Driven
 * directly, as `capture-resolved.test.ts` drives `captureForIntent`: the
 * browser lane runs inside an iframe, where the content script's top-frame
 * gate would refuse the message.
 *
 * The fixture holds the four shapes spec §7 names, each asserted present
 * before anything is measured against it:
 * - a `<summary>` whose label sits beside an icon (Chrome's
 *   DisclosureTriangle; Demoman has no role for it, so it is a text leaf);
 * - an `<img>` (Chrome says "image", Demoman says "img");
 * - two buttons with the same label, which must be LEFT OUT and counted;
 * - a closed `<details>` answer, which is not shown but must be listed
 *   (plan 2, Review Focus 2: the proving run's FAQ).
 */
const FIXTURE = `
  <h1>Kitchen FAQ</h1>
  <button type="button">Show the answer</button>
  <a href="#faq">See how it works</a>
  <img alt="Kitchen photo" width="40" height="30"
       src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==">
  <button type="button" data-testid="checkout-btn">Checkout</button>
  <button type="button">Delete</button>
  <button type="button">Delete</button>
  <details data-fixture="faq">
    <summary><svg width="10" height="10" aria-hidden="true"><path d="M0 0L10 5L0 10z"/></svg>How do customers pay me?</summary>
    <p data-fixture="answer">Through Stripe, every week.</p>
  </details>
  <div style="height: 3000px"></div>
  <p data-fixture="bottom">The last line of the page.</p>
`;
// No `id` attributes on purpose: `id` is a stable-id attribute
// (`STABLE_ID_ATTRS`), so `<p id="bottom">` would be listed as
// {stableId: "bottom"} and the cases below that look for {text} would be
// testing the wrong tier. `data-fixture` is not one of them.

const env = (): ResolveEnv => ({
  root: document,
  shadow: NO_SHADOW,
  patch: NO_PATCH,
});
const ALL: SnapshotRequest = {
  contains: null,
  maxTargets: 1000,
  budgetMs: 60_000,
};
const clock = () => performance.now();

async function walk(request: SnapshotRequest = ALL): Promise<SnapshotWalk> {
  document.body.innerHTML = FIXTURE;
  window.scrollTo(0, 0);
  return snapshotTargets(env(), request, clock);
}

const find = (w: SnapshotWalk, target: object) =>
  w.targets.find((t) => JSON.stringify(t.target) === JSON.stringify(target));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the snapshot's walk", () => {
  it("has its fixture's premises", async () => {
    await walk();
    const summary = document.querySelector("summary") as Element;
    expect(computeRole(summary)).toBeNull();
    expect(isTextLeaf(summary)).toBe(true);
    expect(computeRole(document.querySelector("img") as Element)).toBe("img");
    expect(
      [...document.querySelectorAll("button")].filter(
        (b) => b.textContent === "Delete",
      ),
    ).toHaveLength(2);
    expect(
      (document.querySelector("[data-fixture=faq]") as HTMLDetailsElement).open,
    ).toBe(false);
    // The answer is not shown. Not "has no box": measured on Chrome 151, a
    // closed <details>'s content still lays out (::details-content is
    // content-visibility: hidden) at a real rect inside the first viewport,
    // which is why the walk asks checkVisibility rather than the rect.
    expect(
      (
        document.querySelector("[data-fixture=answer]") as Element
      ).checkVisibility(),
    ).toBe(false);
    // The bottom line is past the first viewport, whatever this iframe's size.
    expect(
      (
        document.querySelector("[data-fixture=bottom]") as Element
      ).getBoundingClientRect().top,
    ).toBeGreaterThan(window.innerHeight);
    // Premise for the {text} cases: nothing in the fixture carries a stable id
    // but the one button that is meant to.
    expect(document.querySelectorAll("[id],[data-testid]")).toHaveLength(1);
  });

  // The guarantee (spec §4.1). Red if the walk lists an anchor without
  // resolving it back: the duplicate "Delete" captures by role+name with two
  // candidates (corroboration breaks the tie), and a bare {role, name} names
  // both.
  it("lists only targets that resolve, through the real resolver, to exactly one element at the listed rect", async () => {
    const w = await walk();
    expect(w.targets.length).toBeGreaterThan(5);
    for (const t of w.targets) {
      const report = await resolveAnchor(
        { id: "check", fingerprint: fingerprintFromTarget(t.target) },
        env(),
      );
      expect(report.candidates, JSON.stringify(t)).toBe(1);
      expect(report.element, JSON.stringify(t)).not.toBeNull();
      if (t.rect !== null && report.element !== null) {
        const r = report.element.getBoundingClientRect();
        expect(Math.round(r.y + window.scrollY), JSON.stringify(t)).toBe(
          Math.round(t.rect.y),
        );
      }
    }
  });

  // Red if a shape is listed in Chrome's vocabulary instead of the
  // resolver's, or if a duplicate is listed instead of counted.
  it("names a summary by its text, an img by its role, a stable id by itself, and leaves the duplicate out", async () => {
    const w = await walk();
    expect(find(w, { text: "How do customers pay me?" })).toMatchObject({
      kind: "text",
    });
    expect(find(w, { role: "img", name: "Kitchen photo" })).toMatchObject({
      kind: "img",
    });
    expect(find(w, { stableId: "checkout-btn" })).toMatchObject({
      kind: "button",
    });
    expect(find(w, { role: "button", name: "Show the answer" })).toMatchObject({
      inFirstViewport: true,
    });
    expect(
      w.targets.filter((t) => t.text === "Delete"),
      JSON.stringify(w.targets.filter((t) => t.text === "Delete")),
    ).toEqual([]);
    expect(w.unresolvable).toBeGreaterThanOrEqual(2);
    expect(w.notExamined).toBe(0);
    expect(w.title).toBe(document.title);
  });

  // Plan 2, Review Focus 2. Red if an element not shown is dropped (the
  // agent could not name a closed FAQ answer in a waitFor), or is given a
  // rect it does not have.
  it("lists a hidden answer with no rect, and a far-down line in document coordinates", async () => {
    const w = await walk();
    expect(find(w, { text: "Through Stripe, every week." })).toMatchObject({
      rect: null,
      inFirstViewport: false,
    });
    const bottom = find(w, { text: "The last line of the page." });
    expect(bottom?.inFirstViewport).toBe(false);
    expect(bottom?.rect?.y ?? 0).toBeGreaterThan(3000);
  });

  // Plan 2, Review Focus 3. Red if the cap or the budget cuts the list
  // without saying so.
  it("says how many it never examined when the cap or the time budget runs out", async () => {
    const capped = await walk({ ...ALL, maxTargets: 2 });
    expect(capped.targets).toHaveLength(2);
    expect(capped.notExamined).toBeGreaterThan(0);

    document.body.innerHTML = FIXTURE;
    let t = 0;
    const jumping = () => {
      t += 5_000; // every reading of the clock is 5 s later
      return t;
    };
    const timed = await snapshotTargets(
      env(),
      { ...ALL, budgetMs: 8_000 },
      jumping,
    );
    // started at 5 s; the first check reads 10 s (examined), the second 15 s
    // (over the 8 s budget): one element examined, the rest counted.
    expect(timed.notExamined).toBeGreaterThan(0);
    expect(timed.targets.length).toBeLessThanOrEqual(1);
  });

  // Red if `contains` is ignored (an agent hunting one section of a long page
  // would get the cap's first 250 instead) or matches case-sensitively.
  it("keeps only targets whose text or name contains `contains`, ignoring case", async () => {
    const w = await walk({ ...ALL, contains: "PAY" });
    expect(w.targets.map((t) => t.target)).toEqual([
      { text: "How do customers pay me?" },
    ]);
  });
});
