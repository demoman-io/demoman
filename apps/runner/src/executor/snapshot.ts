// apps/runner/src/executor/snapshot.ts
import { failure, type Outcome } from "@demoman/agent-bridge";
import {
  createNavigatingGuard,
  createOcclusionGuard,
} from "@demoman/replay-engine";
import {
  chooseRunSize,
  DEFAULT_RUN_SIZE,
  isHttpUrl,
  kitsForSnapshot,
  messageOf,
  snapshotOnStage,
} from "@demoman/run-core";
import {
  DEVICE_IDS,
  type DeviceId,
  DeviceIdSchema,
} from "@demoman/scene-schema";
import type { BrowserContext } from "playwright";
import type { BrowserSession } from "./browser.js";
import { readKits } from "./kits.js";
import { landingVerdict, readLandingFacts } from "./landing.js";
import { measureViewport, pageSnapshotTargets } from "./page-ops.js";
import type { SessionsLoaded } from "./session-loader.js";
import type { SessionChoice } from "./sessions.js";

/**
 * The `snapshot` op: the extension's `snapshotOnStage`, run on the CLI's own
 * page, plus the kits — the same value the run page answers. Refuses before
 * opening anything for a url or a device it cannot use, as the page does.
 */
export async function snapshotOp(
  args: Record<string, unknown>,
  deps: {
    session: BrowserSession;
    home: string;
    log: (line: string) => void;
    loadSessions: (
      context: BrowserContext,
      choice: SessionChoice | null,
    ) => Promise<SessionsLoaded>;
    signinCommand: string;
  },
): Promise<Outcome> {
  const url = typeof args.url === "string" ? args.url : "";
  if (!isHttpUrl(url)) {
    return failure(
      "nonHttpTarget",
      `the url must be an http(s) URL — "${url}" is not one`,
    );
  }
  const contains =
    typeof args.contains === "string" && args.contains !== ""
      ? args.contains
      : null;
  let device: DeviceId | null = null;
  if (args.device !== undefined && args.device !== null) {
    const known = DeviceIdSchema.safeParse(args.device);
    if (!known.success) {
      const raw =
        typeof args.device === "string"
          ? args.device
          : JSON.stringify(args.device);
      // The run page's sentence, verbatim (run/view.ts `api.snapshot`).
      return failure(
        "invalidDevice",
        `no device "${raw}" — use one of ${DEVICE_IDS.join(", ")}`,
      );
    }
    device = known.data;
  }

  // A page of its own: a phone snapshot's emulation and every call's
  // heartbeat stay on the page they were put on (`BrowserSession.stage`).
  const staged = await deps.session.stage();
  if (!staged.ok) return failure(staged.reason, staged.detail);
  const { page, cdp, clock } = staged.stage;
  const loaded = await deps.loadSessions(staged.stage.context, null);
  if (!loaded.ok) return failure(loaded.reason, loaded.detail);

  // As a run chooses it (run.ts), so the targets listed are the layout the
  // run films: a headless stand-in screen is not read as the author's.
  const desktop = chooseRunSize({
    scriptViewport: undefined,
    device: undefined,
    setting: DEFAULT_RUN_SIZE,
    screen: await deps.session.screen(page),
  });
  const occlusion = createNavigatingGuard({
    guard: createOcclusionGuard({ cdp, clock }),
    cdp,
    url,
    sleep: clock.sleep,
  });
  const outcome = await snapshotOnStage(
    {
      cdp,
      occlusion,
      sleep: clock.sleep,
      snapshotTargets: pageSnapshotTargets(page),
      measureViewport: () => measureViewport(page),
    },
    url,
    contains,
    device,
    desktop,
  );
  if (!outcome.ok) return outcome;
  let session: "saved" | "none" | "signedOut" | "unchecked";
  let sessionDetail: string | null = null;
  try {
    const verdict = landingVerdict(
      await readLandingFacts(page, url),
      loaded.files,
      deps.signinCommand,
    );
    if (verdict.kind === "signedOut") {
      session = "signedOut";
      sessionDetail = verdict.detail;
    } else {
      session = verdict.saved ? "saved" : "none";
    }
  } catch (error) {
    session = "unchecked";
    sessionDetail = `the page could not be checked for a sign-in page (${messageOf(error)})`;
  }
  return {
    ok: true,
    value: {
      ...outcome.value,
      session,
      sessionDetail,
      kits: kitsForSnapshot(await readKits(deps.home)),
    },
  };
}
