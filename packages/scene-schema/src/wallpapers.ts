export type WallpaperFamily = "vivid" | "light" | "dark" | "muted";

export interface WallpaperInfo {
  id: string;
  family: WallpaperFamily;
  /** Two lowercase `#rrggbb` colours: what Solid/Gradient start from when
   *  the author leaves the wallpaper, and the alt text's colour words. */
  swatch: { from: string; to: string };
}

/** Display order: vivid, light, dark, muted (light, dark, light, dark). The ids are the shipped file stems.
 *  Each swatch is sampled from its generated image: generate.mjs in
 *  apps/studio/scripts/wallpapers prints them. */
export const WALLPAPERS: readonly WallpaperInfo[] = [
  {
    id: "vivid-1",
    family: "vivid",
    swatch: { from: "#3527bc", to: "#ce1676" },
  },
  {
    id: "vivid-2",
    family: "vivid",
    swatch: { from: "#0769ca", to: "#1e26b7" },
  },
  {
    id: "vivid-3",
    family: "vivid",
    swatch: { from: "#c90757", to: "#ed480d" },
  },
  {
    id: "vivid-4",
    family: "vivid",
    swatch: { from: "#0ba393", to: "#0575c7" },
  },
  {
    id: "vivid-5",
    family: "vivid",
    swatch: { from: "#f28b0a", to: "#df2d21" },
  },
  {
    id: "vivid-6",
    family: "vivid",
    swatch: { from: "#3d0dbf", to: "#133ac7" },
  },
  {
    id: "light-1",
    family: "light",
    swatch: { from: "#b7bff3", to: "#eda9c5" },
  },
  {
    id: "light-2",
    family: "light",
    swatch: { from: "#afe5f0", to: "#98c5e8" },
  },
  { id: "dark-1", family: "dark", swatch: { from: "#150217", to: "#3d044b" } },
  { id: "dark-2", family: "dark", swatch: { from: "#02576e", to: "#023758" } },
  {
    id: "muted-1",
    family: "muted",
    swatch: { from: "#bfb5aa", to: "#a19486" },
  },
  {
    id: "muted-2",
    family: "muted",
    swatch: { from: "#141422", to: "#26233e" },
  },
  {
    id: "muted-3",
    family: "muted",
    swatch: { from: "#a3a299", to: "#cfcbc3" },
  },
  {
    id: "muted-4",
    family: "muted",
    swatch: { from: "#1b1e1d", to: "#51625d" },
  },
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
