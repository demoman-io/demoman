// apps/studio/pages/src/library/state.ts
import type { SceneDocument } from "@demoman/scene-schema";
import type { TakesAnswer, VideoSummary } from "@demoman/studio-protocol";
import { sceneLabel } from "../core/scene-name";
import type { DemoFootprint, StorageSummary } from "../core/storage/types";

export interface LibraryRow {
  sceneId: string;
  /** The author's name for the take; "" while it is untitled. See
   *  src/core/scene-name.ts. */
  name: string;
  /** What to call the take in a sentence — a button's label, the storage
   *  notice: its name, else where it was recorded. Never "". */
  label: string;
  /** The host the take started on, port included: `localhost:4000`. */
  origin: string;
  /** The path it started on, `/checkout`; empty for the root. A developer's
   *  takes are mostly on one localhost, and the path is what tells one
   *  flow from another. Query and hash are dropped: they are state, not
   *  place. */
  path: string;
  createdAt: string;
  /** The row's second line beside the origin: when the take was made, to
   *  the minute: "Sep 22, 2:03 PM". Always present: until 2026-09-22 an untitled take's name
   *  WAS its timestamp and this was withheld to avoid saying it twice, but
   *  a take is named after its page now, and several takes of one page
   *  are told apart by this line. */
  when: string;
  /** The same moment as `when`, without its date: "2:03 PM". What a row
   *  says under a heading that already names its day (`namesDay`). */
  time: string;
  hosted: boolean;
  recoverable: boolean;
  frameBytes: number;
  outputBytes: number;
  state: "Complete" | "Motion reclaimed" | "Keyframes only";
  /** True exactly when `state` is "Motion reclaimed". */
  canRestore: boolean;
  /**
   * Made by a script (`capture.mode === "authored"`). Changes what Restore
   * and the reclaimed chip say, not whether they show: Runs cannot re-shoot
   * an authored take (it refuses with `authoredTake`), but it derives the
   * take's script, and running that again makes a new take with its motion.
   * So both name that route instead of a re-shoot (final review M1).
   */
  authored: boolean;
  /**
   * True when the take plays its re-shot frames, so "Back to your
   * recording" has something to go back from. Both halves matter:
   *
   * - `renderMode === "demo"` **explicitly**. Absent means "demo" to
   *   `renderModeOf`, which would offer the way back on every take recorded
   *   before the field existed.
   * - `capture.mode !== "authored"`. An authored take has no recording; the
   *   re-shot frames are all it has, so there is nothing to go back to.
   */
  servesReshoot: boolean;
  /** A drift check raised an alert on this take that nobody has opened
   *  Needs a look for since — `scenesNeedingALook`, the toolbar badge's
   *  own rule. The card flags it; the popup no longer counts it. */
  needsLook: boolean;
  /** What the take's folder holds, from the studio's listing. Absent on the
   *  extension, whose rows state `frameBytes` and `outputBytes` instead, and
   *  for a folder the studio could not measure (its log says why). */
  sizeBytes?: number;
  /** Which version of its video the take is; absent for a take in none. */
  version?: number;
  /** Its recording expired: the frames were removed, the record stays. */
  expired?: boolean;
  /** The files exported from this version, or why they could not be read;
   *  absent for a take in no video. */
  exports?: TakesAnswer["videoOf"][string]["exports"];
}

/** Where a video was recorded, short: a remote's owner and name
 *  (`acme/web`), a local repo's folder, "no repo", or null when not known
 *  (a video migrated from takes made before videos). */
export function repoLabel(repo: VideoSummary["repo"]): string | null {
  if ("unknown" in repo) return null;
  if ("none" in repo) return "no repo";
  if (repo.key.startsWith("local:")) {
    const parts = repo.key
      .slice("local:".length)
      .split("/")
      .filter((p) => p !== "" && p !== ".git");
    return parts.at(-1) ?? repo.key;
  }
  return repo.key.split("/").slice(1).join("/") || repo.key;
}

/** One video and its takes as rows: `versions` newest first, `current` its
 *  newest complete one (null while none completed). */
export interface VideoGroup {
  video: VideoSummary;
  current: LibraryRow | null;
  versions: LibraryRow[];
}

/** The videos `rows` are versions of. A video none of whose takes is listed
 *  has nothing to show and is left out. */
export function videoGroupsOf(
  rows: readonly LibraryRow[],
  videoOf: TakesAnswer["videoOf"],
  videos: readonly VideoSummary[],
): VideoGroup[] {
  return videos.flatMap((video) => {
    const versions = rows
      .filter((r) => videoOf[r.sceneId]?.videoId === video.id)
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    if (versions.length === 0) return [];
    const current =
      versions.find((r) => r.sceneId === video.current?.takeId) ?? null;
    return [{ video, current, versions }];
  });
}

/** What the list shows: one card per video and one per take in no video,
 *  newest first. A video's card is its current version (else its newest)
 *  dated by its newest version — when it was last recorded — so it sits in
 *  that version's day. */
export interface LibraryCard {
  row: LibraryRow;
  group: VideoGroup | null;
}
export function cardsOf(
  model: Pick<LibraryModel, "rows" | "groups">,
): LibraryCard[] {
  const newestOf = new Map<string, VideoGroup>();
  const inGroup = new Set<string>();
  for (const g of model.groups ?? []) {
    newestOf.set((g.versions[0] as LibraryRow).sceneId, g);
    for (const v of g.versions) inGroup.add(v.sceneId);
  }
  return model.rows.flatMap((row): LibraryCard[] => {
    const group = newestOf.get(row.sceneId);
    if (group !== undefined) {
      const lead = group.current ?? row;
      const { createdAt, when, time } = row;
      return [{ row: { ...lead, createdAt, when, time }, group }];
    }
    return inGroup.has(row.sceneId) ? [] : [{ row, group: null }];
  });
}

export interface LibraryModel {
  usedBytes: number;
  budgetBytes: number;
  fraction: number;
  chromeNearLimit: boolean;
  migrating: boolean;
  /** True when the one-time size migration threw outright, as opposed to
   *  still running or having finished cleanly — `migrating: false` alone
   *  cannot tell those two apart. The footprint below may undercount every
   *  row the migration never got to measure. */
  migrationFailed: boolean;
  notice: string | null;
  rows: LibraryRow[];
  /** The sum of the listed takes' sizes and the unreadable folders': what
   *  the folder holds. Absent where the page has no listing of sizes. */
  totalBytes?: number;
  /** How many listed takes and unreadable folders have no size, so
   *  `totalBytes` leaves them out: the total is then a floor, not the sum.
   *  Present beside `totalBytes`. */
  unmeasured?: number;
  /** Folders under `takes/` the studio could not read. Each is a row of its
   *  own, never a missing card. `sizeBytes` is absent when the folder could
   *  not be measured either. */
  unreadable?: {
    folder: string;
    reason: string;
    /** What its Delete removes (`UnreadableTake`); absent is a take folder. */
    kind?: "take" | "video" | "upkeep";
    sizeBytes?: number;
  }[];
  /** Why the page will not hear of new takes by itself, or null while it
   *  will. Absent where there is no watcher. */
  unwatched?: string | null;
  /** The empty library's hint, in the platform's words. */
  emptyHint?: string;
  /** The videos the rows are versions of. Absent where takes are not
   *  grouped. */
  groups?: VideoGroup[];
}

const STATE: Record<DemoFootprint["motion"], LibraryRow["state"]> = {
  complete: "Complete",
  reclaimed: "Motion reclaimed",
  keyframesOnly: "Keyframes only",
};

/**
 * What the budget field will not accept, in the author's words.
 *
 * Here rather than in either view because both pages carry the same
 * control, and `settings/view.ts` already reads this module — the other
 * direction would make the two views import each other.
 */
export const BAD_BUDGET =
  "A budget has to be a number of GB above zero. Nothing was changed.";

export function formatBytes(n: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (n >= GB) return `${(n / GB).toFixed(1).replace(/\.0$/, "")} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * What a `storage:reclaim` run owes the author who pressed the button.
 *
 * Both pages press it, so the three outcomes are worded once here rather
 * than twice in two views. Until 2026-09-14 neither page read the result
 * at all — it merely re-rendered — so a run that freed 1.8 GB and a run
 * that could free nothing were the same silence, which is the failure
 * shape CLAUDE.md opens with: the success path and the do-nothing path
 * reporting identically.
 *
 * `level` rather than a caller-side guess, so the mapping from outcome to
 * how loudly it is painted is testable on its own.
 */
/**
 * Whether a `storage:reclaim` reply's `result` is one this can describe.
 *
 * Beside `reclaimSentence` because both pages need it and only one of
 * them had it: the Recordings page checked `result !== undefined`, so a
 * reply carrying `{}` reached `formatBytes(undefined)` and printed
 * "Freed undefined B." at info — a malformed reply reading as a clean
 * reclaim, which is this codebase's opening rule inverted.
 */
export function isReclaimResult(
  value: unknown,
): value is { freedBytes: number; pressureRemains: boolean } {
  const r = value as { freedBytes?: unknown; pressureRemains?: unknown };
  return (
    typeof r?.freedBytes === "number" &&
    Number.isFinite(r.freedBytes) &&
    typeof r.pressureRemains === "boolean"
  );
}

export function reclaimSentence(result: {
  freedBytes: number;
  pressureRemains: boolean;
}): { text: string; level: "info" | "warn" } {
  if (result.freedBytes <= 0) {
    // Freed nothing because there was nothing to free. `reclaim`'s
    // `done()` is `used <= targetBytes`, so pressing the button while
    // inside the budget returns here with no pressure — the ordinary,
    // healthy press. Warning on it would tell an author with nothing
    // wrong that nothing could be freed, which is this rule inverted.
    if (!result.pressureRemains) {
      return {
        text: "Nothing to free — you are inside the budget.",
        level: "info",
      };
    }
    // Freed nothing while still over: the button's most confusing
    // outcome, and the one worth the most words. It ran, it succeeded,
    // and the meter did not move.
    return {
      text: "Nothing could be freed. Every video left is one Demoman will not delete on its own.",
      level: "warn",
    };
  }
  const freed = `Freed ${formatBytes(result.freedBytes)}`;
  return result.pressureRemains
    ? {
        text: `${freed}, but the library is still over its budget.`,
        level: "warn",
      }
    : { text: `${freed}.`, level: "info" };
}

/** A page's host, or the URL as recorded when it does not parse. Take info's
 *  Site row too (`take-info.ts`). */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A page's path without its trailing slash, "" for the root or a URL that
 *  does not parse. */
export const pathOf = (url: string): string => {
  try {
    const p = new URL(url).pathname;
    return p === "/" ? "" : p.replace(/\/$/, "");
  } catch {
    return "";
  }
};

/**
 * "Oct 19, 2:14 PM", in the reader's locale, with the year when `withYear`:
 * the one way this extension writes a moment. The library leaves the year
 * to its section headings; Take info has none, so it asks for the year on
 * anything outside this one (`shortTime`).
 */
export function whenLabel(at: Date, withYear: boolean): string {
  return at.toLocaleString(undefined, {
    ...(withYear ? { year: "numeric" as const } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * One section of the list: a heading, the rows under it, and whether it
 * starts folded. Keys are stable across renders so the page can carry an
 * open or closed state from one render to the next: `today`, `yesterday`,
 * `day:YYYY-MM-DD` for the rest of the last week, `month:YYYY-MM` for
 * everything older, `undated` for a row whose date will not parse.
 */
export interface LibrarySection {
  key: string;
  label: string;
  /** True for a month before the current one: the page starts it closed,
   *  so a library that has grown shows this week open and the past as a
   *  short list of month lines. */
  folded: boolean;
  /** True when the heading names one day — Today, Yesterday, "Fri, Oct 2" —
   *  so its rows show only their time. A month or Undated does not. */
  namesDay: boolean;
  rows: LibraryRow[];
}

const DAY_MS = 86_400_000;
const pad = (n: number): string => String(n).padStart(2, "0");
const startOfDay = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Groups rows into sections by when they were made, in the order the rows
 * arrive (the model sorts them newest first, so sections come out newest
 * first too). Calendar days and months in local time — the author's own
 * zone — measured from `now`, which is injected so the boundaries can be
 * tested at midnight and at the week's edge.
 *
 * Today, Yesterday, then the date for the five days before that — "Fri,
 * Oct 2", the weekday with its date, since a bare "Friday" left the author
 * counting back from today (until 2026-10-06) — then a month. Seven days
 * ago shares today's weekday, so it is the first day that goes to its
 * month; the week stays the window a day heading covers.
 * `Math.round` on the day difference absorbs the 23- or 25-hour day a DST
 * change makes.
 */
export function sectionsOf(
  rows: readonly LibraryRow[],
  now: Date,
): LibrarySection[] {
  const today = startOfDay(now);
  const thisMonth = now.getFullYear() * 12 + now.getMonth();
  const sections = new Map<string, LibrarySection>();
  for (const r of rows) {
    const made = new Date(r.createdAt);
    let key: string;
    let label: string;
    let folded = false;
    let namesDay = true;
    if (Number.isNaN(made.getTime())) {
      namesDay = false;
      key = "undated";
      label = "Undated";
    } else {
      const daysAgo = Math.round((today - startOfDay(made)) / DAY_MS);
      if (daysAgo <= 0) {
        key = "today";
        label = "Today";
      } else if (daysAgo === 1) {
        key = "yesterday";
        label = "Yesterday";
      } else if (daysAgo < 7) {
        key = `day:${made.getFullYear()}-${pad(made.getMonth() + 1)}-${pad(made.getDate())}`;
        label = made.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
      } else {
        key = `month:${made.getFullYear()}-${pad(made.getMonth() + 1)}`;
        label = made.toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        });
        folded = made.getFullYear() * 12 + made.getMonth() < thisMonth;
        namesDay = false;
      }
    }
    const section = sections.get(key);
    if (section === undefined) {
      sections.set(key, { key, label, folded, namesDay, rows: [r] });
    } else {
      section.rows.push(r);
    }
  }
  return [...sections.values()];
}

/**
 * A reclaim's outcome as the background actually reports it (Task 10's
 * amendment): `failed: true` means the reclaim itself threw — it never ran
 * to completion, and nobody knows what it would have freed. `failed: false`
 * with `pressureRemains: true` means the reclaim ran fine and legitimately
 * found nothing left to free. Byte-for-byte, `freedBytes` and
 * `pressureRemains` can be identical in both cases (0 and true, the common
 * shape on a small library) — `failed` is the only field that tells them
 * apart, so it must change the sentence, not just the data this type
 * carries.
 */
export interface StorageNotice {
  reason: "budget" | "quota";
  freedBytes: number;
  pressureRemains: boolean;
  failed: boolean;
}

function noticeText(notice: StorageNotice, holders: string): string {
  if (notice.failed) {
    return notice.reason === "quota"
      ? `Chrome is near its storage limit on this drive and the automatic cleanup could not run. Open the extension's error log if this keeps happening. Holding the most: ${holders}.`
      : `Storage is over budget and the automatic cleanup could not run. Open the extension's error log if this keeps happening. Holding the most: ${holders}.`;
  }
  return notice.reason === "quota"
    ? `Chrome is near its storage limit on this drive. Holding the most: ${holders}.`
    : `Storage is over budget and nothing more can be reclaimed automatically. Holding the most: ${holders}.`;
}

export function buildLibraryModel(args: {
  /** Absent on a platform with no storage to manage: every take then reads
   *  as complete, and the footprint is zero, which the page does not draw. */
  summary?: StorageSummary;
  scenes: SceneDocument[];
  migrating: boolean;
  migrationFailed: boolean;
  notice: StorageNotice | null;
  /** The scene ids a drift check flagged. Required rather than defaulted
   *  to empty: a page that could not read them says so itself, and a
   *  default here would draw "nothing to look at" over a read that failed. */
  needsLook: ReadonlySet<string>;
  /** The studio's byte count per folder, by scene id. */
  sizes?: Record<string, number>;
  unreadable?: {
    folder: string;
    reason: string;
    kind?: "take" | "video" | "upkeep";
  }[];
  unwatched?: string | null;
  emptyHint?: string;
  videos?: VideoSummary[];
  videoOf?: TakesAnswer["videoOf"];
}): LibraryModel {
  const videoOf = args.videoOf ?? {};
  const byId = new Map((args.summary?.demos ?? []).map((d) => [d.sceneId, d]));
  const rows: LibraryRow[] = [...args.scenes]
    .sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt))
    .map((scene) => {
      const d = byId.get(scene.meta.id);
      const motion =
        d?.motion ??
        (args.summary === undefined ? "complete" : "keyframesOnly");
      const made = new Date(scene.meta.createdAt);
      return {
        sceneId: scene.meta.id,
        name: scene.meta.name,
        label: sceneLabel(scene.meta),
        origin: hostOf(scene.meta.capture.originUrl),
        path: pathOf(scene.meta.capture.originUrl),
        createdAt: scene.meta.createdAt,
        // No year: the section heading above the row carries it for any
        // take old enough to need one (see `sectionsOf`).
        when: whenLabel(made, false),
        time: made.toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        }),
        hosted: d?.hosted ?? false,
        recoverable: d?.recoverable ?? false,
        frameBytes: d?.frameBytes ?? 0,
        outputBytes: d?.outputBytes ?? 0,
        state: STATE[motion],
        canRestore: motion === "reclaimed",
        authored: scene.meta.capture.mode === "authored",
        servesReshoot:
          scene.meta.renderMode === "demo" &&
          scene.meta.capture.mode !== "authored",
        needsLook: args.needsLook.has(scene.meta.id),
        // A size the listing left out is unknown, never 0 B.
        ...(args.sizes?.[scene.meta.id] === undefined
          ? {}
          : { sizeBytes: args.sizes[scene.meta.id] }),
        ...(videoOf[scene.meta.id] === undefined
          ? {}
          : {
              version: videoOf[scene.meta.id]?.version,
              expired: videoOf[scene.meta.id]?.expired,
              exports: videoOf[scene.meta.id]?.exports,
            }),
      };
    });
  const { usedBytes, budgetBytes } = args.summary ?? {
    usedBytes: 0,
    budgetBytes: 0,
  };
  let notice: string | null = null;
  if (args.notice?.pressureRemains) {
    const holders = rows
      .slice()
      .sort(
        (a, b) => b.frameBytes + b.outputBytes - (a.frameBytes + a.outputBytes),
      )
      .slice(0, 3)
      .map((r) => `${r.label} (${formatBytes(r.frameBytes + r.outputBytes)})`)
      .join(", ");
    notice = noticeText(args.notice, holders);
  }
  const sizes = args.sizes;
  const listedIds = new Set(rows.map((r) => r.sceneId));
  // A take listed as a card too (one that could not join a video) has its
  // size on the card: the row repeating it would count it twice.
  const unreadable: LibraryModel["unreadable"] = args.unreadable?.map((u) =>
    sizes?.[u.folder] === undefined || listedIds.has(u.folder)
      ? { ...u }
      : { ...u, sizeBytes: sizes[u.folder] },
  );
  const listed: { sizeBytes?: number }[] = [...rows, ...(unreadable ?? [])];
  return {
    usedBytes,
    budgetBytes,
    fraction: budgetBytes > 0 ? Math.min(1, usedBytes / budgetBytes) : 1,
    chromeNearLimit: args.notice?.reason === "quota",
    migrating: args.migrating,
    migrationFailed: args.migrationFailed,
    notice,
    rows,
    ...(sizes === undefined
      ? {}
      : {
          totalBytes: listed.reduce((n, r) => n + (r.sizeBytes ?? 0), 0),
          unmeasured: listed.filter((r) => r.sizeBytes === undefined).length,
        }),
    ...(unreadable === undefined ? {} : { unreadable }),
    ...(args.unwatched === undefined ? {} : { unwatched: args.unwatched }),
    ...(args.emptyHint === undefined ? {} : { emptyHint: args.emptyHint }),
    ...(args.videos === undefined
      ? {}
      : { groups: videoGroupsOf(rows, videoOf, args.videos) }),
  };
}

/** One flow a bulk delete tried: gone (with the studio's note on what it
 *  cleared or left), or stayed, and why. */
export type BulkOutcome = { id: string; name: string; note?: string } & (
  | { gone: true }
  | { stayed: string }
);

/**
 * What a bulk delete says (spec 2026-10-30 flows-and-bulk-delete §1.2):
 * every flow that stayed is named with its reason, so a run that freed
 * nothing never reads like one that freed everything.
 */
export function bulkSentence(outcomes: readonly BulkOutcome[]): {
  text: string;
  level: "info" | "warn";
} {
  const flows = (n: number) => `${n} ${n === 1 ? "flow" : "flows"}`;
  const gone = outcomes.filter((o) => "gone" in o);
  const stayed = outcomes.flatMap((o) =>
    "stayed" in o ? [`${o.name} stayed: ${o.stayed.replace(/\.$/, "")}.`] : [],
  );
  // What a delete cleared or left behind is said whether or not another
  // flow stayed: bytes left to delete by hand are owed either way.
  const notes = outcomes.flatMap((o) => (o.note === undefined ? [] : [o.note]));
  if (stayed.length === 0) {
    return {
      text: [`Deleted ${flows(gone.length)}.`, ...notes].join(" "),
      level: "info",
    };
  }
  const lead =
    gone.length === 0
      ? "No flows were deleted."
      : `Deleted ${gone.length} of ${flows(outcomes.length)}.`;
  return { text: [lead, ...stayed, ...notes].join(" "), level: "warn" };
}
