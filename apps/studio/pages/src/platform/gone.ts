// apps/studio/pages/src/platform/gone.ts
import { codeSpans, withoutTicks } from "../shell/code-spans";

/**
 * The studio's three full-page lines (spec 2026-10-15 §4.1, §8), verbatim:
 * the page can do nothing more, and says why in one sentence. Backticks mark
 * the command, drawn as code.
 */
export const GONE_LINES = {
  /** A 403 from any route: the session cookie is missing or wrong. */
  expired: "This studio link has expired; run `npx demoman studio`.",
  /** A `fetch` rejected, or the event stream would not reconnect. */
  stopped: "The studio stopped — run `npx demoman studio`.",
  /** The page and the server are different versions. */
  updated: "The studio was updated; reopen it.",
} as const;

export type GoneKind = keyof typeof GONE_LINES;

/** The line as the page shows it, backticks dropped: what a reader sees,
 *  and what a test compares. */
export const goneText = (kind: GoneKind): string =>
  withoutTicks(GONE_LINES[kind]);

/**
 * Covers the page with one line. The page's own elements are covered, not
 * removed: the editor keeps rendering into them on its own events, and an
 * element it can no longer find would throw on every one. The first line
 * shown stays — an expired link that then loses its server is still, first,
 * an expired link — and so does the page, which nothing on it can fix.
 */
export function showGone(kind: GoneKind, doc: Document = document): void {
  const body = doc.body;
  if (body === null) return;
  if (body.querySelector("[data-studio-gone]") !== null) return;
  for (const child of Array.from(body.children)) {
    // Inert, not hidden: the line is laid over the page (shell.css,
    // `.gone`), and nothing under it should take focus or a click.
    if (child instanceof HTMLElement) child.inert = true;
  }
  const box = doc.createElement("main");
  box.className = "gone";
  box.dataset.studioGone = kind;
  box.setAttribute("role", "alert");
  const line = doc.createElement("p");
  line.append(...codeSpans(GONE_LINES[kind], doc));
  box.append(line);
  body.append(box);
}
