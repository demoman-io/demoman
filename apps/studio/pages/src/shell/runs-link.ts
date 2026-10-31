// apps/studio/pages/src/shell/runs-link.ts
import { runsRouteClause } from "@demoman/run-core";

// `isAuthoredScene` and `runsRouteClause` moved to @demoman/run-core
// (launch prep defect 2, 2026-10-14). Re-exported so this module's
// importers are unchanged.
export { isAuthoredScene, runsRouteClause } from "@demoman/run-core";

/** The run page with one take chosen in its picker — `run.html?take=<id>`
 *  (spec §1, amended 2026-09-28). Preselects only; nothing runs until a
 *  person presses. Relative, so it resolves against whichever extension
 *  page holds it; the library navigates through `chrome.runtime.getURL`. */
export function runsHref(takeId: string): string {
  return `run.html?take=${encodeURIComponent(takeId)}`;
}

/**
 * One take's route to Runs, and whether it was made by a script.
 *
 * The flag decides what the route is FOR. A recorded take is re-shot there;
 * an authored take cannot be (Re-shoot refuses it with `authoredTake`: its
 * frames are the only ones it has), and the run page derives its script
 * instead, whose Run makes a new take. Words that said "re-shoot" to an
 * authored take routed the author into that refusal (final review M1).
 */
export interface RunsRoute {
  takeId: string;
  authored: boolean;
  /** `nav.rerun`'s answer for this take: a link to draw, or the line that
   *  replaces every link where there is no Runs page. */
  rerun:
    | { kind: "link"; href: string; label: string }
    | { kind: "line"; text: string };
}

/** The same, as a link's own label: "Re-shoot this video in Runs" or "Run
 *  its script again in Runs". */
export function runsRouteLabel(authored: boolean): string {
  return authored
    ? "Run its script again in Runs"
    : "Re-shoot this video in Runs";
}

/** The clause opening a sentence: "Re-shoot it in Runs" or "Run its script
 *  again in Runs". Derived from `runsRouteClause`, never a second copy. */
export function runsRouteSentence(authored: boolean): string {
  const clause = runsRouteClause(authored);
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/** The platform's own line for this take where it answers with one — the
 *  studio, which has no Runs page to name — and null where it answers with
 *  a link. */
export function rerunLineOf(route: RunsRoute): string | null {
  return route.rerun.kind === "line" ? route.rerun.text : null;
}

/**
 * An advice sentence on filming this take again that ends in `tail`:
 * "Re-shoot it in Runs first." where the platform answers with a link —
 * today's words, exactly — and the platform's `line`, whole, where it answers
 * with one. That line is a sentence of its own ending in a code span, so
 * nothing is spliced onto it (ruling R18): "Ask your agent … first." would
 * put the tail after the call it names.
 */
export function rerunAdvice(
  authored: boolean,
  line: string | null,
  tail: string,
): string {
  return line ?? `${runsRouteSentence(authored)} ${tail}.`;
}
