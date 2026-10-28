import {
  BRANDING_DEFAULTS,
  BrandingSchema,
  type SceneBranding,
} from "@demoman/scene-schema";

export type BrandKitRead =
  | { state: "missing" }
  | { state: "ready"; kit: SceneBranding }
  | { state: "invalid"; reason: string };

/**
 * A stored kit, checked by the same schema a demo's branding is. An invalid
 * kit is `invalid` with the reason — never `missing`, which would present a
 * broken kit as an empty one and let Save overwrite it without a word.
 */
export function coerceBrandKit(raw: unknown): BrandKitRead {
  if (raw === undefined || raw === null) return { state: "missing" };
  const parsed = BrandingSchema.safeParse(withPadding(raw));
  if (!parsed.success) {
    return {
      state: "invalid",
      reason: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { state: "ready", kit: parsed.data };
}

/**
 * A kit saved before 2026-10-05 has no `padding`. It is the author's
 * working kit, not a broken one, so it reads as that kit at the default
 * padding — an upgrade of an absent key, never a stand-in for a bad value:
 * a present `padding` is passed through for the schema to judge. A copy, so
 * reading never writes; the stored kit gains the key on its next save.
 */
function withPadding(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  if ("padding" in raw) return raw;
  return { ...raw, padding: BRANDING_DEFAULTS.padding };
}

/** One kit as stored: the branding is checked on read, never trusted. */
export interface StoredKit {
  id: string;
  name: string;
  branding: unknown;
}

/** One kit's branding as read. */
export type KitRead =
  | { state: "ready"; kit: SceneBranding }
  | { state: "invalid"; reason: string };

export interface KitEntry {
  id: string;
  name: string;
  read: KitRead;
}

export type BrandKitsRead =
  | {
      state: "ready";
      kits: KitEntry[];
      /** Null only with no kits. May name a kit that is not in `kits`: that
       *  is reported by the consumers ("missing"), never repaired on read. */
      defaultId: string | null;
      /** Both the old single-kit key and the list are stored: the old key's
       *  removal is still owed and the next read retries it. */
      migrationPending: boolean;
    }
  | {
      state: "invalid";
      reason: string;
      /** Storage refused the read or the move: the stored list may be
       *  fine, and a retry may read it. Absent for a list that read and is
       *  malformed — the only kind Settings offers a fresh start for. */
      storageRefused?: true;
    };

/** A kit name as compared: trimmed, case ignored. */
export const foldKitName = (name: string): string =>
  name.trim().toLocaleLowerCase();

/**
 * The stored list, each kit judged on its own by `coerceBrandKit`: one
 * invalid kit is that kit's tile and that kit's Diagnostics line, never the
 * whole card. An entry with no id or name is a list nobody can address kits
 * in, so the whole list is `invalid`, with the entry's position.
 */
export function coerceBrandKits(
  rawList: unknown,
  rawDefault: unknown,
  migrationPending = false,
): BrandKitsRead {
  if (rawList === undefined || rawList === null) {
    return { state: "ready", kits: [], defaultId: null, migrationPending };
  }
  if (!Array.isArray(rawList)) {
    return {
      state: "invalid",
      reason: `the kit list is not a list (${typeof rawList})`,
    };
  }
  const kits: KitEntry[] = [];
  for (const [i, raw] of rawList.entries()) {
    const entry = raw as Partial<StoredKit> | null;
    if (typeof entry?.id !== "string" || entry.id === "") {
      return { state: "invalid", reason: `kit ${i + 1}: it has no id` };
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      return { state: "invalid", reason: `kit ${i + 1}: it has no name` };
    }
    const one = coerceBrandKit(entry.branding);
    const read: KitRead =
      one.state === "missing"
        ? { state: "invalid", reason: "the kit holds no branding" }
        : one;
    kits.push({ id: entry.id, name: entry.name, read });
  }
  // The first kit stands in only when NO default is stored: a stored id that
  // names nothing is kept, so the consumers can say the default is missing.
  const defaultId =
    typeof rawDefault === "string" && rawDefault !== ""
      ? rawDefault
      : (kits[0]?.id ?? null);
  return { state: "ready", kits, defaultId, migrationPending };
}

/** The kit `defaultId` names, or null — never another kit in its place. */
export function defaultKit(read: BrandKitsRead): KitEntry | null {
  if (read.state !== "ready" || read.defaultId === null) return null;
  return read.kits.find((k) => k.id === read.defaultId) ?? null;
}

/** A kit by name, as an agent's `look.kit` names it: case and surrounding
 *  space ignored. Names are unique under the same folding (`checkKitName`). */
export function kitNamed(read: BrandKitsRead, name: string): KitEntry | null {
  if (read.state !== "ready") return null;
  return (
    read.kits.find((k) => foldKitName(k.name) === foldKitName(name)) ?? null
  );
}

/** Why the default kit cannot start a take, or null when it can — or when
 *  there are no kits, which is the defaults by the author's own choice. */
function defaultKitFault(
  read: BrandKitsRead,
): { said: string; reason: string | null } | null {
  if (read.state === "invalid") {
    return { said: "Your brand kits could not be read", reason: read.reason };
  }
  if (read.defaultId === null) return null;
  const entry = defaultKit(read);
  if (entry === null) {
    return { said: "Your default brand kit is missing", reason: null };
  }
  if (entry.read.state === "invalid") {
    return {
      said: `Your default brand kit "${entry.name}" could not be read`,
      reason: entry.read.reason,
    };
  }
  return null;
}

/** What a new take's branding starts from (spec 2026-10-08 §3): the default
 *  kit, never another kit in its place. A take on the wrong brand that looks
 *  right is worse than one on the defaults that says why. */
export function brandingForTake(read: BrandKitsRead): {
  branding: SceneBranding;
  brandKitError: string | null;
} {
  const entry = defaultKit(read);
  if (entry?.read.state === "ready") {
    return { branding: structuredClone(entry.read.kit), brandKitError: null };
  }
  const fault = defaultKitFault(read);
  return {
    branding: BRANDING_DEFAULTS,
    brandKitError:
      fault === null
        ? null
        : `${fault.said}, so this take uses the default background${fault.reason === null ? "" : `: ${fault.reason}`}`,
  };
}

/** Where an agent-made take's branding came from, as its run report says
 *  (spec 2026-10-01 §1.4, 2026-10-08 §3). */
export interface RunLook {
  /** `script`: the script's own `look.branding`. `kit`: the kit the script
   *  named in `look.kit`. `defaultKit`: the script named none and the
   *  default kit supplied it. `defaults`: no kit could. */
  branding: "script" | "kit" | "defaultKit" | "defaults";
  /** The kit's name for `kit` and `defaultKit`; null otherwise. */
  kit: { name: string } | null;
  /** Why the default kit could not be used; null when it was, or there is
   *  none. Reported even when the script's own branding made the kit moot:
   *  the author believes a kit is saved. */
  brandKitError: string | null;
  /** Why the default kit's image could not be made the take's own copy, so
   *  the take keeps the kit's path and an export may leave the image out;
   *  null when it was, or there is none. A kit named in `look.kit` is
   *  refused instead (`wallpaperUnreadable`). Set by the run, not here. */
  wallpaperError: string | null;
}

export type RunLookResult =
  | { ok: true; startingBranding: SceneBranding; look: RunLook }
  /** The script named a kit that is not there, or one that cannot be read
   *  (`unknownKit`), or the list itself could not be read
   *  (`kitsUnreadable` — a fault, not a wrong name). Never answered with
   *  the default: that is a take on the wrong brand. */
  | { ok: false; reason: "unknownKit" | "kitsUnreadable"; detail: string };

/**
 * What an agent-made take starts from: the script's own `look.branding`, else
 * the kit it names in `look.kit`, else the default kit — the same
 * `brandingForTake` a recorded take goes through at Stop — else the defaults.
 */
export function lookForRun(
  script: { look?: { branding?: SceneBranding; kit?: string } },
  read: BrandKitsRead,
): RunLookResult {
  if (script.look?.branding !== undefined) {
    const fault = defaultKitFault(read);
    return {
      ok: true,
      startingBranding: brandingForTake(read).branding,
      look: {
        branding: "script",
        kit: null,
        // `brandingForTake`'s sentence says the take "uses the default
        // background", which is false here. No closing period: the verdict
        // adds one.
        brandKitError:
          fault === null
            ? null
            : `${fault.said}${fault.reason === null ? "" : ` (${fault.reason})`}; this take uses the script's own branding`,
        wallpaperError: null,
      },
    };
  }
  const asked = script.look?.kit;
  if (asked !== undefined) {
    if (read.state === "invalid") {
      return {
        ok: false,
        reason: "kitsUnreadable",
        detail: `the brand kits could not be read (${read.reason}), so "${asked}" cannot be found`,
      };
    }
    const entry = kitNamed(read, asked);
    if (entry === null) {
      return {
        ok: false,
        reason: "unknownKit",
        detail:
          read.kits.length === 0
            ? `no brand kit is named "${asked}" — there are no brand kits`
            : `no brand kit is named "${asked}" — the kits are ${read.kits.map((k) => `"${k.name}"`).join(", ")}`,
      };
    }
    if (entry.read.state === "invalid") {
      return {
        ok: false,
        reason: "unknownKit",
        detail: `the brand kit "${entry.name}" could not be read: ${entry.read.reason}`,
      };
    }
    return {
      ok: true,
      startingBranding: structuredClone(entry.read.kit),
      look: {
        branding: "kit",
        kit: { name: entry.name },
        brandKitError: null,
        wallpaperError: null,
      },
    };
  }
  const { branding, brandKitError } = brandingForTake(read);
  const entry = defaultKit(read);
  return {
    ok: true,
    startingBranding: branding,
    look:
      entry?.read.state === "ready"
        ? {
            branding: "defaultKit",
            kit: { name: entry.name },
            brandKitError: null,
            wallpaperError: null,
          }
        : {
            branding: "defaults",
            kit: null,
            brandKitError,
            wallpaperError: null,
          },
  };
}

/**
 * The author's brand kits by name, for an agent choosing `look.kit` (spec
 * 2026-10-08 §3). An unreadable list is said with its reason, never sent as
 * an empty one: "no kits" and "the kits could not be read" ask an agent for
 * different things.
 */
export type SnapshotKits =
  | {
      ok: true;
      kits: Array<{ name: string; default: boolean; valid: boolean }>;
    }
  | { ok: false; reason: string };

export function kitsForSnapshot(read: BrandKitsRead): SnapshotKits {
  if (read.state === "invalid") return { ok: false, reason: read.reason };
  const def = defaultKit(read);
  return {
    ok: true,
    kits: read.kits.map((k) => ({
      name: k.name,
      default: k.id === def?.id,
      valid: k.read.state === "ready",
    })),
  };
}
