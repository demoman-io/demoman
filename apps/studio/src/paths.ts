/**
 * The page a window shows for a take: the editor on it, or the library when
 * no take is named. The same path is sent to a live window (SSE `open`) and
 * reached by a fresh one through the entry link's redirect.
 */
export function pagePathFor(takeId?: string): string {
  return takeId === undefined
    ? "/"
    : `/editor.html?scene=${encodeURIComponent(takeId)}`;
}

/**
 * The entry link a fresh window opens: `/?t=<ticket>`, plus `&take=<id>`.
 * The ticket is single-use (ruling R12), never the session token. The door
 * spends it, sets the cookie and redirects to `pagePathFor(take)`, so it is
 * in the first request only and never in the page's own address.
 */
export function entryUrlFor(
  origin: string,
  ticket: string,
  takeId?: string,
): string {
  const q = new URLSearchParams({ t: ticket });
  if (takeId !== undefined) q.set("take", takeId);
  return `${origin}/?${q.toString()}`;
}
