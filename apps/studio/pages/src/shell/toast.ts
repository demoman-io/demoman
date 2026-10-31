// apps/studio/pages/src/shell/toast.ts
import { icon } from "./icons";

/** How long a toast stays. */
export const TOAST_MS = 4000;

let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Says a plain success — something the author just did and can see happened
 * ("Deleted 3 flows.") — and takes it down after `TOAST_MS`. One at a time;
 * a newer one replaces it. Only for a sentence with nothing left to act on:
 * a failure, a partial result or a note that asks for something stays on
 * the page's notice line, since a toast nobody was watching is gone
 * (CLAUDE.md, "Report before you forgive").
 *
 * Drawn top right with the check glyph in the success tone, and said
 * without its closing period (the author, 2026-10-30): callers pass the
 * sentence they would write anywhere, and the toast drops the period, so
 * the same words can stand on the notice line when there is more to say.
 */
export function showToast(text: string): void {
  let toast = document.querySelector<HTMLElement>("[data-toast]");
  if (toast === null) {
    toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("data-toast", "");
    document.body.append(toast);
  }
  const words = document.createElement("span");
  words.setAttribute("data-toast-text", "");
  words.textContent = text.replace(/\.$/, "");
  announce(words.textContent);
  toast.replaceChildren(icon("check"), words);
  clearTimeout(timer);
  const shown = toast;
  timer = setTimeout(() => shown.remove(), TOAST_MS);
}

/** Says `text` to a screen reader. A live region added with its words in
 *  it is often not announced, and the toast is gone in `TOAST_MS`; so the
 *  region stays on the page once made, is emptied, and gets the sentence a
 *  moment later, which also says the same sentence twice. */
function announce(text: string): void {
  let region = document.querySelector<HTMLElement>("[data-toast-said]");
  if (region === null) {
    region = document.createElement("div");
    region.className = "toast-said";
    region.setAttribute("data-toast-said", "");
    region.setAttribute("role", "status");
    document.body.append(region);
  }
  region.textContent = "";
  const said = region;
  setTimeout(() => {
    said.textContent = text;
  }, 50);
}
