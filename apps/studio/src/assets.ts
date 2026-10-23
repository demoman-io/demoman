import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { checkLogoFile } from "@demoman/run-core";
import type { AssetAnswer, Refusal } from "@demoman/studio-protocol";
import { messageOf, writeAtomic } from "./files.js";

/** The file extension each accepted logo type is written under. */
const EXTENSION: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
};

/**
 * A logo upload, checked by the extension's own `checkLogoFile`, written to
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
