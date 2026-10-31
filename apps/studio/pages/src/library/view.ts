// apps/studio/pages/src/library/view.ts
import { setCodeText } from "../shell/code-spans";
import { emptyState } from "../shell/empty-state";
import { type GlyphName, icon } from "../shell/icons";
import { EXTENSION_FIRST_TAKE_HINT } from "./hints";
import { previewText } from "./preview";
import type { Selection } from "./selection";
import type {
  LibraryModel,
  LibraryRow,
  LibrarySection,
  VideoGroup,
} from "./state";
import {
  BAD_BUDGET,
  cardsOf,
  formatBytes,
  repoLabel,
  sectionsOf,
} from "./state";

/** Which kind of row a status was said on. A take's folder is named after
 *  it, so a card and the "Couldn't read" row its folder can become share an
 *  id; keyed on the id alone, a card's refusal (an export holding it)
 *  followed the take onto that row, long after it stopped being true. */
export type RowKind = "take" | "folder" | "video" | "record";

/** What an unreadable row's Delete removes, as the kind its status is held
 *  under; null for a row with nothing to delete. */
export const unreadableKind = (u: {
  kind?: "take" | "video" | "upkeep";
}): "folder" | "record" | null =>
  u.kind === "upkeep" ? null : u.kind === "video" ? "record" : "folder";

/** The key a row's status is held under in the page's `rowStatus`. */
export const statusKey = (kind: RowKind, id: string): string => `${kind}:${id}`;

export interface LibraryActions {
  /** Reclaim and the budget are the storage controls: a page that passes
   *  both draws the Storage button and its panel, and a page without them
   *  draws neither (a platform that has no storage to manage). */
  reclaim?(): void;
  setBudget?(bytes: number): void;
  edit(sceneId: string): void;
  /** The author committed a new name on the card. Trimmed and non-empty:
   *  the view keeps a blank or unchanged edit to itself. */
  rename(sceneId: string, name: string): void;
  /** The author committed a new name on a video's card: the video's, not
   *  its takes'. Trimmed and non-empty; a video is never untitled. */
  renameVideo(videoId: string, name: string): void;
  restore(sceneId: string): void;
  /** The sentence that stands where a take's Restore button would, on a
   *  platform with no Runs page to open. Absent, or null for this take,
   *  and the Restore button is drawn. */
  rerunLine?(sceneId: string, authored: boolean): string | null;
  /** Put a re-shot take back on its recording's frames. */
  backToRecording(sceneId: string): void;
  /** Delete pressed: on a take's card or one of a video's versions
   *  (`take`), a video's card (`video`, every version), a folder's
   *  "Couldn't read" row (`folder`), or an unreadable video record's row
   *  (`record`, the record alone). Asks the author first — the page owns the asking, since it
   *  owns the row status a dialog that could not open reports to. */
  remove(id: string, kind: RowKind): void;
  /**
   * Fill this row's preview box. Injected rather than done here because it
   * decodes keyframes off IndexedDB, which this view has no business
   * knowing about — and because it is the one part of a row that cannot be
   * asserted in jsdom.
   */
  preview(sceneId: string, box: HTMLElement): void;
  /** Open Needs a look, the drift review, from this card's flag. Named by
   *  the card so the page can let a rename on it land first, as Edit does. */
  openReview?(sceneId: string): void;
  /** A flow's checkbox, or its card while anything is ticked: tick or
   *  untick it, or with Shift the range from the last one ticked over
   *  `visibleOrder`, the flows in open sections in page order. Absent, and
   *  no card carries a checkbox. */
  select?(
    videoId: string,
    shift: boolean,
    visibleOrder: readonly string[],
  ): void;
  /** The selection bar's Cancel. */
  clearSelection?(): void;
  /** The selection bar's Delete: the page asks once, then deletes. */
  deleteSelected?(): void;
}

/** An expired video's line leads with the fact (spec 2026-10-30
 *  flows-and-bulk-delete §1.1); the platform's line alone is how to film
 *  it again, which the editor also says for a video with no frames. */
const expiredLine = (
  expired: boolean | undefined,
  line: string | null | undefined,
): string | null =>
  line == null
    ? null
    : expired === true
      ? `Expired — ${line.charAt(0).toLowerCase()}${line.slice(1)}`
      : line;

/** The flows in open sections, in page order: what a shift-click ranges
 *  over. Read at the click, so a section folded since the render counts. */
function visibleFlows(from: Element): string[] {
  const library = from.closest("[data-library]") ?? from.ownerDocument;
  return [
    ...library.querySelectorAll<HTMLInputElement>(
      "details[open] [data-select]",
    ),
  ].map((box) => box.dataset.select as string);
}

/** The bar that stands over the list while flows are ticked: the count,
 *  Cancel and Delete, and what a bulk delete left behind. Built once and
 *  filled in place (`fillBar`), so a tick never replaces a control. */
function selectionBar(actions: LibraryActions): HTMLElement {
  const bar = el("div", { class: "selection-bar", "data-selection-bar": "" });
  const cancel = el(
    "button",
    {
      type: "button",
      class: "btn btn-quiet",
      "data-action": "cancel-selection",
    },
    "Cancel",
  );
  cancel.addEventListener("click", () => actions.clearSelection?.());
  const remove = el(
    "button",
    {
      type: "button",
      class: "btn btn-danger",
      "data-action": "delete-selected",
    },
    "Delete",
  );
  remove.addEventListener("click", () => actions.deleteSelected?.());
  bar.append(
    el("span", { class: "selection-count", "data-selection-count": "" }),
    cancel,
    remove,
    el("p", {
      class: "selection-said",
      "data-selection-said": "",
      role: "status",
    }),
  );
  return bar;
}

function fillBar(
  bar: HTMLElement,
  count: number,
  bulk: { busy: boolean; said: string | null } | undefined,
): void {
  const flows = `${count} ${count === 1 ? "flow" : "flows"}`;
  const busy = bulk?.busy === true;
  (bar.querySelector("[data-selection-count]") as HTMLElement).textContent =
    busy ? `Deleting ${flows}…` : `${flows} selected`;
  for (const b of bar.querySelectorAll("button")) b.disabled = busy;
  const said = bar.querySelector("[data-selection-said]") as HTMLElement;
  said.textContent = bulk?.said ?? "";
  said.hidden = bulk?.said == null;
}

/**
 * Shows `selection` on the cards already drawn — each flow's tick and ring,
 * the page's selecting state, the bar — changing them in place. A tick is
 * page state, not a new library: re-rendering the list for one replaced the
 * box under the pointer, and Chrome then threw the page screens up, away
 * from the card just ticked (the author, 2026-10-30, at the foot of the
 * library); it also cleared every card's thumbnail.
 */
export function applySelection(
  root: HTMLElement,
  actions: LibraryActions,
  selection: Selection | undefined,
  bulk?: { busy: boolean; said: string | null },
): void {
  const selected: ReadonlySet<string> =
    actions.select === undefined ? new Set() : (selection?.ids ?? new Set());
  root.toggleAttribute("data-selecting", selected.size > 0);
  // Shut while a bulk delete runs: a box unticked then would look spared
  // while the run, which took its list at the start, deletes it.
  const busy = bulk?.busy === true;
  for (const box of root.querySelectorAll<HTMLInputElement>("[data-select]")) {
    const on = selected.has(box.dataset.select as string);
    box.checked = on;
    box.disabled = busy;
    box.closest("article")?.toggleAttribute("data-selected", on);
  }
  let bar = root.querySelector<HTMLElement>("[data-selection-bar]");
  if (selected.size === 0) {
    bar?.remove();
    return;
  }
  if (bar === null) {
    const notices = headers.get(root)?.notices;
    if (notices === undefined) return;
    bar = selectionBar(actions);
    notices.after(bar);
  }
  fillBar(bar, selected.size, bulk);
}

const GB = 1024 ** 3;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A label on the picture: a glyph and a word. `.tag`, not `.chip`: on
 *  Settings a chip is the round on/off indicator. */
function tag(
  glyph: GlyphName,
  text: string,
  attrs: Record<string, string> = {},
): HTMLElement {
  const span = el("span", { class: "tag", ...attrs });
  span.append(icon(glyph), text);
  return span;
}

/** A hairline bar. A `<div>` rather than `<progress>`, whose paint no
 *  stylesheet owns across themes. */
function meterBar(): { bar: HTMLElement; set(fraction: number): void } {
  const bar = el("div", { class: "meter" });
  const fill = el("div", { class: "meter-fill" });
  bar.append(fill);
  return {
    bar,
    set(fraction) {
      fill.style.width = `${(fraction * 100).toFixed(1)}%`;
      bar.toggleAttribute("data-full", fraction >= 0.9);
    },
  };
}

/** The storage panel's id, which its trigger's `popovertarget` names. */
const STORAGE_PANEL = "storage-panel";

/** The gutter the panel keeps from the window's edges, as the page does. */
const PANEL_GUTTER = 16;
const PANEL_WIDTH = 300;

/**
 * Under the trigger, kept inside the window. Where the trigger sits in a
 * column held in view (`position: sticky`) the panel is `fixed`, so it
 * stays under the trigger while the list scrolls; anywhere else — the top
 * bar, where it sits since 2026-10-08 — it is `absolute`, placed against
 * the initial containing block, so it scrolls with the trigger. Either
 * way it opens above the trigger when below would run off the window's
 * foot. The width is set here, not left to the stylesheet, because the
 * clamp needs it before the panel has a box to measure. Placed on every
 * open and every resize while open; `beforetoggle` rather than `toggle`
 * for the reason `account-menu.ts` gives, and once more after it opens,
 * when its height can be measured.
 */
function placePanel(
  panel: HTMLElement,
  trigger: HTMLElement,
  /** Keep the side it opened on: a scroll that moves the trigger must not
   *  flip an open panel from above it to below. */
  keepSide = false,
): void {
  const r = trigger.getBoundingClientRect();
  const page = document.documentElement.clientWidth;
  const width = Math.min(PANEL_WIDTH, page - 2 * PANEL_GUTTER);
  // Its right edge on the trigger's — the trigger sits at the top bar's
  // right end — unless that would cross the window's left gutter, where
  // it hangs from the trigger's left edge instead.
  const start = r.right - width >= PANEL_GUTTER ? r.right - width : r.left;
  const left = Math.max(
    PANEL_GUTTER,
    Math.min(start, page - PANEL_GUTTER - width),
  );
  const side = trigger.closest<HTMLElement>("[data-header]");
  const held = side !== null && getComputedStyle(side).position === "sticky";
  // Its full height, not what an earlier placement capped it to.
  panel.style.maxHeight = "";
  const height = panel.offsetHeight;
  const below = r.bottom + 6;
  const roomBelow = window.innerHeight - PANEL_GUTTER - below;
  const roomAbove = r.top - 6 - PANEL_GUTTER;
  // Below where it fits; else above where that fits; else whichever side
  // has more room, capped to it (the panel scrolls inside). Never over its
  // own trigger.
  const above =
    keepSide && panel.dataset.side !== undefined
      ? panel.dataset.side === "above"
      : height > roomBelow && (height <= roomAbove || roomAbove > roomBelow);
  panel.dataset.side = above ? "above" : "below";
  const room = Math.max(0, above ? roomAbove : roomBelow);
  if (height > room) panel.style.maxHeight = `${Math.round(room)}px`;
  const shown = Math.min(height, room);
  const top = above ? r.top - 6 - shown : below;
  panel.style.position = held ? "fixed" : "absolute";
  panel.style.width = `${Math.round(width)}px`;
  panel.style.left = `${Math.round(left + (held ? 0 : window.scrollX))}px`;
  panel.style.top = `${Math.round(top + (held ? 0 : window.scrollY))}px`;
}

/** The budget as the field shows it: GB, to two places, no trailing zeros. */
const budgetGb = (bytes: number): string =>
  (bytes / GB).toFixed(2).replace(/\.?0+$/, "");

interface Header {
  /** The page's two columns: `side` and `content`. */
  box: HTMLElement;
  /** Re-filled on every render: the jump list of sections. */
  jumps: HTMLElement;
  /** The list's column. Its notices stay; the rest is replaced. */
  content: HTMLElement;
  notices: HTMLElement;
  update(model: LibraryModel, actions: LibraryActions): void;
}

/**
 * The title row and the storage controls: a quiet button at the title's
 * right that says how full the library is, and a panel it opens. The panel
 * is a popover in the top layer, so it floats over the list — until
 * 2026-10-06 the controls were a `<details>` under the title, and opening
 * it pushed every card down the page.
 *
 * Built once per root and updated in place, not rebuilt on every render
 * as the list is. Reclaim and a saved budget both re-render the page while
 * the panel is open, and a rebuilt panel is a new, closed one: it vanished
 * under the pointer that pressed it. Carrying the old one's state across
 * is not enough either — a number field mid-edit reads "1." back as "1",
 * so its text cannot be put back once the field is gone.
 */
function createHeader(withStorage: boolean): Header {
  let actions: LibraryActions | null = null;
  // Settings' shape (2026-10-08): a column at the left, held in view on a
  // wide window, with the title and a jump list of the sections; the
  // list in the column beside it. The storage trigger
  // goes in the top bar (see `storage` below).
  const box = el("div", { class: "library", "data-library": "" });
  const side = el("aside", { class: "library-side", "data-header": "" });
  const jumps = el("nav", {
    class: "side-group",
    "aria-label": "Sections",
    "data-jumps": "",
  });
  const content = el("div", { class: "library-content" });

  const triggerBar = meterBar();
  triggerBar.bar.setAttribute("aria-hidden", "true");
  const meterText = el("span", { "data-meter": "" });
  const trigger = el("button", {
    type: "button",
    class: "btn btn-quiet storage-trigger",
    "data-storage-trigger": "",
    popovertarget: STORAGE_PANEL,
    "aria-controls": STORAGE_PANEL,
  });
  // The word first: a bar and "1.4 GB of 2 GB" alone did not say what
  // they measure.
  trigger.append(
    el("span", { class: "storage-label" }, "Storage"),
    triggerBar.bar,
    meterText,
    icon("chevronDown"),
  );
  const storage = el("div", { class: "storage" });
  // The studio's total: the word, then what the folder holds. Not a button
  // and no budget — the studio manages no storage, it only states it.
  const totalValue = el("span", { "data-total-size": "" });
  const total = el("span", {
    class: "library-total",
    "data-library-total": "",
  });
  total.append(el("span", { class: "storage-label" }, "Storage"), totalValue);

  // A notice names what is holding the space, and the panel is how the
  // author answers it — so the notices sit in the page, where they are
  // read without opening anything, and the trigger is one press away.
  const notices = el("div", { "data-notices": "" });

  const panel = el("div", {
    id: STORAGE_PANEL,
    class: "storage-panel",
    popover: "",
    "data-storage": "",
    "aria-label": "Storage",
  });
  let resized: AbortController | null = null;
  panel.addEventListener("beforetoggle", (event) => {
    if ((event as ToggleEvent).newState === "open") placePanel(panel, trigger);
  });
  panel.addEventListener("toggle", (event) => {
    const open = (event as ToggleEvent).newState === "open";
    trigger.toggleAttribute("data-open", open);
    resized?.abort();
    resized = null;
    if (open) {
      // Again, with its height: below the trigger may not fit.
      placePanel(panel, trigger);
      resized = new AbortController();
      window.addEventListener("resize", () => placePanel(panel, trigger), {
        signal: resized.signal,
      });
      // And on scroll: the column scrolls with the page until it is held,
      // so a `fixed` panel has to follow the trigger that far.
      window.addEventListener(
        "scroll",
        () => placePanel(panel, trigger, true),
        { passive: true, signal: resized.signal },
      );
    }
  });

  const panelBar = meterBar();
  panelBar.bar.setAttribute("role", "progressbar");
  panelBar.bar.setAttribute("aria-label", "Storage used");
  panelBar.bar.setAttribute("aria-valuemin", "0");
  panelBar.bar.setAttribute("aria-valuemax", "1");
  const usedText = el("p", { class: "storage-used", "data-storage-used": "" });

  // The budget saves on `change` — Enter, or leaving the field, which a
  // click outside the panel and Escape both do — so there is no Set
  // button to forget. A refusal is said under the field; a save the
  // extension refused is said on the page's notice line (main.ts).
  const budget = el("input", {
    type: "number",
    min: "0.25",
    step: "0.25",
    id: "storage-budget",
    "data-storage-budget": "",
  });
  // The Settings page's control, and its silence: see the note there.
  const budgetNote = el("p", {
    class: "notice notice-error hidden",
    role: "alert",
    "data-budget-note": "",
  });
  budget.addEventListener("change", () => {
    const gb = Number(budget.value);
    if (!Number.isFinite(gb) || gb <= 0) {
      budgetNote.textContent = BAD_BUDGET;
      budgetNote.classList.remove("hidden");
      return;
    }
    budgetNote.classList.add("hidden");
    actions?.setBudget?.(Math.round(gb * GB));
  });
  const budgetRow = el("div", { class: "storage-budget-row" });
  budgetRow.append(budget, el("span", {}, "GB"));
  const field = el("div", { class: "storage-field" });
  field.append(
    el("label", { for: "storage-budget" }, "Budget"),
    budgetRow,
    el("p", { class: "storage-hint" }, "Saves automatically."),
    budgetNote,
  );

  const reclaim = el("button", {
    type: "button",
    "data-action": "reclaim",
    class: "btn btn-quiet storage-reclaim",
  });
  reclaim.append(icon("trash"), "Reclaim space");
  reclaim.addEventListener("click", () => actions?.reclaim?.());
  const foot = el("div", { class: "storage-foot" });
  foot.append(
    reclaim,
    el(
      "p",
      { class: "storage-hint" },
      "Clears cached exports, then hosted videos' motion, oldest first, until the library fits its budget.",
    ),
  );

  panel.append(
    el("h2", { class: "storage-title" }, "Storage"),
    panelBar.bar,
    usedText,
    field,
    foot,
  );
  storage.append(trigger, panel);
  side.append(el("h1", {}, "Flows"), jumps);
  content.append(notices);
  box.append(side, content);
  // The page's top bar carries a slot for it, left of the theme switch
  // (library/index.html). A document without one — a test that mounts the
  // list alone — keeps it at the foot of the left column, where it still
  // opens its panel, rather than nowhere.
  const slot = document.querySelector("[data-storage-slot]");
  if (withStorage) (slot ?? side).append(storage);

  return {
    box,
    jumps,
    content,
    notices,
    update(model, next) {
      actions = next;
      if (model.totalBytes === undefined) {
        total.remove();
      } else {
        // A folder the studio could not measure is not in the sum, so the
        // figure is a floor: a `+`, and the title says how many it misses.
        // Folders, not takes: the count includes the Couldn't-read rows.
        const missed = model.unmeasured ?? 0;
        const figure = `${formatBytes(model.totalBytes)}${missed > 0 ? "+" : ""}`;
        const why =
          missed > 0
            ? `${missed} ${missed === 1 ? "folder" : "folders"} could not be measured`
            : null;
        totalValue.textContent = figure;
        total.setAttribute(
          "aria-label",
          `Storage: ${figure}${why === null ? "" : ` (${why})`}`,
        );
        if (why === null) total.removeAttribute("title");
        else total.setAttribute("title", why);
        if (total.parentNode === null) (slot ?? side).append(total);
      }
      const used = formatBytes(model.usedBytes);
      const limit = formatBytes(model.budgetBytes);
      triggerBar.set(model.fraction);
      panelBar.set(model.fraction);
      panelBar.bar.setAttribute("aria-valuenow", model.fraction.toFixed(3));
      meterText.textContent = `${used} of ${limit}`;
      trigger.setAttribute("aria-label", `Storage: ${used} of ${limit} used`);
      usedText.textContent = `${used} used of a ${limit} budget`;
      // A field the author is typing in keeps what they typed. Otherwise
      // it shows the budget in force — after a save, the one just saved;
      // after a refusal, the one that was kept.
      if (document.activeElement !== budget) {
        budget.value = budgetGb(model.budgetBytes);
      }
      notices.replaceChildren(...headerNotices(model));
    },
  };
}

function headerNotices(model: LibraryModel): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (model.migrating) {
    out.push(
      el(
        "p",
        { "data-migrating": "", class: "notice" },
        "Measuring existing videos…",
      ),
    );
  }
  if (model.migrationFailed) {
    // The footprint above may be undercounting: rows the migration never
    // got to measure still read as unsized. Named as its own line rather
    // than folded into `notice` — that field is reclaim's own report, and
    // a migration failure is a different fact from a reclaim that could
    // not run.
    out.push(
      el(
        "p",
        { "data-migration-failed": "", class: "notice notice-warn" },
        "Measuring existing videos failed, so sizes below may be wrong. Open the extension's error log if this keeps happening.",
      ),
    );
  }
  if (model.chromeNearLimit) {
    out.push(
      el(
        "p",
        { "data-chrome-limit": "", class: "notice notice-warn" },
        "Chrome is near its storage limit on this drive.",
      ),
    );
  }
  if (model.unwatched != null) {
    out.push(
      el(
        "p",
        { "data-unwatched": "", class: "notice notice-warn" },
        `New videos will not show until you reload — ${model.unwatched}.`,
      ),
    );
  }
  if (model.notice !== null) {
    out.push(
      el(
        "p",
        { "data-notice": "", class: "notice notice-error" },
        model.notice,
      ),
    );
  }
  return out;
}

/** Each root's header, kept across renders: see `createHeader`. */
const headers = new WeakMap<HTMLElement, Header>();

/**
 * The tags: only for what departs from the ordinary — "Complete" is what a
 * recording is unless something has happened to it, so it says nothing; the
 * two degraded states and a hosted copy each get a glyph and a word. Null
 * when there are none, so the thumbnail carries no empty strip.
 */
function tags(r: LibraryRow, actions: LibraryActions): HTMLElement | null {
  const strip = el("div", { class: "row-tags" });
  // First, and the one tag that is a control: a drift check flagged this
  // take, and the flag is the way to Needs a look — which the popup's
  // "N demos need a look" row was until 2026-10-09. A glyph alone, the
  // author's call: the warn tone says it, the name is for the pointer
  // and the screen reader.
  const openReview = actions.openReview;
  if (r.needsLook && openReview !== undefined) {
    const look = el("button", {
      type: "button",
      class: "tag tag-warn tag-look",
      "data-needs-look": "",
      "aria-label": `Needs a look: ${r.label}`,
      title: "Needs a look",
    });
    look.append(icon("circleAlert"));
    look.addEventListener("click", () => openReview(r.sceneId));
    strip.append(look);
  }
  if (r.hosted) {
    strip.append(
      tag("cloud", "Hosted", {
        "data-hosted": "",
        title: "Hosted copy stays online after a local delete",
      }),
    );
  }
  if (r.state === "Motion reclaimed") {
    strip.append(
      tag("restore", r.state, {
        "data-state-chip": "",
        class: "tag tag-warn",
        title: r.authored
          ? "Its motion was reclaimed to free space; Restore opens Runs to run its script again, which makes a new video"
          : "Its motion was reclaimed to free space; Restore re-shoots it in Runs",
      }),
    );
  } else if (r.state === "Keyframes only") {
    strip.append(
      tag("image", r.state, {
        "data-state-chip": "",
        title: "No motion was recorded for this video",
      }),
    );
  }
  return strip.childElementCount > 0 ? strip : null;
}

/**
 * The empty box a row's preview is painted into, in its loading state.
 *
 * Loading rather than blank: an empty box until the port resolves reads
 * exactly like a demo that has no preview, and those are different facts.
 * The canvas carries `aria-hidden` because the note beside it is what a
 * screen reader should read — a flipbook of the page has nothing to say.
 *
 * Two things ride on the picture's bottom corners: the row's tags at the
 * left, and at the right the export's length, which the preview port
 * fills in once it has the frames (`preview.ts`'s `measure`). Hidden until
 * then, rather than holding a placeholder: a "0:00" or a "–:––" would be a
 * number the take does not have.
 */
function previewBox(r: LibraryRow, actions: LibraryActions): HTMLElement {
  const box = el("div", { "data-preview": "" });
  const canvas = el("canvas", {
    "data-preview-canvas": "",
    "aria-hidden": "true",
    hidden: "",
  });
  box.append(
    canvas,
    el(
      "p",
      { "data-preview-note": "" },
      previewText({ kind: "loading" }) ?? "",
    ),
  );
  const strip = tags(r, actions);
  if (strip !== null) box.append(strip);
  box.append(el("span", { "data-duration": "", hidden: "" }));
  return box;
}

const STATE_ATTR: Record<LibraryRow["state"], string> = {
  Complete: "complete",
  "Motion reclaimed": "reclaimed",
  "Keyframes only": "keyframesOnly",
};

/** The name field's id, which the card's `aria-labelledby` points at. */
const nameFieldId = (sceneId: string): string => `name-${sceneId}`;

/**
 * The take's name, as a field on the card: plain text at rest, a ring
 * under the pointer, a control tint while it is being edited. Enter or
 * leaving the field commits; Escape, or the same name again, puts the last
 * committed name back and sends nothing. A blank commits too: it returns
 * the take to untitled, which reads "Untitled" as the placeholder — the
 * row's second line already says where and when it was made, so the
 * heading does not repeat either. `committed` follows a
 * successful commit so a blank typed straight after one restores the new
 * name, not the one the row was rendered with — the page re-renders the
 * row once the store answers, and until then this is the truth.
 */
function nameField(
  r: LibraryRow,
  actions: LibraryActions,
  /** A video's card names the video: its own name, and a blank puts it
   *  back rather than sending (a video is never untitled). */
  group: VideoGroup | null,
): HTMLInputElement {
  const name = group === null ? r.name : group.video.name;
  const field = el("input", {
    type: "text",
    id: nameFieldId(r.sceneId),
    "data-name": "",
    "aria-label": group === null ? "Video name" : "Flow name",
    // The full name, for the pointer: a long one is clipped at rest.
    title: name,
    placeholder: "Untitled",
    spellcheck: "false",
    autocomplete: "off",
  });
  field.value = name;
  let committed = name;
  field.addEventListener("change", () => {
    const next = field.value.trim();
    if (next === committed || (group !== null && next === "")) {
      field.value = committed;
      return;
    }
    committed = next;
    field.value = next;
    field.title = next;
    if (group === null) actions.rename(r.sceneId, next);
    else actions.renameVideo(group.video.id, next);
  });
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      field.value = committed;
      field.blur();
    } else if (event.key === "Enter") {
      field.blur();
    }
  });
  return field;
}

function row(
  r: LibraryRow,
  actions: LibraryActions,
  status: string | undefined,
  /** The section's heading names the day, so the line drops the date. */
  namesDay: boolean,
  /** The video this card stands for (`r` is its current version, else its
   *  newest), or null for a take in no video. */
  group: VideoGroup | null,
  rowStatus: Map<string, string>,
  /** Whether the video's versions were open before this render. */
  versionsOpen: boolean,
): HTMLElement {
  const flowId = group?.video.id ?? null;
  const article = el("article", {
    class: "card",
    "data-row": r.sceneId,
    "data-state": STATE_ATTR[r.state],
    ...(group === null ? {} : { "data-video": group.video.id }),
    // The card is named by its take, so a screen reader can tell this
    // card's Edit and Delete from the next card's. An untitled take's
    // field is empty — a placeholder is not part of what `labelledby`
    // reads — so that card carries its label outright.
    ...(r.name === "" && group === null
      ? { "aria-label": r.label }
      : { "aria-labelledby": nameFieldId(r.sceneId) }),
  });
  // The whole card opens the editor — a click on a thumbnail or a title
  // is what an author tries first. Not on the name field or a control,
  // each of which does its own thing; not on a click that ends a text
  // selection, which is copying, not choosing; and not on the click that
  // ends a rename — a press on the card's blank area to finish typing
  // blurs the field on mousedown and lands here on mouseup, so what was
  // focused at the press decides. The Edit button stays for the keyboard,
  // and is a button, so its click stops here and the editor opens once.
  let nameWasFocused = false;
  article.addEventListener("pointerdown", () => {
    const active = document.activeElement;
    nameWasFocused =
      active?.matches("[data-name]") === true && article.contains(active);
  });
  article.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (nameWasFocused) return;
    if (target.closest("button, input, a, [data-versions]")) return;
    // While flows are ticked a click on a flow's card ticks it too, as in
    // a photo library; a take in no flow still opens.
    if (flowId !== null && article.closest("[data-selecting]") !== null) {
      actions.select?.(flowId, event.shiftKey, visibleFlows(article));
      return;
    }
    if ((window.getSelection()?.toString() ?? "") !== "") return;
    // An expired recording has nothing to open: its line says what to do.
    if (r.expired === true) return;
    actions.edit(r.sceneId);
  });
  const preview = previewBox(r, actions);
  if (flowId !== null && actions.select !== undefined) {
    const name = group?.video.name || r.label;
    const box = el("input", {
      type: "checkbox",
      class: "select-box",
      "data-select": flowId,
      "aria-label": `Select ${name}`,
    });
    box.addEventListener("click", (event) => {
      // The box toggles itself and the page sets every box from its
      // selection in the same turn (`applySelection`). Not cancelled: a
      // cancelled click puts the box's old state back after the handler,
      // over the one just set.
      actions.select?.(flowId, event.shiftKey, visibleFlows(box));
    });
    preview.append(box);
  }
  article.append(preview);

  const buttons = el("div", { class: "row-actions" });
  if (r.servesReshoot) {
    const back = el("button", {
      type: "button",
      "data-action": "back-to-recording",
      class: "btn btn-quiet btn-icon",
      "aria-label": `Back to the original footage: ${r.label}`,
      title:
        "Back to the original footage — this video plays its re-shot frames; its original footage is kept",
    });
    back.append(icon("undo"));
    back.addEventListener("click", () => actions.backToRecording(r.sceneId));
    buttons.append(back);
  }
  // An expired recording can only be recorded again, which the same line
  // says.
  const rerunLine =
    r.canRestore || r.expired === true
      ? expiredLine(r.expired, actions.rerunLine?.(r.sceneId, r.authored))
      : null;
  if (r.canRestore && rerunLine === null) {
    const restore = el("button", {
      type: "button",
      "data-action": "restore",
      class: "btn btn-quiet btn-icon",
      "aria-label": `Restore motion: ${r.label}`,
      title: r.authored
        ? "Restore motion — run its script again in Runs; a script-made video cannot be re-shot, so this makes a new video"
        : "Restore motion — re-shoot it in Runs",
    });
    restore.append(icon("restore"));
    restore.addEventListener("click", () => actions.restore(r.sceneId));
    buttons.append(restore);
  }

  const edit = el("button", {
    type: "button",
    "data-action": "edit",
    class: "btn btn-quiet btn-icon",
    "aria-label": `Edit ${r.label}`,
    title: "Edit",
  });
  edit.append(icon("clapperboard"));
  edit.addEventListener("click", () => actions.edit(r.sceneId));
  if (r.expired !== true) buttons.append(edit);

  const remove = el("button", {
    type: "button",
    "data-action": "delete",
    class: "btn btn-quiet btn-icon btn-danger",
    "aria-label": `Delete ${r.label}`,
    title: "Delete",
  });
  remove.append(icon("trash"));
  remove.addEventListener("click", () =>
    group === null
      ? actions.remove(r.sceneId, "take")
      : actions.remove(group.video.id, "video"),
  );
  buttons.append(remove);

  // The name and the actions share one row: the card has no footer, so
  // every card is the thumbnail and two lines of text, whatever it holds.
  const text = el("div", { class: "row-text" });
  const title = el("div", { class: "row-title" });
  title.append(nameField(r, actions, group), buttons);
  text.append(title);

  // One line, two sentences in the same place: where and when at rest,
  // and under the pointer the size — management information, what a
  // delete or a reclaim would free — which comes with the actions it
  // informs. Both are always in the DOM, stacked in one grid cell, so the
  // line keeps its height and a screen reader reads both. Host and start
  // path together: a developer's takes are mostly on one localhost, and
  // the path is what tells the checkout flow from the settings page. The
  // full line is the title, for when it is clipped.
  // A video's line leads with its repo, when it is known.
  const repo = group === null ? null : repoLabel(group.video.repo);
  const where = `${repo === null ? "" : `${repo} · `}${r.origin}${r.path}`;
  const line = el("div", { class: "row-line" });
  // Under a heading that names the day the date would say it twice, so
  // the line keeps only the time; under a month it keeps both.
  line.append(
    el(
      "p",
      { class: "row-meta", "data-meta": "", title: where },
      `${where} · ${namesDay ? r.time : r.when}`,
    ),
  );
  // The size is the storage controls' information; a page that draws none
  // has no sizes to state. The studio has no controls but states each
  // folder's size (`sizeBytes`), which is what a delete would free.
  if (r.sizeBytes !== undefined) {
    line.append(
      el("p", { "data-size": "", class: "row-size" }, formatBytes(r.sizeBytes)),
    );
  } else if (actions.reclaim !== undefined) {
    line.append(
      el(
        "p",
        { "data-size": "", class: "row-size" },
        `${formatBytes(r.frameBytes)} frames · ${formatBytes(r.outputBytes)} renders`,
      ),
    );
  }
  text.append(line);
  article.append(text);
  if (group !== null && group.versions.length > 1) {
    article.append(versionList(group, actions, rowStatus, versionsOpen));
  } else if (group !== null) {
    // One version has no fold to hold its exports: they sit on the card.
    const files = exportsList(group.versions[0]?.exports);
    if (files !== null) article.append(files);
  }

  // Where there is no Runs page, the way to restore motion is a sentence,
  // not a button.
  if (rerunLine !== null) {
    const rerun = el("p", { "data-rerun-line": "", class: "row-rerun" });
    setCodeText(rerun, rerunLine);
    article.append(rerun);
  }

  // The row's own status line is the one surface a delete's three distinct
  // outcomes (refused / partly deleted / deleted) reach the author through
  // — see main.ts's `remove` handler for what populates `status`.
  if (status !== undefined) {
    article.append(
      el("p", { "data-status": "", class: "notice notice-error" }, status),
    );
  }
  return article;
}

/**
 * A video's versions, newest first, under its card: a fold whose summary is
 * the count, so a video of one version (nothing to choose between) has
 * none. Each version is its number and when it was made, Edit and Delete —
 * or, once its recording expired, the line that says how to record it
 * again in Edit's place.
 */
function versionList(
  group: VideoGroup,
  actions: LibraryActions,
  rowStatus: Map<string, string>,
  open: boolean,
): HTMLElement {
  const box = el("details", {
    class: "versions",
    "data-versions": group.video.id,
  });
  box.open = open;
  const summary = el("summary", { class: "versions-count" });
  const chev = icon("chevronRight");
  chev.classList.add("chev");
  summary.append(chev, `${group.versions.length} videos`);
  box.append(summary);
  const list = el("ol", { class: "versions-list" });
  for (const v of group.versions) {
    const item = el("li", {
      class: "version",
      "data-version-row": v.sceneId,
      ...(v.expired === true ? { "data-expired": "" } : {}),
    });
    const head = el("div", { class: "version-head" });
    head.append(
      el("span", { class: "version-number" }, `Video ${v.version ?? "?"}`),
      el("span", { class: "version-when", title: v.when }, v.when),
    );
    const buttons = el("div", { class: "row-actions" });
    const line =
      v.expired === true
        ? expiredLine(true, actions.rerunLine?.(v.sceneId, v.authored))
        : null;
    if (v.expired !== true) {
      const edit = el("button", {
        type: "button",
        "data-action": "edit",
        class: "btn btn-quiet btn-icon",
        "aria-label": `Edit video ${v.version ?? ""} of ${group.video.name}`,
        title: "Edit",
      });
      edit.append(icon("clapperboard"));
      edit.addEventListener("click", () => actions.edit(v.sceneId));
      buttons.append(edit);
    }
    const remove = el("button", {
      type: "button",
      "data-action": "delete",
      class: "btn btn-quiet btn-icon btn-danger",
      "aria-label": `Delete video ${v.version ?? ""} of ${group.video.name}`,
      title: "Delete",
    });
    remove.append(icon("trash"));
    remove.addEventListener("click", () => actions.remove(v.sceneId, "take"));
    buttons.append(remove);
    head.append(buttons);
    item.append(head);
    const files = exportsList(v.exports);
    if (files !== null) item.append(files);
    if (line !== null) {
      const rerun = el("p", { "data-rerun-line": "", class: "row-rerun" });
      setCodeText(rerun, line);
      item.append(rerun);
    }
    const status = rowStatus.get(statusKey("take", v.sceneId));
    if (status !== undefined) {
      item.append(
        el("p", { "data-status": "", class: "notice notice-error" }, status),
      );
    }
    list.append(item);
  }
  box.append(list);
  return box;
}

/** A version's exported files: each its name and type, a moved or deleted
 *  one marked gone; or why they could not be read. Null when it has none. */
function exportsList(exports: LibraryRow["exports"]): HTMLElement | null {
  if (exports === undefined) return null;
  if ("unreadable" in exports) {
    return el(
      "p",
      { class: "row-rerun", "data-exports-unreadable": "" },
      `Its exports could not be read: ${exports.unreadable}`,
    );
  }
  if (exports.length === 0) return null;
  const list = el("ul", { class: "version-exports" });
  for (const e of exports) {
    const name = e.path.slice(e.path.lastIndexOf("/") + 1) || e.path;
    const item = el("li", {
      "data-export": e.path,
      title: e.path,
      ...(e.exists ? {} : { "data-gone": "" }),
    });
    item.append(
      el("span", { class: "export-name" }, name),
      el(
        "span",
        { class: "export-type" },
        e.exists
          ? e.fileType.toUpperCase()
          : `${e.fileType.toUpperCase()} · gone`,
      ),
    );
    list.append(item);
  }
  return list;
}

/** The ids of the videos whose versions are open under `root`. */
const openVersions = (root: HTMLElement): Set<string> =>
  new Set(
    [...root.querySelectorAll<HTMLDetailsElement>("[data-versions]")]
      .filter((d) => d.open)
      .map((d) => d.getAttribute("data-versions") as string),
  );

/** The name field being edited under `root`, if any, and what it holds. */
function typingName(root: HTMLElement): {
  sceneId: string;
  value: string;
  start: number | null;
  end: number | null;
} | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !active.matches("[data-name]")) {
    return null;
  }
  if (!root.contains(active)) return null;
  const sceneId = active.closest("[data-row]")?.getAttribute("data-row");
  if (!sceneId) return null;
  return {
    sceneId,
    value: active.value,
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

/** Puts a name being typed back into the row's new field after a render. */
function restoreTyping(
  root: HTMLElement,
  typing: ReturnType<typeof typingName>,
): void {
  if (typing === null) return;
  const field = root.querySelector<HTMLInputElement>(
    `[data-row="${CSS.escape(typing.sceneId)}"] [data-name]`,
  );
  if (field === null) return;
  field.value = typing.value;
  field.focus();
  if (typing.start !== null && typing.end !== null) {
    field.setSelectionRange(typing.start, typing.end);
  }
}

/** The id the section's heading carries, which its `aria-labelledby`
 *  points at. Keys hold only `[a-z0-9:-]`, so no escaping is needed. */
const sectionHeadingId = (key: string): string =>
  `section-${key.replace(/:/g, "-")}`;

/**
 * Which sections under `root` are open and which are closed, by key, so a
 * render can put each one back the way the author left it. A rename or a
 * delete re-renders the whole list; a month the author had
 * opened must not fold back on them, and one they folded must not spring
 * open. A section not in the map is new to this render and takes its own
 * default.
 */
function sectionStates(root: HTMLElement): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const s of root.querySelectorAll<HTMLDetailsElement>("[data-section]")) {
    const key = s.getAttribute("data-section");
    if (key !== null) states.set(key, s.open);
  }
  return states;
}

/** The id of the unreadable folders' section, which its jump link names. */
const UNREADABLE_ID = "unreadable";

/** The id a section's `<details>` carries, which its jump link names. */
const sectionId = (key: string): string => `when-${key.replace(/:/g, "-")}`;

/**
 * The jump list: a link per section, with its count, marked current by
 * `trackSectionNav` as the list scrolls (main.ts). A link to a folded
 * month opens it on the way: jumping to a closed fold would land on one
 * line and leave the author to open it.
 */
function jumpList(
  sections: readonly LibrarySection[],
  unreadable: number,
): HTMLElement {
  const list = el("div", { class: "side-list" });
  for (const s of sections) {
    const id = sectionId(s.key);
    const link = el("a", {
      href: `#${id}`,
      class: "side-item",
      "data-nav": id,
      title: s.label,
    });
    link.append(
      el("span", { class: "side-label" }, s.label),
      el("span", { class: "side-count" }, String(s.rows.length)),
    );
    link.addEventListener("click", () => {
      const target = document.getElementById(id);
      if (target instanceof HTMLDetailsElement) target.open = true;
    });
    list.append(link);
  }
  // The studio's folders that would not read sit after every day, so on a
  // long library they are far below the fold: the list names them too, or
  // nothing in view says they are there.
  if (unreadable > 0) {
    const link = el("a", {
      href: `#${UNREADABLE_ID}`,
      class: "side-item",
      "data-nav": UNREADABLE_ID,
      title: "Couldn't read",
    });
    link.append(
      el("span", { class: "side-label" }, "Couldn't read"),
      el("span", { class: "side-count" }, String(unreadable)),
    );
    list.append(link);
  }
  return list;
}

/**
 * One section: a `<details>` whose summary is the heading and the count,
 * and whose body is the grid of cards. A `<details>` for every section,
 * not only the folded ones, so Today folds with the same control a past
 * month opens with — and the same one the storage controls use.
 */
function section(
  s: LibrarySection,
  open: boolean,
  actions: LibraryActions,
  rowStatus: Map<string, string>,
  groupOf: Map<string, VideoGroup>,
  versionsOpen: Set<string>,
): { box: HTMLElement; articles: (readonly [string, HTMLElement])[] } {
  const headingId = sectionHeadingId(s.key);
  const box = el("details", {
    class: "section",
    id: sectionId(s.key),
    "data-section": s.key,
    "aria-labelledby": headingId,
  });
  box.open = open;
  // The heading sits inside the summary — valid HTML, one control for the
  // fold and the title. Chrome exposes the summary as a disclosure button
  // and (with NVDA and JAWS) still announces the heading inside it; the
  // `aria-labelledby` on the details names the group either way.
  const summary = el("summary", { class: "section-head" });
  // Settings' chevron, the same glyph and class its site lines open with.
  const chev = icon("chevronRight");
  chev.classList.add("chev");
  summary.append(
    chev,
    el("h2", { id: headingId }, s.label),
    el(
      "span",
      { class: "section-count", "data-section-count": "" },
      String(s.rows.length),
    ),
  );
  box.append(summary);
  const list = el("div", { class: "rows" });
  const articles = s.rows.map((r) => {
    const group = groupOf.get(r.sceneId) ?? null;
    const article = row(
      r,
      actions,
      // A video's card says what was said of the video. What was said of
      // the take it shows is said on that take's version row, when the
      // card has them; a card of one version is that version's row.
      group === null
        ? rowStatus.get(statusKey("take", r.sceneId))
        : (rowStatus.get(statusKey("video", group.video.id)) ??
            (group.versions.length > 1
              ? undefined
              : rowStatus.get(statusKey("take", r.sceneId)))),
      s.namesDay,
      group,
      rowStatus,
      group !== null && versionsOpen.has(group.video.id),
    );
    list.append(article);
    return [r.sceneId, article] as const;
  });
  box.append(list);
  return { box, articles };
}

/**
 * The folders the studio could not read, after the dated sections. Each
 * is a row with its name, the reason and the size — a folder that will not
 * read must be a row, never a missing card — and a Delete, the one thing
 * that can be done with it.
 */
function unreadableSection(
  unreadable: NonNullable<LibraryModel["unreadable"]>,
  actions: LibraryActions,
  rowStatus: Map<string, string>,
): HTMLElement {
  const box = el("section", {
    class: "section",
    id: UNREADABLE_ID,
    "data-unreadable": "",
    "aria-labelledby": "section-unreadable",
  });
  const head = el("div", { class: "section-head" });
  head.append(
    el("h2", { id: "section-unreadable" }, "Couldn't read"),
    el("span", { class: "section-count" }, String(unreadable.length)),
  );
  box.append(head);
  const list = el("div", { class: "rows" });
  for (const u of unreadable) {
    const article = el("article", {
      class: "card",
      "data-unreadable-row": u.folder,
    });
    const text = el("div", { class: "row-text" });
    const title = el("div", { class: "row-title" });
    title.append(
      el("p", { class: "row-meta", "data-unreadable-name": "" }, u.folder),
    );
    // A take folder's Delete removes the folder, a video record's the
    // record alone; a failed join or expiry has nothing to delete.
    const kind = unreadableKind(u);
    if (kind !== null) {
      const remove = el("button", {
        type: "button",
        "data-action": "delete",
        class: "btn btn-quiet btn-icon btn-danger",
        "aria-label": `Delete ${u.folder}`,
        title: "Delete",
      });
      remove.append(icon("trash"));
      remove.addEventListener("click", () => actions.remove(u.folder, kind));
      title.append(remove);
    }
    text.append(
      title,
      el("p", { class: "row-meta", "data-reason": "" }, u.reason),
    );
    // No size when the studio could not measure the folder: never "0 B".
    if (u.sizeBytes !== undefined) {
      text.append(
        el(
          "p",
          { "data-size": "", class: "row-size" },
          formatBytes(u.sizeBytes),
        ),
      );
    }
    article.append(text);
    const status =
      kind === null ? undefined : rowStatus.get(statusKey(kind, u.folder));
    if (status !== undefined) {
      article.append(
        el("p", { "data-status": "", class: "notice notice-error" }, status),
      );
    }
    list.append(article);
  }
  box.append(list);
  return box;
}

export function renderLibrary(
  root: HTMLElement,
  model: LibraryModel,
  actions: LibraryActions,
  rowStatus: Map<string, string>,
  /** The clock the sections are measured from. Injected so a test can sit
   *  on midnight; the page takes the real one. */
  now: Date = new Date(),
  /** The flows ticked for a bulk delete (`selection.ts`). */
  selection?: Selection,
  /** A bulk delete under way, or what the last one left behind. */
  bulk?: { busy: boolean; said: string | null },
): void {
  // A name the author is typing on one card survives a render another
  // card's rename triggers: its text, focus and caret move
  // into the new field for the same row. Every row is replaced below.
  const typing = typingName(root);
  const wasOpen = sectionStates(root);
  const versionsOpen = openVersions(root);
  // Everything but the header is replaced. The header is updated in
  // place and never leaves the page: removing it would close an open
  // storage panel and blur a budget being typed (see `createHeader`).
  let head = headers.get(root);
  if (head === undefined) {
    head = createHeader(
      actions.reclaim !== undefined && actions.setBudget !== undefined,
    );
    headers.set(root, head);
  }
  head.update(model, actions);
  for (const child of [...root.childNodes]) {
    if (child !== head.box) child.remove();
  }
  if (head.box.parentNode !== root) root.prepend(head.box);
  for (const child of [...head.content.childNodes]) {
    if (child !== head.notices) child.remove();
  }
  head.jumps.replaceChildren();
  // The list goes in the content column from here on.
  const list = head.content;
  const unreadable = model.unreadable ?? [];
  // After whatever the list drew, on every path out of it.
  const appendUnreadable = (): void => {
    if (unreadable.length > 0) {
      list.append(unreadableSection(unreadable, actions, rowStatus));
    }
  };
  if (model.rows.length === 0) {
    applySelection(root, actions, undefined);
    // A library of only unreadable folders is not empty: the empty card
    // would hide the rows that say what is wrong.
    if (unreadable.length > 0) {
      appendUnreadable();
      return;
    }
    // Settings' empty state, on a card. The hint names where Record is in
    // the author's terms: "the popup" is ours.
    const card = el("div", { "data-empty": "", class: "card empty-card" });
    card.append(
      emptyState(
        "monitorPlay",
        "No flows yet",
        model.emptyHint ?? EXTENSION_FIRST_TAKE_HINT,
      ),
    );
    list.append(card);
    return;
  }
  // One card per video: the sections count cards, not takes.
  const cards = cardsOf(model);
  const leads = cards.map((c) => c.row);
  const groupOf = new Map(
    cards.flatMap((c) =>
      c.group === null ? [] : [[c.row.sceneId, c.group] as const],
    ),
  );
  // Sections by when the take was made — landmarks in a list that was one
  // flat wall of equal cards.
  const articles: (readonly [string, HTMLElement])[] = [];
  const sections = sectionsOf(leads, now);
  head.jumps.append(jumpList(sections, unreadable.length));
  for (const s of sections) {
    const built = section(
      s,
      wasOpen.get(s.key) ?? !s.folded,
      actions,
      rowStatus,
      groupOf,
      versionsOpen,
    );
    list.append(built.box);
    articles.push(...built.articles);
  }
  appendUnreadable();
  // After the list is in the page, never before: the mounter observes the
  // box for visibility, and a detached element is never visible. A card
  // inside a closed section is not visible either, and paints when the
  // section opens.
  for (const [sceneId, article] of articles) {
    actions.preview(
      sceneId,
      article.querySelector("[data-preview]") as HTMLElement,
    );
  }
  restoreTyping(root, typing);
  applySelection(root, actions, selection, bulk);
}
