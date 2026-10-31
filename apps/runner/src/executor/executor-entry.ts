// apps/runner/src/executor/executor-entry.ts

import { fingerprintFromTarget, seenNow } from "@demoman/replay-engine/page";
import type { AnchorIntent, ResolveEnv } from "@demoman/resolver";
import { createCanvasMatcher, resolveAnchor } from "@demoman/resolver";
import {
  type CaptureForIntentResult,
  captureForIntent,
  focusesCredentialField,
  type SnapshotRequest,
  type SnapshotWalk,
  snapshotTargets,
} from "@demoman/run-core/page";
import type { ScriptTarget } from "@demoman/scene-schema";
import { EXECUTOR_ENTRY_GLOBAL, SIGN_IN_MARK } from "../entry-globals.js";

export interface ExecutorEntry {
  snapshotHere(request: SnapshotRequest): Promise<SnapshotWalk>;
  captureHere(intent: AnchorIntent): Promise<CaptureForIntentResult>;
  /** Launch C2: resolves a sign-in step's target the way a run does and
   *  marks the element with SIGN_IN_MARK=`mark`, so Playwright can act on
   *  it. Answers why when nothing resolved. */
  markHere(
    target: ScriptTarget,
    mark: string,
  ): Promise<{ found: true; visible: boolean } | { found: false; why: string }>;
}

// The sensor's env minus what only an extension has: no shadow hook (a
// closed shadow root is out of reach here, where the sensor's hook reaches
// it) and no frame broker (snapshot and capture are top-frame only in the
// extension too). The gate (plan 2) measures what the first costs.
const env = (): ResolveEnv => ({
  root: document,
  patch: createCanvasMatcher(),
});

const entry: ExecutorEntry = {
  snapshotHere: (request) =>
    snapshotTargets(env(), request, () => performance.now()),
  // The field the action will type into, not only the element it resolved
  // to: a script reaches a password input through its label (launch C).
  captureHere: (intent) =>
    captureForIntent(intent, env(), { credential: focusesCredentialField }),
  markHere: async (target, mark) => {
    const report = await resolveAnchor(
      { id: `signin-${mark}`, fingerprint: fingerprintFromTarget(target) },
      env(),
    );
    for (const old of document.querySelectorAll(`[${SIGN_IN_MARK}]`)) {
      old.removeAttribute(SIGN_IN_MARK);
    }
    if (report.element === null) {
      return { found: false, why: report.failureReason ?? report.strategy };
    }
    report.element.setAttribute(SIGN_IN_MARK, mark);
    return {
      found: true,
      visible: seenNow(report.element),
    };
  },
};

(globalThis as Record<string, unknown>)[EXECUTOR_ENTRY_GLOBAL] = entry;
