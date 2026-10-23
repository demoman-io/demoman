import {
  SETTLE_PAINT_TIMEOUT_MS,
  SETTLE_QUIET_TIMEOUT_MS,
  WAIT_POLL_MS,
  WAIT_TIMEOUT_MS,
} from "./constants.js";
import { type SettleReport, settlePaintExpression } from "./settle.js";
import type { CdpSession } from "./types.js";

/** Whether a page is loaded and painted, and why not when it is not. `note`
 *  is null exactly when `settled` is true. */
export interface PageReady {
  settled: boolean;
  note: string | null;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `document.readyState` until `complete` (polled for at most the walk's own
 * `WAIT_TIMEOUT_MS`), then the settle probe — the two waits a script's
 * `waitForLoad` makes, for a caller that is not a walk.
 *
 * Not shared with `walk.ts`: the walk's version records degradations into the
 * take and this one has no take. Both read the same constants and the same
 * probe expression, so they wait the same amount for the same thing.
 *
 * Never answers settled for a page it could not confirm: a document still
 * loading, a probe that threw, a reply it could not read, images still
 * pending, and a document still changing each come back `settled: false`
 * with the reason.
 */
export async function waitForPageReady(
  cdp: CdpSession,
  sleep: (ms: number) => Promise<void>,
): Promise<PageReady> {
  let state = "unknown";
  for (let waited = 0; ; waited += WAIT_POLL_MS) {
    const reply = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    const value = (reply.result as { value?: unknown } | undefined)?.value;
    state = typeof value === "string" ? value : "unknown";
    if (state === "complete" || waited >= WAIT_TIMEOUT_MS) break;
    await sleep(WAIT_POLL_MS);
  }
  if (state !== "complete") {
    return {
      settled: false,
      note: `the document was still "${state}" after ${WAIT_TIMEOUT_MS / 1000} s`,
    };
  }
  let report: SettleReport | undefined;
  try {
    const reply = await cdp.send("Runtime.evaluate", {
      expression: settlePaintExpression(SETTLE_PAINT_TIMEOUT_MS),
      awaitPromise: true,
      returnByValue: true,
    });
    report = (reply.result as { value?: SettleReport } | undefined)?.value;
  } catch (error) {
    return {
      settled: false,
      note: `the page-settle probe failed (${describe(error)})`,
    };
  }
  if (report === undefined || typeof report.settled !== "boolean") {
    return {
      settled: false,
      note: "the page-settle probe answered with nothing this could read",
    };
  }
  if (!report.settled && report.quiet === false && report.pending === 0) {
    return {
      settled: false,
      note: `the page was still changing after ${SETTLE_QUIET_TIMEOUT_MS / 1000} s (its images were in; a loading bar, or an app still connecting)`,
    };
  }
  if (!report.settled) {
    return {
      settled: false,
      note: `${report.pending} image(s) near the top were still loading after ${SETTLE_PAINT_TIMEOUT_MS / 1000} s`,
    };
  }
  return { settled: true, note: null };
}
