import { foldKitName } from "@demoman/run-core";

// The run's half of the kit (reading, defaults, `look.kit`) lives in run-core
// now, where the CLI executor reads kits too; re-exported by name so every
// importer of `core/brand-kit` stays as it was.
export {
  type BrandKitRead,
  type BrandKitsRead,
  brandingForTake,
  coerceBrandKit,
  coerceBrandKits,
  defaultKit,
  type KitEntry,
  type KitRead,
  kitNamed,
  lookForRun,
  type RunLook,
  type RunLookResult,
  type StoredKit,
} from "@demoman/run-core";

/** The single kit's key before 2026-10-08. Read only to migrate it into
 *  `BRAND_KITS_KEY` (`brand-kit-store.ts`). */
export const LEGACY_KIT_KEY = "brandKit";
/** Every brand kit, in creation order (spec 2026-10-08 §1). */
export const BRAND_KITS_KEY = "brandKits";
/** The id of the kit new takes start from. */
export const DEFAULT_KIT_KEY = "defaultKitId";
export const KIT_NAME_MAX = 40;

/**
 * Where the background leaves a finished take's brand-kit failure for the
 * editor that opens on it, in the session storage area. The one-click Stop
 * is a toolbar click with no popup alive to read the Stop reply, and a Keep
 * hands off to the editor as it opens, so the editor is the one surface
 * sure to be there. Per scene, read once and removed.
 */
export const takeNoticeKey = (sceneId: string): string =>
  `takeNotice:${sceneId}`;

/** Whether `name` may name a kit: trimmed, 1–40 characters, unique among
 *  `kits` ignoring case (`selfId`'s own name excepted). A clash is refused,
 *  never suffixed: an author who typed "Dark" meant "Dark". */
export function checkKitName(
  name: string,
  kits: ReadonlyArray<{ id: string; name: string }>,
  selfId: string | null,
): { ok: true; name: string } | { ok: false; reason: string } {
  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, reason: "a kit needs a name" };
  if (trimmed.length > KIT_NAME_MAX) {
    return {
      ok: false,
      reason: `a kit's name is at most ${KIT_NAME_MAX} characters`,
    };
  }
  const clash = kits.find(
    (k) => k.id !== selfId && foldKitName(k.name) === foldKitName(trimmed),
  );
  return clash === undefined
    ? { ok: true, name: trimmed }
    : { ok: false, reason: `a kit is already named "${clash.name}"` };
}

/** `base`, or `base 2`, `base 3`… — the first not taken. For names the page
 *  makes up (New kit, Duplicate), never for one the author typed. */
export function nextKitName(
  base: string,
  kits: ReadonlyArray<{ name: string }>,
): string {
  const taken = new Set(kits.map((k) => foldKitName(k.name)));
  if (!taken.has(foldKitName(base))) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(foldKitName(candidate))) return candidate;
  }
}

/** A new kit's id: opaque, unique, never shown. */
export const newKitId = (): string => `kit-${crypto.randomUUID()}`;
