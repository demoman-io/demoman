// apps/runner/src/executor/page-ops.ts

import { fileURLToPath } from "node:url";
import type { IntentCapture } from "@demoman/replay-engine";
import type { AnchorIntent } from "@demoman/resolver";
import type { SnapshotRequest } from "@demoman/run-core";
import { type EndPage, messageOf, type SnapshotReply } from "@demoman/run-core";
import type { BrowserContext, Page } from "playwright";
import { bundleEntry } from "../bundle-js.js";
import { EXECUTOR_ENTRY_GLOBAL } from "../entry-globals.js";
import { withinDeadline } from "../page-deadline.js";

// `fileURLToPath`, never `.pathname`: a space in the install path is `%20`
// in a URL's pathname, esbuild cannot find that file, and every call would
// answer windowDidNotOpen (final review 2026-10-12, Important 7).
const ENTRY_PATH = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./executor-entry.ts"
      : "./executor-entry.js",
    import.meta.url,
  ),
);

let bundled: Promise<string> | null = null;
function entryBundle(): Promise<string> {
  bundled ??= bundleEntry(ENTRY_PATH).catch((error: unknown) => {
    bundled = null;
    throw error;
  });
  return bundled;
}

/** Every frame of every later navigation gets the entry at document start,
 *  so call this before the first navigation (as `installResolver`). On a
 *  context, every page in it, present and future, gets it: the executor
 *  opens a page per call (`BrowserSession.stage`). */
export async function installExecutorEntry(
  target: Page | BrowserContext,
): Promise<void> {
  await target.addInitScript({ content: await entryBundle() });
}

const NO_ENTRY = "the page has no Demoman entry";

/**
 * The extension's `snapshotTargets` round trip, as a `page.evaluate`. A page
 * with no entry (one the init script did not reach) is `pageSilent`, as a tab
 * with no sensor is; a walk that threw is `pageFaulted` with what it threw.
 */
export function pageSnapshotTargets(
  page: Page,
): (request: SnapshotRequest) => Promise<SnapshotReply> {
  return async (request) => {
    try {
      const walk = await withinDeadline(
        page.evaluate(
          ([global, req, noEntry]) => {
            const e = (globalThis as Record<string, unknown>)[global] as
              | { snapshotHere(r: unknown): Promise<unknown> }
              | undefined;
            if (e === undefined) throw new Error(noEntry);
            return e.snapshotHere(req);
          },
          [EXECUTOR_ENTRY_GLOBAL, request, NO_ENTRY] as const,
        ),
        "the snapshot's walk",
      );
      return {
        walk: walk as Extract<SnapshotReply, { walk: unknown }>["walk"],
      };
    } catch (error) {
      const said = messageOf(error);
      return said.includes(NO_ENTRY)
        ? {
            failed: "pageSilent",
            detail: `${NO_ENTRY} — call this again; if it answers this again, the page blocked Demoman's script`,
          }
        : { failed: "pageFaulted", detail: said };
    }
  };
}

/** The page as text (`endPageHere`), or why it could not be read. */
export async function pageEndPage(
  page: Page,
): Promise<EndPage | { unavailable: string }> {
  try {
    return (await withinDeadline(
      page.evaluate(
        ([global, noEntry]) => {
          const e = (globalThis as Record<string, unknown>)[global] as
            | { endPageHere(): Promise<unknown> }
            | undefined;
          if (e === undefined) throw new Error(noEntry);
          return e.endPageHere();
        },
        [EXECUTOR_ENTRY_GLOBAL, NO_ENTRY] as const,
      ),
      "reading the end page",
    )) as EndPage;
  } catch (error) {
    return { unavailable: `the page could not be read (${messageOf(error)})` };
  }
}

/**
 * `AuthoredDeps.captureResolved`: the sensor's `replayCapture`, as a
 * `page.evaluate`. A throw is `pageFaulted` with the page it happened on and
 * no `intentResolution` (nothing was measured), exactly as the sensor
 * answers; the message goes to the log, which is where the sensor's
 * `console.warn` would have put it.
 */
export function pageCapture(
  page: Page,
  log: (line: string) => void,
): (intent: AnchorIntent) => Promise<IntentCapture> {
  return async (intent) => {
    try {
      return (await withinDeadline(
        page.evaluate(
          ([global, i, noEntry]) => {
            const e = (globalThis as Record<string, unknown>)[global] as
              | { captureHere(x: unknown): Promise<unknown> }
              | undefined;
            if (e === undefined) throw new Error(noEntry);
            return e.captureHere(i);
          },
          [EXECUTOR_ENTRY_GLOBAL, intent, NO_ENTRY] as const,
        ),
        "a step's capture",
      )) as IntentCapture;
    } catch (error) {
      const said = messageOf(error);
      // A page the init script never reached has no entry to ask: said in
      // those words, not as the `undefined` property read it would be.
      log(
        said.includes(NO_ENTRY)
          ? `a step's capture could not run — ${NO_ENTRY} (${page.url()})`
          : `a step's capture threw in the page — ${said}`,
      );
      return {
        anchor: null,
        failureReason: "pageFaulted",
        intentResolution: null,
        pageUrl: page.url(),
        // This port checks credentials; a capture that never reached the
        // page could not, and a typed step is hidden for it (launch C).
        credentialField: null,
      };
    }
  };
}

export function measureViewport(
  page: Page,
): Promise<{ width: number; height: number }> {
  return withinDeadline(
    page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    "measuring the window",
  );
}

/** The screen the run's window is on, for `chooseRunSize`'s `screen`
 *  setting; undefined when it cannot be read, and said here first. */
export async function readScreen(
  page: Page,
  log: (line: string) => void,
): Promise<{ width: number; height: number } | undefined> {
  try {
    return await withinDeadline(
      page.evaluate(() => ({
        width: screen.width,
        height: screen.height,
      })),
      "reading the screen's size",
    );
  } catch (error) {
    // The browser's words go to the log; the caller's `chooseRunSize` then
    // answers `kind: "measure"` ("the run page could not read its screen"),
    // the run films at its measured window, and the report says so on
    // `size.error` (size.from "window").
    log(
      `the window's screen size could not be read (${messageOf(error)}); the run measures its window instead`,
    );
    return undefined;
  }
}
