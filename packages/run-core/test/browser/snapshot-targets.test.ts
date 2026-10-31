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
  type SnapshotTarget,
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
  it("names a summary by its text, an img by its role, a stable id by itself, and the duplicate by position", async () => {
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
    // Both Deletes are listed, each by its position, and none is counted
    // unresolvable: a treePath names exactly one element.
    const deletes = w.targets.filter((t) => t.text === "Delete");
    expect(deletes, JSON.stringify(deletes)).toHaveLength(2);
    for (const d of deletes) expect(d.positional).toBe(true);
    expect(w.unresolvable).toBe(0);
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

  // Spec E: one visibility question. `rect` stays the plain one (a click may
  // aim at a transparent file input); `shown` is what a `waitFor` can see.
  describe("shown", () => {
    const list = async (html: string): Promise<SnapshotWalk> => {
      document.body.innerHTML = html;
      window.scrollTo(0, 0);
      return snapshotTargets(env(), ALL, clock);
    };
    const byText = (w: SnapshotWalk, text: string) =>
      w.targets.find((t) => t.text === text);

    it("lists an opacity-0 button as not shown, with its rect", async () => {
      const w = await list(
        '<button type="button" data-fixture="ghost" style="opacity:0">Upvote</button><button type="button">Plain</button>',
      );
      // Premises: the button really paints at opacity 0, and the plain
      // question still calls it visible (else this tests nothing).
      const ghost = document.querySelector("[data-fixture=ghost]") as Element;
      expect(getComputedStyle(ghost).opacity).toBe("0");
      expect(ghost.checkVisibility()).toBe(true);
      const t = byText(w, "Upvote");
      expect(t, JSON.stringify(w.targets)).toBeDefined();
      expect(t?.shown).toBe(false);
      expect(t?.rect).not.toBeNull();
      expect(byText(w, "Plain")?.shown).toBe(true);
    });

    it("lists a 1x1 native select as not shown", async () => {
      const w = await list(
        '<select aria-label="Range" data-fixture="tiny" style="width:1px;height:1px;padding:0;border:0;appearance:none;overflow:hidden"><option>Day</option><option>Week</option></select>',
      );
      const box = (
        document.querySelector("[data-fixture=tiny]") as Element
      ).getBoundingClientRect();
      expect([box.width, box.height]).toEqual([1, 1]);
      // Premise: the plain question calls it visible, so it is the size rule
      // that makes `shown` false.
      expect(
        (
          document.querySelector("[data-fixture=tiny]") as Element
        ).checkVisibility(),
      ).toBe(true);
      const t = w.targets.find(
        (x) => x.kind === "combobox" || x.kind === "listbox",
      );
      expect(t, JSON.stringify(w.targets)).toBeDefined();
      expect(t?.shown).toBe(false);
    });

    it("keeps a transparent control laid over a button listed, with its rect", async () => {
      const w = await list(
        '<div style="position:relative;width:120px;height:40px"><button type="button">Choose file</button><button type="button" aria-label="Upload" data-fixture="file" style="position:absolute;inset:0;width:100%;height:100%;opacity:0"></button></div>',
      );
      const input = document.querySelector("[data-fixture=file]") as Element;
      expect(getComputedStyle(input).opacity).toBe("0");
      const t = w.targets.find(
        (x) => x.text === null && x.rect !== null && x.rect.width >= 100,
      );
      expect(t, JSON.stringify(w.targets)).toBeDefined();
      expect(t?.rect).not.toBeNull();
      expect(t?.shown).toBe(false);
    });
  });
});

async function walkHtml(
  html: string,
  request: SnapshotRequest = ALL,
): Promise<SnapshotWalk> {
  document.body.innerHTML = html;
  window.scrollTo(0, 0);
  return snapshotTargets(env(), request, clock);
}

describe("what an agent needs listed (spec B)", () => {
  // Red if a div with a stable id but no role and no text is not a candidate.
  it("lists a div with only a data-testid", async () => {
    const html = `<div data-testid="payee" style="width:80px;height:20px"></div>`;
    await walkHtml(html);
    const div = document.querySelector("div") as Element;
    expect(computeRole(div)).toBeNull();
    expect(div.textContent).toBe("");
    const w = await walkHtml(html);
    expect(w.targets).toHaveLength(1);
    expect(w.targets[0]).toMatchObject({
      target: { stableId: "payee" },
      kind: "element",
    });
    expect(w.targets[0]?.positional).toBeFalsy();
  });

  // Red if every descendant of a pointer subtree is listed, or the root is not.
  it("lists a cursor-pointer div with no role, once, not its children", async () => {
    const html = `<div data-fixture="card" style="cursor:pointer"><div data-fixture="a" style="width:20px;height:20px"></div><div data-fixture="b" style="width:20px;height:20px"></div></div>`;
    await walkHtml(html);
    const root = document.querySelector("[data-fixture=card]") as Element;
    const kid = document.querySelector("[data-fixture=a]") as Element;
    expect(getComputedStyle(root).cursor).toBe("pointer");
    expect(getComputedStyle(kid).cursor).toBe("pointer");
    expect(computeRole(root)).toBeNull();
    const w = await walkHtml(html);
    expect(w.targets, JSON.stringify(w.targets)).toHaveLength(1);
    expect(w.targets[0]).toMatchObject({ kind: "element" });
  });

  // Red if the second Delete is dropped, or both are named alike.
  it("lists the second of two Delete buttons by its treePath, marked positional", async () => {
    const w = await walkHtml(
      `<button type="button">Delete</button><button type="button">Delete</button>`,
    );
    const buttons = [...document.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    expect(w.targets).toHaveLength(2);
    for (const t of w.targets) {
      expect(t.positional, JSON.stringify(t)).toBe(true);
      expect(Object.keys(t.target)).toEqual(["treePath"]);
      const report = await resolveAnchor(
        { id: "check", fingerprint: fingerprintFromTarget(t.target) },
        env(),
      );
      expect(report.candidates).toBe(1);
    }
    const second = await resolveAnchor(
      {
        id: "check",
        fingerprint: fingerprintFromTarget(
          (w.targets[1] as SnapshotTarget).target,
        ),
      },
      env(),
    );
    expect(second.element).toBe(buttons[1]);
    expect(w.unresolvable).toBe(0);
  });

  // Red if a value is not read, or a password's is.
  it("shows a field's value and never a password's", async () => {
    const w = await walkHtml(
      `<input data-testid="amount" value="12.50"><input type="password" data-testid="pw" value="hunter2"><div data-testid="plain"></div>`,
    );
    expect(document.querySelectorAll("input")).toHaveLength(2);
    const amount = w.targets.find(
      (t) => "stableId" in t.target && t.target.stableId === "amount",
    );
    const pw = w.targets.find(
      (t) => "stableId" in t.target && t.target.stableId === "pw",
    );
    const plain = w.targets.find(
      (t) => "stableId" in t.target && t.target.stableId === "plain",
    );
    expect(amount?.value).toBe("12.50");
    expect(pw, "the password field is still listed").toBeDefined();
    expect(pw?.value).toBeNull();
    expect(plain?.value).toBeNull();
    expect(JSON.stringify(w)).not.toContain("hunter2");
  });

  // Red if contains tests only name and text.
  it("contains matches a stableId and a kind", async () => {
    const html = `<div data-testid="payee-cell" style="width:80px;height:20px"></div><button type="button">Save</button><p>Unrelated</p>`;
    const byId = await walkHtml(html, { ...ALL, contains: "PAYEE" });
    expect(byId.targets.map((t) => t.target)).toEqual([
      { stableId: "payee-cell" },
    ]);
    const byKind = await walkHtml(html, { ...ALL, contains: "button" });
    expect(byKind.targets.map((t) => t.kind)).toEqual(["button"]);
    const byValue = await walkHtml(
      `<input data-testid="q" value="needle"><p>hay</p>`,
      { ...ALL, contains: "needle" },
    );
    expect(byValue.targets.map((t) => t.value)).toEqual(["needle"]);
  });

  // Ruling E: Actual Budget's transaction row. Cells are role-less, textless
  // divs; only the focused cell renders an input.
  it("lists an Actual-shaped row's empty cells, and the input a click renders", async () => {
    const row = (i: number) =>
      `<div data-fixture="row${i}"><div data-testid="payee" style="width:80px;height:20px"></div><div data-testid="debit" style="width:80px;height:20px"></div></div>`;
    const html = `${row(1)}${row(2)}<div data-testid="notes" style="width:80px;height:20px"></div>`;
    await walkHtml(html);
    for (const cell of document.querySelectorAll("[data-testid]")) {
      expect(computeRole(cell)).toBeNull();
      expect(cell.textContent).toBe("");
    }
    expect(document.querySelectorAll("[data-testid=payee]")).toHaveLength(2);
    const w = await walkHtml(html);
    const listed = (id: string) =>
      w.targets.filter(
        (t) => "stableId" in t.target && t.target.stableId === id,
      );
    expect(listed("notes")).toHaveLength(1);
    expect(listed("notes")[0]?.positional).toBeFalsy();
    // Two cells share a stableId: named by position, both.
    const positional = w.targets.filter((t) => t.positional === true);
    expect(positional).toHaveLength(4);
    expect(w.unresolvable).toBe(0);

    // A click on the second row's debit cell renders an input inside it.
    const cell = document.querySelectorAll(
      "[data-testid=debit]",
    )[1] as HTMLElement;
    cell.innerHTML = `<input value="42.00">`;
    const after = await snapshotTargets(env(), ALL, clock);
    const input = after.targets.find((t) => t.kind === "textbox");
    expect(input, JSON.stringify(after.targets)).toBeDefined();
    expect(input?.value).toBe("42.00");
  });
});
