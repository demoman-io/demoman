import { describe, expect, it } from "vitest";
import {
  type CdpFrameNode,
  findCdpFrameId,
  hopsFromTreePath,
  rectCentre,
  rectFromQuad,
  resolveCdpFrameId,
} from "../../src/index.js";

const tree: CdpFrameNode = {
  frame: { id: "top", url: "https://app.example.com/checkout" },
  childFrames: [
    // Global ordinal 1. Present precisely because it is NOT the frame we want:
    // it is what makes a global index differ from a per-origin one.
    {
      frame: { id: "f-analytics", url: "https://widget.other.com/a", name: "" },
    },
    // Global ordinal 2.
    {
      frame: { id: "f-pay-1", url: "https://js.stripe.com/card", name: "card" },
    },
    // Global ordinal 3.
    {
      frame: { id: "f-pay-2", url: "https://js.stripe.com/card", name: "card" },
      childFrames: [
        {
          frame: {
            id: "f-deep",
            url: "https://js.stripe.com/inner",
            name: "inner",
          },
        },
      ],
    },
    // Global ordinal 4: a srcdoc frame, which records origin "" at capture
    // because it has no src to parse.
    { frame: { id: "f-srcdoc", url: "about:blank", name: "inner" } },
  ],
};

describe("hopsFromTreePath", () => {
  it("finds no hops in a top-frame path", () => {
    expect(hopsFromTreePath("div:1/button:2")).toEqual([]);
  });

  it("reads the frame hops a cross-frame anchor carries", () => {
    const path =
      "#frame(origin=https://js.stripe.com,name=card,ordinal=2)/input:1";
    expect(hopsFromTreePath(path)).toEqual([
      { origin: "https://js.stripe.com", name: "card", ordinal: 2 },
    ]);
  });

  it("treats a null path as top-frame rather than throwing", () => {
    expect(hopsFromTreePath(null)).toEqual([]);
  });
});

describe("findCdpFrameId", () => {
  it("returns the top frame for an empty hop path", () => {
    expect(findCdpFrameId(tree, [])).toBe("top");
  });

  // The ordinal is a global index over every iframe in the document, because
  // that is what hopsForChildren assigns. A per-origin index would look up
  // the second stripe frame here and find only one, or worse, find the wrong
  // one on a page whose frames happen to line up.
  it("indexes frames globally, the way capture numbered them", () => {
    expect(
      findCdpFrameId(tree, [
        { origin: "https://js.stripe.com", name: "card", ordinal: 2 },
      ]),
    ).toBe("f-pay-1");
    expect(
      findCdpFrameId(tree, [
        { origin: "https://js.stripe.com", name: "card", ordinal: 3 },
      ]),
    ).toBe("f-pay-2");
  });

  it("walks more than one level", () => {
    expect(
      findCdpFrameId(tree, [
        { origin: "https://js.stripe.com", name: "card", ordinal: 3 },
        { origin: "https://js.stripe.com", name: "inner", ordinal: 1 },
      ]),
    ).toBe("f-deep");
  });

  it("returns null when the ordinal is past the end", () => {
    expect(
      findCdpFrameId(tree, [
        { origin: "https://js.stripe.com", name: "card", ordinal: 9 },
      ]),
    ).toBeNull();
  });

  // Fail closed. The frame at that index is not the frame that was captured,
  // and dispatching a click into the wrong document is worse than reporting
  // that we could not find it — a partial replay is an outcome we report.
  it("refuses a frame whose origin contradicts the recorded hop", () => {
    expect(
      findCdpFrameId(tree, [
        { origin: "https://evil.test", name: "card", ordinal: 2 },
      ]),
    ).toBeNull();
  });

  // hopsForChildren records origin "" for a frame whose src is absent or
  // unparseable — a srcdoc frame, which is exactly what the integration
  // fixture uses. An empty origin is "no claim", not "the empty origin".
  it("does not check origin when the hop recorded none", () => {
    expect(
      findCdpFrameId(tree, [{ origin: "", name: "inner", ordinal: 4 }]),
    ).toBe("f-srcdoc");
  });

  it("refuses a frame whose name contradicts the recorded hop", () => {
    expect(
      findCdpFrameId(tree, [
        { origin: "https://js.stripe.com", name: "wallet", ordinal: 2 },
      ]),
    ).toBeNull();
  });

  // The same convention for the name, and it is not a nicety: capture records
  // `getAttribute("name") ?? ""`, while `Page.getFrameTree` reports
  // `frame.name` falling back to the element's **id** when the attribute is
  // absent. So `<iframe id="deep">` records "" and reports "deep", and
  // compared strictly every id-only iframe — most of them — fails closed.
  // Measured against real Chromium in the integration lane.
  //
  // The negative control for this is the test directly above it: a hop that
  // DID record a name is still compared strictly, so this loosening cannot
  // quietly become "stop checking the name".
  it("does not check name when the hop recorded none", () => {
    expect(
      findCdpFrameId(tree, [
        { origin: "https://js.stripe.com", name: "", ordinal: 2 },
      ]),
    ).toBe("f-pay-1");
  });
});

/**
 * The ordinal capture assigns is document order; `childFrames` is attach
 * order, and for a JS-mounted frame the two differ — measured against real
 * Chromium in the integration lane. Where a hop records an origin or a name,
 * the corroboration above catches the disagreement. Where it records neither,
 * the ordinal is the whole of the selection, and the frame's own owner
 * element is asked where it actually sits.
 */
describe("resolveCdpFrameId", () => {
  const owner = (ordinals: Record<string, number | null>) => ({
    documentOrdinalOf: async (frameId: string) => ordinals[frameId] ?? null,
    asked: ordinals,
  });

  it("accepts an uncorroborated hop whose ordinal the document agrees with", async () => {
    expect(
      await resolveCdpFrameId(
        tree,
        [{ origin: "", name: "", ordinal: 4 }],
        owner({ "f-srcdoc": 4 }),
      ),
    ).toBe("f-srcdoc");
  });

  // The whole point. Ordinal 4 in attach order is a frame that sits somewhere
  // else in the document, so it is not the frame the take recorded.
  it("refuses an uncorroborated hop the document places elsewhere", async () => {
    expect(
      await resolveCdpFrameId(
        tree,
        [{ origin: "", name: "", ordinal: 4 }],
        owner({ "f-srcdoc": 3 }),
      ),
    ).toBeNull();
  });

  // An unanswerable corroboration is not a passed one: on a hop that claims
  // neither an origin nor a name there is nothing else left to believe.
  it("refuses when the owner lookup cannot answer", async () => {
    expect(
      await resolveCdpFrameId(
        tree,
        [{ origin: "", name: "", ordinal: 4 }],
        owner({}),
      ),
    ).toBeNull();
  });

  // A hop that recorded something is corroborated by that something, and pays
  // nothing for this. Three CDP round trips per hop is not free.
  it("does not consult the owner for a hop that recorded a name or an origin", async () => {
    const asked: string[] = [];
    const spy = {
      documentOrdinalOf: async (frameId: string) => {
        asked.push(frameId);
        return null;
      },
    };
    expect(
      await resolveCdpFrameId(
        tree,
        [{ origin: "https://js.stripe.com", name: "card", ordinal: 2 }],
        spy,
      ),
    ).toBe("f-pay-1");
    expect(
      await resolveCdpFrameId(
        tree,
        [{ origin: "", name: "inner", ordinal: 4 }],
        spy,
      ),
    ).toBe("f-srcdoc");
    expect(asked).toEqual([]);
  });

  it("is findCdpFrameId for a top-frame path", async () => {
    expect(await resolveCdpFrameId(tree, [], owner({}))).toBe("top");
  });
});

describe("rectFromQuad", () => {
  // DOM.getBoxModel returns four corners in main-frame CSS pixels, clockwise
  // from top-left — and a transformed element's quad is not axis-aligned, so
  // the rect is its bounding box, not corner 1 and corner 3.
  it("bounds a rotated quad", () => {
    const rect = rectFromQuad([10, 0, 30, 10, 20, 30, 0, 20]);
    expect(rect).toEqual({ x: 0, y: 0, width: 30, height: 30 });
  });

  it("gives the centre a click should land on", () => {
    expect(rectCentre({ x: 10, y: 20, width: 100, height: 40 })).toEqual({
      x: 60,
      y: 40,
    });
  });
});
