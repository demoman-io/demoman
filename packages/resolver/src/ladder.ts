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
  TiedAt,
} from "./types.js";

/** The tiers that find an element, strongest first: the ladder's order, and
 *  the one a caller ranks a report's strategy by. */
export const TIERS = [
  "stableId",
  "roleName",
  "text",
  "treePath",
  "imagePatch",
] as const;

type Tier = {
  strategy: Exclude<(typeof TIERS)[number], "imagePatch">;
  find: () => Element[];
};

/**
 * How far below the best pixel score a runner-up still counts as the same
 * lookalike. Scores come from computed colours and the box's aspect, never
 * timing, so one page scores alike on every run on one machine. Across
 * machines they do not: font metrics move a box's aspect, the tile's bar
 * moves a row (1/16 of the tile), and two controls one row apart can tie on
 * the Mac and not on CI. That is the exposure the rect signal already has,
 * and either way the answer is a refusal or a corroborated find, never a
 * guess.
 */
const PATCH_TIE_EPSILON = 0.01;

/**
 * A winner that names itself as something else: its role and its own name
 * both differ from a fingerprint that recorded both. Found by its text or
 * position, and contradicted by what it says it is.
 *
 * An element with no name of its own is not a contradiction. A heading
 * restyled as a `<div>` loses its role and, with it, the name it took from
 * its text; the text still matches, and that is a find, not a lookalike.
 *
 * The text and path tiers alone are held to this. A stable id is the author's
 * own handle and outlives a rename; a role-name winner agrees by definition.
 */
function contradicted(el: Element, signals: CorroborationSignal[]): boolean {
  const role = signals.find((s) => s.signal === "role");
  const name = signals.find((s) => s.signal === "name");
  return (
    role?.agreed === false && name?.agreed === false && computeName(el) !== null
  );
}

/**
 * Strict priority order decides the *reported* strategy (v8 §4). Corroboration
 * breaks ties inside a tier and never promotes one; the one thing it can do
 * besides is refuse a text or path winner it contradicts (`contradicted`).
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

  // The first refusal, reported when no later tier resolves cleanly: a tie
  // is a more useful report than "broken", and so is a drift.
  let refused: {
    failureReason: "ambiguousTie" | "drifted";
    count: number;
    signals: CorroborationSignal[];
  } | null = null;
  // Once a tier ties, a lower tier's job is to break that tie, never to pick
  // something else: it chooses only among the tied elements, and the winner's
  // report says which tier tied.
  let tiedAt: TiedAt | null = null;
  let tiedAmong: Set<Element> | null = null;

  for (const tier of tiers) {
    const found = tier.find();
    const among: Set<Element> | null = tiedAmong;
    const candidates: Element[] =
      among === null ? found : found.filter((el) => among.has(el));
    if (candidates.length === 0) continue;

    const { winner, signals } = breakTie(candidates, fp, root);
    if (winner === null) {
      refused ??= {
        failureReason: "ambiguousTie",
        count: candidates.length,
        signals,
      };
      tiedAt ??= { strategy: tier.strategy, count: candidates.length };
      tiedAmong = new Set(candidates);
      continue;
    }
    if (
      (tier.strategy === "text" || tier.strategy === "treePath") &&
      contradicted(winner, signals)
    ) {
      refused ??= {
        failureReason: "drifted",
        count: candidates.length,
        signals,
      };
      continue;
    }
    return {
      anchorId: anchor.id,
      strategy: tier.strategy,
      element: winner,
      candidates: candidates.length,
      failureReason: null,
      corroboration: signals,
      ...(tiedAt === null ? {} : { tiedAt }),
      durationMs: performance.now() - started,
    };
  }

  if (refused !== null) {
    return {
      anchorId: anchor.id,
      strategy:
        refused.failureReason === "ambiguousTie" ? "ambiguous" : "broken",
      element: null,
      candidates: refused.count,
      failureReason: refused.failureReason,
      corroboration: refused.signals,
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
  if (best === undefined) return null;
  // The refusal tiers 1-4 have. The tile is painted from colours and aspect
  // alone, so every same-styled control on a design-system page scores
  // alike: lookalikes within a hair of the best go to corroboration, and a
  // tie it cannot break is a tie.
  const lookalikes = scored
    .filter((s) => best.score - s.score <= PATCH_TIE_EPSILON)
    .map((s) => candidates[s.index])
    .filter((el) => el !== undefined);
  const { winner, signals } = breakTie(lookalikes, anchor.fingerprint, root);
  if (winner === null) {
    return {
      anchorId: anchor.id,
      strategy: "ambiguous",
      element: null,
      candidates: lookalikes.length,
      failureReason: "ambiguousTie",
      corroboration: signals,
      durationMs: performance.now() - started,
    };
  }
  // A picture alone is not a find: the winner needs one thing the page's DOM
  // agrees with (its neighbourhood, role, name, text or path).
  if (!signals.some((s) => s.agreed)) {
    return {
      anchorId: anchor.id,
      strategy: "broken",
      element: null,
      candidates: lookalikes.length,
      failureReason: "drifted",
      corroboration: signals,
      durationMs: performance.now() - started,
    };
  }

  return {
    anchorId: anchor.id,
    strategy: "imagePatch",
    element: winner,
    candidates: scored.length,
    failureReason: null,
    corroboration: signals,
    durationMs: performance.now() - started,
  };
}
