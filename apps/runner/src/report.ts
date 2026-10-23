/**
 * Where a forgiven failure says why.
 *
 * Runner audit 2026-09-14, finding 1. Four sites — the mux's span failure,
 * the parking encoder's dropped frame, the page agent's routing
 * diagnostics and `launch.ts`'s crash warning — wrote straight to
 * `console.warn`/`console.error`. The CLI's real entry point happens to
 * wire `io.err` to the same stream, so a terminal user saw them; an
 * in-process consumer of `main(argv, io, run)` — the door `index.ts` exists
 * for — never did, and a terminal read them ABOVE the result sentence they
 * explain, because they fired mid-run or from the pipeline's `finally`.
 *
 * This is the port those sites speak through instead. `runPipeline` wires
 * it to the result's `notes`, which its caller says after the result. It
 * is deliberately required, never optional with a console default: a
 * default that speaks somewhere else is the same channel a caller can
 * forget, which is the defect this exists to close.
 *
 * CLAUDE.md's "give the swallow somewhere to speak" — this is the
 * somewhere. `createCaptureHarvester`'s `onShotFailed` is the extension's
 * worked example of the same shape.
 */
export type Report = (line: string) => void;

/** An error's own words, whatever was thrown: run-core's, re-exported so
 *  every module that speaks through `Report` has it here (review of the
 *  runner audit, finding 10: five byte-identical private copies; review
 *  2026-10-13, #9: this was a sixth). */
export { messageOf } from "@demoman/run-core";
