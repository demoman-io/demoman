import type { SceneAnchor } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { captureAnchor } from "../../src/capture";
import { NO_PATCH } from "../../src/ports/patch";
import { createCanvasMatcher } from "../../src/ports/patch-canvas";
import { resolveAnchor } from "../../src/resolve";

const ctx = {
  anchorId: "a-1",
  url: "https://app.example.com/",
  actionIndex: 0,
  entryState: true,
};

const page = `
  <main>
    <div style="width:120px;height:40px;background:#1144cc" data-testid="brand-tile"></div>
    <div style="width:120px;height:40px;background:#eeeeee"></div>
  </main>`;

describe("image patch matcher", () => {
  it("captures a patch reference for an element with real pixels", async () => {
    document.body.innerHTML = page;
    const el = document.querySelector("[data-testid=brand-tile]") as Element;
    const { anchor } = await captureAnchor(el, ctx, {
      root: document,
      patch: createCanvasMatcher(),
    });
    expect(anchor.fingerprint.imagePatchRef).not.toBeNull();
  });

  it("resolves by image patch when every other fingerprint is gone", async () => {
    document.body.innerHTML = page;
    const el = document.querySelector("[data-testid=brand-tile]") as Element;
    const patch = createCanvasMatcher();
    const { anchor } = await captureAnchor(el, ctx, { root: document, patch });

    // Strip everything the higher tiers could use; only the pixels remain.
    const stripped: SceneAnchor = {
      ...anchor,
      fingerprint: {
        ...anchor.fingerprint,
        stableId: null,
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: null,
      },
    };
    document.body.innerHTML = page.replace(`data-testid="brand-tile"`, "");

    const report = await resolveAnchor(stripped, { root: document, patch });
    expect(report.strategy).toBe("imagePatch");
    expect((report.element as HTMLElement).style.background).toContain(
      "rgb(17, 68, 204)",
    );
  });

  it("reports patchUnavailable when a patch ref exists but no matcher was supplied", async () => {
    document.body.innerHTML = page;
    const el = document.querySelector("[data-testid=brand-tile]") as Element;
    const { anchor } = await captureAnchor(el, ctx, {
      root: document,
      patch: createCanvasMatcher(),
    });
    const stripped: SceneAnchor = {
      ...anchor,
      fingerprint: {
        ...anchor.fingerprint,
        stableId: null,
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: null,
      },
    };
    document.body.innerHTML = page.replace(`data-testid="brand-tile"`, "");

    const report = await resolveAnchor(stripped, { root: document });
    expect(report.strategy).toBe("broken");
    expect(report.failureReason).toBe("patchUnavailable");
  });

  it("does not resolve tier 5 to a visually identical tile in another data-key row", async () => {
    // v8 §7's data-key rule: a row is identified by its data key, never by
    // position or pixels. Two rows with visually identical tiles must not
    // let tier 5 cross the row boundary tiers 1-4 respected.
    document.body.innerHTML = `
      <main>
        <div data-row-key="row-1"><div style="width:80px;height:30px;background:#1144cc" data-testid="tile-1"></div></div>
        <div data-row-key="row-2"><div style="width:80px;height:30px;background:#1144cc" data-testid="tile-2"></div></div>
      </main>`;
    const target = document.querySelector('[data-testid="tile-2"]') as Element;
    const patch = createCanvasMatcher();
    const { anchor } = await captureAnchor(target, ctx, {
      root: document,
      patch,
    });
    expect(anchor.fingerprint.dataKey).toBe("row-2");

    // Strip everything but the dataKey scope and the patch ref.
    const stripped: SceneAnchor = {
      ...anchor,
      fingerprint: {
        ...anchor.fingerprint,
        stableId: null,
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: null,
      },
    };

    const report = await resolveAnchor(stripped, { root: document, patch });
    expect(report.strategy).toBe("imagePatch");
    expect(report.element).toBe(target);
  });

  it("reports patchUnavailable, not plain broken, when NO_PATCH is passed explicitly", async () => {
    // The identical inversion already fixed for NO_FRAMES: passing an inert
    // port explicitly must not give a *worse* report than passing nothing.
    document.body.innerHTML = page;
    const el = document.querySelector("[data-testid=brand-tile]") as Element;
    const { anchor } = await captureAnchor(el, ctx, {
      root: document,
      patch: createCanvasMatcher(),
    });
    const stripped: SceneAnchor = {
      ...anchor,
      fingerprint: {
        ...anchor.fingerprint,
        stableId: null,
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: null,
      },
    };
    document.body.innerHTML = page.replace(`data-testid="brand-tile"`, "");

    const report = await resolveAnchor(stripped, {
      root: document,
      patch: NO_PATCH,
    });
    expect(report.strategy).toBe("broken");
    expect(report.failureReason).toBe("patchUnavailable");
  });

  it("declines a match below threshold rather than guessing", async () => {
    document.body.innerHTML = page;
    const el = document.querySelector("[data-testid=brand-tile]") as Element;
    const patch = createCanvasMatcher({ threshold: 0.99 });
    const { anchor } = await captureAnchor(el, ctx, { root: document, patch });
    const stripped: SceneAnchor = {
      ...anchor,
      fingerprint: {
        ...anchor.fingerprint,
        stableId: null,
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: null,
      },
    };
    document.body.innerHTML = `<main><div style="width:120px;height:40px;background:#cc4411"></div></main>`;

    const report = await resolveAnchor(stripped, { root: document, patch });
    expect(report.strategy).toBe("broken");
  });

  it("refuses a decoded payload of the wrong length instead of scoring a prefix", async () => {
    // similarity() averages over min(a.length, b.length), so a truncated
    // payload is compared against only that many of the candidate's 256
    // samples — and a prefix of the candidate's own signature scores a
    // perfect 1.0. The threshold filter cannot catch this: it is not a weak
    // match, it is a confident wrong one.
    document.body.innerHTML = page;
    const el = document.querySelector("[data-testid=brand-tile]") as Element;
    const patch = createCanvasMatcher();
    const full = (await patch.capture(el)) as string;
    const truncated = `patch:v1:${btoa(atob(full.slice("patch:v1:".length)).slice(0, 3))}`;

    expect(await patch.match(truncated, [el])).toEqual([]);
  });

  it("produces a reference that survives serialization", async () => {
    // SP8's badge re-resolves a scene document read back from disk, in a
    // process that never ran capture. A ref that points into an in-memory map
    // is dead on arrival there, so tier 5 could never fire on a real demo.
    document.body.innerHTML = page;
    const el = document.querySelector("[data-testid=brand-tile]") as Element;
    const { anchor } = await captureAnchor(el, ctx, {
      root: document,
      patch: createCanvasMatcher(),
    });

    const roundTripped: SceneAnchor = JSON.parse(JSON.stringify(anchor));
    const stripped: SceneAnchor = {
      ...roundTripped,
      fingerprint: {
        ...roundTripped.fingerprint,
        stableId: null,
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: null,
      },
    };
    document.body.innerHTML = page.replace(`data-testid="brand-tile"`, "");

    // A *fresh* matcher, as a fresh process would have.
    const report = await resolveAnchor(stripped, {
      root: document,
      patch: createCanvasMatcher(),
    });
    expect(report.strategy).toBe("imagePatch");
  });

  /** The brand tile's anchor with every DOM fingerprint but the rect gone. */
  const pictureOnly = async (patch: ReturnType<typeof createCanvasMatcher>) => {
    document.body.innerHTML = page;
    const el = document.querySelector("[data-testid=brand-tile]") as Element;
    const { anchor } = await captureAnchor(el, ctx, { root: document, patch });
    // Premise: the rect is the one DOM signal left to agree or not.
    expect(anchor.fingerprint.boundingRect).not.toBeNull();
    return {
      ...anchor,
      fingerprint: {
        ...anchor.fingerprint,
        stableId: null,
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: null,
      },
    } satisfies SceneAnchor;
  };

  it("refuses two lookalikes nothing in the DOM tells apart", async () => {
    const patch = createCanvasMatcher();
    const stripped = await pictureOnly(patch);
    // Two identical tiles, both far from where the brand tile was: the
    // picture ties and the rect agrees with neither.
    const tile = `<div style="width:120px;height:40px;background:#1144cc"></div>`;
    document.body.innerHTML = `<main style="padding-top:300px">${tile}${tile}</main>`;
    const tiles = Array.from(document.querySelectorAll("main > div"));
    const scores = await patch.match(
      stripped.fingerprint.imagePatchRef as string,
      tiles,
    );
    expect(scores).toHaveLength(2);
    expect(scores[0]?.score).toBeGreaterThan(0.99);
    expect(scores[1]?.score).toBe(scores[0]?.score);

    const report = await resolveAnchor(stripped, { root: document, patch });
    expect(report.strategy).toBe("ambiguous");
    expect(report.failureReason).toBe("ambiguousTie");
    expect(report.element).toBeNull();
    expect(report.candidates).toBe(2);
  });

  it("lets the rect break a lookalike tie", async () => {
    const patch = createCanvasMatcher();
    const stripped = await pictureOnly(patch);
    const tile = `<div style="width:120px;height:40px;background:#1144cc"></div>`;
    // The first tile sits where the brand tile was, the second 300px down.
    document.body.innerHTML = `<main>${tile}<div style="height:300px"></div>${tile}</main>`;
    const first = document.querySelector("main > div") as Element;

    const report = await resolveAnchor(stripped, { root: document, patch });
    expect(report.strategy).toBe("imagePatch");
    expect(report.element).toBe(first);
    expect(report.corroboration).toContainEqual({
      signal: "rect",
      agreed: true,
    });
  });

  it("reports drifted when the DOM agrees with nothing about the one lookalike", async () => {
    const patch = createCanvasMatcher();
    const stripped = await pictureOnly(patch);
    document.body.innerHTML = `<main style="padding-top:300px"><div style="width:120px;height:40px;background:#1144cc"></div></main>`;

    const report = await resolveAnchor(stripped, { root: document, patch });
    expect(report.strategy).toBe("broken");
    expect(report.failureReason).toBe("drifted");
    expect(report.element).toBeNull();
    expect(report.corroboration).toEqual([{ signal: "rect", agreed: false }]);
  });
});
