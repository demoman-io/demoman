import type { SceneNetworkEntry } from "@demoman/scene-schema";
import {
  classifyOriginStrict,
  isLocalTarget,
  mayWriteUnattended,
} from "./origin.js";

/**
 * The situation a replay is being asked for in.
 *
 * The axis is **whether a human is watching**, not which caller is asking.
 * v8 §491 carves out unattended replay because there is nobody to read a
 * five-second hold naming the requests and nobody to press Cancel — so
 * `allowMutating` exists only on the attended branch, and a CLI or an agent
 * loop cannot express "the setting is on". There is no setting and no human
 * to have flipped it.
 *
 * A `targetClass` parameter was considered and rejected: it left a caller
 * free to assert "attended" while unattended, which is the same failure
 * `EngineDeps.mayReplay` was made required to prevent.
 */
export type ReplayRequest =
  | { attended: true; targetUrl: string; allowMutating: boolean }
  | { attended: false; targetUrl: string };

/**
 * Whether a scene may be replayed, and what it writes if it does.
 *
 * `scene.flags.mutating` says a scene writes data. Whether that forbids
 * replay is a policy over that fact, and until 2026-08-28 the two were the
 * same thing — v8 §5's rule made mutating scenes unreplayable, full stop, so
 * seven call sites read the flag directly and each one encoded the rule
 * again. The rule has now changed once and v8 §12's Part II matrix changes
 * it again along a second axis, so it lives here and nowhere else.
 *
 * A result union rather than `{ mayReplay: boolean; refusal: string | null }`
 * so that a refusal without a reason is not representable — which is the
 * shape this whole rule exists to forbid. Only a mutating scene is ever
 * refused, so the refusing branch says so.
 */
export type ReplayPolicy =
  | {
      mayReplay: true;
      /**
       * Whether the scene writes data at all — the fact, not the policy.
       *
       * `writes: []` alone cannot say why: a read-only scene and a mutating
       * scene whose writes were never observable (`session.ts`'s `hadNoLog` —
       * the author declined the network-permission prompt, so nothing could be
       * logged) both report an empty list. Only this field tells them apart,
       * and the orchestrator's pre-roll (v8 §12) needs to: the second scene is
       * owed a louder warning than the first, not the silence an empty list
       * alone would read as.
       */
      mutating: boolean;
      /** The requests that made it mutating; empty when read-only, and also
       *  empty — see `mutating` — for a mutating scene whose network log
       *  could not be captured. */
      writes: SceneNetworkEntry[];
    }
  | {
      mayReplay: false;
      mutating: true;
      writes: SceneNetworkEntry[];
      /**
       * A different author action per value, which is the reason the field is
       * not a boolean. The headless runner prints one of these, and an author
       * told only that something was refused cannot tell them apart.
       *
       * - `settingOff` — flip the setting. The only refusal an attended
       *   caller can receive, and so the only one the editor ever sees.
       * - `publishedTargetUnattended` — the target looks like production;
       *   point at a preview deploy or a local build.
       * - `unverifiableTargetUnattended` — the target is not production as
       *   far as the badge's classifier is concerned, and the gate still
       *   cannot verify from its hostname that it is one build's URL:
       *   `myapp.vercel.app`, `staging.bank.com`, `pr-1.bank.com`,
       *   `192.168.1.50`. Split out from `publishedTargetUnattended` because
       *   that reason's advice — point at a preview deploy — is what the
       *   author on a genuine Vercel branch deploy already did, and being
       *   told to do it again names no action they can take. This one has to
       *   say the shape cannot be verified, not that the target is
       *   production; see `mayWriteUnattended` for why it cannot be.
       * - `publishedWritesUnattended` — the target passed, but this take's
       *   own mutations went to a published origin. See below.
       * - `unparseableTargetUnattended` — check the URL you passed. The
       *   runner was handed something that is not a URL at all, so no
       *   environment claim could be made about it either way.
       */
      refusal:
        | "settingOff"
        | "publishedTargetUnattended"
        | "unverifiableTargetUnattended"
        | "publishedWritesUnattended"
        | "unparseableTargetUnattended";
    };

/**
 * The two facts `replayPolicy` reads, and the only two it reads.
 *
 * Declared rather than taking a whole `SceneDocument` so that a door with no
 * document yet can state them without assembling one: an authored run
 * (`apps/extension/src/adapters/authored-runner.ts`) must pass the gate
 * *before* it has measured anything, and a stand-in document would be a
 * fabricated take — the one thing that design forbids. Every existing caller
 * hands over a real `SceneDocument`, which satisfies this structurally, so
 * nothing about the rule or its inputs changes.
 */
export interface ReplaySubject {
  /** `SceneDocument["flags"]["mutating"]`: whether this writes data. A run
   *  that cannot know yet fails closed at `true`, which is what
   *  `assembleAuthored` writes into every authored take for the same reason. */
  flags: { mutating: boolean };
  /** `SceneDocument["sideChannels"]`, narrowed to the log the refusals are
   *  built from. Empty is not evidence of safety — see `mutating`. */
  sideChannels: { network: SceneNetworkEntry[] };
}

export function replayPolicy(
  scene: ReplaySubject,
  request: ReplayRequest,
): ReplayPolicy {
  const mutating = scene.flags.mutating;
  // Only for a mutating scene: the classifier tags analytics requests on
  // every scene, and naming those as the reason a take is gated would
  // point the author at the requests the allowlist already forgave.
  const writes = mutating
    ? scene.sideChannels.network.filter(
        (entry) => entry.classification === "mutation",
      )
    : [];

  if (!mutating) return { mayReplay: true, mutating: false, writes };

  if (request.attended) {
    return request.allowMutating
      ? { mayReplay: true, mutating: true, writes }
      : { mayReplay: false, mutating: true, writes, refusal: "settingOff" };
  }

  // v8 §491, and the only place it is implemented. A local target counts as
  // safe alongside a preview deploy: §491's table is a binary between a safe
  // environment and a production domain, localhost is not a production
  // domain, and the runner's first consumer is a developer's own machine.
  // "Local" is `isLocalTarget`, NOT the classifier's `development` class —
  // that class also holds RFC1918 addresses and `.local`, which is where
  // intranet production lives, and a CI box inside a VPC is exactly where an
  // unattended runner sits.
  //
  // Two calls, deliberately. `classifyOriginStrict` answers only "is this a
  // URL at all", because that failure earns its own reason — check what you
  // passed — and folding it in with the rest would tell an author to find a
  // preview deploy for a typo. `mayWriteUnattended` then decides the rest,
  // and it is NOT `classifyOrigin(...) !== "published"`: that classifier
  // breaks ties toward preview for the badge, where a false preview costs
  // only coverage, while here it would grant writes against `myapp.vercel.app`
  // or `staging.bank.com` — production for plenty of teams. See its docblock.
  const targetClass = classifyOriginStrict(request.targetUrl);
  if (targetClass === null) {
    return {
      mayReplay: false,
      mutating: true,
      writes,
      refusal: "unparseableTargetUnattended",
    };
  }
  if (!mayWriteUnattended(request.targetUrl)) {
    // Which refusal, not just that there was one. `publishedTargetUnattended`
    // tells the author to point at a preview deploy, and that is the wrong
    // sentence for most of the hosts that land here: a genuine Vercel branch
    // deploy refuses (its alias is undecidable from the hostname), and so do
    // `staging.bank.com` and `192.168.1.50`. Telling the author of a real
    // preview deploy to go and find a preview deploy names no action. The
    // classifier's own answer is what separates them — it is the question
    // "does this look like production", which is a different question from
    // the gate's "can this be verified as one build's URL".
    return {
      mayReplay: false,
      mutating: true,
      writes,
      refusal:
        targetClass === "published"
          ? "publishedTargetUnattended"
          : "unverifiableTargetUnattended",
    };
  }

  // The one part of "are these writes safe" that is checkable here.
  //
  // `mayWriteUnattended` reads a hostname and says only that the target is
  // shaped like a throwaway deploy; its docblock is explicit that a preview
  // deploy is a separate FRONTEND, and without per-branch databases it talks
  // to the backend production talks to. That is not checkable from the target
  // URL — but it is not the only evidence in hand. The take carries the
  // requests that made it mutating, and if those reached a published origin
  // once, a preview build of the same app is the case where they will again:
  // it is the same bundle with the same API base, served from a different
  // hostname. So a non-local target with a published write origin refuses,
  // under its own reason: the target passed and the writes did not, so
  // neither target refusal names the author's move.
  //
  // **Local targets are deliberately exempt**, and that is not an oversight
  // in the direction this module usually refuses. A local app is rebuilt from
  // local configuration, so the URL recorded during capture says nothing
  // about where the replay will write — the same take against `localhost:3000`
  // may post to a local API, or to production, and the log cannot tell them
  // apart. Refusing on it would refuse every mutating take ever captured
  // against a real site, on the developer's own machine, which is the
  // runner's first and main use — it would delete v8 §491's carve-out rather
  // than narrow it. The residual risk (a local build pointed at the
  // production API) is real and is the runner's to warn about, not this
  // predicate's to guess at.
  //
  // An empty `writes` is not evidence of safety either — for a mutating scene
  // it can mean the author declined the network prompt and nothing could be
  // logged (`mutating` is the field that says so). That scene is admitted
  // here and is owed the louder warning at the runner's pre-roll.
  if (
    !isLocalTarget(request.targetUrl) &&
    writes.some((entry) => classifyOriginStrict(entry.url) === "published")
  ) {
    return {
      mayReplay: false,
      mutating: true,
      writes,
      refusal: "publishedWritesUnattended",
    };
  }
  return { mayReplay: true, mutating: true, writes };
}
