export declare const STUDIO_SOURCE_DIRS: readonly string[];
export declare const STUDIO_NEEDED: readonly string[];
export declare const WALLPAPER_IDS: readonly string[];
export declare function checkStudioPages(o: {
  pagesDir: string;
  pagesSourceDir: string;
  version: string;
}): { ok: true } | { ok: false; reason: string };
