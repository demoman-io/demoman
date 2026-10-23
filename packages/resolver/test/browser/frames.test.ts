import type { SceneAnchor } from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import { captureAnchor } from "../../src/capture";
import { NO_FRAMES } from "../../src/ports/frames";
import { resolveAll, resolveAnchor } from "../../src/resolve";
import { findFrameElement, sameOriginFrames } from "../../src/scope";
import type { ResolutionReport } from "../../src/types";

const ctx = {
  anchorId: "a-1",
  url: "https://app.example.com/",
  actionIndex: 0,
  entryState: true,
};

async function sameOriginFrame(html: string): Promise<HTMLIFrameElement> {
  document.body.innerHTML = `<main><iframe name="pay" src="about:blank"></iframe></main>`;
  const frame = document.querySelector("iframe") as HTMLIFrameElement;
  await new Promise<void>((resolve) => {
    if (frame.contentDocument?.readyState === "complete") return resolve();
    frame.addEventListener("load", () => resolve(), { once: true });
  });
  const doc = frame.contentDocument as Document;
  doc.body.innerHTML = html;
  return frame;
}

describe("same-origin iframes", () => {
  it("enumerates reachable frame documents", async () => {
    await sameOriginFrame(`<button data-testid="pay">Pay</button>`);
    expect(sameOriginFrames(document)).toHaveLength(1);
  });

  it("captures a frame hop in the tree path and resolves back through it", async () => {
    const frame = await sameOriginFrame(
      `<button data-testid="pay">Pay</button>`,
    );
    const target = frame.contentDocument?.querySelector("button") as Element;

    const { anchor, report } = await captureAnchor(target, ctx, {
      root: document,
    });
    expect(report.element).toBe(target);
    expect(anchor.fingerprint.treePath).toContain("#frame(");

    const again = await resolveAnchor(anchor, { root: document });
    expect(again.strategy).toBe("stableId");
    expect(again.element).toBe(target);
  });

  it("does not carry a disagreeing path signal for a cleanly resolved framed anchor", async () => {
    // scoreCandidate compares a frame-relative path (no #frame hop, computed
    // against the frame document) to fp.treePath (which always carries one)
    // -- a comparison that can never agree. That is a guaranteed false
    // negative, not evidence of drift, so the signal must be omitted rather
    // than reported as disagreeing.
    const frame = await sameOriginFrame(
      `<button data-testid="pay">Pay</button>`,
    );
    const target = frame.contentDocument?.querySelector("button") as Element;

    const { anchor } = await captureAnchor(target, ctx, { root: document });
    const report = await resolveAnchor(anchor, { root: document });
    expect(report.strategy).toBe("stableId");
    expect(
      report.corroboration.find((s) => s.signal === "path"),
    ).toBeUndefined();
  });
});

describe("cross-origin iframes", () => {
  it("routes through the broker rather than touching the document", async () => {
    const origin = window.location.origin.replace("localhost", "127.0.0.1");
    document.body.innerHTML = `<main><iframe name="pay" src="${origin}/"></iframe></main>`;
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    await new Promise((r) => frame.addEventListener("load", r, { once: true }));
    expect(frame.contentDocument).toBeNull(); // genuinely cross-origin

    const brokered: ResolutionReport = {
      anchorId: "a-1",
      strategy: "stableId",
      element: null,
      candidates: 1,
      failureReason: null,
      corroboration: [],
      durationMs: 1,
    };
    const frames = { resolveInFrame: vi.fn(async () => [brokered]) };

    const anchor = {
      id: "a-1",
      fingerprint: {
        stableId: "pay",
        role: "button",
        accessibleName: "Pay",
        textContent: "Pay",
        treePath: `body:1/main:1/#frame(origin=${origin.replace("localhost", "127.0.0.1")},name=pay,ordinal=1)/body:1/button:1`,
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
      resolution: {
        url: ctx.url,
        actionIndex: 0,
        entryState: true,
        strategy: "stableId" as const,
        failureReason: null,
        candidates: 1,
      },
    };

    const report = await resolveAnchor(anchor, { root: document, frames });
    expect(frames.resolveInFrame).toHaveBeenCalledOnce();
    expect(report.strategy).toBe("stableId");
  });

  it("spends one broker round trip per frame, not one per anchor", async () => {
    const origin = window.location.origin.replace("localhost", "127.0.0.1");
    document.body.innerHTML = `<main><iframe name="pay" src="${origin}/"></iframe></main>`;
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    await new Promise((r) => frame.addEventListener("load", r, { once: true }));

    const path = `body:1/main:1/#frame(origin=${origin},name=pay,ordinal=1)/body:1/button:1`;
    const anchorN = (id: string): SceneAnchor => ({
      id,
      fingerprint: {
        stableId: id,
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: path,
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
      resolution: {
        url: ctx.url,
        actionIndex: 0,
        entryState: true,
        strategy: "stableId",
        failureReason: null,
        candidates: 1,
      },
    });

    const frames = {
      resolveInFrame: vi.fn(async (_hop, group: SceneAnchor[]) =>
        group.map((a) => ({
          anchorId: a.id,
          strategy: "stableId" as const,
          element: null,
          candidates: 1,
          failureReason: null,
          corroboration: [],
          durationMs: 1,
        })),
      ),
    };

    const reports = await resolveAll(
      [anchorN("a"), anchorN("b"), anchorN("c")],
      {
        root: document,
        frames,
      },
    );
    expect(frames.resolveInFrame).toHaveBeenCalledOnce();
    expect(reports.map((r) => r.anchorId)).toEqual(["a", "b", "c"]);
  });

  it("reports frameUnreachable when no broker is supplied", async () => {
    const origin = window.location.origin.replace("localhost", "127.0.0.1");
    document.body.innerHTML = `<main><iframe name="pay" src="${origin}/"></iframe></main>`;
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    await new Promise((r) => frame.addEventListener("load", r, { once: true }));

    const anchor = {
      id: "a-1",
      fingerprint: {
        stableId: "pay",
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: `body:1/main:1/#frame(origin=${origin},name=pay,ordinal=1)/body:1/button:1`,
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
      resolution: {
        url: ctx.url,
        actionIndex: 0,
        entryState: true,
        strategy: "stableId" as const,
        failureReason: null,
        candidates: 1,
      },
    };

    const report = await resolveAnchor(anchor, { root: document });
    expect(report.strategy).toBe("broken");
    expect(report.failureReason).toBe("frameUnreachable");
  });

  it("reports frameGone when the iframe itself disappeared", async () => {
    document.body.innerHTML = `<main></main>`;
    const anchor = {
      id: "a-1",
      fingerprint: {
        stableId: "pay",
        role: null,
        accessibleName: null,
        textContent: null,
        treePath:
          "body:1/main:1/#frame(origin=https://js.stripe.com,name=pay,ordinal=1)/body:1/button:1",
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
      resolution: {
        url: ctx.url,
        actionIndex: 0,
        entryState: true,
        strategy: "stableId" as const,
        failureReason: null,
        candidates: 1,
      },
    };
    const report = await resolveAnchor(anchor, {
      root: document,
      frames: {
        resolveInFrame: async () => {
          throw new Error("unreachable");
        },
      },
    });
    expect(report.failureReason).toBe("frameGone");
  });

  it("reports frameUnreachable, not frameGone, when the broker throws but the frame is present", async () => {
    const origin = window.location.origin.replace("localhost", "127.0.0.1");
    document.body.innerHTML = `<main><iframe name="pay" src="${origin}/"></iframe></main>`;
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    await new Promise((r) => frame.addEventListener("load", r, { once: true }));
    expect(frame.contentDocument).toBeNull(); // still genuinely cross-origin, still present

    const anchor = {
      id: "a-1",
      fingerprint: {
        stableId: "pay",
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: `body:1/main:1/#frame(origin=${origin},name=pay,ordinal=1)/body:1/button:1`,
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
      resolution: {
        url: ctx.url,
        actionIndex: 0,
        entryState: true,
        strategy: "stableId" as const,
        failureReason: null,
        candidates: 1,
      },
    };

    const report = await resolveAnchor(anchor, {
      root: document,
      frames: {
        resolveInFrame: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(report.failureReason).toBe("frameUnreachable");
  });

  it("reports frameUnreachable when NO_FRAMES is passed explicitly and the frame is present", async () => {
    const origin = window.location.origin.replace("localhost", "127.0.0.1");
    document.body.innerHTML = `<main><iframe name="pay" src="${origin}/"></iframe></main>`;
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    await new Promise((r) => frame.addEventListener("load", r, { once: true }));

    const anchor = {
      id: "a-1",
      fingerprint: {
        stableId: "pay",
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: `body:1/main:1/#frame(origin=${origin},name=pay,ordinal=1)/body:1/button:1`,
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
      resolution: {
        url: ctx.url,
        actionIndex: 0,
        entryState: true,
        strategy: "stableId" as const,
        failureReason: null,
        candidates: 1,
      },
    };

    const report = await resolveAnchor(anchor, {
      root: document,
      frames: NO_FRAMES,
    });
    expect(report.failureReason).toBe("frameUnreachable");
  });
});

describe("ambiguous same-named iframes", () => {
  async function twoSameOriginFrames(): Promise<
    [HTMLIFrameElement, HTMLIFrameElement]
  > {
    document.body.innerHTML = `<main>
      <iframe name="pay" src="about:blank"></iframe>
      <iframe name="pay" src="about:blank"></iframe>
    </main>`;
    const frames = Array.from(
      document.querySelectorAll("iframe"),
    ) as HTMLIFrameElement[];
    await Promise.all(
      frames.map(
        (frame) =>
          new Promise<void>((resolve) => {
            if (frame.contentDocument?.readyState === "complete")
              return resolve();
            frame.addEventListener("load", () => resolve(), { once: true });
          }),
      ),
    );
    const [first, second] = frames;
    if (first === undefined || second === undefined) {
      throw new Error("expected two iframes");
    }
    (first.contentDocument as Document).body.innerHTML =
      `<button data-testid="pay1">Pay 1</button>`;
    (second.contentDocument as Document).body.innerHTML =
      `<button data-testid="pay2">Pay 2</button>`;
    return [first, second];
  }

  it("resolves against the second of two same-named iframes when the hop ordinal says so", async () => {
    const [, second] = await twoSameOriginFrames();
    const target = second.contentDocument?.querySelector("button") as Element;

    const anchor = {
      id: "a-1",
      fingerprint: {
        stableId: "pay2",
        role: null,
        accessibleName: null,
        textContent: null,
        treePath:
          "body:1/main:1/#frame(origin=,name=pay,ordinal=2)/body:1/button:1",
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
      resolution: {
        url: ctx.url,
        actionIndex: 0,
        entryState: true,
        strategy: "stableId" as const,
        failureReason: null,
        candidates: 1,
      },
    };

    const report = await resolveAnchor(anchor, { root: document });
    expect(report.element).toBe(target);
  });

  it("reports frameGone rather than matching an unrelated frame by ordinal alone", async () => {
    // The hop names a specific frame (name+origin). It's gone; an unrelated
    // frame just happens to sit at the recorded ordinal. Ordinal alone must
    // not be enough to hand the ladder a stranger's document.
    document.body.innerHTML = `<main><iframe name="ads"></iframe></main>`;
    const anchor = {
      id: "a-1",
      fingerprint: {
        stableId: "pay",
        role: null,
        accessibleName: null,
        textContent: null,
        treePath:
          "body:1/main:1/#frame(origin=https://js.stripe.com,name=pay,ordinal=1)/body:1/button:1",
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
      resolution: {
        url: ctx.url,
        actionIndex: 0,
        entryState: true,
        strategy: "stableId" as const,
        failureReason: null,
        candidates: 1,
      },
    };

    const report = await resolveAnchor(anchor, { root: document });
    expect(report.failureReason).toBe("frameGone");
    expect(report.element).toBeNull();
  });

  it("still matches on ordinal alone when the hop carries no name or origin", () => {
    // Anonymous frames (no name, no computable origin) must still resolve
    // positionally -- the fix only tightens the case where the hop names a
    // frame that isn't the one found.
    document.body.innerHTML = `<main><iframe></iframe><iframe></iframe></main>`;
    const frames = Array.from(
      document.querySelectorAll("iframe"),
    ) as HTMLIFrameElement[];
    const hop = { origin: "", name: "", ordinal: 2 };
    expect(findFrameElement(document, hop)).toBe(frames[1]);
  });

  it("refuses to guess between two same-named iframes the hop cannot tell apart", async () => {
    await twoSameOriginFrames();

    // ordinal=3: neither of the two frames (positions 1 and 2) matches, and
    // both tie on the "name" signal alone -- the hop cannot tell them apart.
    const anchor = {
      id: "a-1",
      fingerprint: {
        stableId: "pay2",
        role: null,
        accessibleName: null,
        textContent: null,
        treePath:
          "body:1/main:1/#frame(origin=,name=pay,ordinal=3)/body:1/button:1",
        boundingRect: null,
        imagePatchRef: null,
        dataKey: null,
      },
      resolution: {
        url: ctx.url,
        actionIndex: 0,
        entryState: true,
        strategy: "stableId" as const,
        failureReason: null,
        candidates: 1,
      },
    };

    const report = await resolveAnchor(anchor, { root: document });
    expect(report.failureReason).toBe("frameGone");
    expect(report.element).toBeNull();
  });
});
