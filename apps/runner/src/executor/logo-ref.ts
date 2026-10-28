import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { checkLogoFile } from "@demoman/run-core";
import type { LogoInput } from "../render.js";
import { messageOf } from "../report.js";

/** The extension's four, by file extension (a path carries no MIME type). */
const TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/**
 * A take's `branding.logo.ref`, as the CLI reads it (author's ruling
 * 2026-10-12): a file path, absolute or relative to DEMOMAN_HOME, checked by
 * the extension's own `checkLogoFile`. Never throws: every way it cannot be
 * had is a reason, which the export turns into `warnings.logo` and still
 * saves the video — a logo is decoration.
 */
export async function readLogo(home: string, ref: string): Promise<LogoInput> {
  if (ref.startsWith("logo:")) {
    return {
      ok: false,
      error: `its ref "${ref}" names a logo in the extension's own storage, which this demoman-mcp cannot read — set logo.ref in ${join(home, "kits.json")} to the logo file's path`,
    };
  }
  const path = isAbsolute(ref) ? ref : join(home, ref);
  const type = TYPES[extname(path).toLowerCase()];
  if (type === undefined) {
    return {
      ok: false,
      error: `${path} is not an SVG, PNG, WebP or JPEG file (by its extension)`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    return {
      ok: false,
      error: `${path} could not be read (${messageOf(error)})`,
    };
  }
  const check = checkLogoFile({ name: path, type, size: bytes.byteLength });
  if (!check.ok) return { ok: false, error: check.reason };
  return { ok: true, bytes: new Uint8Array(bytes), contentType: type };
}
