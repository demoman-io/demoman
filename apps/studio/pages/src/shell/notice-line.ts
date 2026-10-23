// apps/studio/pages/src/shell/notice-line.ts
import { icon } from "./icons";

/**
 * What a page's notice line says: one sentence (a refusal, a warning, a
 * fact), or a fault — what could not be done as its title, and the reason
 * behind Details. A fault's reason is a store's or the studio's own words,
 * paths and error codes included; it is what a developer needs, and printed
 * in full it made the line a wall of red for everyone else (2026-10-17).
 * Collapsed, not dropped: the reason is still on the page, one click away.
 */
export type NoticeText = string | { title: string; detail: string };

export type NoticeLevel = "info" | "warn" | "error";

/**
 * Draws `text` into `el` (`.notice-line` in shell.css): a glyph for a
 * warning or a refusal, the title, Details for a fault, and a dismiss that
 * calls `onDismiss`. Replaces whatever the line held, actions included.
 * Two rows at most while Details is closed: a full-width banner has room
 * for its actions at the title row's end, and a row of their own left it
 * mostly empty and taller than the wall of text it replaced.
 */
export function showNotice(
  el: HTMLElement,
  text: NoticeText,
  level: NoticeLevel,
  onDismiss: () => void,
): void {
  const body = document.createElement("div");
  body.className = "notice-body";
  const title = document.createElement("p");
  title.className = "notice-title";
  title.textContent = typeof text === "string" ? text : text.title;
  body.append(title);
  if (typeof text !== "string") {
    const details = document.createElement("details");
    details.className = "notice-details";
    const summary = document.createElement("summary");
    summary.append("Details", icon("chevronDown"));
    const reason = document.createElement("div");
    reason.className = "notice-reason";
    reason.dataset.noticeReason = "";
    reason.textContent = text.detail;
    details.append(summary, reason);
    body.append(details);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "notice-dismiss";
  dismiss.dataset.noticeDismiss = "";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.title = "Dismiss";
  dismiss.append(icon("close"));
  dismiss.addEventListener("click", onDismiss);
  // Bare `.notice` for info: the shell has `.notice-error` and
  // `.notice-warn` and deliberately no `.notice-info`, because the base
  // class IS the neutral panel. Emitting `notice-info` would add a class
  // that styles nothing and read, to the next person, as a level that
  // exists. No glyph for info either: an alert beside "Freed 1.8 GB." is
  // its own small lie about what happened.
  el.className =
    level === "info"
      ? "notice notice-line"
      : `notice notice-line notice-${level}`;
  el.replaceChildren(
    ...(level === "info" ? [] : [icon("circleAlert")]),
    body,
    dismiss,
  );
}

/** Adds `control` to the line's actions, at the end of the title's row
 *  beside the dismiss (made on first use). False when the line holds
 *  nothing to add it to (cleared or dismissed): the caller then owes a line
 *  of its own. */
export function addNoticeAction(
  el: HTMLElement,
  control: HTMLElement,
): boolean {
  const dismiss = el.querySelector(":scope > .notice-dismiss");
  if (dismiss === null || el.classList.contains("hidden")) return false;
  let row = el.querySelector(":scope > .notice-actions");
  if (row === null) {
    row = document.createElement("div");
    row.className = "notice-actions";
    dismiss.before(row);
  }
  row.append(control);
  return true;
}
