import { z } from "zod";
import { DeviceIdSchema } from "./device.js";
import {
  BRANDING_DEFAULTS,
  BrandingSchema,
  CanvasSchema,
  CursorSchema,
  MotionSchema,
  PRESS_KEYS,
  type SceneCursor,
} from "./document.js";
import { WALLPAPERS } from "./wallpapers.js";

/**
 * What an agent writes. A SIBLING of `SceneDocument`, never a version of it:
 * there is no migration path from a script to a document and none may be
 * added. The one legal direction is the other way — `scriptFromTake` reads a
 * take back as intent by DROPPING its evidence, and writes no document.
 * (A scroll's `landing` survives the drop as intent: where the author left
 * the element, not a rect the run can claim to have measured.)
 *
 * The document is a RECORDING format — `actions[].timestamp`, `marker`,
 * `rect` and `anchors[].resolution` are evidence of a performance that
 * happened. A script is an INTENT format: it says what to do, and the run
 * produces the document from what it measured. Teaching `migrateToCurrent`
 * to accept one of these would make a fabricated anchor and a witnessed one
 * report the same thing, which is the defect class CLAUDE.md opens with,
 * installed at the format level.
 *
 * Versioned separately from `CURRENT_SCHEMA_VERSION` for the same reason.
 *
 * The version this build writes, and the one a script that uses nothing
 * newer declares. A script declares the version of the newest thing it
 * uses, so a build that predates that thing refuses it at the door rather
 * than dropping it.
 */
export const SCRIPT_VERSION = 1;

/**
 * The first version whose `look` may name a kit (2026-10-08). A build from
 * before kits reads `look` loosely and drops `kit` without a word, so it
 * would record on the default brand and report success; it refuses a
 * version-2 script instead, because its `scriptVersion` is the literal 1.
 * The bridge's protocol bump guards the agent route; this guards a script
 * pasted into an older install's run page.
 */
export const SCRIPT_VERSION_KIT = 2;

/**
 * The first version whose `look` may carry `motion` (2026-10-09), by
 * `SCRIPT_VERSION_KIT`'s reasoning. A build from before 2026-10-08 reads
 * `look` loosely, so it would drop `motion` without a word and render the
 * camera it knows — no spring, no follow, no blur — and report success;
 * v0.1.1's handover is one, and it is installed. A build from after reads
 * `look` strictly and would refuse the key anyway, by name; the bump costs
 * that build nothing and turns the older one's silent drop into a refusal
 * of the version. A script declares the newest thing it uses, so one that
 * names both `kit` and `motion` declares this.
 *
 * `look.cursor.tilt` and `clickBounce` came in on the same day and need it
 * too: the older build reads `look.cursor` through a `CursorSchema` that is
 * not strict, so it strips both and draws the default lean and press — a
 * lean the author turned off comes back, with success reported.
 */
export const SCRIPT_VERSION_MOTION = 3;

/**
 * The first version that may name a `device` (2026-10-10). The top-level
 * script object is not strict, so a build from before strips `device` and
 * films the desktop layout, reporting success. Refusing the version turns
 * that silent drop into a refusal, by `SCRIPT_VERSION_KIT`'s reasoning.
 */
export const SCRIPT_VERSION_DEVICE = 4;

/**
 * The first version that may name an `account` (launch C2, 2026-10-15): one
 * of the site's accounts in `.demoman/accounts.json`. A build from before
 * strips the key and films signed in as whoever the saved session is,
 * reporting success; refusing the version makes that a refusal, by
 * `SCRIPT_VERSION_KIT`'s reasoning.
 */
export const SCRIPT_VERSION_ACCOUNT = 5;

/**
 * The first version with a `drag` step (2026-10-21). An older build refuses
 * the step anyway, by its unknown `do`; the bump keeps the convention and
 * gives that refusal the sentence a version gives.
 */
export const SCRIPT_VERSION_DRAG = 6;

/**
 * The first version with a `press` step or a click's `at` (2026-10-30). An
 * older build refuses both by their unknown keys; the bump gives that refusal
 * the sentence a version gives.
 */
export const SCRIPT_VERSION_PRESS = 7;

/**
 * The first version with a `trim` or a click's or drag's `zoom` (2026-11-01).
 * The top-level script object is not strict, so a build from before strips
 * `trim` and films the whole take, and its step members are strict, so it
 * refuses `zoom` by name. The first is a silent drop reporting success; the
 * bump turns it into a refusal of the version, by `SCRIPT_VERSION_KIT`'s
 * reasoning.
 */
export const SCRIPT_VERSION_EDITS = 8;

/**
 * The largest zoom a script may ask a click for. The camera clamps to
 * `CAMERA_DEFAULTS.maxScale` (2.5, in `@demoman/compositor`, which depends on
 * this package and so cannot be imported here); a higher ask would be clamped
 * in silence and the film would differ from the script, so it is refused at
 * the door instead. Keep the two equal.
 */
export const ZOOM_MAX_SCALE = 2.5;

/** An account name: it becomes a file name under the sessions folder. */
export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `ACCOUNT_NAME` in words, for every refusal of a name that breaks it:
 *  lower case, so `Seller` and `seller` never share a file on macOS. */
export const ACCOUNT_NAME_RULE =
  'lower-case letters, digits, "-" and "_", starting with a letter or digit, at most 64 characters';

/**
 * How a step names its element — the three strategies an agent can honestly
 * know without having seen the page, and a fourth it can only have READ.
 *
 * `treePath` is the element's position in the document, in the resolver's own
 * path grammar. No agent can know it without looking, and none should write
 * one by hand; it exists because `scriptFromTake` has looked — capture
 * measured it — and a recorded scroll lands on whatever unnamed section sat
 * mid-screen, which no other strategy can name (`chooseScrollAnchor`). The
 * derivation emits it only when capture resolved by it. Like every
 * positional match it breaks when the page's structure changes, and the run
 * then stops at that step and says so.
 *
 * `.strict()` on every member, deliberately: without it `{stableId, text}`
 * matches the first member, zod strips `text`, and a script that named two
 * strategies is half-read in silence. The run would then resolve by a
 * strategy the author did not choose and report success.
 */
export const ScriptTargetSchema = z.union([
  z.object({ stableId: z.string().min(1) }).strict(),
  z.object({ role: z.string().min(1), name: z.string().min(1) }).strict(),
  z.object({ text: z.string().min(1) }).strict(),
  z.object({ treePath: z.string().min(1) }).strict(),
]);

/**
 * The resolver strategy a target's shape names. Every reader of a target's
 * shape goes through this rather than an `in` chain of its own: three such
 * chains ended in a bare `return` for "text", so a member added to the union
 * fell through to a text match in silence. The `never` below makes the
 * compiler refuse that instead.
 */
export function targetStrategy(
  target: ScriptTarget,
): "stableId" | "roleName" | "text" | "treePath" {
  if ("stableId" in target) return "stableId";
  if ("role" in target) return "roleName";
  if ("text" in target) return "text";
  if ("treePath" in target) return "treePath";
  const unknown: never = target;
  throw new Error(`unknown script target ${JSON.stringify(unknown)}`);
}

/**
 * `type` carries a plain `text` and has no `redacted` member. A recording has
 * one because the sensor may witness a credential field and decline to read
 * it; an agent's value is a demo value by construction, and a format that
 * could say "redacted" would be claiming an observation it never made.
 *
 * `pause` is the only step that mentions time, and it is a DURATION. The
 * format cannot express an instant — which is what makes 2026-09-26's bug (a
 * readiness wait stamped at the moment its element appeared, breaking the
 * log's monotonicity) unreachable from this door.
 *
 * `click` names no BUTTON. The run dispatches a left button and nothing else
 * (`performVerb` in `@demoman/replay-engine`), so a field offering `middle`
 * and `right` promised two things no door performs — and the run's honest
 * choices were then to refuse the step or to record a left click the script
 * did not ask for. A field with one legal value is noise; when the walk learns
 * the other buttons, re-adding it is additive. The engine keeps a runtime
 * backstop (`unperformableStep`) for a caller that skipped this parse.
 *
 * `.strict()` on every member, for `ScriptTargetSchema`'s reason one level up:
 * without it an unknown key is STRIPPED in silence, so a script asking for
 * something this format does not have would be half-read and run as though it
 * had asked for something else. The best error an agent can get is this one,
 * at the door, naming the field.
 */
const RecordedSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Written by Demoman when the script was derived from a video; pairs the step with the action it came from. Leave it as it is",
  );

/** A spot inside a target's box, as fractions of its width and height. */
export const DragSpotSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();

/** Where a drag presses: a target, and a spot in it (its centre if absent). */
export const DragFromSchema = z
  .object({ on: ScriptTargetSchema, at: DragSpotSchema.optional() })
  .strict();

/** Where a drag lets go: a place as `from`, or CSS px from the start. */
export const DragToSchema = z.union([
  DragFromSchema,
  z
    .object({
      by: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    })
    .strict(),
]);

/**
 * What a script says about one click's or drag's zoom: `false` for none, or a
 * scale the camera holds there, over 1 (which would be no zoom, so say `false`)
 * and at most `ZOOM_MAX_SCALE`. Absent leaves the decision to the camera.
 */
export const ZoomIntentSchema = z.union([
  z.literal(false),
  z
    .object({
      scale: z
        .number()
        .gt(1, {
          message: "a zoom scale is over 1; use `zoom: false` for none",
        })
        .max(ZOOM_MAX_SCALE, {
          message: `a zoom scale is at most ${ZOOM_MAX_SCALE}, the camera's limit`,
        }),
    })
    .strict(),
]);
export type ZoomIntent = z.infer<typeof ZoomIntentSchema>;

/** The zoom a script asked for at an action, if it named one. */
export type ZoomIntentOf = (actionId: string) => ZoomIntent | undefined;

export const ScriptStepSchema = z.discriminatedUnion("do", [
  z
    .object({
      do: z.literal("click"),
      on: ScriptTargetSchema.describe("The element to click"),
      /** Where in the target's box to click (its centre if absent). */
      at: DragSpotSchema.optional().describe(
        "Where in the element to click, as fractions of its width and height; its centre if absent",
      ),
      zoom: ZoomIntentSchema.optional().describe(
        "The camera's zoom at this click: `false` for none, or `{ scale }` over 1 and at most 2.5. Absent leaves it to the camera",
      ),
      /**
       * The recorded action this step was derived from (`scriptFromTake` writes
       * it). How the recording layer pairs a run's step with the author's —
       * per step, because an agent fills holes and adds steps, and a positional
       * list would go stale the moment it did. Absent on a step the agent wrote.
       */
      recorded: RecordedSchema,
    })
    .strict()
    .describe("Click an element"),
  z
    .object({
      do: z.literal("type"),
      into: ScriptTargetSchema.describe("The field to type into"),
      text: z
        .string()
        .describe("What to type: a demo value, never a real secret"),
      recorded: RecordedSchema,
    })
    .strict()
    .describe("Type text into a field"),
  z
    .object({
      do: z.literal("hover"),
      on: ScriptTargetSchema.describe("The element to rest the pointer on"),
      recorded: RecordedSchema,
    })
    .strict()
    .describe("Rest the pointer on an element"),
  z
    .object({
      do: z.literal("scrollTo"),
      on: ScriptTargetSchema.describe("The element to scroll into view"),
      recorded: RecordedSchema,
      /**
       * Where the scroll leaves its element: `top` is the viewport y, in CSS
       * px, of the element's top edge when the scroll stops. Negative when a
       * block taller than the screen has scrolled partly past the top.
       *
       * Intent, not evidence — the same fact a hand-written "put the pricing
       * table 280px down" would state. `scriptFromTake` writes it from the
       * recorded action's rect, because two scrolls to one tall block differ
       * ONLY by where they stopped, and a derived run that dropped it would
       * centre every scroll instead of reproducing the take.
       *
       * Absent means centred, which is what a hand-written scroll that names
       * only an element asks for. A `top` that would leave the element off
       * screen centres too, and the run reports `scrollLandingOffscreen`.
       */
      landing: z
        .object({ top: z.number().finite() })
        .strict()
        .optional()
        .describe(
          "Where the element's top edge stops, in CSS px from the top of the window. Absent centres it",
        ),
    })
    .strict()
    .describe("Scroll an element into view"),
  z
    .object({
      do: z.literal("waitFor"),
      on: ScriptTargetSchema.describe("The element to wait for"),
      until: z
        .enum(["visible", "hidden"])
        .describe("Wait until it shows, or until it goes"),
      recorded: RecordedSchema,
    })
    .strict()
    .describe("Wait for an element to show or go"),
  z
    .object({
      do: z.literal("drag"),
      from: DragFromSchema.describe(
        "Where the drag presses: `{ on, at? }`, an element and a spot in it",
      ),
      to: DragToSchema.describe(
        "Where it lets go: `{ on, at? }` as `from`, or `{ by: { x, y } }` in CSS px from the start",
      ),
      zoom: ZoomIntentSchema.optional().describe(
        "The camera's zoom at this drag, as on `click`",
      ),
      recorded: RecordedSchema,
    })
    .strict()
    .describe("Press, move and let go"),
  z
    .object({
      do: z.literal("press"),
      key: z.enum(PRESS_KEYS).describe("The key to press"),
      recorded: RecordedSchema,
    })
    .strict()
    .describe("Press a key"),
  z
    .object({
      do: z.literal("waitForLoad"),
      recorded: RecordedSchema,
    })
    .strict()
    .describe("Wait for the page to finish loading"),
  z
    .object({
      do: z.literal("pause"),
      ms: z.number().positive().describe("How long, in milliseconds"),
    })
    .strict()
    .describe("Hold still, so the viewer can read. Performs nothing"),
]);

/**
 * The steps that do something to the page. `pause` is a duration and yields no
 * beat (`authoredTotal` filters it for the same reason), so a script made only
 * of pauses declares no work at all.
 *
 * `Record<ScriptStep["do"], boolean>` rather than a `Set<string>`, the same
 * move `REASON_TEXT` has: a hand-maintained set beside a discriminated union
 * rots silently, and the rot is invisible in the worst direction — a verb added
 * to `ScriptStepSchema` and forgotten here would make a legitimate script fail
 * the pause-only refinement below, under a message ("every step here is a
 * pause") that is then false. This way the compiler refuses the omission.
 */
const ACTS_ON_THE_PAGE: Record<ScriptStep["do"], boolean> = {
  click: true,
  type: true,
  hover: true,
  scrollTo: true,
  waitFor: true,
  drag: true,
  press: true,
  waitForLoad: true,
  pause: false,
};

/**
 * The steps whose beats appear in the film, which is what a trim's `step`
 * counts against. `waitFor`, `waitForLoad` and `pause` perform nothing the
 * viewer sees. `Record<…, boolean>` for `ACTS_ON_THE_PAGE`'s reason: a verb
 * added to the union and forgotten here fails to compile.
 */
export const SHOWN_STEP: Record<ScriptStep["do"], boolean> = {
  click: true,
  type: true,
  hover: true,
  scrollTo: true,
  waitFor: false,
  drag: true,
  press: true,
  waitForLoad: false,
  pause: false,
};

/**
 * The step `trim[side]` is measured from, 0-based into `steps`: its `step`,
 * or the first (start) or last (end) shown step when absent. Null when it
 * names none and no step is shown. The one reading of a trim's step, for the
 * parse, the run, the report and the re-record alike.
 */
export function trimStepIndex(
  script: { steps: readonly { do: ScriptStep["do"] }[]; trim?: ScriptTrim },
  side: "start" | "end",
): number | null {
  const step = script.trim?.[side]?.step;
  if (step !== undefined) return step - 1;
  const shown = script.steps.flatMap((s, i) => (SHOWN_STEP[s.do] ? [i] : []));
  return (side === "start" ? shown[0] : shown.at(-1)) ?? null;
}

/**
 * Where the film starts and ends, against the take. `ms` is cut from the
 * ends (0 or more); `step` (1-based into `steps`, any but a `pause`) names
 * the step the cut is measured from, the first and last shown step if absent.
 * `end.after` says what the end waits for; absent means the zoom-out, and the
 * parse writes no default, so later readers see the absence.
 */
export const ScriptTrimSchema = z
  .object({
    start: z
      .object({
        ms: z.number().finite().nonnegative(),
        step: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    end: z
      .object({
        ms: z.number().finite().nonnegative(),
        step: z.number().int().positive().optional(),
        after: z.enum(["zoomOut", "action"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ScriptTrim = z.infer<typeof ScriptTrimSchema>;

/**
 * A script's branding: the document's, except that a script written before
 * v8 (2026-10-05) — `derive` copied the take's whole branding into `look` —
 * has no `padding`. A document is migrated and a script is not, so the
 * absent key is upgraded to the default, as `coerceBrandKit` upgrades a kit
 * from before padding: only an absent key, never a stand-in for a bad
 * value, which the schema still refuses and names (review, 2026-10-06).
 */
const ScriptBrandingSchema = BrandingSchema.extend({
  padding: BrandingSchema.shape.padding.default(BRANDING_DEFAULTS.padding),
});

const ScriptVersionSchema = z.literal([
  SCRIPT_VERSION,
  SCRIPT_VERSION_KIT,
  SCRIPT_VERSION_MOTION,
  SCRIPT_VERSION_DEVICE,
  SCRIPT_VERSION_ACCOUNT,
  SCRIPT_VERSION_DRAG,
  SCRIPT_VERSION_PRESS,
  SCRIPT_VERSION_EDITS,
]);
export type ScriptVersion = z.infer<typeof ScriptVersionSchema>;

/** The later of two versions. */
const laterVersion = (a: ScriptVersion, b: ScriptVersion): ScriptVersion =>
  b > a ? b : a;

const DemoScriptShape = z.object({
  /** Optional: Demoman sets it (see `minimumScriptVersion`); a lower one is raised. */
  scriptVersion: ScriptVersionSchema.optional().describe(
    "The format's number. Demoman sets it; leave it out",
  ),
  name: z.string().min(1).describe("The video's name"),
  target: z.url().describe("The page the run opens first, http or https"),
  /** Absent means the run's own window size, recorded into the document. */
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional()
    .describe(
      "The window size in CSS px, `{ width, height }`. Absent: Demoman's own window",
    ),
  /** A phone or tablet to film as (spec 2026-10-10 §3). Absent: the desktop.
   *  A device is a viewport, so naming both is refused. */
  device: DeviceIdSchema.optional().describe(
    "A phone or tablet to record as, instead of a viewport. See Phone and tablet",
  ),
  /** One of the site's accounts in `.demoman/accounts.json` (launch C2).
   *  Absent: the site's `default`, else the saved manual session. */
  account: z
    .string()
    .regex(ACCOUNT_NAME, {
      message: `an account name is ${ACCOUNT_NAME_RULE}`,
    })
    .optional()
    .describe(
      "A demo account from `.demoman/accounts.json` to sign in as. Absent: the site's default, else your own saved sign-in",
    ),
  steps: z
    .array(ScriptStepSchema)
    .min(1)
    .describe(
      "What the run does, in order. At least one step acts on the page",
    ),
  /** Cut the film's start and end (`ScriptTrimSchema`). Absent: the whole take. */
  trim: ScriptTrimSchema.optional().describe(
    "Cut the video's start and end: `{ start: { ms, step? }, end: { ms, step?, after? } }`. Absent: the whole video",
  ),
  /**
   * The take that steps' `recorded` ids refer to (`scriptFromTake` writes it).
   * Absent on a script nobody derived from a recording.
   */
  recordedFrom: z
    .string()
    .min(1)
    .optional()
    .describe("The video a derived script came from. Demoman writes it"),
  /**
   * The frame's dress. Reuses the document's own schemas so there is one
   * vocabulary for branding, cursor and canvas rather than two. Absent means
   * the same defaults a human take gets.
   */
  look: z
    .object({
      branding: ScriptBrandingSchema.optional(),
      /**
       * One of the author's brand kits, by the name Settings shows (case and
       * surrounding space ignored). Resolved by the extension at the run's
       * door; a name that is not there is refused (`unknownKit`), never
       * replaced by the default kit (spec 2026-10-08 §3).
       */
      kit: z.string().trim().min(1).optional(),
      cursor: CursorSchema.optional(),
      canvas: CanvasSchema.optional(),
      /**
       * How the camera moves: the document's own block, carried into the
       * take the run makes. Absent means `MOTION_DEFAULTS`, as on a
       * document. Before 2026-10-09 the key did not exist here, so a
       * re-run of a take whose camera the author had tuned came back on
       * the defaults. Needs `SCRIPT_VERSION_MOTION`.
       */
      motion: MotionSchema.optional(),
    })
    // Strict from 2026-10-08: a key this build does not know is refused and
    // named, never dropped. Dropping `kit` is exactly how a build that
    // predates it would record on the wrong brand and report success.
    .strict()
    .refine((look) => look.branding === undefined || look.kit === undefined, {
      message: "name a kit or give a branding, not both",
    })
    .optional()
    .describe(
      "The frame's look: `kit` (a brand kit by name) or `branding`, plus `cursor`, `canvas` and `motion`. Absent: your default brand kit",
    ),
});

/**
 * At least one step that acts on the page.
 *
 * `steps.min(1)` counts a `pause`, so `[{ do: "pause", ms: 500 }]` satisfied
 * the shape while declaring no work: the run would attach the debugger, open a
 * window and navigate, perform nothing, and assemble no take — because a take
 * with no performed step is not a take. A script that can never produce one is
 * not a valid script, and the best error an agent can get for that is this one,
 * at the door, naming the problem.
 *
 * The runtime check stays. `runAuthoredInWindow` still refuses a total of zero
 * with `noActions`, exactly as the engine keeps `unperformableStep` as the
 * backstop for a `click` carrying a `button` this format refuses: scripts arrive
 * from an agent, and a caller that skipped the parse must not get further than
 * one that did.
 */
export const DemoScriptSchema = DemoScriptShape.superRefine((script, ctx) => {
  const bg = script.look?.branding?.background;
  if (bg?.kind === "wallpaper" && !WALLPAPERS.some((w) => w.id === bg.id)) {
    ctx.addIssue({
      code: "custom",
      message: `unknown wallpaper "${bg.id}" — one of ${WALLPAPERS.map((w) => w.id).join(", ")}`,
      path: ["look", "branding", "background", "id"],
    });
  }
  script.steps.forEach((step, index) => {
    if (step.do !== "drag") return;
    // A drag that goes nowhere is a click, and filming it as a drag would
    // report a step the page never saw as a drag.
    const nowhere =
      "by" in step.to
        ? step.to.by.x === 0 && step.to.by.y === 0
        : JSON.stringify(step.to.on) === JSON.stringify(step.from.on) &&
          (step.to.at?.x ?? 0.5) === (step.from.at?.x ?? 0.5) &&
          (step.to.at?.y ?? 0.5) === (step.from.at?.y ?? 0.5);
    if (nowhere) {
      ctx.addIssue({
        code: "custom",
        message: `step ${index + 1} is a drag that starts and ends at the same point: give \`to\` another target, spot or offset, or make it a click`,
        path: ["steps", index, "to"],
      });
    }
  });
  // Secrets resolve only in an account's sign-in steps (launch C2 §3): a
  // demo script that types one would put it on film.
  script.steps.forEach((step, index) => {
    if (step.do !== "type" || !/\{secret:/.test(step.text)) return;
    ctx.addIssue({
      code: "custom",
      message:
        "{secret:…} works only in an account's signIn steps in .demoman/accounts.json, never in a demo script: name the script's account instead, and type demo values here",
      path: ["steps", index, "text"],
    });
  });
  if (script.device !== undefined && script.viewport !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "name a device or a viewport, not both: a device is a viewport",
      path: ["device"],
    });
  }
  // A phone has no hover: a step that asks for one cannot be performed, and
  // performing it as a tap would change the page in a way the script never
  // asked for.
  if (script.device !== undefined) {
    script.steps.forEach((step, index) => {
      if (step.do !== "hover") return;
      ctx.addIssue({
        code: "custom",
        message: `step ${index + 1} is a hover, and a ${script.device} has no hover: tap it, or drop the step`,
        path: ["steps", index],
      });
    });
  }
  if (script.trim) trimIssues(script, ctx);
  if (script.steps.some((step) => ACTS_ON_THE_PAGE[step.do])) return;
  ctx.addIssue({
    code: "custom",
    message:
      "a script needs at least one step that acts on the page; every step here is a pause, which is a duration and performs nothing, so this script can never produce a take",
    path: ["steps"],
  });
}).transform((script) => ({
  ...script,
  scriptVersion: laterVersion(
    script.scriptVersion ?? SCRIPT_VERSION,
    minimumScriptVersion(script),
  ),
}));

/** Refuse a trim `step` that cannot be measured from, in words. */
function trimIssues(
  script: { steps: ScriptStep[]; trim?: ScriptTrim },
  ctx: z.RefinementCtx,
): void {
  const { steps, trim = {} } = script;
  let bad = false;
  for (const edge of ["start", "end"] as const) {
    const step = trim[edge]?.step;
    if (step === undefined) continue;
    const why =
      step > steps.length
        ? `trim.${edge}.step is ${step}, but the script has ${steps.length} steps`
        : steps[step - 1]?.do === "pause"
          ? `trim.${edge}.step is ${step}, a pause: name a step that does something`
          : undefined;
    if (!why) continue;
    bad = true;
    ctx.addIssue({
      code: "custom",
      message: why,
      path: ["trim", edge, "step"],
    });
  }
  // Resolved, not as written: a start naming the last step is as broken
  // against the default end as against an explicit one.
  const start = trimStepIndex(script, "start");
  const end = trimStepIndex(script, "end");
  if (!bad && start !== null && end !== null && start > end) {
    ctx.addIssue({
      code: "custom",
      message: `trim starts at step ${start + 1}, after the step it ends at (${end + 1}): the film would be empty`,
      path: ["trim", "start", "step"],
    });
  }
}

export type DemoScriptInput = z.input<typeof DemoScriptShape>;

/**
 * The lowest version that carries everything the script uses. Demoman sets
 * `scriptVersion` from this, so an agent never writes it; a build from before
 * a feature refuses the higher number rather than dropping the feature. A new
 * rule is one more line here.
 */
export function minimumScriptVersion(script: DemoScriptInput): ScriptVersion {
  const rules: [boolean, ScriptVersion][] = [
    [script.look?.kit !== undefined, SCRIPT_VERSION_KIT],
    [script.look?.motion !== undefined, SCRIPT_VERSION_MOTION],
    [cursorPolishNamed(script.look?.cursor), SCRIPT_VERSION_MOTION],
    [script.device !== undefined, SCRIPT_VERSION_DEVICE],
    [script.account !== undefined, SCRIPT_VERSION_ACCOUNT],
    [script.steps.some((step) => step.do === "drag"), SCRIPT_VERSION_DRAG],
    [
      script.trim !== undefined ||
        script.steps.some(
          (step) =>
            (step.do === "click" || step.do === "drag") &&
            step.zoom !== undefined,
        ),
      SCRIPT_VERSION_EDITS,
    ],
    [
      script.steps.some(
        (step) => step.do === "press" || (step.do === "click" && step.at),
      ),
      SCRIPT_VERSION_PRESS,
    ],
  ];
  return rules
    .filter(([on]) => on)
    .map(([, v]) => v)
    .reduce(laterVersion, SCRIPT_VERSION);
}

export type ScriptTarget = z.infer<typeof ScriptTargetSchema>;
export type DragSpot = z.infer<typeof DragSpotSchema>;
export type DragFrom = z.infer<typeof DragFromSchema>;
export type DragTo = z.infer<typeof DragToSchema>;
export type ScriptStep = z.infer<typeof ScriptStepSchema>;
export type DemoScript = z.infer<typeof DemoScriptSchema>;

/** Whether a cursor block names a key that needs `SCRIPT_VERSION_MOTION`. */
export function cursorPolishNamed(cursor: SceneCursor | undefined): boolean {
  return cursor?.tilt !== undefined || cursor?.clickBounce !== undefined;
}
