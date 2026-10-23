import {
  isKeySymbol,
  isMacPlatform,
  type KeyToken,
  keyLabel,
} from "../editor/shortcuts";

/**
 * The page's one tooltip: a control's name and, when it has one, its key as
 * caps — `Close [Esc]`, `Undo [⌘][Z]` — the way Linear teaches a shortcut
 * on the control it belongs to (the author, 2026-10-19). Escape closing a
 * panel is said here and nowhere else on screen.
 *
 * Built never to be in the way of the click it describes:
 *
 * - It waits `SHOW_DELAY_MS` of resting on a control, so passing over the
 *   header on the way to something else shows nothing.
 * - Once one has shown, a neighbour's shows at once for `WARM_MS` after
 *   leaving, so reading along a row of controls does not wait each time.
 * - It takes no pointer events, and sits below its control (above, where
 *   there is no room), never over it.
 * - Any press, key or scroll takes it away and lets the next one wait again.
 * - Focus by keyboard shows it at once; a touch never does.
 *
 * One element for the page and listeners on the document, so controls that
 * are redrawn on every render — the inspector's close button is — need
 * nothing re-attached: a control opts in by its `data-tip` attributes alone.
 */
export const SHOW_DELAY_MS = 600;
export const WARM_MS = 500;

/** A spelled key's name for `aria-keyshortcuts`, which has its own words. */
function ariaKey(token: KeyToken, mac: boolean): string {
  switch (token) {
    case "Mod":
      return mac ? "Meta" : "Control";
    case "Esc":
      return "Escape";
    case "Left":
      return "ArrowLeft";
    case "Right":
      return "ArrowRight";
    case "Up":
      return "ArrowUp";
    case "Down":
      return "ArrowDown";
    // The legend's minus sign is typographic; the key sends a hyphen.
    case "\u2212":
      return "-";
    default:
      return token;
  }
}

/**
 * Mark a control for the tooltip: its name, and its key as one chord when
 * it has one. Drops a native `title`, which would show beside it, and says
 * the key to a screen reader through `aria-keyshortcuts`. Safe to call on
 * every render.
 */
export function withTip(
  node: HTMLElement,
  label: string,
  keys: readonly KeyToken[] = [],
): void {
  node.dataset.tip = label;
  node.removeAttribute("title");
  if (keys.length === 0) {
    delete node.dataset.tipKeys;
    node.removeAttribute("aria-keyshortcuts");
    return;
  }
  node.dataset.tipKeys = keys.join(" ");
  const mac = isMacPlatform(navigator.userAgent);
  node.setAttribute(
    "aria-keyshortcuts",
    keys.map((key) => ariaKey(key, mac)).join("+"),
  );
}

/** Take a control out of the tooltip, for a state that says something else
 *  in its own `title` (a disabled Play says why it cannot play). */
export function withoutTip(node: HTMLElement): void {
  delete node.dataset.tip;
  delete node.dataset.tipKeys;
  node.removeAttribute("aria-keyshortcuts");
}

const HANDLE = Symbol.for("demoman.tooltip");

/**
 * Start the page's tooltip. Once per page; a second call (a hot reload, a
 * test's next mount) replaces the first rather than stacking listeners.
 * Returns the tooltip element, for the tests that ask what it shows.
 */
export function installTooltips(doc: Document = document): HTMLElement {
  const scope = doc as unknown as Record<symbol, unknown>;
  const previous = scope[HANDLE] as
    | { abort: AbortController; tip: HTMLElement }
    | undefined;
  previous?.abort.abort();
  previous?.tip.remove();

  const abort = new AbortController();
  const { signal } = abort;
  const tip = doc.createElement("div");
  tip.className = "tooltip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("data-tooltip", "");
  tip.hidden = true;
  doc.body.append(tip);
  scope[HANDLE] = { abort, tip };

  const win = doc.defaultView ?? window;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The control `timer` will show, while it runs. */
  let pending: HTMLElement | null = null;
  let current: HTMLElement | null = null;
  let warmUntil = 0;

  const tipOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element
      ? target.closest<HTMLElement>("[data-tip]")
      : null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  const show = (control: HTMLElement) => {
    clearTimer();
    const label = control.dataset.tip ?? "";
    if (label === "" || !control.isConnected) return;
    const mac = isMacPlatform(win.navigator.userAgent);
    const keys = (control.dataset.tipKeys ?? "")
      .split(" ")
      .filter((token) => token !== "");
    tip.replaceChildren(doc.createTextNode(label));
    if (keys.length > 0) {
      const chord = doc.createElement("span");
      chord.className = "tooltip-keys";
      for (const token of keys) {
        const text = keyLabel(token, mac);
        const cap = doc.createElement("kbd");
        cap.className = "keycap";
        cap.textContent = text;
        if (isKeySymbol(text)) cap.setAttribute("data-symbol", "");
        chord.append(cap);
      }
      tip.append(chord);
    }
    tip.hidden = false;
    current = control;
    // Below the control, centred on it and kept in the window; above it
    // where the window has no room below.
    const at = control.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    const gap = 6;
    const left = Math.min(
      Math.max(8, at.left + at.width / 2 - size.width / 2),
      win.innerWidth - size.width - 8,
    );
    const below = at.bottom + gap;
    const top =
      below + size.height > win.innerHeight - 8
        ? at.top - gap - size.height
        : below;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  };

  // Leaving warms the next one; a press, a key or a scroll does not.
  const hide = (warm: boolean) => {
    clearTimer();
    if (!tip.hidden && warm) warmUntil = Date.now() + WARM_MS;
    if (!warm) warmUntil = 0;
    tip.hidden = true;
    current = null;
  };

  doc.addEventListener(
    "pointerover",
    (event) => {
      if (event.pointerType === "touch") return;
      const control = tipOf(event.target);
      if (control === null) {
        // Onto something with no tooltip. Usually `pointerout` has already
        // hidden it, but a control a render removed from under the pointer
        // gets no `pointerout`, and its tooltip would stay standing at the
        // old spot until the next press, key or scroll.
        if (current !== null || pending !== null) hide(true);
        return;
      }
      // Crossing into a child of the control already showing, or already
      // waiting, is not a new arrival: the wait does not start again.
      if (control === current || control === pending) return;
      clearTimer();
      if (current !== null || Date.now() < warmUntil) show(control);
      else {
        pending = control;
        timer = setTimeout(() => show(control), SHOW_DELAY_MS);
      }
    },
    { signal },
  );
  doc.addEventListener(
    "pointerout",
    (event) => {
      const control = tipOf(event.target);
      if (control === null) return;
      const into = event.relatedTarget;
      if (into instanceof Node && control.contains(into)) return;
      hide(true);
    },
    { signal },
  );
  doc.addEventListener("pointerdown", () => hide(false), {
    capture: true,
    signal,
  });
  doc.addEventListener(
    "keydown",
    (event) => {
      // Tab moves the focus, and the focus shows the next one.
      if (event.key !== "Tab") hide(false);
    },
    { capture: true, signal },
  );
  doc.addEventListener("scroll", () => hide(false), {
    capture: true,
    passive: true,
    signal,
  });
  doc.addEventListener(
    "focusin",
    (event) => {
      const control = tipOf(event.target);
      if (control?.matches(":focus-visible")) show(control);
    },
    { signal },
  );
  doc.addEventListener(
    "focusout",
    (event) => {
      // Only the control showing: with nothing showing, `current` is null,
      // and so is the tooltip of any field without one, so focus leaving
      // that field cancelled the wait of the control under the pointer.
      if (current !== null && tipOf(event.target) === current) hide(false);
    },
    { signal },
  );
  return tip;
}
