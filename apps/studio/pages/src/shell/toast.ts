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
    toast.setAttribute("role", "status");
    document.body.append(toast);
  }
  const words = document.createElement("span");
  words.setAttribute("data-toast-text", "");
  words.textContent = text.replace(/\.$/, "");
  toast.replaceChildren(icon("check"), words);
  clearTimeout(timer);
  const shown = toast;
  timer = setTimeout(() => shown.remove(), TOAST_MS);
}
