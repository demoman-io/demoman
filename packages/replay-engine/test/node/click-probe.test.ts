import { describe, expect, it } from "vitest";
import {
  CLICK_DRIFT_PX,
  CLICK_MEASURE_SLACK_PX,
  CLICK_MEASURE_TRIES,
  CLICK_SIGHTING_BINDING,
  type ClickProbe,
  type ClickSeen,
  clickVerdict,
  createClickSightings,
  discardClickProbe,
  dragVerdict,
  pagePointOf,
  placeClickProbe,
  readClickProbe,
} from "../../src/click-probe";
import type { CdpSession } from "../../src/types";

/** The sample app's "Create invoice", sent to its centre (1491, 1021). */
const SENT = { x: 1491, y: 1021 };
const OWN = { x: 1295, y: 1003, width: 391, height: 36 };

const seen = (over: Partial<ClickSeen>): ClickSeen => ({
  own: OWN,
  viewport: { width: 1710, height: 1107 },
  down: SENT,
  up: SENT,
  cancelled: false,
  focused: true,
  ...over,
});

/** A session whose every `send` answers `reply`, or rejects with it, and
 *  which keeps the methods it was sent. */
const session = (
  reply: Record<string, unknown> | Error,
): CdpSession & { sent: string[] } => {
  const sent: string[] = [];
  return {
    sent,
    send: async (method) => {
      sent.push(method);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    on: () => () => undefined,
    detach: async () => undefined,
  };
};

/** A border quad for `getBoxModel`, from a rect. */
const quad = (r: { x: number; y: number; width: number; height: number }) => [
  r.x,
  r.y,
  r.x + r.width,
  r.y,
  r.x + r.width,
  r.y + r.height,
  r.x,
  r.y + r.height,
];

/** A session that answers `DOM.getBoxModel` from `boxes` in turn, places the
 *  probe as `probe-1`, and keeps what it was sent. */
const measuring = (
  boxes: { x: number; y: number; width: number; height: number }[],
) => {
  const sent: string[] = [];
  let measured = 0;
  const cdp: CdpSession = {
    send: async (method) => {
      sent.push(method);
      if (method === "DOM.getBoxModel") {
        const box = boxes[Math.min(measured++, boxes.length - 1)];
        return { model: { border: quad(box as (typeof boxes)[number]) } };
      }
      return { result: { type: "object", objectId: "probe-1" } };
    },
    on: () => () => undefined,
    detach: async () => undefined,
  };
  return { cdp, sent };
};

describe("pagePointOf: where a dispatched point arrives in the page", () => {
  it("is the point itself when the two spaces coincide", () => {
    expect(pagePointOf(SENT, OWN, OWN)).toEqual({
      ...SENT,
      scale: { x: 1, y: 1 },
    });
  });

  // An iframe at (300, 200): the page's client coordinates are the frame's.
  it("subtracts a frame's offset", () => {
    const box = { x: 350, y: 220, width: 100, height: 40 };
    const own = { x: 50, y: 20, width: 100, height: 40 };
    expect(pagePointOf({ x: 400, y: 240 }, box, own)).toEqual({
      x: 100,
      y: 40,
      scale: { x: 1, y: 1 },
    });
  });

  // A frame drawn at twice its size: its page pixels are half the dispatched.
  it("scales by the ratio of the two rects", () => {
    const box = { x: 10, y: 20, width: 200, height: 80 };
    const own = { x: 110, y: 220, width: 100, height: 40 };
    expect(pagePointOf({ x: 110, y: 60 }, box, own)).toEqual({
      x: 160,
      y: 240,
      scale: { x: 0.5, y: 0.5 },
    });
  });

  it("maps a zero-sized target by offset alone", () => {
    const box = { x: 10, y: 20, width: 0, height: 0 };
    const own = { x: 15, y: 25, width: 0, height: 0 };
    expect(pagePointOf({ x: 10, y: 20 }, box, own)).toEqual({
      x: 15,
      y: 25,
      scale: { x: 1, y: 1 },
    });
  });
});

describe("clickVerdict: did the press and the release arrive where they were sent", () => {
  it("is delivered when both arrived where they were sent", () => {
    expect(clickVerdict(seen({}), SENT).kind).toBe("delivered");
  });

  // The first shape found on 2026-10-13: the release alone at 2/3.
  it("is misdelivered when the release arrived elsewhere, and says where everything went", () => {
    const v = clickVerdict(seen({ up: { x: 994, y: 680.67 } }), SENT);
    expect(v.kind).toBe("misdelivered");
    expect(v.kind === "misdelivered" && v.why).toBe(
      "sent to (1491, 1021), the press arrived at (1491, 1021) and the release arrived at (994, 681)",
    );
  });

  // The second: the whole click at 2/3, press and release agreeing with each
  // other. Red if the verdict compares the two events instead of each with
  // where it was sent — the first version of this check did, and let it by.
  it("is misdelivered when the whole click arrived elsewhere", () => {
    const moved = { x: 994, y: 680.67 };
    const v = clickVerdict(seen({ down: moved, up: moved }), SENT);
    expect(v.kind).toBe("misdelivered");
  });

  it("is misdelivered when only the press arrived elsewhere", () => {
    const v = clickVerdict(seen({ down: { x: 994, y: 681 } }), SENT);
    expect(v.kind).toBe("misdelivered");
  });

  // The boundary, both sides of it, on each axis and for each event.
  it("treats CLICK_DRIFT_PX of drift as arrived and anything past it as elsewhere", () => {
    const off = (dx: number, dy: number) => ({
      x: SENT.x + dx,
      y: SENT.y + dy,
    });
    const kind = (over: Partial<ClickSeen>) =>
      clickVerdict(seen(over), SENT).kind;
    expect(kind({ up: off(CLICK_DRIFT_PX, 0) })).toBe("delivered");
    expect(kind({ down: off(0, -CLICK_DRIFT_PX) })).toBe("delivered");
    expect(kind({ up: off(CLICK_DRIFT_PX + 0.5, 0) })).toBe("misdelivered");
    expect(kind({ down: off(0, -(CLICK_DRIFT_PX + 0.5)) })).toBe(
      "misdelivered",
    );
  });

  // The tolerance is in dispatched pixels: on a page drawn at a quarter of
  // them, 1 page pixel is 4 dispatched — past the line — and 0.4 is 1.6.
  it("measures the tolerance in dispatched pixels on a scaled page", () => {
    const quarter = { x: 0.25, y: 0.25 };
    const kind = (dx: number) =>
      clickVerdict(seen({ up: { x: SENT.x + dx, y: SENT.y } }), SENT, quarter)
        .kind;
    expect(kind(0.4)).toBe("delivered");
    expect(kind(1)).toBe("misdelivered");
  });

  // An event never seen is no evidence of a miss: the page's own window
  // listener may have stopped it before the check's (review I3). Red if a
  // missing event stops the run.
  it("is unconfirmed when the release was never seen and the press arrived where it was sent", () => {
    const v = clickVerdict(seen({ up: null }), SENT);
    expect(v).toEqual({
      kind: "unconfirmed",
      why: "sent to (1491, 1021), the press arrived at (1491, 1021) and the release was never seen — the page's own code may have kept it from the check",
      // Carried, so a `type` can still be judged by its field's focus.
      seen: seen({ up: null }),
    });
  });

  it("is unconfirmed when the press was never seen and the release arrived where it was sent", () => {
    expect(clickVerdict(seen({ down: null }), SENT).kind).toBe("unconfirmed");
  });

  // ...unless the one that was seen arrived elsewhere.
  it("is misdelivered when one was never seen and the other arrived elsewhere", () => {
    const v = clickVerdict(seen({ down: null, up: { x: 994, y: 681 } }), SENT);
    expect(v.kind === "misdelivered" && v.why).toBe(
      "sent to (1491, 1021), the press was never seen and the release arrived at (994, 681)",
    );
  });

  it("is unconfirmed, saying why, when neither arrived", () => {
    expect(clickVerdict(seen({ down: null, up: null }), SENT)).toEqual({
      kind: "unconfirmed",
      why: "neither the press nor the release reached the target's page",
      seen: seen({ down: null, up: null }),
    });
  });

  // The 2026-10-13 shape from an app whose script never loaded: its panel
  // stayed off screen, the click went to its field there, and the events
  // arrived exactly where they were sent — on the document. Red if a click
  // sent outside the viewport can read as delivered.
  it("is misdelivered when it was sent outside the viewport, wherever it arrived", () => {
    const off = { x: 1931, y: 168 };
    const v = clickVerdict(seen({ down: off, up: off }), off);
    expect(v.kind === "misdelivered" && v.why).toBe(
      "sent to (1931, 168), outside the page's 1710x1107 viewport — the target is off screen — so it reached nothing",
    );
    for (const at of [
      { x: -1, y: 10 },
      { x: 10, y: -1 },
      { x: 10, y: 1108 },
    ]) {
      expect(clickVerdict(seen({ down: at, up: at }), at).kind).toBe(
        "misdelivered",
      );
    }
    // The edges themselves are inside.
    const edge = { x: 1710, y: 1107 };
    expect(clickVerdict(seen({ down: edge, up: edge }), edge).kind).toBe(
      "delivered",
    );
  });

  // Checked first: a cancelled pointer can come with an event elsewhere.
  it("is unconfirmed when the browser cancelled the pointer, wherever its events went", () => {
    const v = clickVerdict(
      seen({ up: { x: 994, y: 681 }, cancelled: true }),
      SENT,
    );
    expect(v.kind).toBe("unconfirmed");
  });
});

describe("placeClickProbe: measured either side of the page's own measurement", () => {
  it("keeps the box when the target did not move between the two", async () => {
    const { cdp, sent } = measuring([OWN, OWN]);
    expect(await placeClickProbe(cdp, "target")).toEqual({
      probeId: "probe-1",
      token: null,
      box: OWN,
      unmeasured: null,
    });
    // The premise: measured, placed, measured — in that order.
    expect(sent).toEqual([
      "DOM.getBoxModel",
      "Runtime.callFunctionOn",
      "DOM.getBoxModel",
    ]);
  });

  // A target animating between the two boxes gives the page's rect from a
  // third moment, and a mapping off by the motion (review I4). Red if the
  // two are not compared. Moving through every bracket: the boxes alternate
  // for as many as `CLICK_MEASURE_TRIES` brackets ask for.
  it("leaves the click unjudged when the target moved through every bracket", async () => {
    const pulsed = { ...OWN, x: OWN.x - 5, width: OWN.width + 10 };
    const { cdp, sent } = measuring(
      Array.from({ length: CLICK_MEASURE_TRIES }, () => [OWN, pulsed]).flat(),
    );
    const probe = await placeClickProbe(cdp, "target");
    expect(probe).toEqual({
      probeId: "probe-1",
      token: null,
      box: null,
      unmeasured: "the target was moving as it was measured",
    });
    // The premise: it did bracket every time, not give up after one.
    expect(sent.filter((m) => m === "DOM.getBoxModel")).toHaveLength(
      2 * CLICK_MEASURE_TRIES,
    );
  });

  // Review 2026-10-13, #5: a hover transition still running as the click
  // goes out trips one bracket on a frame boundary (measured 18 of 100), and
  // the click was fine. Red if a single moved bracket leaves it unjudged.
  it("brackets again, the page measuring anew, when the target moved once", async () => {
    const pulsed = { ...OWN, x: OWN.x - 5, width: OWN.width + 10 };
    const { cdp, sent } = measuring([OWN, pulsed, pulsed, pulsed]);
    const probe = await placeClickProbe(cdp, "target");
    expect(probe).toEqual({
      probeId: "probe-1",
      token: null,
      box: pulsed,
      unmeasured: null,
    });
    expect(sent).toEqual([
      "DOM.getBoxModel",
      "Runtime.callFunctionOn",
      "DOM.getBoxModel",
      "DOM.getBoxModel",
      "Runtime.callFunctionOn",
      "DOM.getBoxModel",
    ]);
  });

  it("allows CLICK_MEASURE_SLACK_PX between the two boxes", async () => {
    const nudged = { ...OWN, x: OWN.x + CLICK_MEASURE_SLACK_PX };
    const { cdp } = measuring([OWN, nudged]);
    const probe = await placeClickProbe(cdp, "target");
    expect("box" in probe && probe.box).toEqual(nudged);
  });
});

describe("readClickProbe: never a throw, never a silent verdict", () => {
  const placed: ClickProbe = {
    probeId: "p",
    token: null,
    box: OWN,
    unmeasured: null,
  };

  it("is unconfirmed, naming the cause, when the probe was never placed", async () => {
    const v = await readClickProbe(
      session({}),
      { unplaced: "no window" },
      SENT,
    );
    expect(v).toEqual({
      kind: "unconfirmed",
      why: "the click could not be checked: no window",
    });
  });

  it("is unconfirmed, quoting the browser, when the read rejects", async () => {
    const v = await readClickProbe(
      session(new Error("Cannot find context with specified id")),
      placed,
      SENT,
    );
    expect(v).toEqual({
      kind: "unconfirmed",
      why: "the page went away before the click could be checked (Cannot find context with specified id)",
    });
  });

  // Without CDP's rect there is no telling where the click was sent in the
  // page's terms: said, not guessed.
  it("is unconfirmed when the target could not be measured as the click was sent", async () => {
    const v = await readClickProbe(
      session({ result: { type: "object", value: seen({}) } }),
      {
        probeId: "p",
        token: null,
        box: null,
        unmeasured: "Could not compute box model.",
      },
      SENT,
    );
    expect(v).toEqual({
      kind: "unconfirmed",
      why: "the target could not be measured as the click was sent (Could not compute box model.), so where it arrived could not be judged",
      seen: seen({}),
    });
  });

  // A reply of the wrong shape must not reach clickVerdict.
  it("is unconfirmed when the reply is not what the probe answers", async () => {
    for (const value of [
      undefined,
      null,
      { down: null, up: null },
      { ...seen({}), own: undefined },
      { ...seen({}), down: { x: 1 } },
      { ...seen({}), up: undefined },
      { ...seen({}), viewport: undefined },
    ]) {
      const v = await readClickProbe(
        session({ result: { type: "object", value } }),
        placed,
        SENT,
      );
      expect(v, JSON.stringify(value)).toEqual({
        kind: "unconfirmed",
        why: "the click check answered with nothing this could read",
      });
    }
  });

  // Judged in the page's coordinates, with the tolerance in dispatched ones.
  it("judges a well-formed reply against the mapped point", async () => {
    const box = { x: 10, y: 20, width: 200, height: 80 };
    const own = { x: 110, y: 220, width: 100, height: 40 };
    const at = { x: 160, y: 240 };
    const v = await readClickProbe(
      session({
        result: { type: "object", value: seen({ own, down: at, up: at }) },
      }),
      { probeId: "p", token: null, box, unmeasured: null },
      { x: 110, y: 60 },
    );
    expect(v.kind).toBe("delivered");
  });

  // The probe's handle is let go once read (review M1).
  it("releases the probe's handle after reading it", async () => {
    const cdp = session({ result: { type: "object", value: seen({}) } });
    await readClickProbe(cdp, placed, SENT);
    expect(cdp.sent).toEqual([
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ]);
  });

  // A click whose dispatch threw still takes its listeners down.
  it("takes a probe down without a click to judge", async () => {
    const cdp = session({ result: { type: "object", value: seen({}) } });
    await discardClickProbe(cdp, placed);
    expect(cdp.sent).toEqual([
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ]);
  });
});

// A click that navigates: the page goes away before the read can be had,
// and the listeners' own reports, sent as the events arrived, are judged
// instead. Judged — not taken as a pass.
describe("readClickProbe when the page went away: the listeners' reports", () => {
  const TOKEN = "ac-1";
  const placed: ClickProbe = {
    probeId: "p",
    token: TOKEN,
    box: OWN,
    unmeasured: null,
  };

  /** A session whose read is refused as a navigation refuses it, which
   *  hands its `Runtime.bindingCalled` listener to `emit`, and which
   *  answers or refuses `Runtime.addBinding` as `binding` says. */
  function navigatedAway(binding: "given" | Error = "given") {
    const handlers: ((params: Record<string, unknown>) => void)[] = [];
    const cdp: CdpSession = {
      send: async (method) => {
        if (method === "Runtime.addBinding") {
          if (binding instanceof Error) throw binding;
          return {};
        }
        throw new Error("Cannot find context with specified id");
      },
      on: (event, handler) => {
        if (event === "Runtime.bindingCalled") handlers.push(handler);
        return () => undefined;
      },
      detach: async () => undefined,
    };
    const emit = (report: unknown, name = CLICK_SIGHTING_BINDING) => {
      for (const h of handlers) {
        h({ name, payload: JSON.stringify(report), executionContextId: 1 });
      }
    };
    return { cdp, emit };
  }
  const reportOf = (over: Partial<ClickSeen>) => {
    const { focused: _, ...rest } = seen(over);
    return { token: TOKEN, ...rest };
  };

  it("is delivered when both events were reported where they were sent", async () => {
    const { cdp, emit } = navigatedAway();
    const sightings = createClickSightings(cdp);
    await sightings.install();
    emit(reportOf({}));
    const v = await readClickProbe(cdp, placed, SENT, sightings);
    // Focus went with the page.
    expect(v).toEqual({ kind: "delivered", seen: seen({ focused: false }) });
  });

  it("is misdelivered when the release was reported somewhere else", async () => {
    const { cdp, emit } = navigatedAway();
    const sightings = createClickSightings(cdp);
    await sightings.install();
    emit(reportOf({ up: { x: 994, y: 681 } }));
    const v = await readClickProbe(cdp, placed, SENT, sightings);
    expect(v.kind).toBe("misdelivered");
  });

  // Red if a report is matched to the wrong probe: another click's word is
  // not this one's.
  it("is unconfirmed on another probe's report, or another binding's", async () => {
    const { cdp, emit } = navigatedAway();
    const sightings = createClickSightings(cdp);
    await sightings.install();
    emit({ ...reportOf({}), token: "ac-2" });
    emit(reportOf({}), "somePageBinding");
    emit("not json at all {");
    const v = await readClickProbe(cdp, placed, SENT, sightings);
    expect(v).toEqual({
      kind: "unconfirmed",
      why: "the page went away before the click could be checked (Cannot find context with specified id)",
    });
  });

  it("says why there were no reports when the binding was refused", async () => {
    const { cdp } = navigatedAway(new Error("Runtime.addBinding refused"));
    const sightings = createClickSightings(cdp);
    await sightings.install();
    const v = await readClickProbe(cdp, placed, SENT, sightings);
    expect(v).toEqual({
      kind: "unconfirmed",
      why: "the page went away before the click could be checked (Cannot find context with specified id), and the page could not be given a way to report clicks (Runtime.addBinding refused)",
    });
  });
});

describe("dragVerdict: the press at the start, the release at the end", () => {
  const END = { x: SENT.x - 300, y: SENT.y + 40 };

  it("measures inside the page (the premise of the cases below)", () => {
    const { viewport } = seen({});
    expect(END.x).toBeLessThan(viewport.width);
    expect(END.y).toBeLessThan(viewport.height);
  });

  it("is delivered when the press is at the start and the release at the end", () => {
    expect(dragVerdict(seen({ down: SENT, up: END }), SENT, END).kind).toBe(
      "delivered",
    );
  });

  // Red if a drag is judged as a click: its release is 300px from its press
  // by design, and clickVerdict calls that a miss.
  it("is misdelivered when the release lands elsewhere, and says the release", () => {
    const v = dragVerdict(
      seen({ down: SENT, up: { x: END.x - 50, y: END.y } }),
      SENT,
      END,
    );
    expect(v.kind).toBe("misdelivered");
    expect(v.kind === "misdelivered" && v.why).toContain("the release");
    expect(clickVerdict(seen({ down: SENT, up: END }), SENT).kind).toBe(
      "misdelivered",
    );
  });

  // A native drag: Chrome cancels the pointer as the drag begins, and the
  // drop is the release. A click with the same events stays unconfirmed.
  it("reads a cancel followed by a release at the end as a native drag", () => {
    const native = seen({ down: SENT, up: END, cancelled: true });
    expect(dragVerdict(native, SENT, END).kind).toBe("delivered");
    expect(clickVerdict(native, SENT).kind).toBe("unconfirmed");
  });

  // Final review, finding 3, in words: a drag that began and was dropped
  // nowhere says so, not "the browser cancelled the pointer".
  it("says a native drag nothing accepted, rather than a cancelled pointer", () => {
    const v = dragVerdict(
      seen({ down: SENT, up: null, cancelled: true }),
      SENT,
      END,
    );
    expect(v.kind).toBe("unconfirmed");
    expect(v.kind === "unconfirmed" && v.why).toContain("accepted the drop");
  });

  // Review of 2026-10-21: a touch has no native drag, so a cancelled one is
  // the browser taking the gesture as its own pan, not a drop refused.
  it("says a cancelled touch drag was taken by the browser, not refused at its end", () => {
    const cancelled = seen({ down: SENT, up: null, cancelled: true });
    const v = dragVerdict(cancelled, SENT, END, undefined, true);
    expect(v.kind).toBe("unconfirmed");
    expect(v.kind === "unconfirmed" && v.why).toContain("touch-action");
    expect(v.kind === "unconfirmed" && v.why).not.toContain(
      "accepted the drop",
    );
  });

  it("is unconfirmed when no release was seen", () => {
    expect(dragVerdict(seen({ down: SENT, up: null }), SENT, END).kind).toBe(
      "unconfirmed",
    );
  });
});
