import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The vocabulary rule from spec §0, enforced.
 *
 * `renderRenderMode`'s docblock has said since 2026-09-04 that "an author
 * clicking either button is never asked to know what `replay` means". That
 * was a promise nothing checked, and by 2026-09-08 seventeen author-facing
 * strings in one file had broken it. This is the check.
 *
 * It reads source text rather than rendered output on purpose: rendering
 * every branch of every notice would need a fixture per tier, per bundle
 * status and per policy, and the ones nobody thought to build are exactly
 * where the next leak lands.
 *
 * ## The boundary, said out loud
 *
 * `FILES` is a list of files, not a claim about the editor. It covers the
 * files this vocabulary change edited, and a reader who takes it for "the
 * author never sees a retired word" will be wrong — the copy an author reads
 * in one box is routinely assembled from a file that is on this list and one
 * that is not. Two live examples: `develop.ts` is guarded, but its panel
 * headline and notice come from `src/adapters/replay-runner.ts`; `view.ts` is
 * guarded, but the body under its failure headline comes from
 * `src/editor/staleness.ts` (added here) and from `packages/replay-engine`.
 *
 * Author-facing copy that is NOT guarded, as of 2026-09-08:
 *
 * - `src/adapters/replay-runner.ts` — the developing panel's headline and
 *   its progress notices. Its copy WAS rewritten (see that file's
 *   `replayNotice` docblock), but the file cannot join this list: it also
 *   holds `new Error("replay window did not open")` and its siblings, which
 *   are developer surfaces on the same footing as `console.*` and which this
 *   extractor has no way to tell from copy. Exempting them by shape would
 *   buy a green that is not evidence — an `Error` message here CAN reach an
 *   author, through `${result.settleError}` — so the check there is
 *   `replay-runner.test.ts`'s assertions on the joined string instead.
 * - `src/editor/lanes.ts` — one string, and it has to stay:
 *   `LEGACY_MOTION_RECLAIMED_NOTES` quotes the sentences written into
 *   IndexedDB rows before 2026-09-08 (and, since 2026-09-28, until then), so that `labelOf` can recognise those
 *   rows and relabel them. It is a stored value being matched, not copy an
 *   author reads. `editor-lanes.test.ts` asserts what the author actually
 *   sees for both a legacy row and a new one.
 * - `src/review/state.ts` — the review queue's copy.
 * - `packages/replay-engine/src/explain.ts` — twelve of the fourteen
 *   `REASON_TEXT` entries. The two that give the author an *instruction*
 *   were rewritten on 2026-09-08; the rest describe mechanism and still say
 *   "replay". They reach the author through `replaySentence`, so guarding
 *   `staleness.ts` does not reach them.
 *
 * Widening the list is not a matter of adding entries: each file needs its
 * copy rewritten first. `inspector.ts`, `timeline-view.ts` and `session.ts`
 * were on the unguarded list above until 2026-09-08 — a review found the
 * author reading "Frames are regenerating" beside a button saying
 * "Rebuilding…", and three vocabularies inside the one timeline widget — so
 * they were rewritten and moved down into `FILES`. The honest statement of
 * what this test proves is "these twelve files" (nine until `capability.ts`
 * joined, ten until it left again and `approximations.ts`/`export-run.ts`
 * joined on 2026-09-24, eleven from there until `cuts.ts` joined the same
 * day — see their own entries below), and it is written here so nobody has
 * to infer it.
 */
const BANNED =
  /\b(full[- ]quality|replay(s|ed|ing)?|regenerat(e|es|ed|ing|ion|ions))\b/i;

/** The encode is "Export". Capitalised only: "the last render carried no
 *  marker" describes mechanism and stays; "Render" as a button, a heading
 *  or a running label is the retired verb. Case-sensitive on purpose. */
const BANNED_CAPITALISED = /\bRender(ing|ed|s)?\b/;

/**
 * A template literal is either markup or a sentence, and the two need
 * opposite treatment.
 *
 * In markup, only the text outside tags is copy: attribute names
 * (`data-replay-setting`) and URL parameters (`&replay=1`) are wiring that
 * spec §0 forbids renaming, and they must not be dragged into the check.
 *
 * A template with no markup in it is a whole sentence, and taking only the
 * text between `>` and `<` yields *nothing at all* for one — which is how a
 * leak would hide. `entrypoints/library/main.ts` already writes author-facing
 * status that way ("Something went wrong (…). Try again.", "Partly deleted:
 * …"), so a mechanism word moving into one of those must not become
 * invisible. That file's anchor below is one of them, on purpose.
 *
 * The markup branch **splits on tags** rather than matching between them.
 * `/>([^<>]+)</g` needs a tag on both sides of the copy, so a sentence
 * before the first `<` or after the last `>` was dropped without a trace —
 * and `develop.ts`'s `TEMPLATE` is exactly the shape where a sentence gets
 * appended. Measured 2026-09-08: a banned-word sentence added to the tail
 * of that template passed all six files. Splitting keeps the head and tail
 * segments and discards the same tag interiors as before.
 */
function htmlText(literal: string): string[] {
  if (!literal.includes("<")) return [literal];
  return literal.split(/<[^<>]*>/);
}

/** Reads the literal starting at `i`; returns its body and the index past it. */
function readString(source: string, i: number): [string, number] {
  const quote = source[i];
  i++;
  let text = "";
  while (i < source.length && source[i] !== quote) {
    if (source[i] === "\\") {
      text += source[i] + (source[i + 1] ?? "");
      i += 2;
      continue;
    }
    text += source[i];
    i++;
  }
  return [text, i + 1];
}

/**
 * A template literal's `${...}` holds an expression, not copy.
 *
 * `staleness.ts`'s two rebuild sentences interpolate `${replay.total}` and
 * `${replay.completed}` — the identifier spec §0 forbids renaming, sitting
 * inside a sentence no author ever sees it in. Scanned verbatim, both were
 * reported as offenders for a word that is not in the rendered string.
 *
 * Dropping the whole expression would open a hole the other way: a template
 * can hold real copy inside one (`${done ? "Rebuilt" : "Rebuilding…"}`), and
 * `readString` swallows those quotes along with the template rather than
 * scanning them separately. So an interpolation's own string literals are
 * kept and everything else in it is dropped.
 *
 * This is used only for the banned-word test. `minStrings` and `anchor` see
 * the literal exactly as written, so they go on checking the extractor
 * against real source text.
 */
function copyOf(literal: string): string {
  let out = "";
  let i = 0;
  while (i < literal.length) {
    if (literal[i] === "$" && literal[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < literal.length && depth > 0) {
        const ch = literal[i];
        if (ch === '"' || ch === "'" || ch === "`") {
          let text: string;
          [text, i] = readString(literal, i);
          out += ` ${text} `;
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      continue;
    }
    out += literal[i];
    i++;
  }
  return out;
}

const CONSOLE_CALL = /^console\.\w+\(/;

/**
 * Copy, as against identifiers, types, imports, comments and diagnostics.
 *
 * A sequential scan rather than a regex sweep: a regex over quote characters
 * cannot tell a literal's closing quote from the next literal's opening one,
 * and pairing those two reports code as copy while hiding the copy between
 * them.
 *
 * `console.*` arguments are skipped whole. They are a developer surface —
 * CLAUDE.md's chrome://extensions Errors list — and they name the wiring by
 * its code name on purpose: `[demoman] editor: replay:policy not applied…` and
 * "the replay's delete hold on … could not be released" quote message
 * commands that spec §0 forbids renaming. Scanning them would force a
 * weakened `BANNED`, which costs far more than it buys.
 *
 * Known limitation: a regex *literal* holding an odd number of quote
 * characters (`/["]/g`) desynchronizes this scan, and the next real string is
 * swallowed whole. None of the five files carries one today. Closing it means
 * lexing regex literals — telling `/` as division from `/` as a delimiter,
 * which needs the preceding token's kind — a disproportionate amount of
 * machinery for copy scanning. If you add such a regex to one of these files,
 * the `anchor` assertion below is what will go red; rewrite the character
 * class (`/["]/`) rather than deleting the anchor.
 */
function authorFacingStrings(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    const call = c === "c" ? CONSOLE_CALL.exec(source.slice(i, i + 24)) : null;
    if (call !== null) {
      i += call[0].length;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const ch = source[i];
        if (ch === '"' || ch === "'" || ch === "`") {
          [, i] = readString(source, i);
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let text: string;
      [text, i] = readString(source, i);
      if (c === "`") out.push(...htmlText(text));
      else out.push(text);
      continue;
    }
    i++;
  }
  return out.filter((t) => /[a-z]/.test(t) && COPY_SHAPE.test(t));
}

/**
 * Copy an author reads, as against wiring an author never sees.
 *
 * This filter used to require `length >= 12` plus a whitespace character,
 * described as "sentences, not identifiers". That was true of every string
 * the guarded files held the day it was written, and blind to two of the
 * three button labels this vocabulary introduced: `"Rebuild now"` and
 * `"Rebuilding…"` are eleven characters each, so mutating
 * `REBUILDING_LABEL` to `"Rendering…"` or `REBUILD_NOW_LABEL` to
 * `"Replay it"` passed all five files. Buttons are what spec §0 is most
 * about, and the guard could not see them.
 *
 * Dropping the length rule on its own fails in the other direction: it
 * drags in exactly the wiring spec §0 forbids renaming — `z.enum(["replay",
 * "capture"])`, `REFUSAL_TEXT`'s `replaying` key, the `"replay:policy"`,
 * `"replay:gate"` and `"settings:replay"` message commands, and attribute
 * names like `data-replay-setting`.
 *
 * So the distinction drawn is **shape, not length**. Copy is written for a
 * reader: it opens with a capital, or holds a space, or ends in the `…` or
 * `→` that only a running-state or an invitation carries. Wiring is written
 * for a compiler: a single lowercase token, or lowercase tokens joined by
 * `:`, `-`, `.` or `/`, with no space and no sentence punctuation anywhere.
 * A lowercase letter is still required on top of that, so `SCREAMING_CASE`
 * and lone glyphs stay out.
 *
 * The residual risk is a capitalized single-word identifier — a `"Replay"`
 * used as a value rather than as copy would be scanned. That is the safe
 * direction to be wrong in: it costs a false red that a reviewer resolves
 * by looking, where the old rule cost a false green nobody ever saw.
 */
const COPY_SHAPE = /^[A-Z]|\s|[…→]$/;

/**
 * Two fixture guards per file, because they fail on opposite defects and the
 * expensive one is not the obvious one.
 *
 * `minStrings` catches an extractor that stopped finding copy. Each sits just
 * below the file's real count, measured on this tree.
 *
 * `anchor` catches an extractor that finds the *wrong* copy — which is what
 * the first draft of this test actually did. Its regex paired one literal's
 * closing quote with the next literal's opening quote, so it returned plenty
 * of strings (enough to clear any count) while missing every real sentence:
 * it reported 0 offenders in `capability.ts`, which had 3. A count cannot see
 * that. Naming one real sentence per file can: under that extractor every
 * anchor here is absent.
 */
const FILES: ReadonlyArray<{
  rel: string;
  minStrings: number;
  anchor: string;
  /** The rebuild left the editor on 2026-09-28 for the run page's Re-shoot,
   *  and this file's copy followed it (plan 2's final review, M2). Set only
   *  where every author-facing string was moved, so "rebuild" coming back
   *  is red rather than a drift a reviewer has to spot. */
  bansRebuild?: boolean;
}> = [
  {
    // 70 until Task 11 removed `renderMasks` (the mask panel moved into the
    // inspector's per-segment panel). Measured 82 just before Task 5 removed
    // `renderReplacements`/`replacementCandidates` and the replacements
    // list's own copy (labels, placeholders, the substitution/overlay
    // honesty paragraphs) — 77 after that, and 75 since Task 9 (the export
    // panel) dropped `OUTPUT_LABELS`' four format names and gained the
    // "Exported" and "Share (early)" section headings.
    //
    // That 75 was never re-measured across Task 6 (the approximations chip:
    // the stage bar, the popover body, `ROUTE_LABELS`) or the rest of Task 9
    // (branding controls, the Cursor panel, the export panel's own
    // sub-sections, Share) landing in this same file — all real author-facing
    // copy this guard should have been counting the whole time. Reconstructed
    // against this file exactly as those nine tasks left it, the true count
    // was 153, not 75; this task's own deletions (`renderRenderMode`,
    // `renderNotice`, `REBUILD_LABEL`/`REBUILD_NOW_LABEL`/`REBUILDING_LABEL`,
    // `renderFailure`'s retry button and its `routeError` box) took that to
    // 140. The number below is finally re-measured against what is actually
    // here, not carried forward from a stale count three tasks did not touch.
    //
    // 141 after plan 3's final review (140 before it): +1, and a false
    // positive — the per-line replacement route's button (I5) takes its
    // label from the shared `ROUTE_LABELS`, so the string counted is its
    // `"btn btn-quiet"` class, caught on the space. Floor raised to sit just
    // below the count.
    //
    // 132 after plan 2's Task 6: the approximations chip and popover left
    // `renderStageBar` (their heading, labels, "Go to step" and "Back to your
    // recording" went with them).
    //
    // 121 after plan 2's Task 7: the export's rebuild-failure row, its route
    // labels (`ROUTE_LABELS`), "Export as previewed" and the frozen count
    // left with the rebuild. The old anchor, the no-frames banner's "not been
    // rebuilt" sentence, is now the Runs route, so the anchor moved to the
    // reclaimed-motion headline's re-shoot wording.
    //
    // 120 after plan 2's final review: the no-frames link's words, "re-shoot
    // it in Runs", moved to `src/shell/runs-link.ts`'s `runsRouteClause`,
    // which picks them or "run its script again in Runs" for an authored
    // take (M1). The route links it now draws take their labels from there
    // too, so they add nothing here.
    rel: "../../../pages/entrypoints/editor/view.ts",
    minStrings: 120,
    anchor: `Motion was reclaimed to free space and shown as a still. \${rerunAdvice(state.runsRoute.authored, rerunLineOf(state.runsRoute), "to restore")}`,
  },
  {
    // A tag-less template literal, chosen so this file's anchor also holds
    // `htmlText`'s no-markup branch in place.
    rel: "../../../pages/entrypoints/library/main.ts",
    minStrings: 16,
    // Written as an escaped template so this file holds the literal text
    // `${context}` without itself interpolating.
    anchor: `Something went wrong (\${context}). Try again.`,
  },
  {
    // 36 was a floor carried from 2026-09-08. Re-measured at plan 3's final
    // review: 65 before it, 69 after — "Back to your recording" learning to
    // say there is no recording (two sentences, C1), and the two rows the
    // export's rebuild can now stop with (the take moved under it, I2; a
    // throw mid-rebuild, a folded minor).
    //
    // 74 on this tree, re-measured for the replacement-warning brief
    // (2026-09-25): the new `[demoman] editor: replacement exposures — …`
    // diagnostics line's own literal head. The gap above 69 is wider than
    // that one line accounts for on its own — this file carried other
    // in-flight edits already, on the branch, before this task started —
    // so the floor is set just below what is actually here rather than
    // guessed from the delta.
    //
    // 64 after plan 2's Task 6: the popover's lines, its way-back sentences
    // and the diagnostics line left `main.ts` with the chip.
    //
    // 50 after plan 2's Task 7: the frozen routes' alerts, the export's
    // rebuild-stop sentences and the policy's info line left with the
    // rebuild. The old anchor was one of those alerts; the new one is the
    // trim refusal's re-shoot wording.
    rel: "../../../pages/entrypoints/editor/main.ts",
    minStrings: 50,
    anchor: `This video has not been rendered yet, so there is nothing to trim to. \${rerunAdvice(route.authored, rerunLineOf(route), "first")}`,
  },
  // Joined the list on 2026-09-08. It is not an editor entry point and was
  // not in the original five, but `renderFailure`'s body — the sentence
  // under "The last rebuild stopped early" — is written here, so `view.ts`
  // being guarded said less about that box than it looked like it did.
  {
    rel: "../../../pages/src/core/replay/status.ts",
    minStrings: 4,
    // Escaped, like `library/main.ts`'s above, so this file holds the literal
    // `${replay.total}` without interpolating it. The interpolation is part of
    // what the anchor pins: `copyOf` strips it for the banned-word test, and
    // this assertion is what proves the extractor still reads it as written.
    anchor: `\${subject} \${did} all \${replay.total} steps but could not save the frames: \${why}. Nothing from it reached the store, so this page still shows the frames from before it ran — free some space and \${runsRouteClause(authored)} to try again.`,
  },
  // The three below joined on 2026-09-08, each with its copy rewritten in
  // the same pass. They are what an author reads on the timeline and in the
  // inspector — the widget whose lane label this branch had already
  // rewritten, leaving the row beneath it speaking the retired vocabulary.
  {
    rel: "../../../pages/entrypoints/editor/timeline-view.ts",
    minStrings: 13,
    anchor: `Timing from the video, not from a render — \${runsRouteClause(model.authored)} to see the timing this video will actually have.`,
  },
  {
    // 21 was carried from 2026-09-08. Re-measured at plan 3's final review:
    // 74 before it, 75 after — "Stop keeping the jump", the un-keep label
    // with rebuilding switched off (I8).
    //
    // 76 on this tree, re-measured for the replacement-warning brief
    // (2026-09-25). The new exposure warning itself (`data-replace-exposure`)
    // adds no literal here — its sentence comes from `replaceable.ts`'s
    // `replacementExposureHint`, not from a string written in this file —
    // so the gap above 75 is this file's other in-flight edits, already on
    // the branch before this task started, not this task's own copy.
    rel: "../../../pages/entrypoints/editor/inspector.ts",
    //
    // 70 on this tree after Task 5 of the editor-removals plan: the move
    // arrows, their labels and "Add a step after this one" left with insert
    // and reorder, and the estimated line was reworded (the anchor below).
    //
    // 66 after Task 6: the Keep the jump button's three labels and its
    // titles left with the button.
    //
    // 64 after Task 7: the substitution branch's sentence and the "edit Typed
    // text above" pointer left with the rebuild.
    //
    // 59 after step editing left (spec 2026-10-22 split-tool): Delete, Cut,
    // Restore step, Replace on-screen text and its warnings went.
    minStrings: 59,
    anchor:
      "Not in the video: the frames have no marker for this step, so the timeline places it from the video's own timestamp.",
  },
  // Joined on 2026-09-14 with the format switch: the export button's label
  // and the Export panel's first line are written here now, so the one file
  // most likely to say "Render" for the encode was the one file outside
  // this list. 11 strings on this tree; 12 since the 2026-09-23 export
  // panel, whose file-type labels replaced the four format labels.
  {
    rel: "../../../pages/src/editor/formats.ts",
    minStrings: 10,
    anchor: "one per step",
  },
  // Joined on 2026-09-24 (Task 10): the rebuild phase's button label and the
  // export's own rebuild-failure row (`rebuildFailureHeading`) are written
  // here now — the one place most likely to say "Render" or "replay" for the
  // rebuild `renderRenderMode` used to name. Escaped, like `library/main.ts`'s
  // and `staleness.ts`'s entries above, so this file holds the literal
  // `${run.step}`/`${run.total}` without interpolating them.
  //
  // Kept after plan 2's Task 7, though the brief listed this entry for
  // removal: the rebuild labels and the failure heading left, but the
  // running labels ("Exporting…", "Saving…") are still written here, and they
  // are exactly where "Rendering…" would creep back. 8 strings on this tree.
  {
    rel: "../../../pages/src/editor/export-run.ts",
    minStrings: 8,
    anchor: `Exporting\${which} · \${Math.floor((run.done * 100) / run.total)}%`,
  },
];

describe("author-facing copy", () => {
  for (const { rel, minStrings, anchor, bansRebuild } of FILES) {
    it(`says nothing about replay, regeneration, quality or Render in ${rel}`, () => {
      const path = fileURLToPath(new URL(rel, import.meta.url));
      const strings = authorFacingStrings(readFileSync(path, "utf8"));

      expect(
        strings.length,
        `extractor found ${strings.length} copy strings in ${rel}, expected at least ${minStrings} — the extractor is broken or the file was gutted`,
      ).toBeGreaterThanOrEqual(minStrings);

      expect(
        strings,
        `extractor did not find ${rel}'s anchor sentence, so it is reading something other than this file's copy: ${anchor}`,
      ).toContain(anchor);

      const offenders: string[] = [];
      const retiredVerb: string[] = [];
      for (const s of strings) {
        const copy = copyOf(s);
        if (BANNED.test(copy)) offenders.push(s);
        if (bansRebuild === true && /\brebuil/i.test(copy)) offenders.push(s);
        if (BANNED_CAPITALISED.test(copy)) retiredVerb.push(s);
      }
      expect(offenders, offenders.join("\n")).toEqual([]);
      expect(
        retiredVerb,
        `"Render" is the retired verb for the encode in ${rel} — the author-facing word is "Export" ("Rebuild" names the replay). Lowercase "render" describing mechanism is fine; these are not:\n${retiredVerb.join("\n")}`,
      ).toEqual([]);
    });
  }
});
