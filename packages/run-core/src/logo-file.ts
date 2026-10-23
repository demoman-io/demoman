export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const ACCEPTED = new Set([
  "image/svg+xml",
  "image/png",
  "image/webp",
  "image/jpeg",
]);

/**
 * What an upload is allowed to be, before any bytes are read. Pure, so the
 * node lane pins every refusal's wording.
 */
export function checkLogoFile(file: {
  name: string;
  type: string;
  size: number;
}): { ok: true; note: string | null } | { ok: false; reason: string } {
  if (file.type === "") {
    return {
      ok: false,
      reason: `The logo "${file.name}" has no file type — use SVG, PNG, WebP or JPEG`,
    };
  }
  if (!ACCEPTED.has(file.type)) {
    return {
      ok: false,
      reason: `The logo "${file.name}" is a ${file.type} file — use SVG, PNG, WebP or JPEG`,
    };
  }
  if (file.size > LOGO_MAX_BYTES) {
    return {
      ok: false,
      reason: `The logo "${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — logos are limited to 2 MB`,
    };
  }
  return {
    ok: true,
    note:
      file.type === "image/jpeg"
        ? "JPEG has no transparency — the logo shows as a box on the background"
        : null,
  };
}
