import { hexToOklch, oklchToHex } from "./color.js";
import {
  CURRENT_SCHEMA_VERSION,
  CURSOR_DEFAULTS,
  NEUTRAL_BACKGROUND,
  type SceneDocument,
  SceneDocumentSchema,
} from "./document.js";

export class SchemaVersionError extends Error {
  /** True when the document is from a newer schema than this build reads —
   *  the one case where updating Demoman is the fix. */
  readonly tooNew: boolean;
  constructor(message: string, tooNew = false) {
    super(message);
    this.tooNew = tooNew;
  }
}

type MigrationStep = (
  doc: Record<string, unknown>,
  notes: string[],
) => Record<string, unknown>;

type Anchorish = { resolution?: Record<string, unknown> };

// v1 → v2 (SP3): resolution gains a failure reason and a candidate count.
// v1 documents only ever recorded successful, unambiguous resolutions, so the
// honest backfill is "no failure, exactly one candidate". A malformed
// `anchors` (missing, wrong type, or containing a non-object element) is left
// untouched rather than coerced into something schema-shaped — the final
// SceneDocumentSchema.parse below is what reports that malformation, same as
// migrateToCurrent already relies on it for every other structural defect.
// steps[n] migrates a version-n document to version n+1. The machinery exists
// from day one so a format change is a numbered migration, not a breaking rewrite.
const steps: Record<number, MigrationStep> = {
  1: (doc) => {
    if (Array.isArray(doc.anchors)) {
      for (const anchor of doc.anchors) {
        if (anchor === null || typeof anchor !== "object") continue;
        const resolution = (anchor as Anchorish).resolution;
        if (resolution) {
          resolution.failureReason = null;
          resolution.candidates = 1;
        }
      }
    }
    return { ...doc, schemaVersion: 2 };
  },

  // v2 → v3 (SP4): side-channels gain identity and time, waits gain the right
  // to have no anchor, and the document records which build-SHA extractor
  // answered plus which capture build classified the network log.
  2: (doc) => {
    const side = doc.sideChannels;
    if (side !== null && typeof side === "object") {
      const s = side as Record<string, unknown>;
      if (Array.isArray(s.network)) {
        s.network = s.network.map((entry, i) =>
          entry !== null && typeof entry === "object"
            ? {
                ...(entry as object),
                id: `net-${i + 1}`,
                timestamp: 0,
                reclassified: false,
              }
            : entry,
        );
      }
      if (Array.isArray(s.consoleExcerpt)) {
        s.consoleExcerpt = s.consoleExcerpt.map((line) =>
          typeof line === "string"
            ? { level: "log", text: line, timestamp: 0 }
            : line,
        );
      }
      if (Array.isArray(s.urlTrace)) {
        s.urlTrace = s.urlTrace.map((url) =>
          typeof url === "string" ? { url, timestamp: 0 } : url,
        );
      }
    }
    const meta = doc.meta;
    if (meta !== null && typeof meta === "object") {
      const m = meta as Record<string, unknown>;
      const capture = m.capture;
      if (capture !== null && typeof capture === "object") {
        (capture as Record<string, unknown>).buildShaSource = null;
      }
      const toolchain = m.toolchain;
      if (toolchain !== null && typeof toolchain === "object") {
        (toolchain as Record<string, unknown>).captureVersion = null;
      }
    }
    // anchorId and condition widen rather than change: no data to touch.
    return { ...doc, schemaVersion: 3 };
  },

  // v3 → v4 (SP5): the coverage check's uncovered origins become part of the
  // document. A v3 document was written by a build that could not record
  // them, so the backfill is "nothing proven", not "nothing found". The same
  // step also backfills authored holds (SP5 Task 2b): a v3 document was
  // written by a build that had no way to author a hold, so `[]` is the truth.
  3: (doc) => {
    const side = doc.sideChannels;
    if (side !== null && typeof side === "object") {
      (side as Record<string, unknown>).uncoveredOrigins ??= [];
    }
    const edits = doc.edits;
    if (edits !== null && typeof edits === "object") {
      (edits as Record<string, unknown>).holds ??= [];
    }
    return { ...doc, schemaVersion: 4 };
  },
  // v4 -> v5 (2026-09-19): the document gains a cursor look. A v4 document
  // was written by a build with no cursor controls at all, so there is no
  // authored value to preserve and the honest backfill is the product
  // default — including `motionBlur: 1`, which does change how an existing
  // take renders. See CURSOR_DEFAULTS for why that is the chosen direction.
  // Copied rather than shared: CURSOR_DEFAULTS is frozen, and a migrated
  // document's own block has to stay writable.
  4: (doc) => ({
    ...doc,
    cursor: { ...CURSOR_DEFAULTS },
    schemaVersion: 5,
  }),
  // v5 -> v6 (2026-09-22): branding becomes an explicit background and a
  // placed logo. v5 never painted `primaryColor`: it painted a pale gradient
  // derived from it (lightness pinned 0.94 -> 0.82, chroma capped). The
  // honest backfill is that gradient, converted to hex, so a migrated demo
  // keeps its look. 150 degrees is the nearest ten to the old vector
  // (0,0) -> (0.35w, h), 148.1 degrees on 16:9; that vector was aspect-
  // dependent and an angle is not, so vertical and GIF move slightly. A
  // colour v5 accepted but could not read (any non-hex string) painted the
  // neutral, and migrates to it — the same picture, not a refused take.
  // The stops convert in "clip" mode: v5's lighter stop is outside sRGB for
  // a saturated brand, and Chrome's canvas clipped it channel by channel.
  //
  // The logo keeps its size in landscape and GIF, not in vertical. v5 drew
  // it at 3% of the frame's HEIGHT in every format; v6's size is a fraction
  // of the SHORT side, and 0.03 of it is the same pixels wherever height is
  // the short side. In vertical v5's mark was 57.6px tall and sat over the
  // bottom of the recording, which v6 never does (spec §2); v6 draws 0.03
  // there at 32.4px, clear of it. v6 holds one size for every format, so no
  // size chosen here restores vertical's without growing landscape's.
  5: (doc) => {
    const old = (doc.branding ?? {}) as {
      logoRef?: unknown;
      primaryColor?: unknown;
    };
    const base =
      typeof old.primaryColor === "string"
        ? hexToOklch(old.primaryColor)
        : null;
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    const clamp = (v: number, hi: number): number =>
      Math.min(hi, Math.max(0, v));
    const background = base
      ? {
          kind: "gradient",
          from: oklchToHex(
            {
              l: 0.94,
              c: round(clamp(base.c * 0.35, 0.06)),
              h: round(base.h),
            },
            "clip",
          ).hex,
          to: oklchToHex(
            {
              l: 0.82,
              c: round(clamp(base.c * 0.55, 0.1)),
              h: round(base.h),
            },
            "clip",
          ).hex,
          angle: 150,
        }
      : { ...NEUTRAL_BACKGROUND };
    const logo =
      typeof old.logoRef === "string" && old.logoRef.length > 0
        ? { ref: old.logoRef, corner: "bottom-right", size: 0.03, opacity: 0.9 }
        : null;
    return { ...doc, branding: { background, logo }, schemaVersion: 6 };
  },
  // v6 -> v7 (2026-09-23): the frame's shape becomes part of the document,
  // and edits gain cuts. A v6 document was written by a build whose aspect
  // was page-local state that was never saved, so there is no authored value
  // to carry: 16:9 is what every v6 document rendered unless the author
  // flipped the stage select for one export. No build could author a cut.
  6: (doc) => {
    const edits = doc.edits;
    if (edits !== null && typeof edits === "object") {
      (edits as Record<string, unknown>).cuts ??= [];
    }
    // The literal, not CANVAS_DEFAULTS: a v6 document drew 16:9, and the
    // default a new take starts on has since moved (auto, 2026-10-06).
    return { ...doc, canvas: { aspect: "16:9" }, schemaVersion: 7 };
  },
  // v7 -> v8 (2026-10-05): the margin around the recording becomes the
  // author's. A v7 document drew whatever its export preset carried (15%
  // landscape, 8% vertical, 4% GIF, 5% stills), so there is no one value to
  // carry; it gets the new default, and changes look on its next export on
  // purpose (spec 2026-10-05 §1). A malformed `branding` is left for the
  // final parse to report.
  7: (doc) => {
    const branding = doc.branding;
    if (branding === null || typeof branding !== "object") {
      return { ...doc, schemaVersion: 8 };
    }
    return {
      ...doc,
      branding: { padding: 0.08, ...(branding as object) },
      schemaVersion: 8,
    };
  },
  // v8 -> v9 (2026-10-06): `canvas.aspect` may be "auto". Nothing in a v8
  // document changes: it keeps the shape it was exported in, and only new
  // takes start on auto (spec 2026-10-06 §1).
  8: (doc) => ({ ...doc, schemaVersion: 9 }),
  // v9 -> v10 (2026-10-10): `meta.capture.device` may say the take was
  // filmed as a phone. Nothing in a v9 document changes. The bump exists so
  // a build from before refuses a v10 phone take rather than rebuilding it
  // on the desktop (spec 2026-10-10 §4).
  9: (doc) => ({ ...doc, schemaVersion: 10 }),
  // v11 adds the `drag` action kind; no v10 document has one.
  10: (doc) => ({ ...doc, schemaVersion: 11 }),
  // v11 -> v12 (2026-10-22, spec split-tool): step cuts become removed
  // pieces, and text overlays leave the editor. See `cutsToRemoved`.
  11: (doc, notes) => {
    const edits = doc.edits;
    if (edits === null || typeof edits !== "object") {
      return { ...doc, schemaVersion: 12 };
    }
    const e = edits as Record<string, unknown>;
    const replacements = Array.isArray(e.replacements) ? e.replacements : [];
    // A replacement on a blocked (redacted) field's anchor was the value a
    // rebuild typed there, not an overlay: said apart, with what losing it
    // costs (review 2026-10-22).
    const blocked = new Set(
      (Array.isArray(doc.actions) ? doc.actions : []).flatMap((a) =>
        a !== null &&
        typeof a === "object" &&
        (a as Record<string, unknown>).kind === "type" &&
        (a as Record<string, unknown>).redacted === true
          ? [(a as Record<string, unknown>).anchorId]
          : [],
      ),
    );
    const values = replacements.filter(
      (r) =>
        r !== null &&
        typeof r === "object" &&
        blocked.has((r as Record<string, unknown>).targetAnchorId),
    ).length;
    const overlays = replacements.length - values;
    if (overlays > 0) {
      notes.push(
        `${overlays} text ${overlays === 1 ? "overlay was" : "overlays were"} removed from this take: the video shows the text that was recorded.`,
      );
    }
    if (values > 0) {
      notes.push(
        `${values} typed ${values === 1 ? "value for a blocked field was" : "values for blocked fields were"} removed from this take: rebuilding the take stops at ${values === 1 ? "that step. Put the value" : "those steps. Put the values"} in the script and record it again.`,
      );
    }
    const { replacements: _r, cuts, ...rest } = e;
    return {
      ...doc,
      edits: { ...rest, removed: cutsToRemoved(doc.actions, cuts) },
      schemaVersion: 12,
    };
  },
  // v12 -> v13 (audit run 1): a mask's ends move to the frames' own time,
  // as removed pieces are, so a later cut cannot slide or drop a redaction.
  // The output offset is taken as the source one: exact for a mask with no
  // cut, gap or hold between its step and its edge.
  12: (doc) => {
    const edits = doc.edits;
    if (edits === null || typeof edits !== "object") {
      return { ...doc, schemaVersion: 13 };
    }
    const e = edits as Record<string, unknown>;
    const toSource = (m: unknown): unknown => {
      if (m === null || typeof m !== "object") return m;
      const { offsetMs, ...rest } = m as Record<string, unknown>;
      return offsetMs === undefined ? m : { ...rest, sourceOffsetMs: offsetMs };
    };
    const masks = Array.isArray(e.masks)
      ? e.masks.map((m) => {
          if (m === null || typeof m !== "object") return m;
          const mask = m as Record<string, unknown>;
          return {
            ...mask,
            ...(mask.start === undefined
              ? {}
              : { start: toSource(mask.start) }),
            ...(mask.end === undefined ? {} : { end: toSource(mask.end) }),
          };
        })
      : e.masks;
    return { ...doc, edits: { ...e, masks }, schemaVersion: 13 };
  },
};

/**
 * Each run of adjacent cut steps as one removed piece: from the first cut
 * step's frame to the next kept step's frame, or to the take's end. Exactly
 * the stretch the compositor's step cuts removed, so a migrated take plays
 * the same frames. Malformed input converts to nothing; the final parse
 * reports what is wrong with it.
 */
function cutsToRemoved(actions: unknown, cuts: unknown): unknown[] {
  if (!Array.isArray(actions) || !Array.isArray(cuts)) return [];
  const cut = new Set(
    cuts.flatMap((c) =>
      c !== null && typeof c === "object" && "actionId" in c
        ? [(c as { actionId: unknown }).actionId]
        : [],
    ),
  );
  const ids = actions.map((a) => (a as { id?: unknown } | null)?.id);
  const removed: unknown[] = [];
  let i = 0;
  while (i < ids.length) {
    if (!cut.has(ids[i])) {
      i += 1;
      continue;
    }
    const start = ids[i];
    let j = i;
    while (j < ids.length && cut.has(ids[j])) j += 1;
    const end = ids[j];
    removed.push({
      id: `removed-${String(start)}`,
      start: { actionId: start, sourceOffsetMs: 0 },
      end: end === undefined ? null : { actionId: end, sourceOffsetMs: 0 },
    });
    i = j;
  }
  return removed;
}

/**
 * Legacy authored holds become pacing gaps (spec §1, 2026-09-08).
 *
 * A hold at `marker.offsetMs === 0` after action `a[i]` ADDED its duration to
 * whatever the take already had between `a[i]` and `a[i+1]`. A gap REPLACES
 * that interval outright. So the faithful conversion carries both:
 *
 *     durationMs = (a[i+1].timestamp − a[i].timestamp) + hold.durationMs
 *
 * Dropping the recorded half would speed the demo up at exactly the beat the
 * author asked to slow down. The hold's own `id` becomes the gap's, so undo
 * history and any UI keyed on it survive the conversion.
 *
 * Four holds are carried through UNCHANGED rather than converted, because
 * converting them would lose a pause the author authored — the defect class
 * CLAUDE.md opens with. `edits.holds` stays in the schema and `planScene`
 * still maps it to `plan.holds`, so a carried-through hold keeps rendering:
 *
 * - a non-zero `marker.offsetMs`: it pauses mid-clip, which no gap expresses;
 * - a hold on the LAST action: `planScene` pairs each action with the next
 *   one, so it emits no pace for a terminal action and the gap would never be
 *   read;
 * - a hold whose action already carries a gap: the gap is the newer authored
 *   value, and the schema permits only one per action;
 * - a second offset-0 hold on the same action: the schema forbids duplicate
 *   gap targets, so the first one converts and the rest stay holds;
 * - a hold whose id is already a gap id: `SceneDocumentSchema` refuses
 *   duplicate gap ids, and this function runs AFTER `migrateToCurrent`'s
 *   parse and never re-parses, so converting one would hand every reader a
 *   document that fails its NEXT parse with nothing here having said so.
 *
 * `edits.holds` and `edits.gaps` are read with `?? []` even though both are
 * required on `SceneDocument`. Every document reaching this through
 * `migrateToCurrent` has been parsed and so has both — but the frame store
 * casts raw IndexedDB rows without parsing, and Zod's `.default([])` never
 * runs on that path, so a caller arriving with such a row must get an answer
 * rather than a TypeError.
 */
export function migrateHoldsToGaps(doc: SceneDocument): SceneDocument {
  const holds = doc.edits.holds ?? [];
  const actions = doc.actions ?? [];
  const gaps = [...(doc.edits.gaps ?? [])];
  const claimed = new Set(gaps.map((g) => g.afterActionId));
  const claimedIds = new Set(gaps.map((g) => g.id));
  const kept: typeof holds = [];

  for (const hold of holds) {
    const actionId = hold.marker.actionId;
    const index = actions.findIndex((a) => a.id === actionId);
    const action = index === -1 ? undefined : actions[index];
    // `undefined` for both an unknown action and the terminal one. Neither
    // can carry a gap, and both keep their hold.
    const next = index === -1 ? undefined : actions[index + 1];
    if (
      hold.marker.offsetMs !== 0 ||
      action === undefined ||
      next === undefined ||
      claimed.has(actionId) ||
      claimedIds.has(hold.id)
    ) {
      kept.push(hold);
      continue;
    }
    // Floored at zero the same way `planScene` floors its own recorded
    // target, so an out-of-order pair cannot author a negative gap the
    // schema would then refuse to parse.
    //
    // An APPROXIMATION, stated rather than hidden: this is the whole
    // interval between the two actions, while a capture bundle applies an
    // authored gap to the IDLE portion of that interval alone
    // (`idleOutputFor`). A legacy hold that spanned motion therefore
    // converts to a slightly longer pause than it played as. The migration
    // runs in scene-schema with no bundle in reach and cannot know the
    // idle/motion split. On a stretch of pure dead air — which is precisely
    // when an author reached for a hold — the recorded interval IS the idle
    // and the conversion is exact.
    const recordedMs = Math.max(0, next.timestamp - action.timestamp);
    gaps.push({
      id: hold.id,
      afterActionId: actionId,
      durationMs: recordedMs + hold.durationMs,
    });
    claimed.add(actionId);
  }

  return { ...doc, edits: { ...doc.edits, holds: kept, gaps } };
}

/**
 * `notes` collects a sentence for each thing a step took away that the
 * author made (spec split-tool: text overlays); the caller shows them.
 */
export function migrateToCurrent(
  raw: unknown,
  notes: string[] = [],
): SceneDocument {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { schemaVersion?: unknown }).schemaVersion !== "number"
  ) {
    throw new SchemaVersionError("document has no numeric schemaVersion");
  }
  let doc = raw as Record<string, unknown>;
  let version = doc.schemaVersion as number;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `document schemaVersion ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
      true,
    );
  }
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = steps[version];
    if (!step)
      throw new SchemaVersionError(
        `no migration path from schemaVersion ${version}`,
      );
    doc = step(doc, notes);
    version = doc.schemaVersion as number;
  }
  // The one seam every reader shares, so the hold conversion runs here and
  // nowhere else. After the parse, so it works on a typed document.
  return migrateHoldsToGaps(SceneDocumentSchema.parse(doc));
}
