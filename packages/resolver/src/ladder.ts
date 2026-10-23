import { computeName, computeRole } from "./accessibility.js";
import { breakTie } from "./corroboration.js";
import { findByStableId } from "./identifiers.js";
import { NO_PATCH } from "./ports/patch.js";
import {
  hasOpaqueShadow,
  scopeToDataKey,
  searchRoots,
  wasCapturedInShadow,
} from "./scope.js";
import { isTextLeaf, normalizeText } from "./text.js";
import { followTreePath, parseTreePath } from "./treepath.js";
import type {
  AnchorIntent,
  CorroborationSignal,
  ImagePatchMatcher,
  ResolutionReport,
  ResolveEnv,
} from "./types.js";

type Tier = {
  strategy: "stableId" | "roleName" | "text" | "treePath";
  find: () => Element[];
};

/**
 * Strict priority order decides the *reported* strategy (v8 §4). Corroboration
 * only breaks ties inside a tier — it never promotes or demotes one.
 */
export function runLadder(
  anchor: AnchorIntent,
  root: Document,
  env: ResolveEnv,
): ResolutionReport {
  const started = performance.now();
  const fp = anchor.fingerprint;

  // Scope before ranking. A data key that is absent means the row is not in the
  // tree — SP5 responds with scrollTo(anchor), SP8 declines to alert. The row
  // is searched for across every root (including shadow roots), because the
  // row container may itself live inside one.
  const searchRoot = scopeToDataKey(root, fp.dataKey, env);
  if (searchRoot === null) {
    return {
      anchorId: anchor.id,
      strategy: "broken",
      element: null,
      candidates: 0,
      failureReason: "notInTree",
      corroboration: [],
      durationMs: performance.now() - started,
    };
  }

  const roots = searchRoots(searchRoot, env);
  const everyElement = (): Element[] =>
    roots.flatMap((r) => Array.from(r.querySelectorAll("*")));

  const tiers: Tier[] = [
    {
      strategy: "stableId",
      find: () =>
        fp.stableId === null
          ? []
          : roots.flatMap((r) => findByStableId(r, fp.stableId as string)),
    },
    {
      strategy: "roleName",
      find: () =>
        fp.role === null || fp.accessibleName === null
          ? []
          : everyElement().filter(
              (el) =>
                computeRole(el) === fp.role &&
                computeName(el) === fp.accessibleName,
            ),
    },
    {
      strategy: "text",
      find: () => {
        const wanted = normalizeText(fp.textContent);
        if (wanted === null) return [];
        return everyElement().filter(
          (el) => isTextLeaf(el) && normalizeText(el.textContent) === wanted,
        );
      },
    },
    {
      strategy: "treePath",
      find: () => {
        if (fp.treePath === null) return [];
        let segs: ReturnType<typeof parseTreePath>;
        try {
          segs = parseTreePath(fp.treePath);
        } catch {
          // A malformed path costs this signal, not the whole resolution.
          return [];
        }
        // Paths are document-rooted, so walk the document even when scoped.
        const found = followTreePath(segs, root);
        if (found === null) return [];
        // A position is only trustworthy inside the row the data key selected
        // (v8 §7: a list row is identified by data, never by position). If the
        // row moved, the path now points at some other row's slot — withhold it.
        if (searchRoot !== root && !searchRoot.contains(found)) {
          return [];
        }
        return [found];
      },
    },
  ];

  let ambiguousAt: { count: number; signals: CorroborationSignal[] } | null =
    null;

  for (const tier of tiers) {
    const candidates = tier.find();
    if (candidates.length === 0) continue;

    const { winner, signals } = breakTie(candidates, fp, root);
    if (winner !== null) {
      return {
        anchorId: anchor.id,
        strategy: tier.strategy,
        element: winner,
        candidates: candidates.length,
        failureReason: null,
        corroboration: signals,
        durationMs: performance.now() - started,
      };
    }
    // Remember the first unbreakable tie: if no later tier resolves cleanly,
    // "ambiguous" is a more useful report than "broken".
    ambiguousAt ??= { count: candidates.length, signals };
  }

  if (ambiguousAt !== null) {
    return {
      anchorId: anchor.id,
      strategy: "ambiguous",
      element: null,
      candidates: ambiguousAt.count,
      failureReason: "ambiguousTie",
      corroboration: ambiguousAt.signals,
      durationMs: performance.now() - started,
    };
  }

  // Blame a closed root only when both point that way: the anchor was captured
  // inside a shadow root, AND something in scope hosts a root we cannot reach.
  // Either alone misreports — the scan blames every broken anchor on the first
  // light-DOM web component on the page.
  if (wasCapturedInShadow(fp) && hasOpaqueShadow(searchRoot, env)) {
    return {
      anchorId: anchor.id,
      strategy: "broken",
      element: null,
      candidates: 0,
      failureReason: "closedShadowRoot",
      corroboration: [],
      durationMs: performance.now() - started,
    };
  }

  return {
    anchorId: anchor.id,
    strategy: "broken",
    element: null,
    candidates: 0,
    failureReason: null,
    corroboration: [],
    durationMs: performance.now() - started,
  };
}

/**
 * Tier 5, run only when tiers 1–4 all fell through. Separate from runLadder
 * because pixel comparison is async and the four DOM tiers are not.
 */
export async function runPatchTier(
  anchor: AnchorIntent,
  root: Document,
  env: ResolveEnv,
  started: number,
): Promise<ResolutionReport | null> {
  const ref = anchor.fingerprint.imagePatchRef;
  if (ref === null) return null;

  // NO_PATCH is as inert as no matcher at all: passing it explicitly must not
  // give a worse report (an empty match list degrading to plain "broken")
  // than passing nothing does. The identical inversion already fixed for
  // NO_FRAMES.
  const matcher: ImagePatchMatcher | undefined = env.patch;
  if (matcher === undefined || matcher === NO_PATCH) {
    return {
      anchorId: anchor.id,
      strategy: "broken",
      element: null,
      candidates: 0,
      failureReason: "patchUnavailable",
      corroboration: [],
      durationMs: performance.now() - started,
    };
  }

  // Same scope tiers 1-4 searched: a data key that resolved a row must not be
  // escaped here, or a pixel-similar element from a different row could win
  // on a weaker basis than the positional match tier 4 correctly withholds
  // (v8 §7). A null scope means the row genuinely isn't there, but runLadder
  // already returned notInTree for that case before tier 5 is ever reached.
  const scopedRoot =
    scopeToDataKey(root, anchor.fingerprint.dataKey, env) ?? root;
  const candidates = searchRoots(scopedRoot, env).flatMap((r) =>
    Array.from(r.querySelectorAll("*")),
  );
  const scored = await matcher.match(ref, candidates);
  const best = scored[0];
  const winner = best === undefined ? undefined : candidates[best.index];
  if (winner === undefined) return null;

  return {
    anchorId: anchor.id,
    strategy: "imagePatch",
    element: winner,
    candidates: scored.length,
    failureReason: null,
    corroboration: [],
    durationMs: performance.now() - started,
  };
}
