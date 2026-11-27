// How long an old video's footage (its frames and previews) is kept before
// expiry removes it: the user's `settings.json` holds one, expiry
// reads it, `status` reports it, and the Studio offers them. One list, so the
// runner's read, the Studio's check and the page's choices cannot drift.

/** In the order the Studio lists them, shortest first. */
export const KEEP_FOOTAGE_VALUES = ["30d", "90d", "forever"] as const;
export type KeepFootage = (typeof KEEP_FOOTAGE_VALUES)[number];

/** Each value's name wherever a person picks it. */
export const KEEP_FOOTAGE_LABELS: Record<KeepFootage, string> = {
  "30d": "30 days",
  "90d": "90 days",
  forever: "Forever",
};

/** With nothing set: what expiry did before the setting existed. */
export const DEFAULT_KEEP_FOOTAGE: KeepFootage = "30d";

/** How old a video's footage may get, in days; null: never removed. */
export const keepFootageDays = (v: KeepFootage): number | null =>
  v === "forever" ? null : v === "90d" ? 90 : 30;

export const isKeepFootage = (v: unknown): v is KeepFootage =>
  typeof v === "string" &&
  (KEEP_FOOTAGE_VALUES as readonly string[]).includes(v);
