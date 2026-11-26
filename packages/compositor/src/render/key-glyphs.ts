/**
 * The keycap glyphs Geist has no character for (⌘ ⇧ ⌥ ⌃ ↩ ⇥ ⌫ ⌦, checked
 * with fontTools): Lucide outlines, 24-unit and stroked, copied by hand from
 * `lucide-static@LUCIDE_VERSION`. Lucide is ISC (its Feather-derived icons
 * MIT); the notice ships in `apps/studio/pages/NOTICES`, which the Studio's
 * own Lucide outlines already put there.
 *
 * A hand-copied path is a shape no assertion tells apart from the right one,
 * so `scripts/key-glyph-sheet.mjs` draws each beside Lucide's own file.
 */
import type { KeyGlyph } from "../plan/key-marks.js";

/** The `lucide-static` release the paths below were copied from. */
export const LUCIDE_VERSION = "1.52.0";

export const KEY_GLYPHS: Record<
  KeyGlyph,
  { lucide: string; paths: readonly string[]; mirrored?: true }
> = {
  command: {
    lucide: "command",
    paths: [
      "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3",
    ],
  },
  shift: {
    lucide: "arrow-big-up",
    paths: [
      "M9 19a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-6a1 1 0 0 1 1-1h3.293a.707.707 0 0 0 .5-1.207l-7.086-7.086a1 1 0 0 0-1.414 0l-7.086 7.086a.707.707 0 0 0 .5 1.207H8a1 1 0 0 1 1 1z",
    ],
  },
  option: {
    lucide: "option",
    paths: [
      "M14 3h7",
      "M3 3h5.28a1 1 0 0 1 .948.684l5.544 16.632a1 1 0 0 0 .949.684H21",
    ],
  },
  control: { lucide: "chevron-up", paths: ["m18 15-6-6-6 6"] },
  return: {
    lucide: "corner-down-left",
    paths: ["M20 4v7a4 4 0 0 1-4 4H4", "m9 10-5 5 5 5"],
  },
  tab: {
    lucide: "arrow-right-to-line",
    paths: ["M17 12H3", "m11 18 6-6-6-6", "M21 5v14"],
  },
  backspace: {
    lucide: "delete",
    paths: [
      "M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z",
      "m12 9 6 6",
      "m18 9-6 6",
    ],
  },
  // ⌦ is ⌫ facing the other way, as a Mac keyboard prints it.
  delete: {
    lucide: "delete",
    paths: [
      "M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z",
      "m12 9 6 6",
      "m18 9-6 6",
    ],
    mirrored: true,
  },
};
