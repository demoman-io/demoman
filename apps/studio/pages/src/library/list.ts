// apps/studio/pages/src/library/list.ts
//
// The library's list view, drawn: an APG treegrid of headings, flows and
// their videos (spec 2026-10-31-library-list-view §2, §4.1). Clicks, keys,
// rename and lengths are filled in on this DOM by later work; the keys
// are list-keys.ts.
import type {
  LibrarySortColumn,
  LibraryViewChoice,
} from "@demoman/studio-protocol";
import { setCodeText, withoutTicks } from "../shell/code-spans";
import { icon } from "../shell/icons";
import { attachListKeys } from "./list-keys";
import { type ListEntry, listEntries, nextSort, whereOf } from "./list-model";
import type { LibraryModel, LibraryRow, VideoGroup } from "./state";
import { formatBytes } from "./state";
import {
  cardButtons,
  el,
  expiredLine,
  exportsList,
  type LibraryActions,
  sectionId,
  statusKey,
  tags,
  versionButtons,
} from "./view";

/** Whether a video's footage is on this machine, and if not why: one state
 *  drawn one way whatever the cause (§2.4). Expired is the only cause
 *  today. */
export type Footage = "here" | { absent: string };

const footageOf = (r: LibraryRow, actions: LibraryActions): Footage =>
  r.expired === true
    ? {
        absent:
          expiredLine(true, actions.rerunLine?.(r.sceneId, r.authored)) ??
          "Expired",
      }
    : "here";

type Col =
  | "select"
  | "open"
  | "name"
  | "where"
  | "videos"
  | "length"
  | "recorded"
  | "size"
  | "actions";

/** Each column, its heading and the sort its heading button asks for; the
 *  unnamed ones are named for a screen reader only. Length never sorts. */
const COLUMNS: readonly [Col, string, LibrarySortColumn | null, boolean][] = [
  ["select", "Select", null, false],
  ["open", "Open", null, false],
  ["name", "Name", "name", true],
  ["where", "Where", "where", true],
  ["videos", "Videos", "videos", true],
  ["length", "Length", null, true],
  ["recorded", "Recorded", "recorded", true],
  ["size", "Size", "size", true],
  ["actions", "Actions", null, false],
];

/** The keys of the rows that are closed under `root`, read before a
 *  redraw so it can close them again. */
export function collapsedKeys(root: HTMLElement): Set<string> {
  return new Set(
    [
      ...root.querySelectorAll<HTMLElement>(
        '[data-list] [role=row][aria-expanded="false"]',
      ),
    ].map((r) => r.dataset.key as string),
  );
}

function headRow(
  view: LibraryViewChoice,
  actions: LibraryActions,
): HTMLElement {
  const row = el("div", { role: "row", "data-list-head": "" });
  for (const [col, label, sort, shown] of COLUMNS) {
    const head = el("div", { role: "columnheader", "data-col": col });
    if (!shown) head.setAttribute("aria-label", label);
    if (sort !== null && sort === view.sort.column) {
      head.setAttribute(
        "aria-sort",
        view.sort.descending ? "descending" : "ascending",
      );
    }
    const setView = actions.setView;
    if (sort !== null && setView !== undefined) {
      const button = el("button", { type: "button", "data-sort": sort }, label);
      button.addEventListener("click", () =>
        setView({ layout: view.layout, sort: nextSort(view.sort, sort) }),
      );
      head.append(button);
    } else if (shown) {
      head.textContent = label;
    }
    row.append(head);
  }
  return row;
}

/** A text cell that is clipped at rest carries its full text as its title. */
function textCell(
  cells: Record<Col, HTMLElement>,
  col: Col,
  text: string,
): void {
  cells[col].textContent = text;
  cells[col].title = text;
}

const chevron = (): SVGSVGElement => {
  const chev = icon("chevronRight");
  chev.classList.add("chev");
  return chev;
};

function renameButton(label: string): HTMLElement {
  const rename = el("button", {
    type: "button",
    "data-action": "rename",
    class: "btn btn-quiet btn-icon",
    "aria-label": `Rename ${label}`,
    title: "Rename",
  });
  rename.append(icon("pencilLine"));
  return rename;
}

/** One entry's row: its cells, then the line that says what happened to
 *  it, if anything was said. */
function entryRow(
  e: ListEntry,
  actions: LibraryActions,
  rowStatus: Map<string, string>,
  /** Each flow drawn so far, by id: a video row's buttons name its flow. */
  flows: Map<string, VideoGroup>,
): HTMLElement {
  const row = el("div", { role: "row", "data-key": e.key });
  const cells = Object.fromEntries(
    COLUMNS.map(([col]) => [
      col,
      el("div", { role: "gridcell", "data-col": col }),
    ]),
  ) as unknown as Record<Col, HTMLElement>;
  // What the row's line says: the sentence standing where Restore would,
  // and what was said of the row (a refused delete, a partial one).
  const said: HTMLElement[] = [];

  if (e.kind === "heading") {
    const { section } = e;
    row.setAttribute("data-heading", section.key);
    row.id = sectionId(section.key);
    row.setAttribute("aria-label", section.label);
    cells.open.append(chevron());
    cells.name.append(
      el("span", { "data-name-text": "" }, section.label),
      el(
        "span",
        { class: "section-count", "data-section-count": "" },
        String(section.rows.length),
      ),
    );
  } else if (e.kind === "flow") {
    const { card } = e;
    const r = card.row;
    const group = card.group;
    const label =
      group === null ? r.name || r.label : group.video.name || r.label;
    row.setAttribute("data-scene", r.sceneId);
    row.setAttribute("aria-label", label);
    if (footageOf(r, actions) !== "here") row.setAttribute("data-absent", "");
    if (group === null) {
      row.setAttribute("data-take", r.sceneId);
    } else {
      row.setAttribute("data-flow", group.video.id);
      flows.set(group.video.id, group);
      cells.open.append(chevron());
      if (actions.select !== undefined) {
        cells.select.append(
          el("input", {
            type: "checkbox",
            class: "select-box",
            "data-select": group.video.id,
            "aria-label": `Select ${label}`,
          }),
        );
      }
    }
    cells.name.append(
      el("span", { "data-name-text": "", title: label }, label),
    );
    const strip = tags(r, actions, false);
    if (strip !== null) cells.name.append(strip);
    textCell(cells, "where", whereOf(card));
    cells.videos.textContent = String(group?.versions.length ?? 1);
    cells.recorded.textContent = e.namesDay ? r.time : r.when;
    cells.recorded.title = r.when;
    if (e.size.kind === "unknown") {
      cells.size.textContent = "—";
    } else {
      const missed = e.size.unmeasured;
      cells.size.textContent = `${formatBytes(e.size.bytes)}${missed > 0 ? "+" : ""}`;
      if (missed > 0) {
        cells.size.title = `${missed} ${missed === 1 ? "video" : "videos"} could not be measured`;
      }
    }
    const { buttons, rerunLine } = cardButtons(r, actions, group);
    buttons.insertBefore(
      renameButton(label),
      buttons.querySelector('[data-action="edit"], [data-action="delete"]'),
    );
    cells.actions.append(buttons);
    if (rerunLine !== null) {
      const rerun = el("p", { "data-rerun-line": "" });
      setCodeText(rerun, rerunLine);
      said.push(rerun);
    }
    // A flow's own status only: what was said of one of its takes is said
    // on that take's video row, which every flow has here (not the card's
    // fallback for a one-version flow, which would say it twice).
    const status =
      group === null
        ? rowStatus.get(statusKey("take", r.sceneId))
        : rowStatus.get(statusKey("video", group.video.id));
    if (status !== undefined) said.push(el("p", {}, status));
  } else {
    const v = e.row;
    row.setAttribute("data-video-row", v.sceneId);
    row.setAttribute("data-scene", v.sceneId);
    const name = `Video ${v.version ?? "?"}`;
    row.setAttribute("aria-label", name);
    cells.name.append(el("span", { "data-name-text": "" }, name));
    const footage = footageOf(v, actions);
    if (footage !== "here") row.setAttribute("data-absent", "");
    if (footage === "here") {
      const files = exportsList(v.exports);
      if (files !== null) cells.where.append(files);
    } else {
      // The platform's line may carry a code span, drawn as the card does.
      setCodeText(cells.where, footage.absent);
      cells.where.title = withoutTicks(footage.absent);
    }
    // Its own moment: an older video may be from another day than the
    // heading it sits under.
    cells.recorded.textContent = v.when;
    cells.recorded.title = v.when;
    cells.size.textContent =
      v.sizeBytes === undefined ? "—" : formatBytes(v.sizeBytes);
    cells.actions.append(
      versionButtons(
        v,
        flows.get(e.flowId) as VideoGroup,
        actions,
        footage === "here",
      ),
    );
    const status = rowStatus.get(statusKey("take", v.sceneId));
    if (status !== undefined) said.push(el("p", {}, status));
  }
  row.append(...COLUMNS.map(([col]) => cells[col]));

  if (said.length > 0) {
    // Not a cell, so never a keyboard stop; the row's description.
    const line = el("div", {
      "data-status": "",
      class: "notice notice-error",
      id: `list-status-${e.key}`,
    });
    line.append(...said);
    row.append(line);
    row.setAttribute("aria-describedby", line.id);
  }
  return row;
}

/**
 * Draws the treegrid into `list` and returns it. A row under a closed row
 * is `hidden`. A heading or flow keeps the fold it had (`was.collapsed`);
 * one the last draw did not have (`was.drawn`) takes its default — a past
 * month folded, as its card section starts, and every flow closed.
 */
export function renderList(
  list: HTMLElement,
  model: LibraryModel,
  actions: LibraryActions,
  rowStatus: Map<string, string>,
  now: Date,
  view: LibraryViewChoice,
  was: { collapsed: ReadonlySet<string>; drawn?: ReadonlySet<string> },
): HTMLElement {
  const entries = listEntries(model, view.sort, now);
  const grid = el("div", {
    role: "treegrid",
    class: "library-list",
    "data-list": "",
    "aria-multiselectable": "true",
    "aria-label": "Flows",
    "aria-rowcount": String(entries.length + 1),
  });
  grid.append(headRow(view, actions));

  const setSize = new Map<string | null, number>();
  for (const e of entries)
    setSize.set(e.parent, (setSize.get(e.parent) ?? 0) + 1);
  const seen = new Map<string | null, number>();
  const flows = new Map<string, VideoGroup>();

  for (const e of entries) {
    const row = entryRow(e, actions, rowStatus, flows);
    const pos = (seen.get(e.parent) ?? 0) + 1;
    seen.set(e.parent, pos);
    row.setAttribute("aria-level", String(e.level));
    row.setAttribute("aria-posinset", String(pos));
    row.setAttribute("aria-setsize", String(setSize.get(e.parent)));
    const opens =
      e.kind === "heading" || (e.kind === "flow" && e.flowId !== null);
    if (opens) {
      const byDefault = e.kind === "heading" ? e.section.folded : true;
      const closed =
        was.collapsed.has(e.key) ||
        (byDefault && !(was.drawn?.has(e.key) ?? false));
      row.setAttribute("aria-expanded", String(!closed));
    }
    if (e.kind === "flow" && e.flowId !== null) {
      row.setAttribute("aria-selected", "false");
    }
    grid.append(row);
  }
  refold(grid);
  listenForClicks(grid, actions);
  attachListKeys(grid, actions);
  list.append(grid);
  return grid;
}

/** Hides every row under a closed row and shows the rest, from each row's
 *  `aria-expanded`, in place: a redraw would cost focus and scroll. */
function refold(grid: HTMLElement): void {
  // shown[n]: whether the last row at level n shows its children.
  const shown: boolean[] = [];
  for (const row of grid.querySelectorAll<HTMLElement>(
    "[role=row][data-key]",
  )) {
    const level = Number(row.getAttribute("aria-level"));
    row.hidden = level > 1 && shown[level - 1] !== true;
    shown[level] = !row.hidden && row.getAttribute("aria-expanded") !== "false";
  }
}

/** Opens or closes a heading or flow row, and shows or hides its rows. */
export function setExpanded(row: HTMLElement, open: boolean): void {
  row.setAttribute("aria-expanded", String(open));
  const grid = row.closest<HTMLElement>("[data-list]");
  if (grid !== null) refold(grid);
}

/** The flows on screen, in page order: what a Shift-click or Shift+arrow
 *  ranges over, and what Cmd+A ticks. */
export const flowsOnScreen = (grid: HTMLElement): string[] =>
  [
    ...grid.querySelectorAll<HTMLElement>(
      "[role=row][data-flow]:not([hidden])",
    ),
  ].map((r) => r.dataset.flow as string);

/**
 * A click opens, as a card's does (§4.2), with the card's exceptions
 * (view.ts `row()`): the chevron or a heading only folds; a checkbox,
 * button or link does its own thing; a click that ends a text selection or
 * a rename does nothing; a video with no footage here does nothing. While
 * flows are ticked, or with Cmd or Shift, a click on a flow selects it.
 */
function listenForClicks(grid: HTMLElement, actions: LibraryActions): void {
  // The click that ends a rename: the press blurs the field before the
  // click lands, so what was focused at the press decides.
  let nameWasFocused = false;
  grid.addEventListener("pointerdown", () => {
    const active = document.activeElement;
    nameWasFocused =
      active?.matches("[data-name]") === true && grid.contains(active);
  });
  grid.addEventListener("click", (event) => {
    const target = event.target as Element;
    const row = target.closest<HTMLElement>("[role=row][data-key]");
    const typed = nameWasFocused;
    nameWasFocused = false;
    if (row === null) return;
    const flowId = row.dataset.flow;
    const select = (): void =>
      actions.select?.(
        flowId as string,
        event.shiftKey ? "range" : "toggle",
        flowsOnScreen(grid),
      );
    if (
      row.hasAttribute("aria-expanded") &&
      (row.dataset.heading !== undefined ||
        target.closest('[data-col="open"]') !== null)
    ) {
      setExpanded(row, row.getAttribute("aria-expanded") === "false");
      return;
    }
    // The box toggles itself; not cancelled, as the card's is not.
    if (target.matches("[data-select]")) {
      select();
      return;
    }
    // Below the row's own controls, which work while a name is typed.
    if (typed || target.closest("button, input, a")) return;
    if (
      flowId !== undefined &&
      actions.select !== undefined &&
      (grid.closest("[data-selecting]") !== null ||
        event.metaKey ||
        event.shiftKey)
    ) {
      select();
      return;
    }
    if ((window.getSelection()?.toString() ?? "") !== "") return;
    // Nothing to open: the Where cell says what to do.
    if (row.hasAttribute("data-absent")) return;
    const scene = row.dataset.scene;
    if (scene !== undefined) actions.edit(scene);
  });
}
