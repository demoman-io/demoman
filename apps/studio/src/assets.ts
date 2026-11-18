import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  checkLogoFile,
  checkWallpaperFile,
  WALLPAPER_MAX_BYTES,
} from "@demoman/run-core";
import { writeWallpaperAsset } from "@demoman/runner/studio";
import type { AssetAnswer, Refusal } from "@demoman/studio-protocol";
import { isMissing, messageOf, writeAtomic } from "./files.js";

/** An upload is written before the kit that names it is saved: younger
 *  than this, an asset nothing names yet is left. */
export const ASSET_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** A reset's `kits.json.bak-<ms>` is the person's way back: the newest is
 *  always kept, and any younger than this. */
export const BACKUP_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const ASSET_REF = /assets\/([A-Za-z0-9._-]+)/g;
const BACKUP = /^kits\.json\.bak-(\d+)$/;

/**
 * The upkeep's sweep of `<home>/assets` (DEM-136): removes kit backups past
 * `BACKUP_KEEP_MS` but the newest, then each asset past `ASSET_GRACE_MS`
 * that no kit, kept backup or take names. A name is any `assets/<file>` in
 * those files' text, so a field this sweep does not know still keeps its
 * file. A file that will not read stops it before any asset goes: what it
 * names cannot be told. What went, what would not, and why it stopped are
 * all answered.
 */
export async function sweepAssets(
  home: string,
  takesRoot: string,
  now: number,
): Promise<{ removed: string[]; failed: string[]; stopped?: string }> {
  const removed: string[] = [];
  const failed: string[] = [];
  const remove = async (path: string) => {
    try {
      await rm(path);
      removed.push(path);
    } catch (error) {
      if (!isMissing(error)) failed.push(`${path} (${messageOf(error)})`);
    }
  };
  const list = async (dir: string) => {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw new Error(`${dir} could not be listed (${messageOf(error)})`);
    }
  };
  const named = new Set<string>();
  const readNames = async (path: string) => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return;
      throw new Error(`${path} could not be read (${messageOf(error)})`);
    }
    for (const m of text.matchAll(ASSET_REF)) named.add(m[1] as string);
  };

  try {
    const backups = (await list(home))
      .flatMap((d) => {
        const m = d.isFile() ? BACKUP.exec(d.name) : null;
        return m === null ? [] : [{ name: d.name, at: Number(m[1]) }];
      })
      .sort((a, b) => b.at - a.at);
    const kept = backups.filter(
      (b, i) => i === 0 || now - b.at < BACKUP_KEEP_MS,
    );
    for (const b of backups) {
      if (!kept.includes(b)) await remove(join(home, b.name));
    }
    await readNames(join(home, "kits.json"));
    for (const b of kept) await readNames(join(home, b.name));
    for (const d of await list(takesRoot)) {
      if (!d.isDirectory()) continue;
      await readNames(join(takesRoot, d.name, "scene.json"));
      await readNames(join(takesRoot, d.name, "script.json"));
    }
    const dir = join(home, "assets");
    for (const d of await list(dir)) {
      if (!d.isFile() || named.has(d.name)) continue;
      const path = join(dir, d.name);
      const s = await stat(path).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw new Error(`${path} could not be read (${messageOf(error)})`);
      });
      if (s !== null && now - s.mtimeMs >= ASSET_GRACE_MS) await remove(path);
    }
  } catch (error) {
    return {
      removed,
      failed,
      stopped: `${messageOf(error)}, so no further file was removed`,
    };
  }
  return { removed, failed };
}

/** The file extension each accepted logo type is written under. */
const EXTENSION: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
};

/**
 * A logo upload, checked by `checkLogoFile`, the pages' own check, written to
 * `<home>/assets/<uuid>.<ext>`. The ref is relative to the home, which is
 * how `readLogo` (and so every export) resolves it.
 */
export async function saveLogo(
  home: string,
  file: { name: string; type: string; bytes: Buffer },
): Promise<
  | { ok: true; answer: AssetAnswer }
  | { ok: false; status: number; refusal: Refusal }
> {
  const check = checkLogoFile({
    name: file.name,
    type: file.type,
    size: file.bytes.byteLength,
  });
  if (!check.ok) {
    return {
      ok: false,
      status: 400,
      refusal: { reason: "logoRefused", detail: check.reason },
    };
  }
  const ext = EXTENSION[file.type];
  if (ext === undefined) {
    // `checkLogoFile` accepted a type this table does not name: the two
    // lists have drifted. Said, rather than written under a guessed name.
    throw new Error(
      `no file extension for the accepted logo type ${file.type}`,
    );
  }
  const ref = `assets/${randomUUID()}.${ext}`;
  try {
    await writeAtomic(join(home, ref), file.bytes);
  } catch (error) {
    return {
      ok: false,
      status: 500,
      refusal: {
        reason: "studioUnwritable",
        detail: `The logo was not saved: ${messageOf(error)}.`,
      },
    };
  }
  return { ok: true, answer: { ref } };
}

/**
 * A wallpaper upload: the page's resized WebP (`fitWallpaperImage`), written
 * by the runner's `writeWallpaperAsset` to `<home>/assets/<uuid>.webp`, the
 * ref `readWallpaper` resolves. Any size of picture is accepted because the
 * page bounds it first; what is refused here is a body that is not that
 * WebP, named by type, or one past `WALLPAPER_MAX_BYTES`, a sanity bound.
 */
export async function saveWallpaper(
  home: string,
  file: { name: string; type: string; bytes: Buffer },
): Promise<
  | { ok: true; answer: AssetAnswer }
  | { ok: false; status: number; refusal: Refusal }
> {
  const refused = (detail: string) => ({
    ok: false as const,
    status: 400,
    refusal: { reason: "wallpaperRefused" as const, detail },
  });
  const check = checkWallpaperFile(file);
  if (!check.ok) return refused(check.reason);
  if (file.type !== "image/webp") {
    // An accepted type the page did not resize: stored as .webp it would
    // be a lie, and unbounded.
    return refused(
      `The image "${file.name}" reached the studio as ${file.type}, not the resized WebP the page makes — upload it again`,
    );
  }
  if (file.bytes.byteLength > WALLPAPER_MAX_BYTES) {
    return refused(
      `The image "${file.name}" is ${(file.bytes.byteLength / 1024 / 1024).toFixed(1)} MB after resizing — the studio stores at most ${WALLPAPER_MAX_BYTES / 1024 / 1024} MB`,
    );
  }
  try {
    return {
      ok: true,
      answer: { ref: await writeWallpaperAsset(home, file.bytes) },
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      refusal: {
        reason: "studioUnwritable",
        detail: `The image was not saved: ${messageOf(error)}.`,
      },
    };
  }
}
