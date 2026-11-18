// apps/studio/pages/src/shell/runs-link.ts
// `isAuthoredScene` and `runsRouteClause` moved to @demoman/run-core
// (launch prep defect 2, 2026-10-14). Re-exported so this module's
// importers are unchanged.
export { isAuthoredScene, runsRouteClause } from "@demoman/run-core";

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
  /** `nav.rerun`'s answer for this take: the line naming the agent call
   *  that films it again. */
  rerun: string;
}
