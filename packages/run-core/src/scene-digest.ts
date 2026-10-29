import { BACKGROUND_PAINT_VERSION } from "@demoman/compositor";
import type { SceneBranding, SceneDocument } from "@demoman/scene-schema";

/**
 * A fingerprint of what a scene asks the video to be, so the Recent exports
 * list can say "made before your last edit" — and stop saying it after an
 * undo lands the document back where the export was made.
 *
 * `meta.toolchain` is left out: the offscreen renderer stamps the
 * compositor's version onto its copy, and that is not an edit. `meta.name`
 * is left out because it changes only the file's NAME, which already
 * carries it.
 *
 * `canvas` is left out for a different reason, and the difference matters
 * to anyone changing this function: `canvas.aspect` is NOT cosmetic. It
 * picks the render target (`targetFor`), flips `fit` from `contain` to
 * `cover`, caps the scale through `verticalCameraIntents` and changes the
 * corner radius — a different picture, not a different name. It is
 * excluded anyway because exporting both shapes is one workflow: the 16:9
 * file is not out of date because the author then toggled 9:16 to export
 * the vertical one, and marking it stale would put "made before your last
 * edit" on a file nothing edited.
 *
 * Keys are sorted, so two documents that differ only in key order agree.
 *
 * Not cryptographic, and does not need to be: a collision would claim an
 * old export is current, the same claim no digest at all makes today.
 */
export function sceneDigest(scene: SceneDocument): string {
  const { toolchain: _toolchain, name: _name, ...meta } = scene.meta;
  const { canvas: _canvas, ...rest } = scene;
  return cyrb53(canonical({ ...rest, meta })).toString(16);
}

/**
 * A fingerprint of what paints round the app's window — the background,
 * the padding and the logo — which refresh judges the background by
 * (`same-picture.ts`), as its pixels cannot be.
 *
 * Each image is in it by the bytes the render read (`files`, each a
 * `fileDigest`, null for none), never by its `ref`: keep reads the take's
 * own file and refresh the repo's copy of it, the same bytes under two
 * names, while a file replaced under the same name is a new look. A blur
 * left out is 0, as the compositor paints it. `BACKGROUND_PAINT_VERSION`
 * stands for how those bytes are painted.
 */
export function lookDigest(
  branding: SceneBranding,
  files: { logo: string | null; wallpaper: string | null },
): string {
  const { background: bg, logo, padding } = branding;
  const background =
    bg.kind === "wallpaper"
      ? { kind: bg.kind, id: bg.id, blur: bg.blur ?? 0, file: files.wallpaper }
      : bg.kind === "image"
        ? { kind: bg.kind, blur: bg.blur ?? 0, file: files.wallpaper }
        : bg;
  const { ref: _ref, ...mark } = logo ?? { ref: "" };
  return cyrb53(
    canonical({
      paint: BACKGROUND_PAINT_VERSION,
      background,
      padding,
      logo: logo === null ? null : { ...mark, file: files.logo },
    }),
  ).toString(16);
}

/** A fingerprint of a file's bytes, for `lookDigest`. */
export function fileDigest(bytes: Uint8Array): string {
  return cyrb53(bytes).toString(16);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}

/** cyrb53 (public domain): a fast 53-bit string hash. */
function cyrb53(text: string | Uint8Array): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch =
      typeof text === "string" ? text.charCodeAt(i) : (text[i] as number);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
