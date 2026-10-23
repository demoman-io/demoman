import { describe, expect, it } from "vitest";
import { captureAnchor } from "../../src/capture";
import { createShadowRegistry } from "../../src/ports/shadow";
import { resolveAnchor } from "../../src/resolve";

const ctx = {
  anchorId: "a-1",
  url: "https://app.example.com/",
  actionIndex: 0,
  entryState: true,
};

function host(mode: ShadowRootMode, inner: string): ShadowRoot {
  document.body.innerHTML = `<main><sf-card></sf-card></main>`;
  const el = document.querySelector("sf-card") as Element;
  const root = el.attachShadow({ mode });
  root.innerHTML = inner;
  return root;
}

describe("shadow DOM", () => {
  it("captures and resolves through an open root", async () => {
    const root = host("open", `<button data-testid="pay">Pay</button>`);
    const target = root.querySelector("button") as Element;

    const { anchor, report } = await captureAnchor(target, ctx, {
      root: document,
    });
    expect(report.element).toBe(target);
    expect(anchor.fingerprint.treePath).toContain("#shadow");

    const again = await resolveAnchor(anchor, { root: document });
    expect(again.strategy).toBe("stableId");
    expect(again.element).toBe(target);
  });

  it("resolves inside a closed root when the registry knows it", async () => {
    const { registry, install } = createShadowRegistry();
    install(window);

    document.body.innerHTML = `<main><sf-card></sf-card></main>`;
    const el = document.querySelector("sf-card") as Element;
    const closed = el.attachShadow({ mode: "closed" });
    closed.innerHTML = `<button data-testid="pay">Pay</button>`;
    const target = closed.querySelector("button") as Element;

    const { anchor } = await captureAnchor(target, ctx, {
      root: document,
      shadow: registry,
    });
    const report = await resolveAnchor(anchor, {
      root: document,
      shadow: registry,
    });
    expect(report.strategy).toBe("stableId");
    expect(report.element).toBe(target);
  });

  it("reports closedShadowRoot when no registry was installed in time", async () => {
    const { registry, install } = createShadowRegistry();
    install(window);
    document.body.innerHTML = `<main><sf-card></sf-card></main>`;
    const el = document.querySelector("sf-card") as Element;
    const closed = el.attachShadow({ mode: "closed" });
    closed.innerHTML = `<button data-testid="pay">Pay</button>`;
    const target = closed.querySelector("button") as Element;
    const { anchor } = await captureAnchor(target, ctx, {
      root: document,
      shadow: registry,
    });

    // A second page load where the hook never ran: the root is opaque.
    const report = await resolveAnchor(anchor, { root: document });
    expect(report.strategy).toBe("broken");
    expect(report.failureReason).toBe("closedShadowRoot");
  });

  it("descends nested shadow roots", async () => {
    const outer = host("open", `<sf-row></sf-row>`);
    const rowHost = outer.querySelector("sf-row") as Element;
    const inner = rowHost.attachShadow({ mode: "open" });
    inner.innerHTML = `<button data-testid="deep">Deep</button>`;
    const target = inner.querySelector("button") as Element;

    const { anchor } = await captureAnchor(target, ctx, { root: document });
    const report = await resolveAnchor(anchor, { root: document });
    expect(report.element).toBe(target);
  });

  it("resolves a dataKey row that lives inside an open shadow root, against the same unmodified document", async () => {
    // The Salesforce-Lightning shape the design doc's grammar example cites:
    // the row container carrying data-row-key is itself inside a shadow
    // root. findDataKeyRow's root.querySelector never pierces the shadow
    // boundary, so re-resolving against the identical, unmodified document
    // must not report notInTree -- the element is right there in the tree.
    const root = host(
      "open",
      `<div data-row-key="order-1002"><button data-testid="pay">Pay</button></div>`,
    );
    const target = root.querySelector("button") as Element;

    const { anchor } = await captureAnchor(target, ctx, { root: document });
    expect(anchor.fingerprint.dataKey).toBe("order-1002");

    const report = await resolveAnchor(anchor, { root: document });
    expect(report.failureReason).not.toBe("notInTree");
    expect(report.element).toBe(target);
  });

  it("does not blame a light-DOM custom element for an unrelated broken anchor", async () => {
    // This is the misreporting case the two-signal condition (captured-in-shadow
    // AND opaque-in-scope) exists to prevent: a page can contain a custom
    // element with no shadow root at all, and hasOpaqueShadow's scan alone
    // cannot tell that apart from a closed root. Without also requiring the
    // anchor's own path to carry a #shadow segment, every broken anchor on
    // this page would be misreported as closedShadowRoot.
    document.body.innerHTML = `<main><my-widget><span>hi</span></my-widget><button data-testid="gone">Gone</button></main>`;
    const target = document.querySelector('[data-testid="gone"]') as Element;

    const { anchor } = await captureAnchor(target, ctx, { root: document });
    target.remove();

    const report = await resolveAnchor(anchor, { root: document });
    expect(report.strategy).toBe("broken");
    expect(report.failureReason).toBeNull();
  });
});
