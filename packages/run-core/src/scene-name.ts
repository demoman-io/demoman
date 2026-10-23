import type { SceneDocument } from "@demoman/scene-schema";

/**
 * What a take is called, and what it is called when nobody named it.
 *
 * An empty `meta.name` is an untitled take — a stored fact, not a guess.
 * Until 2026-09-22 a take was named `new Date(startedAt).toLocaleString()`
 * at finalize, and the library decided "untitled" by comparing the name
 * against that formatter in the reader's current locale: a locale change
 * turned every unrenamed take into a renamed one.
 */

/**
 * The name a new take starts with: the tab's title at the moment it was
 * captured, or "" when there is no title worth having.
 *
 * Chrome reports a page with no `<title>` as its URL — sometimes whole,
 * sometimes without the scheme — so a title that is only the address says
 * nothing the row's host-and-path line does not, and the take stays
 * untitled instead.
 */
export function nameFromPageTitle(
  title: string | null | undefined,
  url: string,
): string {
  const name = (title ?? "").replace(/\s+/g, " ").trim();
  if (name === "") return "";
  const bare = (u: string) =>
    u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
  if (bare(name) === bare(url)) return "";
  return name;
}

/**
 * A take finalized before 2026-09-22 carries its start time as its name.
 * Read back as untitled so it shows the same way a new untitled take does.
 *
 * Still the locale comparison the old library made, so a take recorded
 * under another locale keeps its timestamp name — which is what it showed
 * before, not a new fault. A rename writes the document back and the
 * question does not come up again for that take.
 */
export function untitleTimestampName(scene: SceneDocument): SceneDocument {
  const stamp = new Date(scene.meta.createdAt).toLocaleString();
  if (scene.meta.name !== stamp) return scene;
  return { ...scene, meta: { ...scene.meta, name: "" } };
}
