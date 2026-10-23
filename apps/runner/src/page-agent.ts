import { fileURLToPath } from "node:url";
import type {
  PageAgent,
  ResolveFailure,
  ResolveReport,
} from "@demoman/replay-engine";
import {
  type SerializedReport,
  stripLeadingHop,
} from "@demoman/replay-engine/page";
import {
  type AnchorIntent,
  type FrameHop,
  parseTreePath,
} from "@demoman/resolver";
import type { BrowserContext, Frame, Page } from "playwright";
import { bundleEntry } from "./bundle-js.js";
import { ENTRY_GLOBAL } from "./entry-globals.js";
import { withinDeadline } from "./page-deadline.js";
import { messageOf, type Report } from "./report.js";

/**
 * The in-page entry, as this module is running: `src/resolve-entry.ts` under
 * vite-node, `dist/resolve-entry.js` from the shipped CLI. Decided from this
 * module's own extension rather than by probing the filesystem — a probe
 * that fell back to the other candidate would paper over a `dist` that never
 * got built, and esbuild's own "could not resolve" names the path anyway.
 */
const ENTRY_PATH = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./resolve-entry.ts"
      : "./resolve-entry.js",
    import.meta.url,
  ),
);

/**
 * Bundled once per process. A rejection is not cached: the next call must be
 * able to try again, and must see the real esbuild error rather than a
 * remembered one with no context.
 */
let bundled: Promise<string> | null = null;
function resolverBundle(): Promise<string> {
  bundled ??= bundleEntry(ENTRY_PATH).catch((error: unknown) => {
    bundled = null;
    throw error;
  });
  return bundled;
}

/**
 * Puts the resolver in every frame of `page`, present and future.
 *
 * `addInitScript` runs at document start in every frame, cross-origin ones
 * included, which is what lets the agent evaluate in a frame it has just
 * walked into. Call it before the first navigation: a frame that already has
 * a document when this runs does not get the script until it navigates
 * again, and the agent would then throw naming the missing global rather
 * than resolve against a page it cannot reach. Given a context, every page
 * in it gets the script, including pages opened later.
 */
export async function installResolver(
  target: Page | BrowserContext,
): Promise<void> {
  await target.addInitScript({ content: await resolverBundle() });
}

/** `report`, once per key: the engine re-resolves the same anchor once per
 *  poll inside `awaitCondition` (every 150ms, for up to 10s) and again for
 *  every later action that names it, so a line about the ANCHOR — as
 *  opposed to one about an event — would otherwise be appended to the
 *  result dozens of times (review of the runner audit, finding 7). The
 *  engine's own forgiven failures carry a once-per-span guard for the same
 *  reason. */
type ReportOnce = (key: string, line: string) => void;

/** The frame hop an anchor's path *leads* with, or null if it does not. */
function leadingHop(
  anchor: AnchorIntent,
  reportOnce: ReportOnce,
): FrameHop | null {
  const path = anchor.fingerprint.treePath;
  if (path === null) return null;
  let segments: ReturnType<typeof parseTreePath>;
  try {
    segments = parseTreePath(path);
  } catch {
    // A malformed path costs this signal and nothing else, which is exactly
    // what the resolver's own `frameHopOf` does with the same throw. The
    // anchor is resolved against this document and reported on its merits;
    // diverging here would make the runner and the extension disagree about
    // the same scene, which is worse than agreeing with a known limit.
    //
    // The control flow is forgiven; the reason is not. This is the one path
    // on which a *framed* anchor is resolved against the top document, and
    // it can come back `resolved: true, strategy: "stableId"` pointing at a
    // stranger's element — a failure reporting exactly what a success
    // reports, with no other channel to say so. An expected outcome, not a
    // fault — it still owes a reason.
    //
    // Through the injected reporter, never the console (report.ts): this
    // used to be a `console.error`, which kept it off stdout — `cli.ts`'s
    // result channel — but also kept it off `RunnerIo`, so an in-process
    // caller never saw it, and a terminal saw it mid-replay, above the
    // result it belongs under. `runPipeline` carries it on `notes` now.
    // Once per anchor id — see `ReportOnce`.
    reportOnce(
      anchor.id,
      `demoman: anchor "${anchor.id}" has an unparseable tree path ` +
        `(${path}) — resolving it against the top document. If it was ` +
        "captured inside a frame, the element found is not the one recorded.",
    );
    return null;
  }
  const first = segments[0];
  return first !== undefined && first.kind === "frame" ? first.hop : null;
}

type Routed =
  | { kind: "frame"; frame: Frame; anchor: AnchorIntent }
  | { kind: "failed"; failureReason: ResolveFailure };

/**
 * Whether an error from `frame.evaluate`/`evaluateHandle` means the page
 * moved under us mid-resolve rather than that anything is wrong here.
 *
 * Task 8's deferred minor, triaged into the whole-branch review's finding 2:
 * a frame that navigates while a resolve is in flight rejects the evaluate
 * with "Execution context was destroyed, most likely because of a
 * navigation", and — with no catch — that rejection took the whole
 * `PageAgent.resolve` down, out of `runReplay`, and into cli.ts's exit-70
 * "this is a bug in the runner" bucket. It is not a bug in the runner: it is
 * a page that was not reachable at the moment it was asked, which is exactly
 * what `notReachable` already means to replay (it asks the author to re-run,
 * not to re-record).
 *
 * Matched by message, narrowly and deliberately. Playwright has no error
 * code to switch on here, and the alternative — treating EVERY evaluate
 * rejection as `notReachable` — would swallow the two throws this file
 * raises on purpose ("<global> is not installed in this frame"), which are
 * real faults and must keep escaping.
 */
const NAVIGATION_RACE =
  /execution context was destroyed|frame (was |got )?detached|target (page|frame)?,? ?(context )?(was )?closed|navigating and changing the content/i;

function isNavigationRace(error: unknown): boolean {
  return error instanceof Error && NAVIGATION_RACE.test(error.message);
}

/**
 * The iframe a hop names, as a Playwright `Frame` to evaluate in.
 *
 * The match itself is `@demoman/resolver`'s `findFrameElement`, reached
 * through the in-page entry — the same function `frameTarget` uses when the
 * resolver routes a hop itself, so the runner and the extension agree about
 * which frame a hop is about, and about when it cannot tell.
 */
async function frameForHop(
  frame: Frame,
  hop: FrameHop,
): Promise<Routed | { kind: "ok"; frame: Frame }> {
  const handle = await withinDeadline(
    frame.evaluateHandle(
      ([globalName, wanted]) => {
        const entry = (
          globalThis as unknown as Record<
            string,
            { frameElementForHop(h: unknown): Element | null } | undefined
          >
        )[globalName as string];
        // Named rather than optional-chained. `?.` here returned null, which
        // this function reads as "no iframe answers to that hop" -- so a page
        // the entry was never injected into reported `frameGone`, the same
        // thing a genuinely missing frame reports, and the author would be
        // sent to re-record a step against a page that never had a resolver.
        if (entry === undefined) {
          throw new Error(
            `${globalName} is not installed in this frame (${location.href}) — ` +
              "installResolver must run before the first navigation",
          );
        }
        return entry.frameElementForHop(wanted);
      },
      [ENTRY_GLOBAL, hop] as const,
    ),
    "finding a step's frame",
  );
  const element = handle.asElement();
  if (element === null) {
    await handle.dispose();
    // No iframe in this document answers to the hop. Reported as such, and
    // never by falling through to a resolve against this document: an anchor
    // captured behind a frame that is gone would then be matched against the
    // parent's own DOM, where it either finds a same-named element (the
    // wrong one, clicked confidently) or reports a healthy anchor broken.
    return { kind: "failed", failureReason: "frameGone" };
  }
  try {
    const child = await element.contentFrame();
    return child === null
      ? // The iframe element is there; its document is not reachable as a
        // frame. Distinct from `frameGone` for the reason the resolver keeps
        // them distinct: this asks the author to re-run, `frameGone` asks
        // them to re-record.
        { kind: "failed", failureReason: "frameUnreachable" }
      : { kind: "ok", frame: child };
  } finally {
    await element.dispose();
  }
}

/**
 * Walks an anchor into the frame that owns its element.
 *
 * One `frame` segment at a time, `stripLeadingHop` once per boundary
 * crossed, until the path leads with something that is not a frame. That
 * pairing is the contract: `stripLeadingHop` strips exactly one *leading*
 * hop, and a production path's hops are all leading and contiguous — the
 * sensor's `prefixTreePath` prepends them to a path `buildTreePath` built
 * inside the owning frame.
 */
async function routeAnchor(
  page: Page,
  anchor: AnchorIntent,
  report: Report,
  reportOnce: ReportOnce,
): Promise<Routed> {
  let frame = page.mainFrame();
  let current = anchor;
  try {
    for (;;) {
      const hop = leadingHop(current, reportOnce);
      if (hop === null) return { kind: "frame", frame, anchor: current };
      const step = await frameForHop(frame, hop);
      if (step.kind !== "ok") return step;
      frame = step.frame;
      current = stripLeadingHop(current);
    }
  } catch (error) {
    // Walking into the frame raced a navigation — see `isNavigationRace`.
    // Anything else is a real fault and keeps escaping.
    if (!isNavigationRace(error)) throw error;
    report(
      `demoman: anchor "${anchor.id}" could not be routed into its frame — ` +
        `the page navigated mid-resolve (${messageOf(error)}). Reported as ` +
        "notReachable.",
    );
    return { kind: "failed", failureReason: "notReachable" };
  }
}

/**
 * How a resolver report reads to replay. Kept identical to the extension's
 * `createSensorPageAgent`: `ambiguous` is not a resolution, because clicking
 * one of several tied candidates is how a replay clicks the wrong row, and
 * the resolver's own `failureReason` is carried through rather than
 * recomputed — it already knows whether the element is gone, tied, or simply
 * not rendered yet, and those are three different things to tell an author.
 */
function readReport(anchorId: string, report: SerializedReport): ResolveReport {
  return {
    anchorId,
    strategy: report.strategy,
    resolved: report.strategy !== "broken" && report.strategy !== "ambiguous",
    failureReason: report.failureReason,
  };
}

/**
 * The `PageAgent` port with no extension behind it: the real resolver,
 * injected into the page, driven from node over Playwright.
 *
 * **It routes by hop before the resolver sees the anchor.** That is the
 * whole design, and it is here rather than in the resolver because parking
 * is *replay's* requirement, not resolution's — so the routing belongs
 * wherever replay asks for resolution, which is this caller. The badge only
 * ever wants a verdict and would pay a same-origin round trip for nothing.
 *
 * What it buys, concretely: the element is resolved *in the frame that owns
 * it*, against a path with that frame's hop already stripped. Without the
 * walk, a same-origin child is resolved by the top document through
 * `contentDocument` against a path that still names the iframe it is already
 * inside, so the tree-path tier — the only tier an unlabelled element has —
 * can never match. (It would still park in the right realm; that half was
 * fixed in `resolveForReplay` on 2026-09-07, after the spike that found it.)
 */
export function createHeadlessPageAgent(page: Page, report: Report): PageAgent {
  const said = new Set<string>();
  const reportOnce: ReportOnce = (key, line) => {
    if (said.has(key)) return;
    said.add(key);
    report(line);
  };
  return {
    async resolve(anchors: AnchorIntent[]): Promise<ResolveReport[]> {
      const routed = await Promise.all(
        anchors.map((anchor) => routeAnchor(page, anchor, report, reportOnce)),
      );

      // Grouped by frame, one round trip per frame rather than one per
      // anchor — the same reason `FrameBroker.resolveInFrame` is batched.
      const groups = new Map<
        Frame,
        { index: number; anchor: AnchorIntent }[]
      >();
      const out: ResolveReport[] = new Array(anchors.length);
      routed.forEach((entry, index) => {
        const anchorId = anchors[index]?.id ?? "";
        if (entry.kind === "failed") {
          out[index] = {
            anchorId,
            strategy: "broken",
            resolved: false,
            failureReason: entry.failureReason,
          };
          return;
        }
        const group = groups.get(entry.frame);
        if (group === undefined)
          groups.set(entry.frame, [{ index, anchor: entry.anchor }]);
        else group.push({ index, anchor: entry.anchor });
      });

      await Promise.all(
        Array.from(groups, async ([frame, entries]) => {
          let reports: SerializedReport[];
          try {
            reports = (await withinDeadline(
              frame.evaluate(
                ([globalName, list]) => {
                  const entry = (
                    globalThis as unknown as Record<
                      string,
                      { resolveHere(a: unknown): Promise<unknown> } | undefined
                    >
                  )[globalName as string];
                  // Same reason as `frameForHop`'s check: say which name was
                  // missing and where, rather than leaving a bare "cannot read
                  // properties of undefined" for someone to trace back.
                  if (entry === undefined) {
                    throw new Error(
                      `${globalName} is not installed in this frame (${location.href}) — ` +
                        "installResolver must run before the first navigation",
                    );
                  }
                  return entry.resolveHere(list);
                },
                [ENTRY_GLOBAL, entries.map((e) => e.anchor)] as const,
              ),
              "resolving a step's target",
            )) as SerializedReport[];
          } catch (error) {
            // The frame navigated (or went away) between being routed to
            // and being asked — see `isNavigationRace`. Every anchor in
            // this group is reported `notReachable` rather than taking the
            // whole `resolve` down as an exit-70 internal error; the real
            // message goes to the reporter so the reason is never lost.
            if (!isNavigationRace(error)) throw error;
            report(
              `demoman: ${entries.length} anchor(s) could not be resolved — ` +
                `the frame navigated mid-resolve (${messageOf(error)}). ` +
                "Reported as notReachable.",
            );
            for (const { index } of entries) {
              out[index] = {
                anchorId: anchors[index]?.id ?? "",
                strategy: "broken",
                resolved: false,
                failureReason: "notReachable",
              };
            }
            return;
          }
          entries.forEach(({ index }, position) => {
            const anchorId = anchors[index]?.id ?? "";
            const report = reports[position];
            out[index] =
              report === undefined
                ? // The frame answered with fewer reports than it was asked
                  // about. Not silence — it answered — but this anchor was
                  // not among the answers, and reporting it as a plain
                  // unresolved anchor would send the author to re-record a
                  // step nothing is known to be wrong with.
                  {
                    anchorId,
                    strategy: "broken",
                    resolved: false,
                    failureReason: "notReachable",
                  }
                : // Matched by position, not by anchor id: SceneDocument
                  // does not require anchor ids to be unique, and keying by
                  // id would let two anchors that share one collapse onto a
                  // single, order-dependent report. `resolveAll` preserves
                  // the order it was given.
                  readReport(anchorId, report);
          });
        }),
      );
      return out;
    },
  };
}
