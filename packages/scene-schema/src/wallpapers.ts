export type WallpaperFamily = "vivid" | "light" | "dark";

export interface WallpaperInfo {
  id: string;
  family: WallpaperFamily;
  /** Two lowercase `#rrggbb` colours: what Solid/Gradient start from when
   *  the author leaves the wallpaper, and the alt text's colour words. */
  swatch: { from: string; to: string };
}

/** Display order: vivid, light, dark. The ids are the shipped file stems. */
export const WALLPAPERS: readonly WallpaperInfo[] = [
  {
    id: "vivid-1",
    family: "vivid",
    swatch: { from: "#5b3bf5", to: "#f53b8f" },
  },
  {
    id: "vivid-2",
    family: "vivid",
    swatch: { from: "#0ea5e9", to: "#7c3aed" },
  },
  {
    id: "vivid-3",
    family: "vivid",
    swatch: { from: "#f97316", to: "#e11d48" },
  },
  {
    id: "vivid-4",
    family: "vivid",
    swatch: { from: "#10b981", to: "#0284c7" },
  },
  {
    id: "vivid-5",
    family: "vivid",
    swatch: { from: "#facc15", to: "#f43f5e" },
  },
  {
    id: "vivid-6",
    family: "vivid",
    swatch: { from: "#6366f1", to: "#06b6d4" },
  },
  {
    id: "light-1",
    family: "light",
    swatch: { from: "#e0e7ff", to: "#fce7f3" },
  },
  {
    id: "light-2",
    family: "light",
    swatch: { from: "#d1fae5", to: "#e0f2fe" },
  },
  { id: "dark-1", family: "dark", swatch: { from: "#0f0a24", to: "#2a1250" } },
  { id: "dark-2", family: "dark", swatch: { from: "#06121f", to: "#0b3a4a" } },
];

export const DEFAULT_WALLPAPER_ID = "vivid-1";

export function wallpaperInfo(id: string): WallpaperInfo | null {
  return WALLPAPERS.find((w) => w.id === id) ?? null;
}

export function wallpaperFile(
  id: string,
  shape: "landscape" | "portrait" | "thumb",
): string {
  return `${id}-${shape}.webp`;
}
