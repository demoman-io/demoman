// apps/studio/test/pages/node/library-view.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  LibraryModel,
  LibraryRow,
} from "../../../pages/src/library/state";
import { renderLibrary, statusKey } from "../../../pages/src/library/view";

const reclaimedRow: LibraryRow = {
  sceneId: "a",
  name: "Checkout",
  label: "Checkout",
  origin: "app.test",
  path: "/checkout",
  createdAt: "2026-09-01T00:00:00Z",
  when: "Sep 1, 12:00 AM",
  time: "12:00 AM",
  hosted: true,
  recoverable: true,
  frameBytes: 100,
  outputBytes: 20,
  state: "Motion reclaimed",
  canRestore: true,
  authored: false,
  servesReshoot: false,
  needsLook: false,
};

const model: LibraryModel = {
  usedBytes: 250,
  budgetBytes: 1000,
  fraction: 0.25,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [reclaimedRow],
};

describe("renderLibrary", () => {
  it("renders the meter, one row per demo, and wires the buttons", () => {
    const root = document.createElement("div");
    const actions = {
      reclaim: vi.fn(),
      setBudget: vi.fn(),
      edit: vi.fn(),
      restore: vi.fn(),
      backToRecording: vi.fn(),
      remove: vi.fn(),
      preview: vi.fn(),
      filter: vi.fn(),
      rename: vi.fn(),
      openReview: vi.fn(),
    };
    // Delete hands straight to `actions.remove`: the page asks the author,
    // not the view (entrypoints/library/main.ts), so nothing here stands
    // between the click and the call.
    renderLibrary(root, model, actions, new Map());
    expect(root.querySelector("[data-meter]")?.textContent).toContain(
      "250 B of 1000 B",
    );
    const row = root.querySelector('[data-row="a"]') as HTMLElement;
    const hosted = row.querySelector("[data-hosted]") as HTMLElement;
    expect(hosted.textContent).toContain("Hosted");
    // A tag, not a chip: on Settings a chip is the round on/off icon.
    expect(hosted.classList.contains("tag")).toBe(true);
    expect(hosted.title).toMatch(/stays online/);
    (row.querySelector('[data-action="restore"]') as HTMLButtonElement).click();
    (row.querySelector('[data-action="delete"]') as HTMLButtonElement).click();
    expect(actions.restore).toHaveBeenCalledWith("a");
    expect(actions.remove).toHaveBeenCalledWith("a", "take");
  });

  it("shows a row's own status line, and never 'Deleted' for a partial delete", () => {
    const root = document.createElement("div");
    renderLibrary(
      root,
      model,
      {
        reclaim() {},
        setBudget() {},
        edit() {},
        restore() {},
        backToRecording() {},
        remove() {},
        preview() {},
        filter() {},
        rename() {},
        openReview() {},
      },
      new Map([
        [
          statusKey("take", "a"),
          "Partly deleted: outputs could not be removed — outputs db closed",
        ],
      ]),
    );
    expect(
      root.querySelector('[data-row="a"] [data-status]')?.textContent,
    ).toMatch(/Partly deleted: outputs/);
  });

  // FINDING 4 (whole-branch review). `migrating: false` alone cannot tell
  // "finished cleanly" apart from "threw outright" — before this, a failed
  // migration had no way to say so anywhere the library could render.
  it("says the migration itself failed, distinctly from still-migrating", () => {
    const root = document.createElement("div");
    const actions = {
      reclaim() {},
      setBudget() {},
      edit() {},
      restore() {},
      backToRecording() {},
      remove() {},
      preview() {},
      filter() {},
      rename() {},
      openReview() {},
    };
    renderLibrary(
      root,
      { ...model, migrating: false, migrationFailed: true },
      actions,
      new Map(),
    );
    expect(root.querySelector("[data-migration-failed]")).not.toBeNull();
    expect(root.querySelector("[data-migrating]")).toBeNull();
  });

  const noop = {
    reclaim() {},
    setBudget() {},
    edit() {},
    restore() {},
    backToRecording() {},
    remove() {},
    preview() {},
    filter() {},
    rename() {},
    openReview() {},
  };
  const complete: LibraryRow = {
    ...reclaimedRow,
    sceneId: "c",
    hosted: false,
    state: "Complete",
    canRestore: false,
    authored: false,
  };

  // Production change that reddens it: dropping the `r.servesReshoot` gate
  // (the button on every card), or wiring it to another action.
  it("offers Back to your recording only on a row that serves its re-shot frames", () => {
    const root = document.createElement("div");
    const actions = { ...noop, backToRecording: vi.fn() };
    const serving: LibraryRow = {
      ...complete,
      sceneId: "s",
      servesReshoot: true,
      needsLook: false,
    };
    renderLibrary(
      root,
      { ...model, rows: [complete, serving] },
      actions,
      new Map(),
    );
    const plain = root.querySelector('[data-row="c"]') as HTMLElement;
    expect(plain.querySelector('[data-action="back-to-recording"]')).toBeNull();
    const card = root.querySelector('[data-row="s"]') as HTMLElement;
    const back = card.querySelector(
      '[data-action="back-to-recording"]',
    ) as HTMLButtonElement;
    // Icon-only since 2026-10-05, beside the name: the words moved to the
    // accessible name, and the explanation stays on the tooltip.
    expect(back.textContent?.trim()).toBe("");
    expect(back.getAttribute("aria-label")).toBe(
      `Back to your recording: ${serving.label}`,
    );
    expect(back.title).toContain(
      "this take plays its re-shot frames; its recording is kept",
    );
    back.click();
    expect(actions.backToRecording).toHaveBeenCalledExactlyOnceWith("s");
  });

  // The 2026-09-13 restyle. "Complete" is what a recording is unless
  // something has happened to it, so a complete row says nothing about its
  // state; the two degraded states wear a chip. The production change that
  // reddens the first assertion: rendering `r.state` unconditionally again.
  it("labels only the states that depart from complete", () => {
    const root = document.createElement("div");
    renderLibrary(
      root,
      { ...model, rows: [complete, reclaimedRow] },
      noop,
      new Map(),
    );
    const done = root.querySelector('[data-row="c"]') as HTMLElement;
    expect(done.textContent).not.toMatch(/complete/i);
    expect(done.querySelector("[data-state-chip]")).toBeNull();
    expect(done.getAttribute("data-state")).toBe("complete");
    const reclaimed = root.querySelector('[data-row="a"]') as HTMLElement;
    expect(reclaimed.querySelector("[data-state-chip]")?.textContent).toContain(
      "Motion reclaimed",
    );
    expect(reclaimed.querySelector('[data-action="restore"]')).not.toBeNull();
    expect(done.querySelector('[data-action="restore"]')).toBeNull();
  });

  // Final review M1. Runs refuses to re-shoot a script-made take
  // (`authoredTake`), so a reclaimed authored take's chip and Restore name
  // the route that works there — its derived script, run again — instead
  // of a re-shoot. Chose retitling over hiding Restore: the route is real,
  // and hiding it would leave the reclaimed take with no way forward.
  it("tells a reclaimed authored take that Restore runs its script again", () => {
    const root = document.createElement("div");
    renderLibrary(
      root,
      {
        ...model,
        rows: [reclaimedRow, { ...reclaimedRow, sceneId: "s", authored: true }],
      },
      noop,
      new Map(),
    );
    const recorded = root.querySelector('[data-row="a"]') as HTMLElement;
    const scripted = root.querySelector('[data-row="s"]') as HTMLElement;
    // Premise: both rows offer Restore and wear the reclaimed chip.
    for (const row of [recorded, scripted]) {
      expect(row.querySelector('[data-action="restore"]')).not.toBeNull();
      expect(row.querySelector("[data-state-chip]")).not.toBeNull();
    }
    const titles = (row: HTMLElement) =>
      [
        row.querySelector<HTMLElement>('[data-action="restore"]')?.title,
        row.querySelector<HTMLElement>("[data-state-chip]")?.title,
      ].join(" | ");
    expect(titles(recorded)).toMatch(/re-shoots? it in Runs/i);
    expect(titles(scripted)).not.toMatch(/re-shoots? it/i);
    for (const t of [
      scripted.querySelector<HTMLElement>('[data-action="restore"]')?.title,
      scripted.querySelector<HTMLElement>("[data-state-chip]")?.title,
    ]) {
      expect(t).toMatch(/run its script again/i);
    }
  });

  it("names its icon-only actions, and says the take's size", () => {
    const root = document.createElement("div");
    renderLibrary(root, model, noop, new Map());
    const row = root.querySelector('[data-row="a"]') as HTMLElement;
    const edit = row.querySelector('[data-action="edit"]') as HTMLElement;
    const del = row.querySelector('[data-action="delete"]') as HTMLElement;
    // No words inside; the name is the aria-label, or a screen reader
    // announces "button".
    expect(edit.textContent?.trim()).toBe("");
    expect(edit.getAttribute("aria-label")).toBe("Edit Checkout");
    expect(edit.querySelector("svg")).not.toBeNull();
    expect(del.textContent?.trim()).toBe("");
    expect(del.getAttribute("aria-label")).toBe("Delete Checkout");
    expect(del.querySelector("svg")).not.toBeNull();
    const restore = row.querySelector('[data-action="restore"]') as HTMLElement;
    expect(restore.textContent?.trim()).toBe("");
    expect(restore.getAttribute("aria-label")).toBe("Restore motion: Checkout");
    expect(row.querySelector("[data-size]")?.textContent).toBe(
      "100 B frames · 20 B renders",
    );
  });

  // The 2026-10-05 card: the name and its actions share the title row; the
  // place-and-time and the size share the line under it; the chips and the
  // length ride on the thumbnail. The production change that reddens it:
  // putting the footer back, or the chips anywhere but the picture.
  it("lays the card out as a thumbnail, a title row and one line", () => {
    const root = document.createElement("div");
    renderLibrary(root, model, noop, new Map());
    const row = root.querySelector('[data-row="a"]') as HTMLElement;
    expect(row.querySelector(".row-footer")).toBeNull();
    const title = row.querySelector(".row-title") as HTMLElement;
    expect(title.querySelector("[data-name]")).not.toBeNull();
    expect(title.querySelector('[data-action="edit"]')).not.toBeNull();
    expect(title.querySelector('[data-action="delete"]')).not.toBeNull();
    const line = row.querySelector(".row-line") as HTMLElement;
    expect(line.querySelector(".row-meta")).not.toBeNull();
    expect(line.querySelector("[data-size]")).not.toBeNull();
    const box = row.querySelector("[data-preview]") as HTMLElement;
    // Premise: this row wears both kinds of chip.
    expect(box.querySelector("[data-hosted]")).not.toBeNull();
    expect(box.querySelector("[data-state-chip]")).not.toBeNull();
    // The length arrives from the preview port; until then there is none.
    const duration = box.querySelector("[data-duration]") as HTMLElement;
    expect(duration.hidden).toBe(true);
    expect(duration.textContent).toBe("");
  });

  it("puts no chip strip on a take with nothing to say", () => {
    const root = document.createElement("div");
    renderLibrary(
      root,
      { ...model, rows: [{ ...complete, hosted: false }] },
      noop,
      new Map(),
    );
    expect(root.querySelector('[data-row="c"] [data-preview]')).not.toBeNull();
    expect(root.querySelector('[data-row="c"] .row-tags')).toBeNull();
  });

  // The way to Needs a look since the popup's "N demos need a look" row
  // left it (2026-10-09). On the picture, where a tag stays visible without
  // a hover — the row's other controls only show under the pointer.
  it("flags a take that needs a look, and opens Needs a look from the flag", () => {
    const root = document.createElement("div");
    const actions = { ...noop, openReview: vi.fn(), edit: vi.fn() };
    renderLibrary(
      root,
      {
        ...model,
        rows: [
          { ...complete, needsLook: true },
          { ...complete, sceneId: "d", needsLook: false },
        ],
      },
      actions,
      new Map(),
    );
    const flag = root.querySelector(
      '[data-row="c"] [data-preview] .row-tags [data-needs-look]',
    ) as HTMLButtonElement;
    expect(flag).not.toBeNull();
    expect(flag.tagName).toBe("BUTTON");
    // A glyph alone; the name is for the screen reader and the pointer.
    expect(flag.textContent).toBe("");
    expect(flag.querySelector("svg")).not.toBeNull();
    expect(flag.getAttribute("aria-label")).toBe(
      `Needs a look: ${complete.label}`,
    );
    expect(flag.classList.contains("tag-warn")).toBe(true);
    // Only the flagged take: the other card carries no flag, and no strip.
    expect(root.querySelector('[data-row="d"] [data-needs-look]')).toBeNull();
    expect(root.querySelector('[data-row="d"] .row-tags')).toBeNull();

    flag.click();
    expect(actions.openReview).toHaveBeenCalledTimes(1);
    expect(actions.openReview).toHaveBeenCalledWith("c");
    // A button inside the card: the card's own click (open the editor)
    // stays out of it.
    expect(actions.edit).not.toHaveBeenCalled();
  });

  it("edits with a clapperboard, not a pencil: a take is a video, not a field", () => {
    const root = document.createElement("div");
    renderLibrary(root, model, noop, new Map());
    const glyph = root.querySelector('[data-action="edit"] svg');
    expect(glyph?.getAttribute("data-icon")).toBe("clapperboard");
  });

  it("renames on a committed edit, puts the name back on an escaped one, and clears it on a blank one", () => {
    const root = document.createElement("div");
    const actions = { ...noop, rename: vi.fn() };
    renderLibrary(root, model, actions, new Map());
    const field = root.querySelector(
      '[data-row="a"] [data-name]',
    ) as HTMLInputElement;
    expect(field.value).toBe("Checkout");
    expect(field.getAttribute("aria-label")).toBe("Demo name");
    // The full name rides on the tooltip: a long one is clipped at rest.
    expect(field.title).toBe("Checkout");
    field.value = "  Signup flow ";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions.rename).toHaveBeenCalledWith("a", "Signup flow");
    expect(field.value).toBe("Signup flow");
    expect(field.title).toBe("Signup flow");
    // Escape abandons what was typed.
    field.value = "Half-typ";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(field.value).toBe("Signup flow");
    // The same name again is not a rename.
    field.value = "Signup flow";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions.rename).toHaveBeenCalledTimes(1);
    // A blank returns the take to untitled: it is sent, as "", and the
    // field stays empty so its "Untitled" placeholder shows. Reddens if
    // the blank goes back to restoring the last name.
    field.value = "   ";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions.rename).toHaveBeenLastCalledWith("a", "");
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("Untitled");
  });

  it("opens the editor on a click on the card, but not on its name or its controls", () => {
    const root = document.createElement("div");
    const actions = { ...noop, edit: vi.fn(), restore: vi.fn() };
    renderLibrary(root, model, actions, new Map());
    const row = root.querySelector('[data-row="a"]') as HTMLElement;
    (row.querySelector("[data-name]") as HTMLElement).click();
    (row.querySelector('[data-action="delete"]') as HTMLElement).click();
    (row.querySelector('[data-action="restore"]') as HTMLElement).click();
    expect(actions.edit).not.toHaveBeenCalled();
    expect(actions.restore).toHaveBeenCalledWith("a");
    (row.querySelector(".row-meta") as HTMLElement).click();
    expect(actions.edit).toHaveBeenCalledWith("a");
    // The Edit button still opens it exactly once — not once from the
    // button and again from the click bubbling to the card.
    (row.querySelector('[data-action="edit"]') as HTMLElement).click();
    expect(actions.edit).toHaveBeenCalledTimes(2);
  });

  it("does not open the editor on the click that leaves the name field", () => {
    // A click on the card's blank area to finish typing a name blurs the
    // field on mousedown (committing the rename) and lands a click on the
    // card on mouseup. That click is the end of a rename, not a request
    // for the editor.
    const root = document.createElement("div");
    document.body.append(root);
    const actions = { ...noop, edit: vi.fn(), rename: vi.fn() };
    renderLibrary(root, model, actions, new Map());
    const row = root.querySelector('[data-row="a"]') as HTMLElement;
    const field = row.querySelector("[data-name]") as HTMLInputElement;
    const meta = row.querySelector(".row-meta") as HTMLElement;
    field.focus();
    meta.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    field.blur();
    meta.click();
    expect(actions.edit).not.toHaveBeenCalled();
    // The next click, with nothing focused, is the request.
    meta.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    meta.click();
    expect(actions.edit).toHaveBeenCalledTimes(1);
    root.remove();
  });

  it("carries a name still being typed across a re-render", () => {
    // The page re-renders every row when any row's rename settles. A
    // field the author is typing into on another card must not lose its
    // text or its focus to that.
    const root = document.createElement("div");
    document.body.append(root);
    renderLibrary(root, model, noop, new Map());
    const before = root.querySelector("[data-name]") as HTMLInputElement;
    before.focus();
    before.value = "Onb";
    before.setSelectionRange(1, 3);
    renderLibrary(root, model, noop, new Map());
    const after = root.querySelector("[data-name]") as HTMLInputElement;
    expect(after).not.toBe(before);
    expect(after.value).toBe("Onb");
    expect(document.activeElement).toBe(after);
    expect([after.selectionStart, after.selectionEnd]).toEqual([1, 3]);
    root.remove();
  });

  it("names each card by its take, so a screen reader can tell one Delete from another", () => {
    const root = document.createElement("div");
    renderLibrary(root, model, noop, new Map());
    const row = root.querySelector('[data-row="a"]') as HTMLElement;
    const field = row.querySelector("[data-name]") as HTMLInputElement;
    expect(field.id).not.toBe("");
    expect(row.getAttribute("aria-labelledby")).toBe(field.id);
  });

  // An untitled take shows "Untitled" in an empty field — the second line
  // already says where and when — and the card, whose usual name source is
  // that empty field, is labelled outright. Reddens if the card keeps
  // `aria-labelledby` (a nameless card to a screen reader) or the field is
  // filled with the label (a label passed off as a name).
  it("shows an untitled take as Untitled, still named for a screen reader", () => {
    const root = document.createElement("div");
    const untitled: LibraryRow = {
      ...complete,
      sceneId: "u",
      name: "",
      label: "app.test/checkout",
    };
    renderLibrary(
      root,
      { ...model, rows: [untitled, complete] },
      noop,
      new Map(),
    );
    const card = root.querySelector('[data-row="u"]') as HTMLElement;
    const field = card.querySelector("[data-name]") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("Untitled");
    expect(card.getAttribute("aria-labelledby")).toBeNull();
    expect(card.getAttribute("aria-label")).toBe("app.test/checkout");
    // The named card beside it keeps pointing at its field.
    const named = root.querySelector('[data-row="c"]') as HTMLElement;
    expect(named.getAttribute("aria-labelledby")).toBe(
      (named.querySelector("[data-name]") as HTMLElement).id,
    );
  });

  it("puts where and when under every take, named or not", () => {
    const root = document.createElement("div");
    renderLibrary(
      root,
      {
        ...model,
        rows: [
          { ...complete, sceneId: "u", name: "", when: "Sep 1, 9:05 AM" },
          { ...complete, sceneId: "named", when: "Sep 1, 10:30 AM" },
        ],
      },
      noop,
      new Map(),
    );
    expect(root.querySelector('[data-row="u"] .row-meta')?.textContent).toBe(
      "app.test/checkout · Sep 1, 9:05 AM",
    );
    expect(
      root.querySelector('[data-row="named"] .row-meta')?.textContent,
    ).toBe("app.test/checkout · Sep 1, 10:30 AM");
  });

  // The filter row exists only when there is something to choose between:
  // a developer with every take on one localhost and nothing reclaimed
  // would otherwise see a row holding one pill. The production change that
  // reddens the first case: rendering the row unconditionally.
  it("offers no filter row for one host with every take complete", () => {
    const root = document.createElement("div");
    renderLibrary(
      root,
      { ...model, rows: [complete, { ...complete, sceneId: "d" }] },
      noop,
      new Map(),
    );
    expect(root.querySelector("[data-filters]")).toBeNull();
  });

  it("offers host and state pills with counts, and reports the pick", () => {
    const root = document.createElement("div");
    const filter = vi.fn();
    const staging: LibraryRow = {
      ...complete,
      sceneId: "s",
      origin: "staging.test",
    };
    renderLibrary(
      root,
      { ...model, rows: [complete, staging, reclaimedRow] },
      { ...noop, filter },
      new Map(),
    );
    const hosts = [...root.querySelectorAll("[data-filter-host]")].map(
      (b) => b.textContent,
    );
    // app.test has two takes (complete + reclaimed), staging one: busiest
    // first, and the count rides on the pill.
    expect(hosts).toEqual(["app.test2", "staging.test1"]);
    expect(
      root.querySelector('[data-filter-state="Motion reclaimed"]')?.textContent,
    ).toBe("Motion reclaimed1");
    // Complete is the ordinary state, never a pill.
    expect(root.querySelector('[data-filter-state="Complete"]')).toBeNull();
    expect(
      root.querySelector("[data-filter-all]")?.getAttribute("aria-pressed"),
    ).toBe("true");
    (
      root.querySelector('[data-filter-host="staging.test"]') as HTMLElement
    ).click();
    expect(filter).toHaveBeenCalledWith({ host: "staging.test", state: null });
  });

  it("shows only the matching rows under a filter, and a way back from none", () => {
    const root = document.createElement("div");
    const staging: LibraryRow = {
      ...complete,
      sceneId: "s",
      origin: "staging.test",
    };
    const rows = [complete, staging, reclaimedRow];
    const filter = vi.fn();
    renderLibrary(root, { ...model, rows }, { ...noop, filter }, new Map(), {
      host: "staging.test",
      state: null,
    });
    expect(
      [...root.querySelectorAll("[data-row]")].map((r) =>
        r.getAttribute("data-row"),
      ),
    ).toEqual(["s"]);
    expect(
      root
        .querySelector('[data-filter-host="staging.test"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    // Pressing the active pill clears it.
    (
      root.querySelector('[data-filter-host="staging.test"]') as HTMLElement
    ).click();
    expect(filter).toHaveBeenLastCalledWith({ host: null, state: null });

    // A filter nothing matches — the host's last take was deleted — must
    // not read as an empty library.
    renderLibrary(root, { ...model, rows }, { ...noop, filter }, new Map(), {
      host: "gone.test",
      state: null,
    });
    expect(root.querySelector("[data-row]")).toBeNull();
    expect(root.querySelector("[data-empty]")).toBeNull();
    const filtered = root.querySelector("[data-empty-filtered]") as HTMLElement;
    expect([
      filtered.querySelector("svg")?.getAttribute("data-icon"),
      filtered.querySelector("strong")?.textContent,
    ]).toEqual(["funnel", "No recordings match this filter"]);
    (
      root.querySelector(
        "[data-empty-filtered] [data-filter-all]",
      ) as HTMLElement
    ).click();
    expect(filter).toHaveBeenLastCalledWith({ host: null, state: null });
  });

  it("heads the page Recordings, with the storage controls in a panel its trigger opens", () => {
    const root = document.createElement("div");
    renderLibrary(root, model, noop, new Map());
    // The title heads the left column (2026-10-08), as Settings' does,
    // and the trigger sits at that column's foot. It names the numbers,
    // for a screen reader as well as on its face.
    const side = root.querySelector("[data-header]") as HTMLElement;
    expect(side.querySelector("h1")?.textContent).toBe("Recordings");
    const trigger = side.querySelector(
      "[data-storage-trigger]",
    ) as HTMLButtonElement;
    expect(side.lastElementChild?.contains(trigger)).toBe(true);
    expect(trigger.getAttribute("aria-label")).toBe(
      "Storage: 250 B of 1000 B used",
    );
    // The panel is a popover, not a fold in the page's flow: that is what
    // keeps it from pushing the list down. The trigger opens it by id, and
    // the controls live inside it.
    const panel = root.querySelector("[data-storage]") as HTMLElement;
    expect(panel.tagName).not.toBe("DETAILS");
    expect(panel.hasAttribute("popover")).toBe(true);
    expect(trigger.getAttribute("popovertarget")).toBe(panel.id);
    expect(panel.querySelector('[data-action="reclaim"]')).not.toBeNull();
    expect(panel.querySelector("[data-storage-budget]")).not.toBeNull();
    expect(panel.querySelector('[role="progressbar"]')).not.toBeNull();
    // One progressbar: the trigger's bar is decoration under its label.
    expect(root.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    expect(panel.querySelector("[data-storage-used]")?.textContent).toBe(
      "250 B used of a 1000 B budget",
    );
  });

  it("keeps a storage notice in the page, where it is read without opening anything", () => {
    const root = document.createElement("div");
    renderLibrary(
      root,
      { ...model, notice: "Storage is over budget." },
      noop,
      new Map(),
    );
    const notice = root.querySelector("[data-notice]") as HTMLElement;
    expect(notice.textContent).toBe("Storage is over budget.");
    expect(notice.closest("[data-storage]")).toBeNull();
  });
});

describe("renderLibrary page parts", () => {
  const noop = {
    reclaim() {},
    setBudget() {},
    edit() {},
    restore() {},
    backToRecording() {},
    remove() {},
    preview() {},
    filter() {},
    rename() {},
    openReview() {},
  };

  // The button was a bar and "250 B of 1000 B", a figure with nothing to
  // say what it counts. Reddens if the word leaves the button.
  it("says Storage on the storage button, before the figure", () => {
    const root = document.createElement("div");
    renderLibrary(root, model, noop, new Map());
    expect(root.querySelector("[data-storage-trigger]")?.textContent).toBe(
      "Storage250 B of 1000 B",
    );
  });

  // Every other pill carries its count; All carried none.
  it("counts every take on the All pill", () => {
    const root = document.createElement("div");
    renderLibrary(
      root,
      {
        ...model,
        rows: [
          { ...reclaimedRow, sceneId: "x", origin: "one.test" },
          { ...reclaimedRow, sceneId: "y", origin: "two.test" },
          { ...reclaimedRow, sceneId: "z", origin: "two.test" },
        ],
      },
      noop,
      new Map(),
    );
    expect(root.querySelector("[data-filter-all]")?.textContent).toBe("All3");
  });

  // Settings' empty state: a glyph beside a title and a hint, on a card,
  // with no button. The hint says where Record is in the author's words:
  // "the popup" is ours.
  it("says an empty library with a glyph, a title and where Record is", () => {
    const root = document.createElement("div");
    renderLibrary(root, { ...model, rows: [] }, noop, new Map());
    const empty = root.querySelector("[data-empty]") as HTMLElement;
    expect([
      empty.classList.contains("card"),
      empty.querySelector("svg")?.getAttribute("data-icon"),
      empty.querySelector("strong")?.textContent,
      empty.querySelectorAll("button").length,
    ]).toEqual([true, "monitorPlay", "No recordings yet", 0]);
    expect(empty.querySelector(".hint")?.textContent).toMatch(
      /toolbar.*Record/,
    );
    expect(empty.textContent).not.toMatch(/popup/);
  });
});

describe("renderLibrary sections", () => {
  const noop = {
    reclaim() {},
    setBudget() {},
    edit() {},
    restore() {},
    backToRecording() {},
    remove() {},
    preview() {},
    filter() {},
    rename() {},
    openReview() {},
  };
  const at = (y: number, m: number, d: number, h = 12): string =>
    new Date(y, m - 1, d, h).toISOString();
  const row = (sceneId: string, createdAt: string): LibraryRow => ({
    ...reclaimedRow,
    sceneId,
    name: sceneId,
    createdAt,
    state: "Complete",
    canRestore: false,
    authored: false,
    recoverable: false,
    hosted: false,
  });
  const now = new Date(2026, 8, 14, 9);
  const dated: LibraryModel = {
    ...model,
    rows: [
      row("t1", at(2026, 9, 14, 8)),
      row("t2", at(2026, 9, 14, 7)),
      row("y", at(2026, 9, 13)),
      row("aug", at(2026, 8, 30)),
    ],
  };
  const sections = (root: HTMLElement) => [
    ...root.querySelectorAll<HTMLDetailsElement>("[data-section]"),
  ];

  // The production change that reddens this: rendering the rows as one
  // flat list again, or a heading that lists a row from another section.
  it("heads each section, counts it, and lists exactly its rows", () => {
    const root = document.createElement("div");
    renderLibrary(root, dated, noop, new Map(), undefined, now);
    const got = sections(root).map((s) => ({
      key: s.getAttribute("data-section"),
      heading: s.querySelector("h2")?.textContent,
      count: s.querySelector("[data-section-count]")?.textContent,
      rows: [...s.querySelectorAll("[data-row]")].map((r) =>
        r.getAttribute("data-row"),
      ),
    }));
    expect(got).toEqual([
      { key: "today", heading: "Today", count: "2", rows: ["t1", "t2"] },
      { key: "yesterday", heading: "Yesterday", count: "1", rows: ["y"] },
      {
        key: "month:2026-08",
        heading: new Date(2026, 7, 30).toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        }),
        count: "1",
        rows: ["aug"],
      },
    ]);
    // Every row is under some heading: none escaped to the root.
    expect(root.querySelectorAll("[data-row]")).toHaveLength(4);
  });

  // The left column's jump list (2026-10-08): a link per section, in the
  // sections' order, each naming its section's id and count — and a link
  // to a folded month opens it, or the jump lands on one closed line.
  it("lists a jump to each section, and opens a folded month it jumps to", () => {
    const root = document.createElement("div");
    document.body.append(root);
    renderLibrary(root, dated, noop, new Map(), undefined, now);
    const links = [
      ...root.querySelectorAll<HTMLAnchorElement>("[data-jumps] a[data-nav]"),
    ];
    expect(
      links.map((a) => ({
        to: a.getAttribute("href"),
        label: a.querySelector(".side-label")?.textContent,
        count: a.querySelector(".side-count")?.textContent,
      })),
    ).toEqual(
      sections(root).map((s) => ({
        to: `#${s.id}`,
        label: s.querySelector("h2")?.textContent,
        count: s.querySelector("[data-section-count]")?.textContent,
      })),
    );
    // Every link names a section that is there to land on.
    for (const a of links) {
      expect(document.getElementById(a.dataset.nav ?? "")).not.toBeNull();
    }
    // Premise: August is a past month, so it starts folded.
    const august = root.querySelector(
      '[data-section="month:2026-08"]',
    ) as HTMLDetailsElement;
    expect(august.open, "August started open").toBe(false);
    (links.at(-1) as HTMLAnchorElement).click();
    expect(august.open, "the jump left August folded").toBe(true);
    root.remove();
  });

  // Settings' disclosure: the Lucide chevron first in the summary, not a
  // corner drawn in CSS.
  it("opens each section with Settings' chevron", () => {
    const root = document.createElement("div");
    renderLibrary(root, dated, noop, new Map(), undefined, now);
    for (const s of sections(root)) {
      const first = s.querySelector("summary")?.firstElementChild;
      expect(first?.getAttribute("data-icon")).toBe("chevronRight");
      expect(first?.classList.contains("chev")).toBe(true);
    }
  });

  // A heading that names the day already says the date, so its rows show
  // only the time; a month's rows keep theirs. The fixture's premise: the
  // two fields differ, or the assertions could not tell them apart.
  it("times a row under a day and dates a row under a month", () => {
    expect(reclaimedRow.when).not.toBe(reclaimedRow.time);
    const root = document.createElement("div");
    renderLibrary(root, dated, noop, new Map(), undefined, now);
    const meta = (id: string) =>
      root.querySelector(`[data-row="${id}"] .row-meta`)?.textContent;
    expect(meta("t1")).toBe(`app.test/checkout · ${reclaimedRow.time}`);
    expect(meta("y")).toBe(`app.test/checkout · ${reclaimedRow.time}`);
    expect(meta("aug")).toBe(`app.test/checkout · ${reclaimedRow.when}`);
  });

  it("starts a past month closed and everything newer open", () => {
    const root = document.createElement("div");
    renderLibrary(root, dated, noop, new Map(), undefined, now);
    expect(
      sections(root).map((s) => [s.getAttribute("data-section"), s.open]),
    ).toEqual([
      ["today", true],
      ["yesterday", true],
      ["month:2026-08", false],
    ]);
  });

  // A rename, a delete or a filter re-renders the whole list. A month the
  // author had opened must not fold back on them, and one they folded
  // must not spring open. The production change that reddens this:
  // rendering `open` from the section's default alone.
  it("carries each section's open or closed state across a re-render", () => {
    const root = document.createElement("div");
    renderLibrary(root, dated, noop, new Map(), undefined, now);
    const by = (key: string) =>
      root.querySelector<HTMLDetailsElement>(`[data-section="${key}"]`);
    (by("month:2026-08") as HTMLDetailsElement).open = true;
    (by("yesterday") as HTMLDetailsElement).open = false;
    renderLibrary(root, dated, noop, new Map(), undefined, now);
    expect(by("month:2026-08")?.open).toBe(true);
    expect(by("yesterday")?.open).toBe(false);
    expect(by("today")?.open).toBe(true);
  });

  // A filter that matches nothing renders no sections, so the DOM has no
  // state to read on the next render. The production change that reddens
  // this: reading only the DOM in `sectionStates`.
  it("keeps a month the author opened open across a filter that matched nothing", () => {
    const root = document.createElement("div");
    renderLibrary(root, dated, noop, new Map(), undefined, now);
    const by = (key: string) =>
      root.querySelector<HTMLDetailsElement>(`[data-section="${key}"]`);
    (by("month:2026-08") as HTMLDetailsElement).open = true;
    renderLibrary(
      root,
      dated,
      noop,
      new Map(),
      { host: "nowhere.test", state: null },
      now,
    );
    expect(root.querySelector("[data-empty-filtered]")).not.toBeNull();
    renderLibrary(root, dated, noop, new Map(), undefined, now);
    expect(by("month:2026-08")?.open).toBe(true);
  });

  it("applies a filter within sections, and drops a section it empties", () => {
    const root = document.createElement("div");
    const mixed: LibraryModel = {
      ...dated,
      rows: [
        ...dated.rows,
        { ...row("staging", at(2026, 9, 13)), origin: "staging.test" },
      ],
    };
    renderLibrary(
      root,
      mixed,
      noop,
      new Map(),
      { host: "staging.test", state: null },
      now,
    );
    expect(sections(root).map((s) => s.getAttribute("data-section"))).toEqual([
      "yesterday",
    ]);
    expect(
      [...root.querySelectorAll("[data-row]")].map((r) =>
        r.getAttribute("data-row"),
      ),
    ).toEqual(["staging"]);
  });

  it("tells a screen reader the section a card is in", () => {
    const root = document.createElement("div");
    renderLibrary(root, dated, noop, new Map(), undefined, now);
    const section = root.querySelector('[data-section="today"]') as HTMLElement;
    const heading = section.querySelector("h2") as HTMLElement;
    expect(heading.id).not.toBe("");
    expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
  });
});

describe("the Recordings stylesheet", () => {
  // A shape assertion on the stylesheet, and named as one: the browser
  // lane cannot take away Chrome's ability to hover, so the rule that
  // shows the size line and the actions on a device without hover can
  // only be checked for being there. The production change that reddens
  // this: dropping the `hover: none` block, any selector from it, or the
  // rule that stacks the size under the place rather than over it.
  it("keeps the size line and the actions in view where nothing can hover", () => {
    const html = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "..",
        "pages",
        "entrypoints",
        "library",
        "index.html",
      ),
      "utf8",
    );
    const block = /@media \(hover: none\) \{([\s\S]*?)\n {6}\}/.exec(html)?.[1];
    expect(block, "a hover: none block").toBeDefined();
    const rule = /([^{}]+)\{([^}]*)\}/.exec(block ?? "");
    expect(rule?.[1]?.replace(/\s+/g, " ").trim()).toBe(
      ".row-size, .row-actions, article.card .row-meta, article.card:focus-within .row-meta",
    );
    expect(rule?.[2]?.replace(/\s+/g, " ").trim()).toBe("opacity: 1;");
    expect(block?.replace(/\s+/g, " ")).toContain(
      ".row-line > .row-size { grid-area: 2 / 1; }",
    );
  });
});

describe("renderLibrary preview box", () => {
  const actions = () => ({
    reclaim: vi.fn(),
    setBudget: vi.fn(),
    edit: vi.fn(),
    restore: vi.fn(),
    backToRecording: vi.fn(),
    remove: vi.fn(),
    preview: vi.fn(),
    filter: vi.fn(),
    rename: vi.fn(),
    openReview: vi.fn(),
  });

  it("gives every row a preview box and hands it to the preview port", () => {
    const root = document.createElement("div");
    const a = actions();
    renderLibrary(root, model, a, new Map());
    const box = root.querySelector('[data-row="a"] [data-preview]');
    expect(box).not.toBeNull();
    expect(a.preview).toHaveBeenCalledWith("a", box);
  });

  it("starts the box in a state that says so, not blank", () => {
    const root = document.createElement("div");
    renderLibrary(root, model, actions(), new Map());
    const note = root.querySelector('[data-row="a"] [data-preview-note]');
    // A box that renders empty until its port resolves is indistinguishable
    // from a demo with no preview at all.
    expect(note?.textContent).toBe("Loading preview…");
  });

  it("says why a budget was refused, and asks nothing of the extension", () => {
    // The Settings page's control and the Settings page's defect: a commit
    // that returned in silence looked exactly like one that worked. The
    // field saves on `change` since 2026-10-06 — there is no Set button.
    const root = document.createElement("div");
    const a = actions();
    renderLibrary(root, model, a, new Map());
    const note = root.querySelector("[data-budget-note]") as HTMLElement;
    const input = root.querySelector(
      "[data-storage-budget]",
    ) as HTMLInputElement;
    expect(root.querySelector('[data-action="set-budget"]')).toBeNull();
    expect(note.classList.contains("hidden")).toBe(true);

    const commit = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event("change"));
    };
    commit("0");
    expect(a.setBudget).not.toHaveBeenCalled();
    expect(note.classList.contains("hidden")).toBe(false);
    expect(note.textContent).toMatch(/above zero/i);

    // An emptied field is refused too, not read as zero bytes.
    note.classList.add("hidden");
    commit("");
    expect(a.setBudget).not.toHaveBeenCalled();
    expect(note.classList.contains("hidden")).toBe(false);

    // And put away again by a budget it does accept.
    commit("2");
    expect(a.setBudget).toHaveBeenCalledWith(2 * 1024 ** 3);
    expect(note.classList.contains("hidden")).toBe(true);
  });
});
