import {
  type CursorSegment,
  planCursorSegment,
  type Vec,
} from "@demoman/compositor";
import type { Rect } from "./types.js";

/**
 * The first moves of a drag, small and in its direction: most drag libraries
 * (dnd-kit, SortableJS, a canvas tool) wait for the pointer to travel a few
 * pixels with the button down before they treat a press as a drag, and a
 * single long move can land past their threshold check in one event.
 */
export const DRAG_LEAD_STEPS = 3;
export const DRAG_LEAD_PX = 3;

/**
 * Where a native `<input type="range">` draws its thumb: the value's
 * fraction along the track, in its inline direction — left to right, or top
 * to bottom when vertical (a vertical `writing-mode`), and the other way under
 * `direction: rtl`. Measured in Chromium on 2026-10-21, where `orient` does
 * nothing. A press at the track's centre would jump the value there before
 * the drag began.
 */
export function rangeThumb(
  rect: Rect,
  input: {
    value: number;
    min: number;
    max: number;
    vertical: boolean;
    reversed: boolean;
  },
): Vec {
  const span = input.max - input.min;
  const along =
    span === 0 ? 0 : Math.min(1, Math.max(0, (input.value - input.min) / span));
  const f = input.reversed ? 1 - along : along;
  return input.vertical
    ? { x: rect.x + rect.width / 2, y: rect.y + rect.height * f }
    : { x: rect.x + rect.width * f, y: rect.y + rect.height / 2 };
}

/** The held move: the lead steps, then the walk's eased timing from the last
 *  of them to the end, along a straight line: a stroke follows the pointer,
 *  and a drag from one spot to another on a canvas is a line, where the
 *  cursor's own travel bows. */
export function heldPath(
  start: Vec,
  end: Vec,
  actionId: string,
): { lead: Vec[]; segment: CursorSegment } {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const ux = length === 0 ? 0 : (end.x - start.x) / length;
  const uy = length === 0 ? 0 : (end.y - start.y) / length;
  const lead = Array.from({ length: DRAG_LEAD_STEPS }, (_, i) => ({
    x: start.x + ux * DRAG_LEAD_PX * (i + 1),
    y: start.y + uy * DRAG_LEAD_PX * (i + 1),
  }));
  const from = lead[lead.length - 1] ?? start;
  const planned = planCursorSegment({
    from,
    to: end,
    index: 0,
    fromActionId: actionId,
    toActionId: actionId,
  });
  const mid = { x: (from.x + end.x) / 2, y: (from.y + end.y) / 2 };
  return { lead, segment: { ...planned, via: [from, mid, end] } };
}

/** Whether a point is on the page: a drag cannot scroll it mid-move. */
export function inViewport(
  p: Vec,
  viewport: { width: number; height: number },
): boolean {
  return (
    p.x >= 0 && p.y >= 0 && p.x <= viewport.width && p.y <= viewport.height
  );
}

/**
 * Watches the page while a drag is held, for anything a drag can change
 * where it happened: the DOM, a scroll, an `input` or `change` (a range
 * moves its value without touching the DOM), or the pixels of a 2D canvas
 * under the drag. `this` is the drag's start element; `box` the drag's
 * bounds in client px. A canvas that reads back blank both times — a WebGL
 * one, or an empty one — makes the answer `unknown`, never "unchanged".
 *
 * In the page rather than a clipped screenshot: while the walk re-asserts its
 * metrics override (`surfaceMismatch`), a clip can read a different part of
 * the page than the one asked for, and a drag that did nothing read as one
 * that changed something, 2 runs in 6 (2026-10-21).
 */
export const DRAG_WATCH_INSTALL = `function (box) {
  const doc = this.ownerDocument;
  // The drag's bounds, widened by a cursor's reach: a drop target's hover
  // highlight sits on the target's own box, at the edge of the bounds.
  const pad = 24;
  const meets = (r) =>
    r.right > box.x - pad && r.left < box.x + box.width + pad &&
    r.bottom > box.y - pad && r.top < box.y + box.height + pad;
  // A canvas's pixels under the drag only, copied into a canvas of ours and
  // read there: no PNG encode of a page-sized canvas on the page's thread
  // (review of 2026-10-21), and no context asked of the page's own canvas,
  // which would create one a WebGL page could then never get. Null when it
  // cannot be read: a canvas another origin's image tainted.
  const regionOf = (c) => {
    const r = c.getBoundingClientRect();
    const sx = c.width / r.width;
    const sy = c.height / r.height;
    const left = Math.max(r.left, box.x - pad);
    const top = Math.max(r.top, box.y - pad);
    const right = Math.min(r.right, box.x + box.width + pad);
    const bottom = Math.min(r.bottom, box.y + box.height + pad);
    return {
      x: Math.floor((left - r.left) * sx),
      y: Math.floor((top - r.top) * sy),
      w: Math.max(1, Math.ceil((right - left) * sx)),
      h: Math.max(1, Math.ceil((bottom - top) * sy)),
    };
  };
  const read = (c, g) => {
    const ours = doc.createElement("canvas");
    ours.width = g.w;
    ours.height = g.h;
    const ctx = ours.getContext("2d");
    try {
      ctx.drawImage(c, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h);
      return ctx.getImageData(0, 0, g.w, g.h).data;
    } catch {
      return null;
    }
  };
  const watch = { changed: false, read };
  watch.canvases = [...doc.querySelectorAll("canvas")]
    .filter((c) => {
      const r = c.getBoundingClientRect();
      return c.width > 0 && c.height > 0 && r.width > 0 && r.height > 0 && meets(r);
    })
    .map((c) => {
      const g = regionOf(c);
      return { c, g, before: read(c, g) };
    });
  const mark = () => { watch.changed = true; };
  // The drag's own picture (\`DRAG_PICTURE_SHOW\`) is ours, not the page's.
  const ours = (n) => n instanceof Element && n.closest("[data-demoman-drag]") !== null;
  // Only what changed where the drag happened: a live page changes on its
  // own elsewhere (a clock, a toast, a carousel), and counting that read a
  // drag the page ignored as done (final review, finding 5). Each change is
  // judged by the node it made — never by its parent, whose box (the body,
  // an app's root) overlaps every drag (review of 2026-10-21). A removed
  // node is judged by its neighbours, where it was, else by a parent it was
  // alone in.
  const boxOf = (n) => {
    if (!n || !n.isConnected) return null;
    if (n instanceof Element) return n.getBoundingClientRect();
    if (n instanceof Text) {
      const range = doc.createRange();
      range.selectNodeContents(n);
      return range.getBoundingClientRect();
    }
    return null;
  };
  const near = (n) => {
    const r = boxOf(n);
    return r !== null && meets(r);
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (ours(r.target) || [...r.addedNodes, ...r.removedNodes].some(ours)) continue;
      const touched =
        r.type !== "childList"
          ? near(r.target)
          : [...r.addedNodes].some(near) ||
            (r.removedNodes.length > 0 &&
              (r.previousSibling || r.nextSibling
                ? near(r.previousSibling) || near(r.nextSibling)
                : near(r.target)));
      if (touched) return mark();
    }
  });
  observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
  // A scroll of the document moves everything under the drag; an element's
  // scroll, or a field's input, counts where that element is.
  const kinds = ["scroll", "input", "change"];
  const heard = (e) => {
    if (e.target === doc || e.target === doc.defaultView || near(e.target)) mark();
  };
  for (const k of kinds) doc.addEventListener(k, heard, true);
  watch.stop = () => {
    observer.disconnect();
    for (const k of kinds) doc.removeEventListener(k, heard, true);
  };
  return watch;
}`;

/** Reads and stops a `DRAG_WATCH_INSTALL` watch: `this` is the watch. */
export const DRAG_WATCH_READ = `function () {
  this.stop();
  if (this.changed) return { changed: true, unknown: false };
  let unknown = false;
  for (const { c, g, before } of this.canvases) {
    const after = this.read(c, g);
    if (before === null || after === null) { unknown = true; continue; }
    if (after.length !== before.length) return { changed: true, unknown: false };
    for (let i = 0; i < after.length; i++) {
      if (after[i] !== before[i]) return { changed: true, unknown: false };
    }
    if (after.every((v) => v === 0)) unknown = true;
  }
  return { changed: false, unknown };
}`;

/**
 * A native drag's picture, drawn in the page (spec 2026-10-21, "The drag
 * picture, drawn in the page"). Chrome floats it outside the page, where the
 * screencast never sees it, so the film would show the card jump to its
 * drop. `this` is the drag's start element.
 *
 * Install, before the press: records what the page declares — the element
 * and offset it hands `setDragImage`, else the element the drag starts on and
 * where the pointer held it.
 */
export const DRAG_PICTURE_INSTALL = `function () {
  const view = this.ownerDocument.defaultView;
  const state = { image: null, source: null };
  view.__demomanDrag = state;
  if (!view.__demomanDragWrapped) {
    view.__demomanDragWrapped = true;
    const original = view.DataTransfer.prototype.setDragImage;
    view.DataTransfer.prototype.setDragImage = function (element, x, y) {
      if (view.__demomanDrag) view.__demomanDrag.image = { element, x, y };
      return original.call(this, element, x, y);
    };
  }
  view.addEventListener("dragstart", (e) => {
    const el = e.target instanceof view.Element ? e.target : null;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    state.source = { element: el, x: e.clientX - r.left, y: e.clientY - r.top };
  }, { capture: true, once: true });
}`;

/** Shows the picture with its grab point at (x, y). Returns null, or why it
 *  could not be drawn. */
export const DRAG_PICTURE_SHOW = `function (x, y) {
  const doc = this.ownerDocument;
  const view = doc.defaultView;
  const state = view.__demomanDrag;
  const declared = state && (state.image || state.source);
  if (!declared || !declared.element) return "the page named no element for its drag picture";
  const el = declared.element;
  const r = el.getBoundingClientRect();
  let copy;
  if (el instanceof view.HTMLCanvasElement) {
    copy = doc.createElement("img");
    copy.src = el.toDataURL();
  } else {
    copy = el.cloneNode(true);
    copy.removeAttribute("id");
    // With its computed look, element by element: outside the page's own
    // tree it inherits no font and matches no descendant selector (final
    // review, finding 6: a card drew in the default serif).
    // shortcut: the first 300 elements only, for a huge picture; upgrade to
    // a canvas snapshot if a demo drags something that big.
    let budget = 300;
    const dress = (from, to) => {
      if (budget-- <= 0 || !(to instanceof view.Element)) return;
      const cs = view.getComputedStyle(from);
      for (let i = 0; i < cs.length; i++) {
        to.style.setProperty(cs[i], cs.getPropertyValue(cs[i]));
      }
      // Never the drop target: a copied \`pointer-events: auto\` would take
      // the drop meant for the page under it.
      to.style.setProperty("pointer-events", "none");
      for (let i = 0; i < from.children.length; i++) {
        dress(from.children[i], to.children[i]);
      }
    };
    dress(el, copy);
  }
  copy.style.position = "static";
  copy.style.margin = "0";
  copy.style.width = r.width + "px";
  copy.style.height = r.height + "px";
  const frame = doc.createElement("div");
  frame.setAttribute("data-demoman-drag", "");
  frame.style.cssText =
    "position:fixed;pointer-events:none;opacity:0.7;z-index:2147483647;margin:0;";
  frame.append(copy);
  frame.__grab = { x: declared.x, y: declared.y };
  frame.style.left = x - declared.x + "px";
  frame.style.top = y - declared.y + "px";
  doc.documentElement.append(frame);
  return null;
}`;

/** Moves the picture's grab point to (x, y). */
export const DRAG_PICTURE_MOVE = `function (x, y) {
  const frame = this.ownerDocument.querySelector("[data-demoman-drag]");
  if (frame === null) return;
  frame.style.left = x - frame.__grab.x + "px";
  frame.style.top = y - frame.__grab.y + "px";
}`;

/** Removes every picture and answers how many are left: 0, or the removal
 *  failed and the film would show a copy over everything after. */
export const DRAG_PICTURE_REMOVE = `function () {
  const doc = this.ownerDocument;
  for (const f of doc.querySelectorAll("[data-demoman-drag]")) f.remove();
  const view = doc.defaultView;
  if (view) view.__demomanDrag = null;
  return doc.querySelectorAll("[data-demoman-drag]").length;
}`;
