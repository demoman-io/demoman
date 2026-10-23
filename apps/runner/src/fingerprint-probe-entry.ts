/**
 * The test-only FINGERPRINT probe: what `packages/resolver` computes for an
 * element of `fixture-app.html`, right now, in a real browser.
 *
 * Why it exists (whole-branch review, round 2's finding 3). `2ccdc7a`
 * replaced `fixture-scene.ts`'s fabricated `role`/`accessibleName`/
 * `textContent` — every anchor claimed role "button" and its own id as its
 * name — with the page's real ones, and said the runner's lane re-checked
 * them. It did not. The same commit gave all four anchors a real `stableId`,
 * and `ladder.ts` runs `stableId` as the first tier in strict priority
 * order, so the `roleName` and `text` tiers are never reached for any
 * fixture anchor: `fixture-guard.test.ts`'s only assertion — that each
 * anchor resolves by the strategy the scene records — passed with the
 * fabricated values and with the real ones alike. Restoring
 * `role: "button", accessibleName: id, textContent: id` left the whole
 * branch green. A fix that passes with and without itself is CLAUDE.md's
 * "tests must be able to fail" rule, exactly.
 *
 * So this probe asks the resolver's own `captureAnchor` — the function that
 * produced those values in the first place — rather than restating the
 * accname algorithm, the role table and the leaf-only `textContent` rule on
 * the test's side. A second implementation of those three would be the
 * divergent double this design keeps refusing, and it would go stale in the
 * direction that matters: a test more forgiving than production.
 *
 * No production path bundles or injects this file — `test/fixture.ts` does,
 * through the same `bundleEntry` + `page.addScriptTag` mechanism the
 * production entries use, and additively, so it can sit alongside
 * `ENTRY_GLOBAL`'s resolver on the same page.
 */
import { captureAnchor } from "@demoman/resolver";
import { FINGERPRINT_PROBE_GLOBAL } from "./entry-globals.js";

/** The fields a fixture fingerprint claims about the page. `treePath` and
 *  `boundingRect` are deliberately not here: the scene's tree paths are
 *  synthetic (`fixture-scene.ts` writes `body:1/main:1/*:N` for all four)
 *  and the rects have their own check, `anchorRectComplaints`. */
export interface ProbedFingerprint {
  stableId: string | null;
  role: string | null;
  accessibleName: string | null;
  textContent: string | null;
  dataKey: string | null;
}

export interface FingerprintProbe {
  /** `null` when nothing in this document matches `selector` — distinct from
   *  a captured fingerprint whose every field happens to be null, which is a
   *  real answer about a real element. */
  fingerprintOf(selector: string): Promise<ProbedFingerprint | null>;
}

async function fingerprintOf(
  selector: string,
): Promise<ProbedFingerprint | null> {
  const el = document.querySelector(selector);
  if (el === null) return null;
  // `captureAnchor` also resolves the anchor it just built, to fill in
  // `resolution` — irrelevant here and harmless (a few querySelectorAll
  // passes over a fixture page), and not worth reaching past the public
  // door into `runLadder` to avoid.
  const { anchor } = await captureAnchor(
    el,
    {
      anchorId: "probe",
      url: location.href,
      actionIndex: 0,
      entryState: true,
    },
    { root: document },
  );
  const fp = anchor.fingerprint;
  return {
    stableId: fp.stableId,
    role: fp.role,
    accessibleName: fp.accessibleName,
    textContent: fp.textContent,
    dataKey: fp.dataKey,
  };
}

const probe: FingerprintProbe = { fingerprintOf };
(globalThis as unknown as Record<string, unknown>)[FINGERPRINT_PROBE_GLOBAL] =
  probe;
