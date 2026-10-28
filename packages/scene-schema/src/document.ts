import { z } from "zod";
import { oklchToHex } from "./color.js";
import { CaptureDeviceSchema } from "./device.js";
import { DEFAULT_WALLPAPER_ID } from "./wallpapers.js";

export const CURRENT_SCHEMA_VERSION = 13;

const Rect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

// v8 §4: the fingerprint bundle. Every field nullable — resolution walks them
// in priority order — but a fingerprint with nothing usable is invalid.
const Fingerprint = z.object({
  stableId: z.string().min(1).nullable(),
  role: z.string().min(1).nullable(),
  accessibleName: z.string().nullable(),
  textContent: z.string().nullable(),
  treePath: z.string().min(1).nullable(),
  boundingRect: Rect.nullable(),
  imagePatchRef: z.string().min(1).nullable(),
  dataKey: z.string().min(1).nullable(),
});

export const ResolutionStrategy = z.enum([
  "stableId",
  "roleName",
  "text",
  "treePath",
  "imagePatch",
  "ambiguous",
  "broken",
]);

// Why a resolution ended where it did. Load-bearing for SP8: `notInTree` is a
// virtualized row the app can still be asked to scroll into view, not breakage.
export const FailureReason = z.enum([
  "notInTree",
  "closedShadowRoot",
  "frameGone",
  "frameUnreachable",
  "patchUnavailable",
  "ambiguousTie",
]);

export type StrategyName = z.infer<typeof ResolutionStrategy>;
export type FailureReasonName = z.infer<typeof FailureReason>;

// v8 §4: anchors record the state they were resolved in; entryState gates
// passive (badge) checkability.
const Resolution = z.object({
  url: z.string(),
  actionIndex: z.number().int().nonnegative(),
  entryState: z.boolean(),
  strategy: ResolutionStrategy,
  failureReason: FailureReason.nullable(),
  candidates: z.number().int().nonnegative(),
});

const Anchor = z
  .object({
    id: z.string().min(1),
    fingerprint: Fingerprint,
    resolution: Resolution,
  })
  .superRefine((anchor, ctx) => {
    const f = anchor.fingerprint;
    const usable =
      f.stableId !== null ||
      (f.role !== null && f.accessibleName !== null) ||
      f.textContent !== null ||
      f.treePath !== null ||
      f.imagePatchRef !== null ||
      f.dataKey !== null;
    if (!usable) {
      ctx.addIssue({
        code: "custom",
        message: "fingerprint must contain at least one usable strategy",
        path: ["fingerprint"],
      });
    }
  });

const actionBase = {
  id: z.string().min(1),
  anchorId: z.string().min(1),
  timestamp: z.number().nonnegative(),
  marker: z.string().min(1),
  /**
   * Where the element was at THIS action.
   *
   * The anchor's `fingerprint.boundingRect` is the first sighting's rect and
   * has to stay that way — `intern` reuses one anchor for every action on an
   * element, and `actionIndex` and `entryState` describe that first sighting.
   * The rect is not an identity fact, though: an element that scrolls or
   * reflows is in a different place at the second action, and a camera move
   * aimed at the first one aims at nothing.
   *
   * Optional for the usual reason — documents written before it still
   * validate. Absent means the sighting had no rect, and consumers fall back
   * to the fingerprint.
   */
  rect: Rect.optional(),
};

const MoveTo = z.object({
  ...actionBase,
  kind: z.literal("moveTo"),
  /**
   * How capture caught this hover. Optional, so documents written before it
   * existed still validate and no migration is owed — the same treatment
   * `Click.button` gets.
   *
   * The develop-time pixel check reads it and probes only `"style"`: a
   * `"mutation"` hover was witnessed by the DOM, and pixels do not overrule
   * that.
   */
  signal: z.enum(["mutation", "style"]).optional(),
});
/**
 * The most text lines a click may carry. The schema's cap on `Click.textLines`,
 * kept for the documents written while something produced them (it was every
 * producer's own limit then), and so that a hand-edited one still cannot be
 * unbounded.
 */
export const TEXT_LINES_MAX = 200;

const Click = z.object({
  ...actionBase,
  kind: z.literal("click"),
  button: z.enum(["left", "middle", "right"]).optional(),
  /**
   * The lines of text on screen when the click was measured, in the space
   * `rect` is in and from the same moment. **No longer written, and read by
   * nothing.** From 2026-10-09 to 2026-10-10 the sensor measured them at a
   * recorded click and the walk at an agent's, and a generated zoom was
   * narrowed until its edges cut none of them (`zoomsForClicks`, "O2"). On a
   * text-dense page that left no zoom at all, and the author went back to
   * fitting the zoom to its target; the measurement went with it, since a
   * report that a click's text "was not measured" would have warned about a
   * zoom that no longer looks at text.
   *
   * Still accepted, unchanged, with no version bump: documents saved in
   * those two days, and scripts that copied a click from one, must still
   * validate. The measurement is in history at 1b372ebf
   * (`replay-engine/src/text-lines.ts`) if a later framing wants it back.
   */
  textLines: z.array(Rect).max(TEXT_LINES_MAX).optional(),
});
const TypeAction = z
  .object({
    ...actionBase,
    kind: z.literal("type"),
    text: z.string().nullable(),
    /**
     * No text, and a replacement owed before replay can pass this action.
     * For an input or textarea it means a credential field, whose value the
     * sensor never read. With `host` set it means the sensor could not
     * follow what was typed — see there.
     */
    redacted: z.boolean(),
    /**
     * The field is a contenteditable host — a rich-text editor, whose
     * contents are a document rather than a value. Two consequences, both
     * read downstream:
     *
     * - `text` is what the author typed into it, accumulated keystroke by
     *   keystroke, never the host's document. Replay inserts it at the caret
     *   the click left, and does NOT select the host's contents first the
     *   way it does for an input, which would type over every paragraph the
     *   author never touched.
     * - When an edit the sensor does not follow landed mid-field (a
     *   deletion, a paste, a formatting or history command) the text is
     *   unknown: `redacted` is true and `text` null, so the editor asks for
     *   a demo value exactly as it does for a credential field.
     *
     * Optional so documents written before it existed still validate, the
     * same treatment `Click.button` and `MoveTo.signal` get. Absent means an
     * input or a textarea.
     */
    host: z.literal(true).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.redacted && a.text !== null) {
      ctx.addIssue({
        code: "custom",
        message: "redacted type action must not carry text",
        path: ["text"],
      });
    }
    if (!a.redacted && a.text === null) {
      ctx.addIssue({
        code: "custom",
        message: "non-redacted type action requires text",
        path: ["text"],
      });
    }
  });
const ScrollTo = z.object({ ...actionBase, kind: z.literal("scrollTo") });
const WaitFor = z.object({
  ...actionBase,
  // A navigation wait has no element to name. Every other verb does, which is
  // why this override lives here and not on actionBase.
  anchorId: z.string().min(1).nullable(),
  kind: z.literal("waitFor"),
  condition: z.enum(["visible", "hidden", "loaded"]).optional(),
});

const Spot = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
/**
 * A press, a move with the button held, a release (v11, 2026-10-21).
 * `anchorId` and `rect` are where it pressed. The end is beside them, and so
 * is what the script asked for — the spots, and whether the end was an
 * offset — so a rebuild reproduces the same points from fresh boxes, where
 * two rects alone would replay two spots on one canvas as a drag from its
 * centre to its centre.
 */
const Drag = z.object({
  ...actionBase,
  kind: z.literal("drag"),
  /** Null when the end was an offset, which names no element. */
  toAnchorId: z.string().min(1).nullable(),
  toRect: Rect.optional(),
  fromAt: Spot.optional(),
  /** Where it pressed when the walk chose the spot itself — a native
   *  range's thumb, where a press at the centre would jump its value — as a
   *  spot in `rect`. Absent: `fromAt`, else the centre. Never written back
   *  into a script: a re-run reads the thumb afresh. */
  pressedAt: Spot.optional(),
  to: z.union([
    z.object({ at: Spot.optional() }).strict(),
    z.object({ by: z.object({ x: z.number(), y: z.number() }) }).strict(),
  ]),
});

const Action = z.discriminatedUnion("kind", [
  MoveTo,
  Click,
  TypeAction,
  ScrollTo,
  WaitFor,
  Drag,
]);

/**
 * "This step, this far from it." Output milliseconds, relative to the
 * step's instant on the UNTRIMMED output axis — the meaning
 * `CameraEvent.marker.offsetMs` has always had (the -350ms lead-in). Every
 * time-addressed edit (a trim end, a zoom's end, a mask's range) is one of
 * these, which is what keeps v8 §6 true of a timeline whose gestures can
 * land anywhere: the surface is free, the storage is step-relative.
 */
export const MarkerSchema = z.object({
  actionId: z.string().min(1),
  offsetMs: z.number(),
});
export type SceneMarker = z.infer<typeof MarkerSchema>;

/**
 * "This step's frame, this far from it" in SOURCE milliseconds: the
 * recorded time of the step's frame marker plus `sourceOffsetMs`. What a
 * split and a removed piece are stored in. Not a `SceneMarker`: a removal
 * changes the output axis that marker is measured on, so it is addressed in
 * the frames' own time, and the field name says which axis it is.
 */
export const SourcePointSchema = z.object({
  actionId: z.string().min(1),
  sourceOffsetMs: z.number(),
});
export type SourcePoint = z.infer<typeof SourcePointSchema>;

const Point = z.object({ x: z.number(), y: z.number() });

// v8 §6: camera events attach to anchors and to action markers, never to
// absolute timeline positions. Since 2026-09-13 a zoom may aim at a POINT
// instead of an anchor — the recorded cursor position where the author
// clicked the Zoom lane — and may carry an authored END; both are markers or
// capture-space CSS px, so nothing here is an absolute instant.
const CameraEvent = z.object({
  id: z.string().min(1),
  kind: z.enum(["zoom", "pan"]),
  /** Exactly one of `anchorId` / `point`; the refinement below enforces it. */
  anchorId: z.string().min(1).optional(),
  point: Point.optional(),
  marker: MarkerSchema,
  /** Where the camera is back at full frame. Absent: the compositor's own
   *  return timing (`insertNeutralKeys`), which is what every pre-2026-09-13
   *  document gets. */
  end: MarkerSchema.optional(),
  scale: z.number().positive().optional(),
  /** Why the aim is not what the click asked for (`aimFallback`), or
   *  anything else the editor owes the author about this zoom. */
  note: z.string().optional(),
});

/**
 * A click the zooms generated at save left without one, and why
 * (`zoomsForClicks`). Recorded beside `camera` because a missing zoom looks
 * exactly like a click nobody thought to zoom on: the author recorded five
 * clicks on 2026-10-09, got one zoom, and nothing anywhere said which rule
 * had dropped the other four.
 *
 * - `tooClose`: the click came `gapMs` after the zoom on `afterActionId`,
 *   under the gap a glide between two zooms needs to read as a move;
 * - `sameTarget`: the same, on the element that zoom is already framing;
 * - `targetTooWide`: the widest zoom that keeps the clicked element whole
 *   is `scale`, under the floor;
 * - `textTooWide`: the widest zoom that cuts no line of text on screen is
 *   `scale`, under the floor. Written only from 2026-10-09 to 2026-10-10,
 *   while the zoom was narrowed to the text (`Click.textLines`); nothing
 *   writes it now, and it stays accepted so a take saved then validates.
 *
 * `gapMs` is signed: nothing orders action timestamps, and a click stamped
 * before the zoom it follows is as close as one after it. `scale` can be 0:
 * the fit floors to hundredths, and a target many windows tall fits at none.
 * Either one refused here threw at Stop and lost the take, for a note.
 *
 * Optional, with no version bump — the widening rule `motion` follows.
 * Absent on a take whose zooms left no click out, and on every take saved
 * before the field existed, whose skips were never recorded.
 */
const ZoomSkipped = z.union([
  z.object({
    actionId: z.string().min(1),
    reason: z.enum(["tooClose", "sameTarget"]),
    afterActionId: z.string().min(1),
    gapMs: z.number(),
  }),
  z.object({
    actionId: z.string().min(1),
    reason: z.enum(["targetTooWide", "textTooWide"]),
    scale: z.number().nonnegative(),
  }),
]);

export type SceneZoomSkipped = z.infer<typeof ZoomSkipped>;

/** Every action id a skip note names: its click, and the zoomed click a
 *  too-close one was measured from. */
function skipActionIds(skip: SceneZoomSkipped): [string, string][] {
  const named: [string, string][] = [["actionId", skip.actionId]];
  if ("afterActionId" in skip)
    named.push(["afterActionId", skip.afterActionId]);
  return named;
}

/**
 * `doc` with every zoom skip note that names an action it no longer has
 * dropped, and the field gone when none is left. For anything that removes
 * actions — a deleted step, a partial retro replay, a rebuild without its
 * cut steps — so the document still validates. A note whose click is gone
 * describes nothing the author can find, and one whose zoomed click is gone
 * describes a zoom that is not there; neither is an edit to report.
 */
export function withoutStaleZoomsSkipped(doc: SceneDocument): SceneDocument {
  if (doc.zoomsSkipped === undefined) return doc;
  const live = new Set(doc.actions.map((a) => a.id));
  const kept = doc.zoomsSkipped.filter((s) =>
    skipActionIds(s).every(([, id]) => live.has(id)),
  );
  const { zoomsSkipped: _dropped, ...rest } = doc;
  return kept.length > 0 ? { ...rest, zoomsSkipped: kept } : rest;
}

const Mask = z.object({
  id: z.string().min(1),
  rect: Rect,
  note: z.string().optional(),
  /** Both or neither. Neither means the WHOLE take — the migration rule for
   *  every mask written before ranges existed. In the frames' own time
   *  since v13, as a removed piece is: a redaction follows the frames it
   *  covers through every later cut, gap and hold (audit run 1). */
  start: SourcePointSchema.optional(),
  end: SourcePointSchema.optional(),
});

// v8 §6: an authored pause, anchored to an event rather than to a timestamp —
// "hold 800ms after the checkout click" survives re-capture and regeneration,
// "hold at 00:04.320" does not. Uses CameraEvent's marker shape deliberately:
// the document has one way to say "attached to this action, at this offset",
// and a second flatter way to say it would be a fork in a format that is
// forever. Retiming is one of the few edits v9's tier table keeps available
// on a scene whose frames are not being regenerated — a mutating scene the
// author's setting refuses to replay, most often. Whether it does is
// `packages/replay-engine/src/policy.ts`'s decision, not this schema's.
const Hold = z.object({
  id: z.string().min(1),
  marker: z.object({ actionId: z.string().min(1), offsetMs: z.number() }),
  durationMs: z.number().positive(),
});

/**
 * The time between two steps — recorded by default, authored when the author
 * wants it shorter or longer.
 *
 * Anchor-relative for v8 §6's reason, the same one `Hold` states: "1.2s after
 * the checkout click" survives re-capture and regeneration, "1.2s at
 * 00:04.320" does not. One gap per action; a second is the first one moved.
 *
 * `nonnegative`, where `Hold.durationMs` is `positive`. That is deliberate and
 * is the whole difference between them: a gap's ABSENCE means "use what was
 * recorded", so zero has to remain available to mean "no pause here". A hold's
 * absence already means "no pause", which is why `removeHold` exists and why a
 * zero-length hold was ruled out as a way to say it.
 *
 * Supersedes `Hold`. See spec §1; holds are migrated on read.
 */
const Gap = z.object({
  id: z.string().min(1),
  afterActionId: z.string().min(1),
  durationMs: z.number().nonnegative(),
});

const NetworkEntry = z.object({
  id: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]),
  url: z.string(),
  classification: z.enum(["read", "analytics", "mutation"]),
  timestamp: z.number().nonnegative(),
  // The author pressed "this is analytics". Recorded so a false positive
  // becomes tuning data instead of a support ticket (v8 §5).
  reclassified: z.boolean(),
});

const ConsoleEntry = z.object({
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  text: z.string(),
  timestamp: z.number().nonnegative(),
});

const UrlTraceEntry = z.object({
  url: z.string(),
  timestamp: z.number().nonnegative(),
});

/**
 * How a URL's origin is classified. Declared here because
 * `meta.capture.originClass` is a field of this document; the classifier
 * that assigns it lives in `@demoman/replay-engine` beside the replay policy
 * that reads it, so a churning table of preview-host suffixes does not sit
 * in the package that defines the format.
 */
/**
 * What capture writes in place of a URL value it will not put on disk — every
 * query value, and any path segment the secret scrub would touch
 * (`scrubUrl` in the extension). `meta.capture.originUrl` is stored scrubbed,
 * so a URL carrying this was not the URL the author visited. Here rather than
 * in the extension so that capture and `scriptFromTake`, which has to tell a
 * scrubbed origin from a real one, read one value.
 */
export const URL_SCRUB_PLACEHOLDER = "redacted";

export const ORIGIN_CLASSES = ["published", "development", "preview"] as const;
export type OriginClass = (typeof ORIGIN_CLASSES)[number];

const Meta = z.object({
  id: z.string().min(1),
  name: z.string(),
  createdAt: z.iso.datetime(),
  toolchain: z.object({
    resolverVersion: z.string().min(1),
    compositorVersion: z.string().min(1).nullable(),
    captureVersion: z.string().min(1).nullable(),
  }),
  capture: z.object({
    originUrl: z.url(),
    originClass: z.enum(ORIGIN_CLASSES),
    buildSha: z.string().min(1).nullable(),
    buildShaSource: z.string().min(1).nullable(),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    dpr: z.number().positive(),
    /**
     * How this take was made. `record` and `retro` are the two ways a human
     * produces one; `authored` means an agent wrote a `DemoScript` and the
     * run performed it (see `script.ts`).
     *
     * A third member rather than reusing `record`: a take's own document must
     * not misreport how it was made, which is the same rule every other
     * field here follows. Widening an enum is backward compatible — every
     * document on disk still validates — so `CURRENT_SCHEMA_VERSION` stays 7
     * and no migration is owed.
     */
    mode: z.enum(["record", "retro", "authored"]),
    /**
     * The phone or tablet this take was filmed as, with the exact values
     * applied (spec 2026-10-10 §4). Absent: the desktop. Rebuild and derive
     * read it, so a phone take never replays at desktop size. Optional, but
     * it came with the v10 bump all the same: a build from before would read
     * `capture` without it and rebuild a phone take on the desktop.
     */
    device: CaptureDeviceSchema.optional(),
    /**
     * The display scale the run filmed motion at: the scale screencast spans
     * follow, which `dpr` (the stills' scale) is not. Written by the run that
     * decided it (the CLI's browser session, at launch), so `keep` reads it
     * rather than guessing from the frames. Absent on takes filmed before it
     * and where the run could not know it (a visible window, whose scale is
     * the OS's). Widening with an optional field is backward compatible, as
     * `mode`'s was: `CURRENT_SCHEMA_VERSION` stays and no migration is owed.
     */
    displayScale: z.number().positive().optional(),
  }),
  /**
   * Which render this scene wants: `screen` serves the frames the take
   * itself recorded, `demo` serves a complete replay.
   *
   * Optional so documents written before it still validate and no migration
   * is owed — the same treatment `Click.button` and `MoveTo.signal` get.
   * Absent is NOT the default; see `renderModeOf`.
   *
   * Author-facing: `screen` is "Recording", `demo` is "Rebuild". "Demo" is
   * the deliverable both modes produce, never a mode. See spec §0.
   *
   * The enum survives spec §2's approximations-and-rebuild redesign
   * unchanged, but its MEANING narrows: this now records which frames PLAY,
   * not which the author chose. The editor writes it nowhere — since
   * 2026-09-28 every write the editor makes carries the store's current
   * value (`persist()` in `apps/extension/src/editor/session.ts`). Two
   * writers flip it, both outside the editor: the run page's re-shoot
   * promotion (`promote` in `apps/extension/src/adapters/reshoot.ts`) sets
   * `demo` when a re-shoot finishes complete, and the library card's "Back
   * to your recording" (`backToRecording` in
   * `apps/extension/entrypoints/library/main.ts`) sets `screen`. Neither
   * deletes anything to do it — the recording stays on disk under either
   * mode (`chooseActiveBundle`'s own docblock) — so a re-shoot that turns
   * out worse than the recording is always reversible by writing this field
   * back.
   */
  renderMode: z.enum(["screen", "demo"]).optional(),
});

/**
 * How the pointer is drawn. Beside `branding` and for the same reason: it
 * must travel with the demo, so an export, a re-render on another machine,
 * a hosted copy and a Rebuild all reproduce the cursor the author scrubbed.
 */
export const CursorStyleName = z.enum(["light", "dark", "touch"]);

export const CursorSchema = z.object({
  /** Draws no cursor, no click pulse and no press. */
  hidden: z.boolean(),
  style: CursorStyleName,
  /** Multiplies the drawn size. 1 is `CURSOR_ART.height` at 1080p. */
  scale: z.number().min(0.5).max(2),
  /** 0 is a crisp pointer at any speed; 1 is the full exposure window. */
  motionBlur: z.number().min(0).max(1),
  hideWhenIdle: z.boolean(),
  /**
   * How far the pointer leans into horizontal motion: 0 never leans, 1 is
   * the full lean. Optional, and so are `clickBounce` below, on purpose:
   * agent scripts pass `look.cursor` through this very schema, and a
   * required field would refuse every script written before it existed.
   * Widening is backward compatible — every document on disk still
   * validates — so `CURRENT_SCHEMA_VERSION` does not move, the same
   * treatment `meta.capture.mode`'s widening got. Absent reads as
   * `CURSOR_POLISH_DEFAULTS.tilt`, never as 0.
   */
  tilt: z.number().min(0).max(1).optional(),
  /** Depth of the press-and-spring on a click: 0 is no press at all, 1 is
   *  the press every take drew before the field existed, 2 doubles it.
   *  Absent reads as `CURSOR_POLISH_DEFAULTS.clickBounce`. */
  clickBounce: z.number().min(0).max(2).optional(),
});

export type CursorStyle = z.infer<typeof CursorStyleName>;
export type SceneCursor = z.infer<typeof CursorSchema>;

/**
 * What a document with no authored cursor draws, and what the v4 -> v5
 * migration backfills.
 *
 * Four of the five reproduce what every take drew before the block existed.
 * `motionBlur: 1` does not — the slider defaults to its maximum by design
 * (spec §1), so an existing take re-renders with a smear it did not have.
 * Backfilling `0` instead would be as invented as backfilling max, and would
 * contradict the product intent as well; there is no authored value to
 * preserve, because no build that wrote a v4 document could author one.
 *
 * Frozen: six fixtures hold this exact object by reference and `resolvePlan`
 * hands it back as `cursorLook` when it is given no scene, so a single
 * `scene.cursor.scale = 2` in a test would poison every one of them for the
 * rest of the process. Nothing mutates it today; the freeze is what keeps
 * that true audibly rather than by luck.
 */
export const CURSOR_DEFAULTS: SceneCursor = Object.freeze({
  hidden: false,
  style: "light",
  scale: 1,
  motionBlur: 1,
  hideWhenIdle: false,
});

/**
 * What an absent `tilt` or `clickBounce` draws. Deliberately NOT inside
 * `CURSOR_DEFAULTS`: that object is also what the v4 -> v5 migration
 * spreads into a migrated document, and that step's output is history — a
 * v4 document migrated today must come out exactly as one migrated on
 * 2026-09-19 did (`migrate-cursor.test.ts` pins it). The fields are
 * optional, so a document without them is complete as it stands; readers
 * apply these at the point of use (`cursor.tilt ?? CURSOR_POLISH_DEFAULTS
 * .tilt`). An existing take therefore re-renders with the lean and the
 * bounce, the same direction `motionBlur: 1` took in v5.
 *
 * Frozen for `CURSOR_DEFAULTS`' reason.
 */
export const CURSOR_POLISH_DEFAULTS: Readonly<{
  tilt: number;
  clickBounce: number;
}> = Object.freeze({ tilt: 0.5, clickBounce: 1 });

/**
 * How the camera moves — beside `cursor` and for the same reason: an
 * export, a re-render and a Rebuild must reproduce what the author
 * scrubbed.
 *
 * - `smoothness` 0..1 lengthens every camera move and softens its landing
 *   (the compositor's `motionTimings` maps it to durations and a spring
 *   stiffness).
 * - `blur` 0..1 is the camera's motion blur while it moves; 0 is sharp.
 * - `follow` keeps the cursor in frame while zoomed by panning with it.
 *
 * The block is optional on the document: absent reads as `MOTION_DEFAULTS`,
 * so every document on disk still validates and no migration is owed — the
 * widening rule `meta.capture.mode` and `CursorSchema.tilt` follow.
 */
export const MotionSchema = z.object({
  smoothness: z.number().min(0).max(1),
  blur: z.number().min(0).max(1),
  follow: z.boolean(),
});

export type SceneMotion = z.infer<typeof MotionSchema>;

/** What a document with no `motion` block moves like. Frozen for
 *  `CURSOR_DEFAULTS`' reason: `resolvePlan` hands it back by reference. */
export const MOTION_DEFAULTS: SceneMotion = Object.freeze({
  smoothness: 0.5,
  blur: 0.5,
  follow: true,
});

/**
 * The frame's shape. A property of the demo, not of an export: it moves the
 * camera and the framing, so an export, a rebuild and a hosted copy must all
 * reproduce what the author scrubbed — the reason `branding` and `cursor`
 * live on the document too.
 *
 * `auto` (2026-10-06) is the recording's own shape plus an even margin
 * (`autoTarget`): the only shape where padding 0 is edge-to-edge recording on
 * every take, since a page's shape is whatever the author's window made it.
 */
export const SCENE_ASPECTS = ["auto", "16:9", "9:16"] as const;
export const CanvasSchema = z.object({ aspect: z.enum(SCENE_ASPECTS) });
export type SceneAspect = (typeof SCENE_ASPECTS)[number];
export type SceneCanvas = z.infer<typeof CanvasSchema>;

/** Frozen for `CURSOR_DEFAULTS`' reason: fixtures hold it by reference.
 *  What a NEW take starts on — never what an old document had: the v6 -> v7
 *  migration writes its own literal. */
export const CANVAS_DEFAULTS: SceneCanvas = Object.freeze({
  aspect: "auto",
}) as SceneCanvas;

/**
 * A brand colour as stored: lowercase `#rrggbb` and nothing else. Every
 * other notation is converted on entry (`parseColor`), so the painter, the
 * kit and the server's JSON Schema all read one spelling — and a value the
 * painter could not read is refused here rather than painted as grey, which
 * is what v5's `z.string().min(1)` allowed.
 */
export const BrandColorSchema = z.string().regex(/^#[0-9a-f]{6}$/);

/**
 * How blurred an image background is, 0 (sharp) to 1 (`WALLPAPER_BLUR_MAX`
 * of the frame's short side, in the compositor). Optional, and absent reads
 * as 0: everything saved before blur existed renders as it did, with no
 * version bump (spec 2026-10-28, "Blur").
 */
const WallpaperBlurSchema = z.number().min(0).max(1).optional();

/** The blur new takes and kits start on: the author's pick (2026-10-28),
 *  the top of the slider, 12% of the frame's short side. */
export const DEFAULT_WALLPAPER_BLUR = 1;

export const BackgroundSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("solid"), color: BrandColorSchema }),
  z.object({
    kind: z.literal("gradient"),
    from: BrandColorSchema,
    to: BrandColorSchema,
    /** CSS convention: 0 = to top, 90 = to right, 180 = to bottom. */
    angle: z.number().int().min(0).max(359),
  }),
  // Not restricted to `WALLPAPERS`: a take naming an id a later build
  // removed still loads, and export says so. A script is checked against
  // the list in `DemoScriptSchema`.
  z.object({
    kind: z.literal("wallpaper"),
    id: z.string().regex(/^[a-z0-9-]+$/),
    blur: WallpaperBlurSchema,
  }),
  z.object({
    kind: z.literal("image"),
    ref: z.string().min(1),
    blur: WallpaperBlurSchema,
  }),
]);

export const LOGO_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export const BrandLogoSchema = z.object({
  ref: z.string().min(1),
  corner: z.enum(LOGO_CORNERS),
  /** The logo's height ÷ the frame's shorter side, so a mark reads the same
   *  across landscape, vertical and GIF. */
  size: z.number().min(0.02).max(0.2),
  opacity: z.number().min(0.2).max(1),
});

/**
 * How the frame around the recording is dressed. The brand kit is a value
 * of this same schema (spec §6) — one validator, so a kit and a demo cannot
 * disagree about what a valid branding is.
 */
export const BrandingSchema = z.object({
  background: BackgroundSchema,
  logo: BrandLogoSchema.nullable(),
  /**
   * The margin around the recording ÷ the frame's shorter side, so 0.08
   * means the same in a 16:9 and a 9:16 frame. 0 is full screen: no margin,
   * square corners, no shadow. Required: a document always states its
   * padding, as it always states its background (spec 2026-10-05 §1).
   */
  padding: z.number().min(0).max(0.2),
});

export type SceneBackground = z.infer<typeof BackgroundSchema>;
export type LogoCorner = (typeof LOGO_CORNERS)[number];
export type SceneLogo = z.infer<typeof BrandLogoSchema>;
export type SceneBranding = z.infer<typeof BrandingSchema>;

/**
 * What a document with no authored branding draws: v5's neutral, converted
 * to hex. Computed rather than written out so it is, by construction, the
 * value the migration gives a v5 document with no colour.
 */
export const NEUTRAL_BACKGROUND = Object.freeze({
  kind: "gradient",
  from: oklchToHex({ l: 0.95, c: 0.005, h: 260 }, "clip").hex,
  to: oklchToHex({ l: 0.86, c: 0.008, h: 260 }, "clip").hex,
  angle: 150,
}) as Extract<SceneBackground, { kind: "gradient" }>;

export const BRANDING_DEFAULTS: SceneBranding = Object.freeze({
  background: Object.freeze({
    kind: "wallpaper",
    id: DEFAULT_WALLPAPER_ID,
    blur: DEFAULT_WALLPAPER_BLUR,
  }) as SceneBackground,
  logo: null,
  /**
   * 12%: the author's call on 2026-10-28, from a side-by-side with the
   * wallpapers, which want more of the frame to show. It was 8% from
   * 2026-10-05 (the margin of a polished recording, 8.4% measured), the
   * smallest padding that draws the default logo at full size; documents
   * migrated from v7 still get that 8% (`migrations.ts`), so nothing saved
   * changes. `placeLogo` keeps a mark 0.02 × short in from the edge and
   * clear of the recording, so a logo of size `s` fits only when the padding
   * is at least `s + 0.02`; `LOGO_DEFAULTS.size` is 0.06, well inside.
   *
   * Landscape exports used 15% until 2026-10-05 for zoom headroom: a
   * smaller window leaves more source detail per output pixel. That trade
   * is the author's now; `clampToSourceDetail` reports what it costs.
   */
  padding: 0.12,
}) as SceneBranding;

/** Where, how large and how strong a freshly uploaded logo lands. The
 *  size is larger than a migrated v5 watermark's 0.03 by design: that one
 *  read as a tool's stamp. */
export const LOGO_DEFAULTS: Omit<SceneLogo, "ref"> = Object.freeze({
  corner: "bottom-right",
  size: 0.06,
  opacity: 0.9,
});

export const SceneDocumentSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    meta: Meta,
    anchors: z.array(Anchor),
    actions: z.array(Action),
    camera: z.array(CameraEvent),
    /** See `ZoomSkipped`. */
    zoomsSkipped: z.array(ZoomSkipped).optional(),
    edits: z.object({
      masks: z.array(Mask),
      holds: z.array(Hold),
      gaps: z.array(Gap).default([]),
      /** Where the author split the clip. A split alone removes nothing. */
      splits: z
        .array(z.object({ id: z.string().min(1), at: SourcePointSchema }))
        .default([]),
      /**
       * Stretches of the frames the author removed. A null side is that end
       * of the take. Its edits stay in the document; what it removes is
       * resolved against the frames by the compositor.
       */
      removed: z
        .array(
          z.object({
            id: z.string().min(1),
            start: SourcePointSchema.nullable(),
            end: SourcePointSchema.nullable(),
          }),
        )
        .default([]),
      /**
       * A cut on the OUTPUT axis, never on the action log: a step outside
       * the trim still exists and a Rebuild still performs it (that is what
       * makes a head trim safe when the cut steps are a login). Absent
       * means untrimmed. `trimFrom` — removing steps — is a different edit.
       */
      trim: z
        .object({
          head: MarkerSchema.optional(),
          tail: MarkerSchema.optional(),
        })
        .optional(),
    }),
    sideChannels: z.object({
      network: z.array(NetworkEntry),
      consoleExcerpt: z.array(ConsoleEntry),
      urlTrace: z.array(UrlTraceEntry),
      // Origins the page contacted that the network log had no permission to
      // see. Non-empty means the log is incomplete, which is why the scene is
      // tagged mutating — persisted so that explanation survives a popup
      // reopen instead of living only in the Stop reply (SP4's deferral).
      uncoveredOrigins: z.array(z.string()),
    }),
    flags: z.object({
      mutating: z.boolean(),
      hoverSensitive: z.boolean(),
    }),
    branding: BrandingSchema,
    cursor: CursorSchema,
    canvas: CanvasSchema,
    /** Absent means `MOTION_DEFAULTS`; see `MotionSchema`. */
    motion: MotionSchema.optional(),
  })
  .superRefine((doc, ctx) => {
    // Referential integrity: these invariants live in TS only — the generated
    // JSON Schema is structural, so server-side validation is shallower by design.
    //
    // Uniqueness first. Consumers key Maps by these ids — the compositor's
    // `holdInstants` and `resolvePlan`'s rect lookup among them — and a Map
    // keeps the last writer, so a duplicate would silently land a hold on
    // the wrong beat rather than fail. Refused here, at the second sighting.
    const unique = (
      items: { id: string }[],
      label: string,
      path: (string | number)[],
    ): void => {
      const seen = new Set<string>();
      items.forEach((item, i) => {
        if (seen.has(item.id)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate ${label} id "${item.id}"`,
            path: [...path, i, "id"],
          });
        }
        seen.add(item.id);
      });
    };
    unique(doc.anchors, "anchor", ["anchors"]);
    unique(doc.actions, "action", ["actions"]);
    unique(doc.camera, "camera event", ["camera"]);
    unique(doc.edits.holds, "hold", ["edits", "holds"]);
    unique(doc.edits.gaps, "gap", ["edits", "gaps"]);
    // One gap per action: a second is the first one moved, not a second pause.
    unique(
      doc.edits.gaps.map((g) => ({ id: g.afterActionId })),
      "gap for an action",
      ["edits", "gaps"],
    );
    unique(doc.edits.splits, "split", ["edits", "splits"]);
    unique(doc.edits.removed, "removed piece", ["edits", "removed"]);

    const anchorIds = new Set(doc.anchors.map((a) => a.id));
    const actionIds = new Set(doc.actions.map((a) => a.id));
    doc.actions.forEach((a, i) => {
      // waitFor may carry no anchor; every other verb's anchorId is required
      // by its own schema, so a null here is only ever a navigation wait.
      if (a.anchorId !== null && !anchorIds.has(a.anchorId)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown anchor "${a.anchorId}"`,
          path: ["actions", i, "anchorId"],
        });
      }
    });
    doc.camera.forEach((c, i) => {
      const hasAnchor = c.anchorId !== undefined;
      const hasPoint = c.point !== undefined;
      if (hasAnchor === hasPoint) {
        ctx.addIssue({
          code: "custom",
          message: hasAnchor
            ? `camera event "${c.id}" names both an anchor and a point; a zoom aims at one thing`
            : `camera event "${c.id}" aims at nothing: it needs an anchorId or a point`,
          path: ["camera", i, "anchorId"],
        });
      }
      if (c.anchorId !== undefined && !anchorIds.has(c.anchorId)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown anchor "${c.anchorId}"`,
          path: ["camera", i, "anchorId"],
        });
      }
      if (!actionIds.has(c.marker.actionId)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown action "${c.marker.actionId}"`,
          path: ["camera", i, "marker", "actionId"],
        });
      }
      if (c.end !== undefined && !actionIds.has(c.end.actionId)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown action "${c.end.actionId}"`,
          path: ["camera", i, "end", "actionId"],
        });
      }
    });
    // A skip that names no action of this take would be a note about a click
    // the author cannot find.
    (doc.zoomsSkipped ?? []).forEach((s, i) => {
      for (const [key, id] of skipActionIds(s)) {
        if (!actionIds.has(id)) {
          ctx.addIssue({
            code: "custom",
            message: `unknown action "${id}"`,
            path: ["zoomsSkipped", i, key],
          });
        }
      }
    });
    doc.edits.masks.forEach((m, i) => {
      if ((m.start === undefined) !== (m.end === undefined)) {
        const missing = m.start === undefined ? "start" : "end";
        ctx.addIssue({
          code: "custom",
          message: `mask "${m.id}" has ${missing === "start" ? "an end" : "a start"} but no ${missing}; a range needs both, and neither means the whole take`,
          path: ["edits", "masks", i, missing],
        });
      }
      for (const side of ["start", "end"] as const) {
        const marker = m[side];
        if (marker !== undefined && !actionIds.has(marker.actionId)) {
          ctx.addIssue({
            code: "custom",
            message: `unknown action "${marker.actionId}"`,
            path: ["edits", "masks", i, side, "actionId"],
          });
        }
      }
      // The one zero-length range the schema CAN see: both ends on the same
      // step. Ends on different steps are ordered by the render, which is
      // where `resolveRange` reports a range cut to nothing.
      if (
        m.start !== undefined &&
        m.end !== undefined &&
        m.start.actionId === m.end.actionId &&
        m.end.sourceOffsetMs <= m.start.sourceOffsetMs
      ) {
        ctx.addIssue({
          code: "custom",
          message: `mask "${m.id}" ends before it starts`,
          path: ["edits", "masks", i, "end"],
        });
      }
    });
    for (const side of ["head", "tail"] as const) {
      const marker = doc.edits.trim?.[side];
      if (marker !== undefined && !actionIds.has(marker.actionId)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown action "${marker.actionId}"`,
          path: ["edits", "trim", side, "actionId"],
        });
      }
    }
    doc.edits.holds.forEach((h, i) => {
      if (!actionIds.has(h.marker.actionId)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown action "${h.marker.actionId}"`,
          path: ["edits", "holds", i, "marker", "actionId"],
        });
      }
    });
    (doc.edits.splits ?? []).forEach((split, i) => {
      if (!actionIds.has(split.at.actionId)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown action "${split.at.actionId}"`,
          path: ["edits", "splits", i, "at", "actionId"],
        });
      }
    });
    (doc.edits.removed ?? []).forEach((range, i) => {
      for (const side of ["start", "end"] as const) {
        const point = range[side];
        if (point !== null && !actionIds.has(point.actionId)) {
          ctx.addIssue({
            code: "custom",
            message: `unknown action "${point.actionId}"`,
            path: ["edits", "removed", i, side, "actionId"],
          });
        }
      }
    });
    doc.edits.gaps.forEach((g, i) => {
      if (!actionIds.has(g.afterActionId)) {
        ctx.addIssue({
          code: "custom",
          message: `gap ${g.id} follows an action that does not exist`,
          path: ["edits", "gaps", i, "afterActionId"],
        });
      }
    });
  });

export type SceneDocument = z.infer<typeof SceneDocumentSchema>;
export type SceneAction = z.infer<typeof Action>;
export type SceneAnchor = z.infer<typeof Anchor>;
export type SceneNetworkEntry = z.infer<typeof NetworkEntry>;
export type SceneConsoleEntry = z.infer<typeof ConsoleEntry>;

export function sceneJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(SceneDocumentSchema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
}
