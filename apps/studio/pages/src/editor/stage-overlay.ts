import type {
  Presentation,
  Rect,
  RenderTarget,
  ResolvedPlan,
  Vec,
} from "@demoman/compositor";
import { el } from "./dom";
import type { LaneModel } from "./lanes";
import { canvasRectToCss, cssRectToCanvas, zoomFocusRect } from "./masks";
import type { Selection } from "./selection";

export interface OverlayProps {
  canvas: HTMLCanvasElement;
  selection: Selection;
  model: LaneModel;
  resolved: ResolvedPlan | null;
  presentation: Presentation | null;
  target: RenderTarget;
  outputTimeMs: number;
}

export interface OverlayHandlers {
  onMaskRect(id: string, rect: Rect): void;
  onZoomPoint(id: string, point: Vec): void;
}

/**
 * The canvas bitmap's box inside its element.
 *
 * Still the `object-fit: contain` arithmetic, and still correct — but since
 * 2026-09-21 it is correct for a different reason. `#stage-frame` gives the
 * canvas an element box at the bitmap's own ratio, so `Math.min` picks a
 * scale that fits both axes exactly and both offsets fall to zero. Leave
 * the arithmetic: it is what keeps this honest if a frame's ratio ever
 * drifts from its bitmap's, and it is the reason this function needed no
 * edit when the zoom control arrived.
 */
export function drawnBox(canvas: HTMLCanvasElement): {
  left: number;
  top: number;
  scale: number;
} {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(
    rect.width / canvas.width,
    rect.height / canvas.height,
  );
  return {
    left: (rect.width - canvas.width * scale) / 2,
    top: (rect.height - canvas.height * scale) / 2,
    scale,
  };
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

/** Below this a "drag" is a click that wobbled — same value and same
 *  reasoning as `timeline-view.ts`'s constant of the same name: a plain
 *  click used to dispatch the box's own unmoved position, indistinguishable
 *  from an author who actually meant to move it there. */
const DRAG_THRESHOLD_PX = 3;

function place(
  node: HTMLElement,
  rect: Rect,
  box: ReturnType<typeof drawnBox>,
): void {
  node.style.left = `${box.left + rect.x * box.scale}px`;
  node.style.top = `${box.top + rect.y * box.scale}px`;
  node.style.width = `${rect.width * box.scale}px`;
  node.style.height = `${rect.height * box.scale}px`;
}

function resized(
  rect: Rect,
  handle: Handle | "body",
  dx: number,
  dy: number,
): Rect {
  let { x, y, width, height } = rect;
  if (handle === "body") return { x: x + dx, y: y + dy, width, height };
  if (handle.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (handle.includes("e")) width += dx;
  if (handle.includes("n")) {
    y += dy;
    height -= dy;
  }
  if (handle.includes("s")) height += dy;
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  return { x, y, width, height };
}

/**
 * Selection-shaped, not mode-shaped: the box exists while a mask or a zoom
 * is selected and dispatches on every pointerup. Nothing is armed, so
 * nothing can stay armed — the wiring `drawOnce` replaced authored a
 * phantom mask on every later click, and that shape is gone.
 */
export function renderStageOverlay(
  root: HTMLElement,
  props: OverlayProps,
  handlers: OverlayHandlers,
): void {
  root.replaceChildren();

  const { selection, resolved, presentation } = props;
  if (
    selection === null ||
    selection.kind === "tick" ||
    resolved === null ||
    presentation === null
  )
    return;
  const box = drawnBox(props.canvas);
  const convert = {
    resolved,
    target: props.target,
    presentation,
    outputTimeMs: props.outputTimeMs,
  };

  if (selection.kind === "mask") {
    const mask = props.model.masks.find((m) => m.id === selection.id);
    if (!mask) return;
    const node = el("div", "overlay");
    node.setAttribute("data-overlay", "mask");
    let rect = cssRectToCanvas({ rect: mask.rect, ...convert });
    place(node, rect, box);
    const arm = (target: HTMLElement, handle: Handle | "body"): void => {
      target.addEventListener("pointerdown", (down: PointerEvent) => {
        down.preventDefault();
        down.stopPropagation();
        const origin = rect;
        let moved = false;
        const onMove = (move: PointerEvent): void => {
          if (
            Math.hypot(
              move.clientX - down.clientX,
              move.clientY - down.clientY,
            ) > DRAG_THRESHOLD_PX
          )
            moved = true;
          rect = resized(
            origin,
            handle,
            (move.clientX - down.clientX) / box.scale,
            (move.clientY - down.clientY) / box.scale,
          );
          place(node, rect, box);
        };
        const onUp = (): void => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          if (!moved) return; // a press that never moved is a click
          handlers.onMaskRect(mask.id, canvasRectToCss({ rect, ...convert }));
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    };
    arm(node, "body");
    for (const handle of HANDLES) {
      const grip = el("div", "grip");
      grip.setAttribute("data-handle", handle);
      arm(grip, handle);
      node.append(grip);
    }
    root.append(node);
    return;
  }

  if (selection.kind !== "zoom") return;
  const zoom = props.model.zooms.find((z) => z.id === selection.id);
  if (!zoom) return;
  const node = el("div", "overlay");
  node.setAttribute("data-overlay", "zoom");
  const focus = zoomFocusRect({
    zoom,
    resolved,
    viewport: resolved.plan.viewport,
    presentation,
    target: props.target,
  });
  let rect = cssRectToCanvas({ rect: focus, ...convert });
  place(node, rect, box);
  node.addEventListener("pointerdown", (down: PointerEvent) => {
    down.preventDefault();
    const origin = rect;
    let moved = false;
    const onMove = (move: PointerEvent): void => {
      if (
        Math.hypot(move.clientX - down.clientX, move.clientY - down.clientY) >
        DRAG_THRESHOLD_PX
      )
        moved = true;
      rect = resized(
        origin,
        "body",
        (move.clientX - down.clientX) / box.scale,
        (move.clientY - down.clientY) / box.scale,
      );
      place(node, rect, box);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!moved) return; // a press that never moved is a click
      const css = canvasRectToCss({ rect, ...convert });
      handlers.onZoomPoint(zoom.id, {
        x: css.x + css.width / 2,
        y: css.y + css.height / 2,
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  root.append(node);
}
