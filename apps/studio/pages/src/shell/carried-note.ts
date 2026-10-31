/**
 * A sentence one page owes the author and the next page says: the editor's
 * Delete ends on the Recordings page, and on the studio its reply can carry
 * a note (a folder that could not be removed, a stale export lock that was
 * cleared). The editor is gone by the time it could be read, so the note
 * travels in the library URL's query and the library says it.
 */
export const NOTE_PARAM = "note";

/** The editor's clean Delete, said on the library as a toast; a delete with
 *  a note to read carries the note instead, said on the notice line. */
export const VIDEO_DELETED = "Deleted the video";

/** `url` with `note` in its query; `url` unchanged when there is none. */
export function withNote(url: string, note: string | null): string {
  if (note === null || note === "") return url;
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash);
  const tail = hash < 0 ? "" : url.slice(hash);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${NOTE_PARAM}=${encodeURIComponent(note)}${tail}`;
}

/**
 * The note this page was opened with, or null, and the URL without it —
 * so a reload or a Back does not say it again.
 */
export function takeNote(
  loc: Pick<Location, "href"> = location,
  hist: Pick<History, "replaceState" | "state"> = history,
): string | null {
  const url = new URL(loc.href);
  const note = url.searchParams.get(NOTE_PARAM);
  if (note === null) return null;
  url.searchParams.delete(NOTE_PARAM);
  hist.replaceState(hist.state, "", `${url.pathname}${url.search}${url.hash}`);
  return note === "" ? null : note;
}
