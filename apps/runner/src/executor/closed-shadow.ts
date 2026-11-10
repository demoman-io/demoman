// apps/runner/src/executor/closed-shadow.ts
//
// Whether a target a run could not find sits in a closed shadow root
// (DEM-102). No run installs the resolver's shadow registry (the author's
// decision, 2026-11-09: a known limitation for now), so such a target is
// out of reach, and the run's stop says so only when the page shows it.
// The page's own JS cannot see a closed root; the browser's DOM domain can.
import { messageOf } from "@demoman/run-core";
import type { ScriptStep } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { withinDeadline } from "../page-deadline.js";

/** Its own ceiling, well under the run's: it is asked only after a stop,
 *  and a large page's whole DOM is what it reads. */
const CHECK_MS = 5_000;

interface DomNode {
  nodeType?: number;
  nodeValue?: string;
  attributes?: string[];
  shadowRootType?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The words a step's targets name: a text, an accessible name, a
 *  stableId. A tree path names none. */
export function targetWords(step: ScriptStep): string[] {
  const s = step as {
    on?: unknown;
    into?: unknown;
    from?: { on?: unknown };
    to?: { on?: unknown };
  };
  const words: string[] = [];
  for (const t of [s.on, s.into, s.from?.on, s.to?.on]) {
    if (typeof t !== "object" || t === null) continue;
    const { text, name, stableId } = t as Record<string, unknown>;
    for (const w of [text, name, stableId]) {
      if (typeof w === "string" && norm(w) !== "") words.push(norm(w));
    }
  }
  return words;
}

/** Each closed root's text and attribute values, one string per root. */
function closedRootsText(root: DomNode): string[] {
  const out: string[] = [];
  const collect = (n: DomNode, into: string[]) => {
    if (n.nodeType === 3 && n.nodeValue) into.push(n.nodeValue);
    if (n.attributes) {
      for (let i = 1; i < n.attributes.length; i += 2) {
        into.push(n.attributes[i] ?? "");
      }
    }
    for (const c of n.children ?? []) collect(c, into);
    for (const c of n.shadowRoots ?? []) collect(c, into);
    if (n.contentDocument) collect(n.contentDocument, into);
  };
  const walk = (n: DomNode) => {
    if (n.shadowRootType === "closed") {
      const parts: string[] = [];
      collect(n, parts);
      out.push(norm(parts.join(" ")));
      return;
    }
    for (const c of n.children ?? []) walk(c);
    for (const c of n.shadowRoots ?? []) walk(c);
    if (n.contentDocument) walk(n.contentDocument);
  };
  walk(root);
  return out;
}

/**
 * True when a closed shadow root on the page holds one of `words` (or, with
 * no words, when the page has any closed root); false when none does; null,
 * said in `log`, when the browser could not be asked.
 */
export async function closedShadowHolds(
  page: Pick<Page, "context">,
  words: string[],
  log: (line: string) => void,
  ms = CHECK_MS,
): Promise<boolean | null> {
  try {
    const cdp = await page.context().newCDPSession(page as Page);
    try {
      const { root } = (await withinDeadline(
        cdp.send("DOM.getDocument", { depth: -1, pierce: true }),
        "looking for a closed shadow root",
        ms,
      )) as { root: DomNode };
      const roots = closedRootsText(root);
      return words.length === 0
        ? roots.length > 0
        : roots.some((text) => words.some((w) => text.includes(w)));
    } finally {
      await cdp.detach().catch((error: unknown) => {
        log(`a DevTools session was left attached (${messageOf(error)})`);
      });
    }
  } catch (error) {
    log(
      `the page the run stopped on could not be checked for a closed shadow root (${messageOf(error)})`,
    );
    return null;
  }
}
