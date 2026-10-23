import {
  captureAnchor,
  createShadowRegistry,
  NO_PATCH,
  NO_SHADOW,
} from "@demoman/resolver";
import { describe, expect, it } from "vitest";
import { REPLAY_TARGETS } from "../../src/index.js";
import { resolveForReplay } from "../../src/page.js";
import { hopsForChildren, prefixTreePath } from "../helpers/frame-hops";

const ctx = (anchorId: string) => ({
  anchorId,
  url: "https://app.test/",
  actionIndex: 0,
  entryState: true,
});

function fixture(html: string): Document {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return document;
}

describe("resolveForReplay", () => {
  it("parks each resolved element where CDP can read it back", async () => {
    const doc = fixture(`<button id="checkout-btn">Place order</button>`);
    const el = doc.querySelector("#checkout-btn") as Element;
    const { registry: shadow } = createShadowRegistry();
    const { anchor } = await captureAnchor(el, ctx("checkout-btn"), {
      root: doc,
      shadow,
      patch: NO_PATCH,
    });

    const win = window as unknown as Record<string, unknown>;
    delete win[REPLAY_TARGETS];

    const reports = await resolveForReplay([anchor], {
      root: doc,
      shadow,
      patch: NO_PATCH,
    });

    expect(reports[0]?.strategy).toBe("stableId");
    expect(
      (win[REPLAY_TARGETS] as Record<string, Element>)["checkout-btn"],
    ).toBe(el);
  });

  // A serialized report cannot carry a DOM node, and the orchestrator does
  // not want one — it wants an objectId in the frame that has it. Parking is
  // the handoff; the report stays serializable.
  it("returns reports that survive JSON", async () => {
    const doc = fixture(`<button id="pay-btn">Pay</button>`);
    const el = doc.querySelector("#pay-btn") as Element;
    const { registry: shadow } = createShadowRegistry();
    const { anchor } = await captureAnchor(el, ctx("pay-btn"), {
      root: doc,
      shadow,
      patch: NO_PATCH,
    });

    const reports = await resolveForReplay([anchor], {
      root: doc,
      shadow,
      patch: NO_PATCH,
    });

    expect(() => JSON.stringify(reports)).not.toThrow();
    expect(reports[0]?.element).toBeNull();
  });

  // A *stale* entry is the case that matters, so one is planted first. Wiping
  // the global before the call would leave "parks nothing" true of an
  // implementation that merely skips the write — and the element a previous
  // step parked under this id would then be measured, scrolled to and clicked
  // as though this step had succeeded.
  it("clears the element a previous step parked when this one does not resolve", async () => {
    const doc = fixture(
      `<div id="stale-host"><button id="stale">Old</button></div>`,
    );
    const stale = doc.querySelector("#stale") as Element;
    const el = document.createElement("button");
    el.id = "gone-btn";
    const { registry: shadow } = createShadowRegistry();
    const { anchor } = await captureAnchor(el, ctx("gone-btn"), {
      root: doc,
      shadow,
      patch: NO_PATCH,
    });

    const win = window as unknown as Record<string, unknown>;
    win[REPLAY_TARGETS] = { "gone-btn": stale };

    const reports = await resolveForReplay([anchor], {
      root: doc,
      shadow,
      patch: NO_PATCH,
    });

    expect(reports[0]?.strategy).toBe("broken");
    expect(
      (win[REPLAY_TARGETS] as Record<string, Element>)["gone-btn"],
    ).toBeUndefined();
  });

  /**
   * The case the integration lane could not see, because its
   * `selectorPageAgent` parks inside the frame by construction.
   *
   * `replayResolve` is answered by the TOP frame only, and for a same-origin
   * child the resolver walks `contentDocument` itself rather than going
   * through the broker — so the element it hands back lives in the child's
   * realm while the code that parks it runs in the top one. The engine looks
   * for it in the child's execution context, because that is what the frame
   * hop in the tree path names. Park it anywhere else and the anchor resolves
   * cleanly and the action never happens.
   */
  it("parks an element inside a same-origin frame on that frame's own window", async () => {
    const frame = document.createElement("iframe");
    frame.srcdoc = `<button id="framed-btn">Inner</button>`;
    await new Promise<void>((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
      document.body.append(frame);
    });
    const childWin = frame.contentWindow as unknown as Record<string, unknown>;
    const childDoc = frame.contentDocument as Document;
    const el = childDoc.querySelector("#framed-btn") as Element;

    // Captured in the child and hopped from above, exactly as the sensor
    // does it: `hopsForChildren` in the parent, `prefixTreePath` in the child.
    const { anchor } = await captureAnchor(el, ctx("framed-btn"), {
      root: childDoc,
      shadow: NO_SHADOW,
      patch: NO_PATCH,
    });
    const hop = hopsForChildren(document).find((h) => h.frame === frame)?.hop;
    expect(hop, "the fixture frame must get a hop").toBeDefined();
    anchor.fingerprint.treePath = prefixTreePath(anchor.fingerprint.treePath, [
      hop as NonNullable<typeof hop>,
    ]);

    const topWin = window as unknown as Record<string, unknown>;
    delete topWin[REPLAY_TARGETS];
    delete childWin[REPLAY_TARGETS];

    const reports = await resolveForReplay([anchor], {
      root: document,
      shadow: NO_SHADOW,
      patch: NO_PATCH,
    });

    const parkedIn = (w: Record<string, unknown>): unknown =>
      (w[REPLAY_TARGETS] as Record<string, Element> | undefined)?.[
        "framed-btn"
      ];
    expect({
      strategy: reports[0]?.strategy,
      inTop: parkedIn(topWin) === undefined ? "absent" : "present",
      inChild: parkedIn(childWin) === el ? "the element" : parkedIn(childWin),
    }).toEqual({
      strategy: "stableId",
      inTop: "absent",
      inChild: "the element",
    });
  });

  /**
   * The stale-entry guard, across a frame boundary.
   *
   * The existing guard deletes from the realm this code runs in, which was
   * the only realm anything was ever parked in. Now that an element parks in
   * the frame that holds it, a failed resolve has to reach that frame too —
   * otherwise the element a previous step left in the child is still sitting
   * under this anchor's id, and the engine, which evaluates in that frame,
   * measures and clicks it as though this step had succeeded.
   */
  it("clears a stale element a previous step parked inside a frame", async () => {
    const frame = document.createElement("iframe");
    frame.srcdoc = `<button id="vanishing-btn">Now you see it</button>`;
    await new Promise<void>((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
      document.body.append(frame);
    });
    const childWin = frame.contentWindow as unknown as Record<string, unknown>;
    const childDoc = frame.contentDocument as Document;
    const el = childDoc.querySelector("#vanishing-btn") as Element;

    const { anchor } = await captureAnchor(el, ctx("vanishing-btn"), {
      root: childDoc,
      shadow: NO_SHADOW,
      patch: NO_PATCH,
    });
    const hop = hopsForChildren(document).find((h) => h.frame === frame)?.hop;
    anchor.fingerprint.treePath = prefixTreePath(anchor.fingerprint.treePath, [
      hop as NonNullable<typeof hop>,
    ]);

    const env = { root: document, shadow: NO_SHADOW, patch: NO_PATCH };
    const first = await resolveForReplay([anchor], env);
    const parkedAfterFirst = (
      childWin[REPLAY_TARGETS] as Record<string, Element> | undefined
    )?.["vanishing-btn"];

    // Now it is gone, and the anchor has nothing left to match on.
    el.remove();
    const second = await resolveForReplay([anchor], env);

    expect({
      firstStrategy: first[0]?.strategy,
      parkedAfterFirst:
        parkedAfterFirst === el ? "the element" : "something else",
      secondStrategy: second[0]?.strategy,
      parkedAfterSecond:
        (childWin[REPLAY_TARGETS] as Record<string, Element> | undefined)?.[
          "vanishing-btn"
        ] === undefined
          ? "absent"
          : "STALE",
    }).toEqual({
      firstStrategy: "stableId",
      parkedAfterFirst: "the element",
      secondStrategy: "broken",
      parkedAfterSecond: "absent",
    });
  });
});
