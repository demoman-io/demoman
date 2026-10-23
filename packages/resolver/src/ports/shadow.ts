import type { ShadowRegistry } from "../types.js";

/** Default: open roots only. The resolver never assumes the hook is installed. */
export const NO_SHADOW: ShadowRegistry = {
  getClosedRoot: () => null,
};

/**
 * Wraps Element.attachShadow so closed roots stay reachable. SP4 installs this
 * in the MAIN world at document_start; roots attached before that stay opaque
 * and resolve with failureReason "closedShadowRoot" rather than silently broken.
 */
export function createShadowRegistry(): {
  registry: ShadowRegistry;
  install(win: Window): void;
} {
  const roots = new WeakMap<Element, ShadowRoot>();
  return {
    registry: { getClosedRoot: (host) => roots.get(host) ?? null },
    install(win) {
      // `Element` is a global var in lib.dom.d.ts, not a member of the `Window`
      // interface itself — it's only visible through the same intersection
      // the global `window` carries (`Window & typeof globalThis`).
      const proto = (win as Window & typeof globalThis).Element.prototype;
      const original = proto.attachShadow;
      proto.attachShadow = function attachShadow(
        this: Element,
        init: ShadowRootInit,
      ) {
        const root = original.call(this, init);
        if (init.mode === "closed") roots.set(this, root);
        return root;
      };
    },
  };
}
