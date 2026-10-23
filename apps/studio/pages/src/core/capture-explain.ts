import type { CaptureStatus } from "./storage/types";

/**
 * The capture harvester's own reasons: a take that kept its action log and
 * lost its frames, and why.
 *
 * Split out of `@demoman/replay-engine`'s `explain.ts` on 2026-09-07. That
 * file held two vocabularies in one table — the engine's stop reasons and
 * these — and the headless runner needs the first without the second. It is
 * a data split rather than a file split, which is why it was deferred until
 * a consumer made the seam obvious.
 *
 * An unmapped identifier is printed verbatim rather than swallowed or turned
 * into "something went wrong". Curt beats mysterious, and a support thread
 * can work with a literal.
 */
const CAPTURE_REASON_TEXT: Record<string, string> = {
  attachFailed: "Couldn't record the screen, so this take has no video",
  debuggerDetached: "Recording stopped partway through",
  // Its fought-for sibling. Both stop the video; only this one has already
  // tried to get it back, and the difference is what tells an author whether
  // to record again or to look at their browser.
  debuggerLost: "Recording stopped and couldn't restart",
  // Recovered: the frames resume, so this one is about a hole rather than an
  // ending, and the coverage figure beside it says how big.
  debuggerRecovered: "A stretch in the middle is missing",
  workerRestarted:
    "The extension restarted mid-take, so this take has no video",
  noKeyframes: "Nothing could be photographed, so there's no video",
  screencastUnavailable: "Motion couldn't be recorded, so this take is stills",
  muxFailed: "The motion couldn't be encoded, so this take is stills",
  muxUnavailable:
    "There was nowhere to encode the motion, so this take is stills",
  budgetSpent: "The take outran its motion budget, so the rest is stills",
  credentialSuspended: "Motion paused while you typed in a password field",
  motionIncomplete: "Some motion couldn't be saved, so parts are stills",
  motionInterrupted: "Recording was interrupted, so parts are stills",
  spansDiscarded:
    "Some motion couldn't be encoded, so those moments are stills",
  storageRefused:
    "This take's frames couldn't be saved — free up space and record it again",
  // Not the disk: the frames were recorded and the bundle that indexes them
  // failed validation, so there was nothing valid to store. Recording again
  // may well hit it again, and the detail after the colon is what to report.
  bundleInvalid: "This take's video couldn't be put together",
};

/**
 * The browser's own debugger-detach reasons, in the author's words. They
 * arrive as the `reason` the extension's `onDetach` listener is handed, and
 * are named here as plain strings — this file is under `core/`, which the
 * boundary test keeps free of any reach for an extension API.
 *
 * The browser knows exactly why it let go, and until 2026-09-26 this file
 * guessed instead: `debuggerDetached` read "the Cancel on its infobar, most
 * likely" whatever Chrome had actually said. A take that lost its frames to
 * DevTools opening, to a closed tab or to a dead renderer all read as the
 * author cancelling — a sentence that fires whether or not anyone knows what
 * happened, which is the defect class CLAUDE.md opens with.
 *
 * Unmapped values print verbatim, for the same reason `CAPTURE_REASON_TEXT`
 * does: Chrome may add reasons, and a literal a support thread can search
 * beats a sentence that has lost the fact.
 */
const DETACH_REASON_TEXT: Record<string, string> = {
  canceled_by_user: "you cancelled it on the debugging bar",
  // NOT "the tab was closed", which this said for a few hours on
  // 2026-09-26 and which is a claim the browser does not make. The word
  // means the target being recorded is gone; a tab close is one cause, and
  // on a real site the likelier ones are a navigation that swapped the
  // page's process, a discarded tab, or a prerender activating. The take
  // that found it went on recording actions for fourteen seconds after the
  // detach, which a closed tab cannot do.
  target_closed: "the page was replaced",
  replaced_with_devtools: "DevTools took the tab",
  render_process_gone: "the page crashed",
};

/** The reasons whose detail is a reason Chrome gave for a detach. */
const DETACH_KEYS = new Set([
  "debuggerDetached",
  "debuggerLost",
  "debuggerRecovered",
]);

/** Own keys only: a detail like "constructor" is not a detach reason. */
const detachText = (detail: string): string =>
  Object.hasOwn(DETACH_REASON_TEXT, detail)
    ? (DETACH_REASON_TEXT[detail] as string)
    : detail;

/**
 * A reason, optionally carrying a detail after a colon: the producer keeps
 * the mapped key so the sentence survives, and appends what it was told so
 * the fact does too. Two vocabularies ride there: the detach reasons'
 * detail is a word Chrome gave, translated through `DETACH_REASON_TEXT`;
 * `storageRefused` and `bundleInvalid` carry an error's own text, printed
 * as it is — looked up in the detach table, an error that happened to read
 * "target_closed" or "constructor" printed something it never said.
 */
function captureReasonSentence(reason: string): string {
  const whole = CAPTURE_REASON_TEXT[reason];
  if (whole !== undefined) return whole;

  const sep = reason.indexOf(":");
  if (sep > 0) {
    const key = reason.slice(0, sep);
    const base = CAPTURE_REASON_TEXT[key];
    const detail = reason.slice(sep + 1);
    if (base !== undefined && detail !== "") {
      return `${base} — ${DETACH_KEYS.has(key) ? detachText(detail) : detail}`;
    }
  }
  return reason;
}

/**
 * What the take's motion recording has to say, or null when it has nothing.
 *
 * Null for both healthy states — a full recording and a genuinely static
 * page — because a surface that says something on every take teaches the
 * author to ignore it. `motion: "none"` with `reason: null` is the static
 * page and is not a problem.
 */
export function captureSentence(status: CaptureStatus): string | null {
  // `== null`, deliberately: the type says `string | null`, but rows come
  // out of IndexedDB by cast rather than by parse, so a take stored before
  // this field existed arrives with it absent. The old lookup was total and
  // printed the literal "undefined" beside a coverage figure; the split
  // below is not, and threw out of the editor's render.
  if (status.reason == null) return null;
  // Never 0s for a nonzero duration: the guard below admits any coveredMs
  // above zero, and a plain round would print "(0s of 0s recorded)" beside
  // a sentence saying motion was kept.
  const seconds = (ms: number): string =>
    `${ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0}s`;
  const coverage =
    status.coveredMs > 0
      ? ` (${seconds(status.coveredMs)} of ${seconds(status.takeMs)} recorded)`
      : "";
  return `${captureReasonSentence(status.reason)}${coverage}`;
}
