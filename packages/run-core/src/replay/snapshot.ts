import {
  applyDevice,
  type CdpSession,
  desktopMetrics,
  waitForPageReady,
} from "@demoman/replay-engine";
import { type DeviceId, deviceFor } from "@demoman/scene-schema";
import type { SnapshotKits } from "../brand-kit.js";
import { messageOf } from "../run-host.js";
import {
  SNAPSHOT_BUDGET_MS,
  SNAPSHOT_MAX_TARGETS,
  type SnapshotRequest,
  type SnapshotTarget,
  type SnapshotWalk,
} from "../snapshot-walk.js";
import type { RunSize, RunSizePlan } from "./run-size.js";

/** One `snapshotTargets` round trip's answer (moved from resolve-bridge.ts). */
export type SnapshotReply =
  | { walk: SnapshotWalk }
  | { failed: "pageSilent" | "pageFaulted"; detail: string };

/** What `snapshot(url)` answers (spec 2026-10-01-agent-bridge §4.2, with
 *  plan 2's additive fields). */
export interface Snapshot {
  url: string;
  /** Where the page actually is after load, unscrubbed: it goes only to the
   *  user's own agent, which supplied `url`. Null when it could not be read. */
  landedUrl: string | null;
  /** The signed-out signal (gap 4 (b)). Null when `landedUrl` is. */
  landedElsewhere: boolean | null;
  title: string;
  settled: boolean;
  settleNote: string | null;
  targets: SnapshotTarget[];
  unresolvable: number;
  notExamined: number;
  walkMs: number;
  /** The phone or tablet the page was seen as; null for the desktop
   *  (spec 2026-10-10 §3). */
  device: DeviceId | null;
  /** The size the page was laid out at, which `inFirstViewport` is measured
   *  against — the size a run with the same device, or none, films. Null
   *  only when even the window's own size could not be read. */
  size: RunSize | null;
}

export type SnapshotOutcome =
  | { ok: true; value: Snapshot }
  | { ok: false; reason: string; detail: string };

/** What the run page answers a snapshot with: the stage's snapshot plus the
 *  kits, which the page reads (`run/view.ts`), not the stage. */
export type PageSnapshotOutcome =
  | { ok: true; value: Snapshot & { kits: SnapshotKits } }
  | { ok: false; reason: string; detail: string };

/** Whether `landed` is a different page from `asked`: compared as parsed
 *  URLs, ignoring a trailing slash and a hash the app dropped or kept, so
 *  `http://x/faq` and `http://x/faq/#faq` are the same page while a hash
 *  router's `#/login` is not. A URL that does not parse is compared as
 *  written. */
export function landedElsewhere(asked: string, landed: string): boolean {
  const parts = (raw: string): { page: string; hash: string } => {
    const url = new URL(raw);
    const { hash } = url;
    url.hash = "";
    // `/faq` and `/faq/` are one page to the app that answers both, and a
    // static host or an APPEND_SLASH server redirects between them.
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return { page: url.href, hash };
  };
  try {
    const a = parts(asked);
    const l = parts(landed);
    // A hash the app CHANGED TO is a move (a hash router's `#/login`); one it
    // dropped, or the one asked for, is the same page.
    return a.page !== l.page || (l.hash !== "" && l.hash !== a.hash);
  } catch {
    return asked !== landed;
  }
}

/** The part of a staged run a snapshot uses — a seam, so the order of work
 *  is testable without `chrome`. */
export interface SnapshotStage {
  cdp: CdpSession;
  occlusion: { install(): Promise<void> };
  sleep(ms: number): Promise<void>;
  snapshotTargets(request: SnapshotRequest): Promise<SnapshotReply>;
  /** The stage window's own page size, for a snapshot that could not be
   *  laid out at the run's. */
  measureViewport(): Promise<{ width: number; height: number }>;
}

/**
 * Load `url` on an open stage and list its targets.
 *
 * `Page.enable` first: the navigation that rides the occlusion guard's
 * install waits for `Page.loadEventFired`, which never fires with the Page
 * domain off — the engine enables it before install, and so must this.
 *
 * A page that never settled is still walked, and says so (`settled`,
 * `settleNote`): an agent with a half-drawn page's targets is better served
 * than one with none, as long as it is told.
 */
export async function snapshotOnStage(
  stage: SnapshotStage,
  url: string,
  contains: string | null,
  device: DeviceId | null,
  desktop: RunSizePlan,
): Promise<SnapshotOutcome> {
  await stage.cdp.send("Page.enable", {});
  // Before the navigation `install()` makes, so the page loads as the phone a
  // run will film (spec 2026-10-10 §3). A refusal is said, and nothing is
  // listed: desktop targets offered for a phone run are targets it misses.
  let size: RunSize | null = null;
  /** Why the page is at the window's own size, when it is. */
  let windowError: string | null = null;
  if (device !== null) {
    const preset = deviceFor(device);
    try {
      await applyDevice(stage.cdp, preset);
    } catch (error) {
      return { ok: false, reason: "deviceFailed", detail: messageOf(error) };
    }
    size = {
      width: preset.width,
      height: preset.height,
      from: "device",
      error: null,
    };
  } else if (desktop.kind === "fixed") {
    // The desktop at the size a run with no viewport films (2026-10-11), so
    // `inFirstViewport` describes that video and not the hidden stage
    // window. Forgiven when refused — a list is still worth having — but
    // said on `size`, so the agent knows the layout is not the run's.
    try {
      await stage.cdp.send(
        "Emulation.setDeviceMetricsOverride",
        desktopMetrics(desktop.size),
      );
      size = desktop.size;
    } catch (error) {
      windowError = `the browser would not lay the page out at ${desktop.size.width}x${desktop.size.height} (${messageOf(error)})`;
    }
  } else {
    windowError = desktop.error;
  }
  if (windowError !== null) {
    console.warn(
      `demoman snapshot: ${windowError}; listing the run window's own layout`,
    );
  }
  await stage.occlusion.install();
  const ready = await waitForPageReady(stage.cdp, stage.sleep);

  let landedUrl: string | null = null;
  try {
    const reply = await stage.cdp.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
    const value = (reply.result as { value?: unknown } | undefined)?.value;
    if (typeof value === "string") landedUrl = value;
  } catch (error) {
    // Said, and answered as null — "could not tell", which the recipe says is
    // not an all-clear. The walk is still worth having.
    console.info(
      `demoman snapshot: the page's URL could not be read (${messageOf(error)})`,
    );
  }

  // The browser's own error page (the app is down, or on another port) has
  // no Demoman sensor, so walking it would answer pageSilent, "reload the
  // page" — the reason is known here, so it is said here.
  if (landedUrl?.startsWith("chrome-error:")) {
    console.info(`demoman snapshot: ${url} did not load (${landedUrl})`);
    return {
      ok: false,
      reason: "pageDidNotLoad",
      detail: `${url} did not load — the browser showed its own error page instead; check that the app is running at that address`,
    };
  }

  const reply = await stage.snapshotTargets({
    contains,
    maxTargets: SNAPSHOT_MAX_TARGETS,
    budgetMs: SNAPSHOT_BUDGET_MS,
  });
  if ("failed" in reply) {
    return { ok: false, reason: reply.failed, detail: reply.detail };
  }
  const { walk } = reply;
  if (size === null) {
    try {
      const measured = await stage.measureViewport();
      size = { ...measured, from: "window", error: windowError };
    } catch (error) {
      // Null is "could not tell", which is what this is; the reason the
      // window was used at all was warned above.
      console.info(
        `demoman snapshot: the window's own size could not be read either (${messageOf(error)})`,
      );
    }
  }
  return {
    ok: true,
    value: {
      url,
      landedUrl,
      landedElsewhere:
        landedUrl === null ? null : landedElsewhere(url, landedUrl),
      title: walk.title,
      settled: ready.settled,
      settleNote: ready.note,
      targets: walk.targets,
      unresolvable: walk.unresolvable,
      notExamined: walk.notExamined,
      walkMs: walk.walkMs,
      device,
      size,
    },
  };
}
