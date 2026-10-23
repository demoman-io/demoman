import {
  fingerprintFromTarget,
  targetFromFingerprint,
} from "@demoman/replay-engine/page";
import {
  captureAnchor,
  computeName,
  computeRole,
  isTextLeaf,
  NO_PATCH,
  normalizeText,
  type ResolveEnv,
  resolveAnchor,
} from "@demoman/resolver";
import type { ScriptTarget } from "@demoman/scene-schema";

/** The most targets one answer lists. An agent reads every one of them, and
 *  250 entries is already some 50 KB of JSON. `contains` is how it asks for
 *  a part of a longer page. */
export const SNAPSHOT_MAX_TARGETS = 250;
/** How long the walk may examine elements. Every capture and every check
 *  resolves against the whole document, so a large page is quadratic; past
 *  this the rest are counted `notExamined`, never dropped silently. */
export const SNAPSHOT_BUDGET_MS = 8_000;
export const SNAPSHOT_TEXT_MAX = 80;
/** How long the run page waits for the walk's answer: the budget, plus the
 *  capture still in flight when it ran out, plus margin. */
export const SNAPSHOT_PAGE_TIMEOUT_MS = 20_000;

export interface SnapshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotTarget {
  /** Copy this into a step verbatim: the run resolves it to this element. */
  target: ScriptTarget;
  /** The resolver's role, else "text" for a text leaf, else "element". */
  kind: string;
  /** The element's text, normalized and cut to SNAPSHOT_TEXT_MAX. */
  text: string | null;
  /** Document coordinates (scroll included). Null when it is not shown:
   *  no box, `display: none`, or inside a closed `<details>`. */
  rect: SnapshotRect | null;
  inFirstViewport: boolean;
}

export interface SnapshotRequest {
  /** Case-insensitive; matched against the element's text and its name. */
  contains: string | null;
  maxTargets: number;
  budgetMs: number;
}

export interface SnapshotWalk {
  title: string;
  targets: SnapshotTarget[];
  /** Examined and left out: the run would not resolve it to exactly that
   *  element (a duplicate label, an unnamed element no other tier picks). */
  unresolvable: number;
  /** Never examined: the cap or the budget ran out first. With `contains`,
   *  only the candidates that pass it count — its cheap name/text test is run
   *  over the remainder, so a positive count always means more matches are on
   *  the page, never merely more page. */
  notExamined: number;
  walkMs: number;
}

/** Elements whose text is not page text. */
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

function clip(text: string | null): string | null {
  if (text === null || text.length <= SNAPSHOT_TEXT_MAX) return text;
  return `${text.slice(0, SNAPSHOT_TEXT_MAX - 1)}…`;
}

/**
 * Every element a script could act on or scroll to, as a target the run
 * resolves (spec 2026-10-01-agent-bridge §4.1):
 *
 * 1. the candidates are every element `computeRole` gives a role, and every
 *    text leaf with text (`isTextLeaf`, the rule capture and the text tier
 *    share), in document order under `<body>`;
 * 2. each is captured with `captureAnchor` — what a recording does — and its
 *    winning strategy becomes a `ScriptTarget` (`targetFromFingerprint`);
 * 3. that target is resolved BACK, as the run will resolve it: the bare
 *    fingerprint `fingerprintFromTarget` builds, through `resolveAnchor`. It
 *    is kept only when exactly one candidate came back and it is this
 *    element.
 *
 * Step 3 is what makes a listed target one the run resolves, by
 * construction: a capture breaks a tie with every signal it measured, while
 * a script names one, so a capture can succeed where the script's target
 * would be ambiguous. Those are counted `unresolvable`, never listed.
 *
 * The image-patch tier is skipped (`NO_PATCH`) on both sides. A run reaches
 * it only when tiers 1–4 found nothing, and a kept target was found in tiers
 * 1–4, so no kept answer changes. It saves a canvas capture per element.
 *
 * Light DOM under `<body>` only: elements inside iframes and shadow roots
 * are not candidates, and the tool's description says so.
 */
export async function snapshotTargets(
  env: ResolveEnv,
  request: SnapshotRequest,
  now: () => number,
): Promise<SnapshotWalk> {
  const started = now();
  const doc = env.root;
  const view = doc.defaultView;
  const scrollX = view?.scrollX ?? 0;
  const scrollY = view?.scrollY ?? 0;
  const width = view?.innerWidth ?? 0;
  const height = view?.innerHeight ?? 0;
  const scan: ResolveEnv = { ...env, patch: NO_PATCH };
  const wanted = request.contains?.toLowerCase() ?? null;

  const candidates = Array.from(doc.body?.querySelectorAll("*") ?? []).filter(
    (el) =>
      !SKIP.has(el.tagName) &&
      el.closest("script,style,noscript,template") === null &&
      (computeRole(el) !== null ||
        (isTextLeaf(el) && normalizeText(el.textContent) !== null)),
  );

  /** The `contains` test: the element's name and its text. Cheap next to a
   *  capture and a resolve, which each walk the whole document. */
  const passes = (el: Element, text: string | null): boolean =>
    wanted === null ||
    `${computeName(el) ?? ""} ${text ?? ""}`.toLowerCase().includes(wanted);

  const targets: SnapshotTarget[] = [];
  let unresolvable = 0;
  let notExamined = 0;
  for (const [i, el] of candidates.entries()) {
    if (
      targets.length >= request.maxTargets ||
      now() - started > request.budgetMs
    ) {
      // Counted through the same filter, even when it was the budget that ran
      // out. The agent is told a positive count means "the page had more —
      // narrow with contains"; counting candidates its `contains` would have
      // dropped sent it narrowing a query that was already narrow. The pass
      // can overrun the budget, but only linearly — one name and one text per
      // remaining candidate, the work the candidate list above already did
      // for each of them — while the budget guards the quadratic part, the
      // capture and resolve, which this never runs.
      notExamined =
        wanted === null
          ? candidates.length - i
          : candidates
              .slice(i)
              .filter((rest) => passes(rest, normalizeText(rest.textContent)))
              .length;
      break;
    }
    const text = normalizeText(el.textContent);
    if (!passes(el, text)) continue;
    const { anchor } = await captureAnchor(
      el,
      // Only `fingerprint` and `resolution.strategy` are read: nothing here
      // is stored, so no url, action index or entry state is claimed.
      { anchorId: `snapshot-${i}`, url: "", actionIndex: 0, entryState: false },
      scan,
    );
    const target = targetFromFingerprint(
      anchor.resolution.strategy,
      anchor.fingerprint,
    );
    if (target === null) {
      unresolvable += 1;
      continue;
    }
    const back = await resolveAnchor(
      { id: anchor.id, fingerprint: fingerprintFromTarget(target) },
      scan,
    );
    if (back.element !== el || back.candidates !== 1) {
      unresolvable += 1;
      continue;
    }
    // Not shown means no rect, whatever layout says: a closed <details>'s
    // content keeps a real box under content-visibility: hidden (measured on
    // Chrome 151), and listing that box would put the hidden answer in the
    // first viewport.
    const box = el.checkVisibility() ? anchor.fingerprint.boundingRect : null;
    const rect =
      box === null
        ? null
        : {
            x: box.x + scrollX,
            y: box.y + scrollY,
            width: box.width,
            height: box.height,
          };
    targets.push({
      target,
      kind:
        computeRole(el) ??
        (anchor.fingerprint.textContent !== null ? "text" : "element"),
      text: clip(text),
      rect,
      inFirstViewport:
        rect !== null &&
        rect.x < width &&
        rect.x + rect.width > 0 &&
        rect.y < height &&
        rect.y + rect.height > 0,
    });
  }
  return {
    title: doc.title,
    targets,
    unresolvable,
    notExamined,
    walkMs: Math.round(now() - started),
  };
}
