/**
 * The dialog card (DEM-161): Chrome's own macOS JavaScript dialog, drawn
 * because Chrome's is never in the captured frames. Option A of the mockup
 * (`docs/superpowers/specs/assets/2026-11-21-inputs/index.html`, `.chrome`
 * and `.b`): top centre of the page area, flush under its top edge, in page
 * space so a zoom carries it as it carries the page.
 *
 * Its text is Geist and nothing else: the runner's system fonts are not the
 * Mac's, so a card in a fallback face would differ between machines. A
 * render whose Geist is not loaded throws rather than draw one.
 */
import type { DialogRecord } from "@demoman/scene-schema";
import type { Rect } from "../geometry.js";

export const DIALOG_FONT = "Geist";

/** The mockup's `.chrome` and `.b` rules, in CSS px. */
export const DIALOG_CARD = {
  width: 440,
  padTop: 18,
  padX: 20,
  padBottom: 16,
  radius: 10,
  lineHeight: 1.45,
  whoSize: 15,
  whoGap: 8,
  msgSize: 14,
  msgGap: 18,
  /** Not in the mockup, which has no prompt: a field the message's width,
   *  as tall as a button, with the message's gap under it. */
  fieldHeight: 30,
  fieldPadX: 8,
  buttonSize: 13,
  buttonPadY: 6,
  buttonPadX: 16,
  buttonGap: 8,
  /** 13px at the line height, the padding and a 1px border, top and bottom. */
  buttonHeight: 13 * 1.45 + 2 * 6 + 2,
} as const;

const INK = "#1a1a1a";
const BLUE = "#1a73e8";
const PILL_BORDER = "#c7c7c7";

export interface DialogCardLayout {
  card: Rect;
  who: string;
  lines: string[];
  field: Rect | null;
  ok: Rect & { label: string };
  cancel: (Rect & { label: string }) | null;
}

function fontFor(size: number, weight: number, s: number): string {
  return `${weight} ${size * s}px ${DIALOG_FONT}`;
}

/** Greedy word wrap at `width`, keeping the message's own line breaks. A
 *  word wider than the card overflows it. */
function wrap(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  width: number,
): string[] {
  return text.split("\n").flatMap((paragraph) => {
    const lines: string[] = [];
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line === "" ? word : `${line} ${word}`;
      if (line !== "" && ctx.measureText(next).width > width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
    return lines;
  });
}

/** Where everything on the card goes, in output px. Sets `ctx.font`. */
export function dialogCardLayout(
  ctx: OffscreenCanvasRenderingContext2D,
  card: DialogRecord,
  pageRect: Rect,
  cssScale: number,
): DialogCardLayout {
  const c = DIALOG_CARD;
  const s = cssScale;
  const leaving = card.kind === "beforeunload";
  const who = leaving ? "Leave site?" : `${card.host} says`;
  const message = leaving ? "Changes you made may not be saved." : card.message;
  ctx.font = fontFor(c.msgSize, 400, s);
  const lines = wrap(ctx, message, (c.width - 2 * c.padX) * s);

  const width = c.width * s;
  const x = pageRect.x + (pageRect.width - width) / 2;
  const y = pageRect.y;
  let top = y + c.padTop * s;
  top += (c.whoSize * c.lineHeight + c.whoGap) * s;
  top += (lines.length * c.msgSize * c.lineHeight + c.msgGap) * s;
  const field =
    card.kind === "prompt"
      ? {
          x: x + c.padX * s,
          y: top,
          width: (c.width - 2 * c.padX) * s,
          height: c.fieldHeight * s,
        }
      : null;
  if (field !== null) top += (c.fieldHeight + c.msgGap) * s;
  const buttonHeight = c.buttonHeight * s;
  const height = top + buttonHeight + c.padBottom * s - y;

  ctx.font = fontFor(c.buttonSize, 500, s);
  const pill = (label: string, right: number) => {
    const w = ctx.measureText(label).width + (2 * c.buttonPadX + 2) * s;
    return { label, x: right - w, y: top, width: w, height: buttonHeight };
  };
  const ok = pill(leaving ? "Leave" : "OK", x + width - c.padX * s);
  const cancel =
    card.kind === "alert" ? null : pill("Cancel", ok.x - c.buttonGap * s);
  return { card: { x, y, width, height }, who, lines, field, ok, cancel };
}

/** A colour under the mockup's `.b.pressed` `filter: brightness(.82)`. */
function dim(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * 0.82);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

function drawPill(
  ctx: OffscreenCanvasRenderingContext2D,
  pill: Rect & { label: string },
  filled: boolean,
  pressed: boolean,
  s: number,
): void {
  const tone = (hex: string) => (pressed ? dim(hex) : hex);
  ctx.save();
  if (pressed) {
    // `transform: scale(.96)` about the pill's centre.
    ctx.translate(pill.x + pill.width / 2, pill.y + pill.height / 2);
    ctx.scale(0.96, 0.96);
    ctx.translate(-(pill.x + pill.width / 2), -(pill.y + pill.height / 2));
  }
  const radius = 16 * s;
  const shape = () => {
    ctx.beginPath();
    ctx.roundRect(pill.x, pill.y, pill.width, pill.height, radius);
  };
  shape();
  ctx.fillStyle = tone(filled ? BLUE : "#ffffff");
  ctx.fill();
  if (pressed) {
    // `box-shadow: inset 0 2px 4px #0004`: the shadow of everything outside
    // the pill, clipped to the pill, so only its inner edge shows.
    ctx.save();
    shape();
    ctx.clip();
    ctx.beginPath();
    ctx.rect(
      pill.x - 50 * s,
      pill.y - 50 * s,
      pill.width + 100 * s,
      pill.height + 100 * s,
    );
    ctx.roundRect(pill.x, pill.y, pill.width, pill.height, radius);
    ctx.shadowColor = "rgba(0, 0, 0, 0.267)";
    ctx.shadowBlur = 4 * s;
    ctx.shadowOffsetY = 2 * s;
    ctx.fillStyle = "#000000";
    ctx.fill("evenodd");
    ctx.restore();
  }
  ctx.lineWidth = s;
  ctx.strokeStyle = tone(filled ? BLUE : PILL_BORDER);
  ctx.beginPath();
  ctx.roundRect(
    pill.x + s / 2,
    pill.y + s / 2,
    pill.width - s,
    pill.height - s,
    radius,
  );
  ctx.stroke();
  ctx.font = fontFor(DIALOG_CARD.buttonSize, 500, s);
  ctx.fillStyle = tone(filled ? "#ffffff" : BLUE);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(pill.label, pill.x + pill.width / 2, pill.y + pill.height / 2);
  ctx.restore();
}

/** A `FontFaceSet` as used here: TypeScript's DOM lib leaves out its
 *  set-like `add`. */
interface FontFaces {
  add(face: FontFace): unknown;
  forEach(each: (face: FontFace) => void): void;
}

function fontFaces(): FontFaces | undefined {
  const scope = globalThis as unknown as {
    document?: { fonts?: FontFaces };
    fonts?: FontFaces;
  };
  return scope.document?.fonts ?? scope.fonts;
}

/** Whether a Geist face is loaded in this document or worker. */
export function dialogFontLoaded(): boolean {
  let loaded = false;
  fontFaces()?.forEach((face) => {
    if (
      face.family.replace(/"/g, "") === DIALOG_FONT &&
      face.status === "loaded"
    )
      loaded = true;
  });
  return loaded;
}

/**
 * Loads Geist for the video's text (the card, the key marks) from its bytes,
 * or from a CSS `url(...)`, and adds it to this document's (or worker's)
 * fonts. Rejects with a sentence when it will not load: the text is never
 * drawn in another face.
 */
export async function loadDialogFont(
  source: string | BufferSource,
): Promise<void> {
  const faces = fontFaces();
  if (faces === undefined) {
    throw new Error(
      `the video's text font, ${DIALOG_FONT}, cannot load here: this context has no font set`,
    );
  }
  const face = new FontFace(DIALOG_FONT, source, { weight: "100 900" });
  try {
    await face.load();
  } catch (error) {
    throw new Error(
      `the video's text font, ${DIALOG_FONT}, did not load (${error instanceof Error ? error.message : String(error)}); its text is never drawn in another face`,
    );
  }
  faces.add(face);
}

/**
 * One card over the page. `pageRect` is the page area in output px
 * (`cssRectToOutput` of the viewport), and `cssScale` output px per CSS px
 * (`contentScale(frameRect, viewport) * camera.scale`). `pressed` draws the
 * answer's button pressed: OK on an accept, Cancel on a dismiss.
 */
export function drawDialogCard(
  ctx: OffscreenCanvasRenderingContext2D,
  card: DialogRecord,
  pageRect: Rect,
  cssScale: number,
  pressed: boolean,
): void {
  if (!dialogFontLoaded()) {
    throw new Error(
      `a dialog card needs the font ${DIALOG_FONT}, which is not loaded (loadDialogFont); it is never drawn in another face`,
    );
  }
  const c = DIALOG_CARD;
  const s = cssScale;
  const layout = dialogCardLayout(ctx, card, pageRect, s);
  const { x, y, width, height } = layout.card;
  const shape = () => {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, [0, 0, c.radius * s, c.radius * s]);
  };

  ctx.save();
  // The page's own edge cuts the card's shadow and outline, as the mockup's
  // `overflow: hidden` does.
  ctx.beginPath();
  ctx.rect(pageRect.x, pageRect.y, pageRect.width, pageRect.height);
  ctx.clip();

  // `box-shadow: 0 8px 28px #0003, 0 0 0 1px #0001`.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.2)";
  ctx.shadowBlur = 28 * s;
  ctx.shadowOffsetY = 8 * s;
  shape();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
  shape();
  ctx.lineWidth = 2 * s;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.067)";
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const left = x + c.padX * s;
  let top = y + c.padTop * s;
  ctx.font = fontFor(c.whoSize, 600, s);
  ctx.fillText(layout.who, left, top + (c.whoSize * c.lineHeight * s) / 2);
  top += (c.whoSize * c.lineHeight + c.whoGap) * s;
  ctx.font = fontFor(c.msgSize, 400, s);
  const msgLine = c.msgSize * c.lineHeight * s;
  for (const line of layout.lines) {
    ctx.fillText(line, left, top + msgLine / 2);
    top += msgLine;
  }

  const field = layout.field;
  if (field !== null) {
    ctx.beginPath();
    ctx.roundRect(
      field.x + s,
      field.y + s,
      field.width - 2 * s,
      field.height - 2 * s,
      6 * s,
    );
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = BLUE;
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.rect(field.x, field.y, field.width, field.height);
    ctx.clip();
    ctx.fillStyle = INK;
    ctx.fillText(
      card.text ?? "",
      field.x + c.fieldPadX * s,
      field.y + field.height / 2,
    );
    ctx.restore();
  }

  const accepted = card.answer === "accept";
  if (layout.cancel !== null)
    drawPill(ctx, layout.cancel, false, pressed && !accepted, s);
  drawPill(ctx, layout.ok, true, pressed && accepted, s);
  ctx.restore();
}
