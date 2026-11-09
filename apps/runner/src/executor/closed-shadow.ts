// apps/runner/src/executor/closed-shadow.ts
//
// Whether a page has a closed shadow root (DEM-102). No run installs the
// resolver's shadow registry, so a target inside one cannot be found: a
// known limitation, named in a run's stop only when the page has one. The
// page's own JS cannot see a closed root; the browser's DOM domain can.
import { messageOf } from "@demoman/run-core";
import type { Page } from "playwright";
import { withinDeadline } from "../page-deadline.js";

interface DomNode {
  shadowRootType?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

const anyClosed = (n: DomNode): boolean =>
  n.shadowRootType === "closed" ||
  [
    ...(n.children ?? []),
    ...(n.shadowRoots ?? []),
    ...(n.contentDocument ? [n.contentDocument] : []),
  ].some(anyClosed);

/** True or false from the browser; null, said in `log`, when it could not
 *  be asked. */
export async function hasClosedShadowRoot(
  page: Pick<Page, "context">,
  log: (line: string) => void,
  ms?: number,
): Promise<boolean | null> {
  try {
    const cdp = await page.context().newCDPSession(page as Page);
    try {
      const { root } = (await withinDeadline(
        cdp.send("DOM.getDocument", { depth: -1, pierce: true }),
        "looking for a closed shadow root",
        ms,
      )) as { root: DomNode };
      return anyClosed(root);
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
