// apps/studio/pages/src/library/list-keys.ts
//
// The list's keyboard: the APG treegrid's
// (https://www.w3.org/WAI/ARIA/apg/patterns/treegrid/) with the Mac's keys
// (spec 2026-10-31-library-list-view §4.3). Rows take focus until → moves
// into their cells; one Tab stop enters the grid and the next leaves it.
import { flowsOnScreen, openRename, setExpanded } from "./list";
import type { LibraryActions } from "./view";

/** How long a pause ends a type-ahead search. */
export const TYPE_AHEAD_MS = 500;

let typeAheadMs = TYPE_AHEAD_MS;

/** Tests only: sets the pause that ends a search (null restores
 *  `TYPE_AHEAD_MS`), so a case that proves a click ends one does not
 *  depend on a real click landing within 500 ms (DEM-172: 669 ms on CI's
 *  macOS runner). */
export function setTypeAheadMsForTests(ms: number | null): void {
  typeAheadMs = ms ?? TYPE_AHEAD_MS;
}

/** Where focus last was in each grid: a row's key (`HEAD_KEY` for the
 *  column headings), and the column of the cell in it (null on the row
 *  itself). Read to put focus back after a redraw. */
export const listFocus = new WeakMap<
  HTMLElement,
  { key: string; col: string | null }
>();

/** The first of `names` after `from` (wrapping, `from` itself last) that
 *  starts with `typed`, ignoring case; null for none. */
export function typeAheadMatch(
  names: readonly string[],
  from: number,
  typed: string,
): number | null {
  const t = typed.toLocaleLowerCase();
  for (let i = 1; i <= names.length; i++) {
    const at = (from + i + names.length) % names.length;
    if ((names[at] as string).toLocaleLowerCase().startsWith(t)) return at;
  }
  return null;
}

const ROWS = "[role=row][data-key]";
/** The head row's key in `listFocus`; no row's key is bare. */
export const HEAD_KEY = "head";
const SORTS = "[data-list-head] [data-sort]";
const CONTROLS = "button, input, a[href]";

const visibleRows = (grid: HTMLElement): HTMLElement[] => [
  ...grid.querySelectorAll<HTMLElement>(`${ROWS}:not([hidden])`),
];

const colOf = (stop: HTMLElement): string | null =>
  stop.closest<HTMLElement>("[role=gridcell], [role=columnheader]")?.dataset
    .col ?? null;

/** Where focus stops in a row's cells, in order: a cell's controls, or the
 *  cell itself when it has none. The name cell is a stop of its own as
 *  well, for Enter to rename. A row's actions hidden while flows are
 *  ticked cannot take focus, so they are not stops. */
function stops(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(":scope > [role=gridcell]")]
    .flatMap((cell) => {
      const controls = [...cell.querySelectorAll<HTMLElement>(CONTROLS)];
      return controls.length === 0 || cell.dataset.col === "name"
        ? [cell, ...controls]
        : controls;
    })
    .filter((s) => s.checkVisibility({ visibilityProperty: true }));
}

/** The row itself for no column, else the row's first stop in `col`, else
 *  the row (a column with nothing to focus in this row). */
const stopIn = (row: HTMLElement, col: string | null): HTMLElement =>
  col === null ? row : (stops(row).find((s) => colOf(s) === col) ?? row);

/** The row a row sits under, if any. */
function parentOf(row: HTMLElement): HTMLElement | null {
  const level = Number(row.getAttribute("aria-level"));
  for (let r = row.previousElementSibling; r !== null; ) {
    if (Number(r.getAttribute("aria-level")) < level) return r as HTMLElement;
    r = r.previousElementSibling;
  }
  return null;
}

function focusOn(stop: HTMLElement | null | undefined): void {
  if (stop == null) return;
  stop.focus({ preventScroll: true });
  // Rows carry a scroll margin that keeps them clear of the sticky head.
  stop.scrollIntoView({ block: "nearest" });
}

/** Makes `stop` the grid's one Tab stop, and the place a redraw keeps. */
function markStop(grid: HTMLElement, stop: HTMLElement): void {
  for (const e of grid.querySelectorAll<HTMLElement>('[tabindex="0"]')) {
    e.tabIndex = -1;
  }
  stop.tabIndex = 0;
  const row = stop.closest<HTMLElement>(ROWS);
  listFocus.set(grid, {
    key: row === null ? HEAD_KEY : (row.dataset.key as string),
    col: stop === row ? null : colOf(stop),
  });
}

/** Where focus was last in `grid`, read before a redraw replaces it: its
 *  row and column, the row's place on screen, and whether focus is still
 *  there. Null when the grid was never entered. */
export function placeIn(grid: HTMLElement | null): {
  key: string;
  col: string | null;
  at: number;
  inside: boolean;
} | null {
  const was = grid === null ? undefined : listFocus.get(grid);
  if (grid === null || was === undefined) return null;
  const at = visibleRows(grid).findIndex((r) => r.dataset.key === was.key);
  return { ...was, at, inside: grid.contains(document.activeElement) };
}

/** Puts the place `placeIn` read back in the grid drawn since: the same
 *  row and column, else the row now in its place, else the one before.
 *  Focused, without scrolling, if focus was in the grid; else only the
 *  Tab stop, so a redraw never pulls focus in (§4.5) and the next Tab in
 *  lands where the author left. */
export function restorePlace(
  grid: HTMLElement,
  place: ReturnType<typeof placeIn>,
): void {
  if (place === null) return;
  const rows = visibleRows(grid);
  const row =
    rows.find((r) => r.dataset.key === place.key) ??
    rows[Math.min(place.at, rows.length - 1)];
  const stop =
    place.key === HEAD_KEY
      ? grid.querySelector<HTMLElement>(
          `[data-list-head] [data-col="${place.col}"] [data-sort]`,
        )
      : row === undefined
        ? null
        : stopIn(row, place.col);
  if (stop === null) return;
  if (place.inside) stop.focus({ preventScroll: true });
  else markStop(grid, stop);
}

export function attachListKeys(
  grid: HTMLElement,
  actions: LibraryActions,
): void {
  // APG's roving tabindex: one stop in the grid, the head's sort buttons
  // and everything in the rows reached by the keys.
  for (const e of grid.querySelectorAll<HTMLElement>(
    `${SORTS}, ${ROWS}, ${ROWS} > [role=gridcell], ${ROWS} :is(${CONTROLS})`,
  )) {
    e.tabIndex = -1;
  }
  const first = visibleRows(grid)[0];
  if (first !== undefined) first.tabIndex = 0;

  // Wherever focus lands in the grid, by key or pointer, is the stop.
  grid.addEventListener("focusin", (event) => {
    const stop = event.target as HTMLElement;
    const row = stop.closest<HTMLElement>(ROWS);
    const sort = stop.matches(SORTS);
    if ((row === null && !sort) || stop.matches("[data-name]")) return;
    markStop(grid, stop);
  });

  // The column headings, as APG's sortable grid: ← and → walk the sort
  // buttons, ↓ goes back to the rows. Enter and Space are the button's own.
  grid.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (!target.matches(SORTS) || event.ctrlKey || event.altKey) return;
    if (event.metaKey || event.shiftKey) return;
    // Not the columns a narrow list drops.
    const sorts = [...grid.querySelectorAll<HTMLElement>(SORTS)].filter((s) =>
      s.checkVisibility(),
    );
    const here = sorts.indexOf(target);
    switch (event.key) {
      case "ArrowLeft":
        focusOn(sorts[here - 1]);
        break;
      case "ArrowRight":
        focusOn(sorts[here + 1]);
        break;
      case "ArrowDown":
        focusOn(visibleRows(grid)[0]);
        break;
      case "ArrowUp":
      case "Home":
      case "End":
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  // What was typed, when, the row the search started from, and where it
  // left focus.
  let typed = "";
  let typedAt = Number.NEGATIVE_INFINITY;
  let from = -1;
  let left: Element | null = null;

  grid.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(ROWS);
    // While the name field is open the keys are its own (§4.6).
    if (row === null || document.activeElement?.matches("[data-name]")) {
      return;
    }
    if (event.ctrlKey || event.altKey) return;
    const { key, metaKey: meta, shiftKey: shift } = event;
    const rows = visibleRows(grid);
    const at = rows.indexOf(row);
    const inCell = target !== row;
    const col = inCell ? colOf(target) : null;

    // A pause, or focus moved since (a click), ends a search.
    const searching =
      event.timeStamp - typedAt <= typeAheadMs &&
      document.activeElement === left;
    // A Space inside a search is part of the name ("Export a…"); else it
    // selects, below.
    if (key.length === 1 && !meta && (key !== " " || searching)) {
      if (!searching) {
        typed = "";
        from = at;
      }
      typed += key;
      typedAt = event.timeStamp;
      // Only a flow, or a take in no flow, is a name to jump to.
      const names = rows.map((r) =>
        r.dataset.flow !== undefined || r.dataset.take !== undefined
          ? (r.getAttribute("aria-label") ?? "")
          : "",
      );
      const found = typeAheadMatch(names, from, typed);
      if (found !== null) focusOn(stopIn(rows[found] as HTMLElement, col));
      left = document.activeElement;
      event.preventDefault();
      return;
    }

    const cellStops = inCell ? stops(row) : [];
    const here = cellStops.indexOf(target);
    // A bulk delete under way: the selection and deletes are its (the
    // page marks it on the root, as it shuts the boxes).
    const busy = grid.closest("[data-busy]") !== null;
    const flowId = row.dataset.flow;
    // The selecting state hides a flow or video row's actions, and with
    // them a control focused there: Space and Cmd+A move to the row first.
    const offActions = (): void => {
      if (
        col === "actions" &&
        (flowId !== undefined || row.dataset.videoRow !== undefined)
      ) {
        focusOn(row);
      }
    };
    // Enter folds what a click folds: a heading, or a row's chevron.
    const toggles =
      row.hasAttribute("aria-expanded") &&
      (row.dataset.heading !== undefined || col === "open");

    const handled = ((): boolean => {
      if (
        meta &&
        !["ArrowUp", "ArrowDown", "Backspace", "a", "A"].includes(key)
      ) {
        return false;
      }
      switch (key) {
        case "ArrowDown":
        case "ArrowUp": {
          const step = key === "ArrowDown" ? 1 : -1;
          if (meta) {
            const end = step > 0 ? rows[rows.length - 1] : rows[0];
            focusOn(end === undefined ? null : stopIn(end, col));
            return true;
          }
          const next = rows[at + step];
          // Above the first row are the headings: this column's sort, else
          // Name's.
          if (next === undefined && step < 0 && !shift) {
            focusOn(
              grid.querySelector<HTMLElement>(
                `[data-list-head] [data-col="${col}"] [data-sort]`,
              ) ?? grid.querySelector<HTMLElement>('[data-sort="name"]'),
            );
            return true;
          }
          if (shift) {
            if (inCell) return false;
            if (busy) return true;
            focusOn(next);
            const id = next?.dataset.flow;
            if (id !== undefined) {
              // With no anchor, the range grows from the row it left.
              actions.select?.(id, "range", flowsOnScreen(grid), flowId);
            }
            return true;
          }
          if (next !== undefined) focusOn(stopIn(next, col));
          return true;
        }
        case "ArrowRight":
          if (inCell) focusOn(cellStops[here + 1]);
          else if (row.getAttribute("aria-expanded") === "false") {
            setExpanded(row, true);
          } else focusOn(stops(row)[0]);
          return true;
        case "ArrowLeft":
          if (inCell) focusOn(here > 0 ? cellStops[here - 1] : row);
          else if (row.getAttribute("aria-expanded") === "true") {
            setExpanded(row, false);
          } else focusOn(parentOf(row));
          return true;
        case "Home":
          focusOn(inCell ? cellStops[0] : rows[0]);
          return true;
        case "End":
          focusOn(inCell ? cellStops.at(-1) : rows.at(-1));
          return true;
        case "PageDown":
        case "PageUp": {
          // The page scrolls, not the grid: a screenful is the window's.
          const fit = Math.max(
            1,
            Math.floor(
              document.documentElement.clientHeight /
                Math.max(1, row.offsetHeight),
            ),
          );
          const to = Math.min(
            rows.length - 1,
            Math.max(0, at + (key === "PageDown" ? fit : -fit)),
          );
          focusOn(stopIn(rows[to] as HTMLElement, col));
          return true;
        }
        case "Enter":
          // A control in a cell does its own thing.
          if (inCell && target.matches(CONTROLS)) return false;
          if (toggles) {
            setExpanded(row, row.getAttribute("aria-expanded") === "false");
          } else if (col === "name") {
            openRename(row);
          } else if (inCell) {
            // A cell with no control has nothing to open.
          } else if (grid.closest("[data-selecting]") !== null) {
            // As a click does while flows are ticked: a flow toggles and a
            // video opens nothing, so one key never drops the selection.
            if (flowId !== undefined && !busy) {
              actions.select?.(flowId, "toggle", flowsOnScreen(grid));
            } else if (
              row.dataset.videoRow === undefined &&
              !row.hasAttribute("data-absent") &&
              row.dataset.scene !== undefined
            ) {
              actions.edit(row.dataset.scene);
            }
          } else if (!row.hasAttribute("data-absent")) {
            const scene = row.dataset.scene;
            if (scene !== undefined) actions.edit(scene);
          }
          return true;
        case " ":
          // A control in a cell does its own thing: a button presses, the
          // checkbox ticks itself.
          if (inCell && target.matches(CONTROLS)) return false;
          if (busy) return true;
          if (flowId !== undefined) {
            offActions();
            actions.select?.(flowId, "toggle", flowsOnScreen(grid));
          }
          return true;
        case "a":
        case "A":
          if (!busy) {
            offActions();
            actions.selectAll?.(flowsOnScreen(grid));
          }
          return true;
        case "Backspace": {
          if (!meta) return false;
          if (busy) return true;
          if (grid.closest("[data-selecting]") !== null) {
            actions.deleteSelected?.();
          } else if (flowId !== undefined) {
            actions.remove(flowId, "video");
          } else if (row.dataset.scene !== undefined) {
            // A video's row, or a take in no flow; a heading has no scene.
            actions.remove(row.dataset.scene, "take");
          }
          return true;
        }
        case "Escape":
          if (!inCell) return false;
          focusOn(row);
          // Back to the row is all this Escape does: the page's own clears
          // the selection, and must not hear it.
          event.stopPropagation();
          return true;
        default:
          return false;
      }
    })();
    if (handled) {
      event.preventDefault();
      // Any other key ends the search: the next letter starts a new one
      // from where focus is.
      typedAt = Number.NEGATIVE_INFINITY;
    }
  });
}
