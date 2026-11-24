// The list's rows as DOM: rename hooks, expanding a flow, and the flows on
// screen in order. Apart from list.ts so the keyboard (list-keys.ts) can
// drive the list without importing it back (DEM-199).

/** Each flow row's rename, and each take's in no flow: what Enter on the
 *  name cell and the row's Rename button open (§4.6). */
export const renamers = new WeakMap<HTMLElement, () => void>();

/** Swaps the row's name field in, focused, if the row has one and it is
 *  not open already. */
export const openRename = (row: HTMLElement): void => renamers.get(row)?.();

/** Hides every row under a closed row and shows the rest, from each row's
 *  `aria-expanded`, in place: a redraw would cost focus and scroll. */
export function refold(grid: HTMLElement): void {
  // shown[n]: whether the last row at level n shows its children.
  const shown: boolean[] = [];
  for (const row of grid.querySelectorAll<HTMLElement>(
    "[role=row][data-key]",
  )) {
    const level = Number(row.getAttribute("aria-level"));
    row.hidden = level > 1 && shown[level - 1] !== true;
    shown[level] = !row.hidden && row.getAttribute("aria-expanded") !== "false";
    const leads = row.querySelectorAll<HTMLElement>(
      ":scope > [data-status] > [data-lead-status]",
    );
    if (leads.length > 0) {
      // Said on the video rows while the flow is open (`entryRow`); the line
      // goes, and the row's description with it, when nothing else is on it.
      for (const lead of leads) {
        lead.hidden = row.getAttribute("aria-expanded") === "true";
      }
      const line = leads[0]?.parentElement as HTMLElement;
      line.hidden = [...line.children].every((c) => (c as HTMLElement).hidden);
      if (line.hidden) row.removeAttribute("aria-describedby");
      else row.setAttribute("aria-describedby", line.id);
    }
  }
}

/** Opens or closes a heading or flow row, and shows or hides its rows. */
export function setExpanded(row: HTMLElement, open: boolean): void {
  row.setAttribute("aria-expanded", String(open));
  const grid = row.closest<HTMLElement>("[data-list]");
  if (grid === null) return;
  const videos = [...grid.querySelectorAll<HTMLElement>("[data-video-row]")];
  const was = videos.map((v) => v.hidden);
  refold(grid);
  // The videos this fold brought on screen fade in (§4.7); a redraw's rows
  // never carry the mark, so a redraw never fades. Cleared at the next fold.
  for (const [i, v] of videos.entries()) {
    v.toggleAttribute("data-opening", was[i] === true && !v.hidden);
  }
}

/** The flows on screen, in page order: what a Shift-click or Shift+arrow
 *  ranges over, and what Cmd+A ticks. */
export const flowsOnScreen = (grid: HTMLElement): string[] =>
  [
    ...grid.querySelectorAll<HTMLElement>(
      "[role=row][data-flow]:not([hidden])",
    ),
  ].map((r) => r.dataset.flow as string);
