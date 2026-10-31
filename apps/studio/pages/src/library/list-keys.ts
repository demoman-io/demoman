// apps/studio/pages/src/library/list-keys.ts
//
// The list's keyboard: the APG treegrid's
// (https://www.w3.org/WAI/ARIA/apg/patterns/treegrid/) with the Mac's keys
// (spec 2026-10-31-library-list-view §4.3). Rows take focus until → moves
// into their cells; one Tab stop enters the grid and the next leaves it.
import { flowsOnScreen, setExpanded } from "./list";
import type { LibraryActions } from "./view";

/** How long a pause ends a type-ahead search. */
export const TYPE_AHEAD_MS = 500;

/** Where focus last was in each grid: a row's key, and the column of the
 *  cell in it (null on the row itself). Read to put focus back after a
 *  redraw. */
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
const CONTROLS = "button, input, a[href]";

const visibleRows = (grid: HTMLElement): HTMLElement[] => [
  ...grid.querySelectorAll<HTMLElement>(`${ROWS}:not([hidden])`),
];

const colOf = (stop: HTMLElement): string | null =>
  stop.closest<HTMLElement>("[role=gridcell]")?.dataset.col ?? null;

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

/** Enter on a name cell. Renaming is the name field's, swapped in here by
 *  the rename work (§4.6); until then it does nothing. */
function renameFromKeys(_row: HTMLElement): void {}

export function attachListKeys(
  grid: HTMLElement,
  actions: LibraryActions,
): void {
  // APG's roving tabindex: one stop in the rows, everything else in them
  // reached by the keys. The head's sort buttons keep their own.
  for (const e of grid.querySelectorAll<HTMLElement>(
    `${ROWS}, ${ROWS} > [role=gridcell], ${ROWS} :is(${CONTROLS})`,
  )) {
    e.tabIndex = -1;
  }
  const first = visibleRows(grid)[0];
  if (first !== undefined) first.tabIndex = 0;

  // Wherever focus lands in the rows, by key or pointer, is the stop.
  grid.addEventListener("focusin", (event) => {
    const stop = event.target as HTMLElement;
    const row = stop.closest<HTMLElement>(ROWS);
    if (row === null || stop.matches("[data-name]")) return;
    for (const e of grid.querySelectorAll<HTMLElement>('[tabindex="0"]')) {
      e.tabIndex = -1;
    }
    stop.tabIndex = 0;
    listFocus.set(grid, {
      key: row.dataset.key as string,
      col: stop === row ? null : colOf(stop),
    });
  });

  // What was typed, when, and the row the search started from.
  let typed = "";
  let typedAt = Number.NEGATIVE_INFINITY;
  let from = -1;

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

    if (key.length === 1 && key !== " " && !meta) {
      if (event.timeStamp - typedAt > TYPE_AHEAD_MS) {
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
      event.preventDefault();
      return;
    }

    const cellStops = inCell ? stops(row) : [];
    const here = cellStops.indexOf(target);
    // A bulk delete under way: the selection and deletes are its (the
    // page marks it on the root, as it shuts the boxes).
    const busy = grid.closest("[data-busy]") !== null;
    const flowId = row.dataset.flow;
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
          if (shift) {
            if (inCell) return false;
            if (busy) return true;
            focusOn(next);
            const id = next?.dataset.flow;
            if (id !== undefined) {
              actions.select?.(id, "range", flowsOnScreen(grid));
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
            renameFromKeys(row);
          } else if (!inCell && !row.hasAttribute("data-absent")) {
            const scene = row.dataset.scene;
            if (scene !== undefined) actions.edit(scene);
          }
          return true;
        case " ":
          if (busy) return true;
          if (flowId !== undefined) {
            actions.select?.(flowId, "toggle", flowsOnScreen(grid));
            return true;
          }
          // Another row's button presses as a button does.
          return !(inCell && target.matches(CONTROLS));
        case "a":
        case "A":
          if (!busy) actions.selectAll?.(flowsOnScreen(grid));
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
      typed = "";
    }
  });
}
