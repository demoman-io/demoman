import type { HoverVerdict } from "@demoman/compositor";

export interface HoverReport {
  /** Action ids the pixels say changed nothing. Only ever `still` verdicts. */
  removable: string[];
  /** Hovers a verdict was actually reached for. */
  checked: number;
  /** Hovers no verdict could be reached for. Never removable, always said. */
  unchecked: number;
  /**
   * `unchecked`, broken down by why. Absent on a report built by hand (the
   * failed sentinel, older fixtures), which then says the count alone; every
   * report `summarizeHoverVerdicts` builds carries it.
   */
  uncheckedBy?: Partial<Record<UncheckedReason, number>>;
  /**
   * The check itself did not complete. Distinct from `unchecked`, which means
   * it ran and declined: a crashed check that rendered as "nothing to remove"
   * would be indistinguishable from a clean take.
   */
  failed: boolean;
}

/** What the editor holds when the pass threw. Never silent. */
export const HOVER_CHECK_FAILED: HoverReport = {
  removable: [],
  checked: 0,
  unchecked: 0,
  failed: true,
};

// `notStyleSignalled` fires for a mutation-signalled or author-inserted
// `moveTo` (commands.ts inserts one with no `signal` at all) — a hover the
// pixel check was never asked to look at, not one it looked at and could not
// resolve. It is the pre-existing majority on any take with JS-driven
// hovers, so folding it into `unchecked` told the author "most of your
// hovers could not be checked" when in fact they were simply out of scope.
// Excluded from both `checked` and `unchecked` rather than given its own
// counted field: nothing downstream reads a scope count today, and a field
// no consumer reads is exactly the shape this codebase pays for elsewhere —
// add it back the day something needs to say it.
function inScope(verdict: HoverVerdict): boolean {
  return !(
    verdict.kind === "unknown" && verdict.reason === "notStyleSignalled"
  );
}

/**
 * `cutSteps` are the steps the author cut. A hover inside a cut is already
 * out of the video, so it is neither removable nor counted: offering to
 * remove it a second time is an offer with nothing behind it, and the
 * "remove them all" batch would then reach a step whose removal is a no-op
 * and report it as a removal that did not go through.
 *
 * Required rather than defaulted, for the reason `planCosmetics` takes its
 * cut set the same way: a caller that forgets it silently gets the
 * pre-cuts behaviour back.
 */
export function summarizeHoverVerdicts(
  verdicts: HoverVerdict[],
  cutSteps: ReadonlySet<string>,
): HoverReport {
  const scoped = verdicts
    .filter(inScope)
    .filter((v) => !cutSteps.has(v.actionId));
  const uncheckedBy: Partial<Record<UncheckedReason, number>> = {};
  for (const v of scoped) {
    if (v.kind === "unknown")
      uncheckedBy[v.reason] = (uncheckedBy[v.reason] ?? 0) + 1;
  }
  return {
    removable: scoped.flatMap((v) => (v.kind === "still" ? [v.actionId] : [])),
    checked: scoped.filter((v) => v.kind !== "unknown").length,
    unchecked: scoped.filter((v) => v.kind === "unknown").length,
    uncheckedBy,
    failed: false,
  };
}

type UncheckedReason = Extract<HoverVerdict, { kind: "unknown" }>["reason"];

/**
 * Each reason as the clause that follows a count ("3 had no frame close
 * enough …"). A `Record` over the whole union, so a reason added to
 * `HoverVerdict` without words here is a type error rather than a raw
 * identifier on screen — the `REASON_TEXT[reason] ?? reason` shape that once
 * made a test pass with and without its implementation.
 */
const UNCHECKED_WORDS: Record<UncheckedReason, { one: string; many: string }> =
  {
    notStyleSignalled: {
      one: "was not a style hover",
      many: "were not style hovers",
    },
    noMarker: {
      one: "had no place on the timeline",
      many: "had no place on the timeline",
    },
    noRect: {
      one: "had no recorded position",
      many: "had no recorded position",
    },
    crossFrameRect: {
      one: "was inside an embedded frame",
      many: "were inside an embedded frame",
    },
    degenerateRect: {
      one: "had a zero-size target",
      many: "had a zero-size target",
    },
    offFrame: {
      one: "was partly off screen",
      many: "were partly off screen",
    },
    cropTooSmall: {
      one: "was too small to compare",
      many: "were too small to compare",
    },
    nativeCropTooSmall: {
      one: "was too small in the recorded frames to compare",
      many: "were too small in the recorded frames to compare",
    },
    sameFrame: {
      one: "had only one frame around it",
      many: "had only one frame around them",
    },
    outOfTolerance: {
      one: "had no frame close enough to the hover",
      many: "had no frame close enough to the hover",
    },
    decodeFailed: {
      one: "had a frame that would not decode",
      many: "had frames that would not decode",
    },
  };

/**
 * "3 had no frame close enough to the hover, 1 was partly off screen" —
 * largest group first, ties in the order the probe decides them. Empty when
 * the report carries no breakdown.
 */
function uncheckedBreakdown(report: HoverReport): string {
  const entries = Object.entries(report.uncheckedBy ?? {}) as [
    UncheckedReason,
    number,
  ][];
  return entries
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => {
      const words = UNCHECKED_WORDS[reason];
      return `${n} ${n === 1 ? words.one : words.many}`;
    })
    .join(", ");
}

/**
 * What the author is told, or null when there is nothing worth saying.
 *
 * `unchecked` is reported whenever it is non-zero, even with nothing to
 * remove — a message that omitted it would read as *checked and clean* when
 * most of the take may not have been. `unchecked` folds together ten
 * distinct reasons (see `HoverProbeReason` and `HoverVerdict`'s own
 * "unknown" reasons in hover-verdict.ts), and asserting one cause for all of
 * them was that field's own defect. So it says each reason with its own
 * count, from `uncheckedBy` — never one story for the lot. Until 2026-10-10
 * it said the count alone, and "4 of 4 could not be checked" left the author
 * no way to tell missing frames from an off-screen target without a
 * debugging round.
 */
export function hoverReportText(report: HoverReport): string | null {
  if (report.failed)
    return "The hover check could not run, so nothing here has been checked.";

  const removals =
    report.removable.length > 0
      ? `${report.removable.length} hover ${
          report.removable.length === 1 ? "move" : "moves"
        } changed nothing on screen.`
      : null;
  // Names its subject: in the take notes this sentence stands alone, and
  // "4 of 4 could not be checked" read as the whole take having failed.
  const breakdown = uncheckedBreakdown(report);
  const total = report.checked + report.unchecked;
  const coverage =
    report.unchecked > 0
      ? `${report.unchecked} of ${total} ${total === 1 ? "hover" : "hovers"} could not be checked${
          breakdown === "" ? "" : `: ${breakdown}`
        }.`
      : null;

  if (removals === null && coverage === null) return null;
  return [removals, coverage].filter((part) => part !== null).join(" ");
}
