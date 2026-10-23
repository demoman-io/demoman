import type { LogoPlacement } from "@demoman/compositor";
import {
  LOGO_CORNERS,
  type LogoCorner,
  parseColor,
  type SceneBackground,
  type SceneBranding,
} from "@demoman/scene-schema";
import {
  type BrandKitsRead,
  KIT_NAME_MAX,
  type KitEntry,
} from "../core/brand-kit";
import type { BrandingPatch, GradientAdjust } from "../editor/branding";
import { el, paintSliderFill } from "../editor/dom";
import { icon } from "../shell/icons";

/**
 * The logo's thumbnail beside Replace and Remove, the way a file upload
 * shows what it holds. Null with no logo. `failed` carries the reason for
 * the tile's own title; the notes under the row say it in full.
 */
export type LogoThumb =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "failed"; reason: string };

export interface BrandingControlsProps {
  branding: SceneBranding;
  logoThumb: LogoThumb | null;
  logoPlacement: LogoPlacement | null;
  formatTitle: string;
  logoNotes: string[];
  /**
   * The brand kits' row, in the editor. Absent on the Settings page, which
   * IS the kits.
   */
  kit?: KitRowProps;
  /** Titles over the Background, Logo and Frame groups: Settings, where the
   *  groups sit side by side; the editor's narrow panel reads without them. */
  groupTitles?: boolean;
}

/** The editor's kit picker (spec 2026-10-08 §3, mockup A): it names the kit
 *  the take is on and whether the take has been edited from it; its menu
 *  applies any kit, updates the take's own kit, or saves the take's look as
 *  a new kit. */
export interface KitRowProps {
  read: BrandKitsRead;
  /** The kit the take is on, and whether the take differs from it; null
   *  for a take on no kit ("Custom look", or no kits at all). */
  standing: { kit: KitEntry; edited: boolean } | null;
  /** "Save as new kit"'s name field, open, with what is typed and the
   *  refusal it earned; null when closed. Owned by the editor so the
   *  re-render on every session emit keeps it. */
  naming: { text: string; error: string | null } | null;
  onApply(id: string): void;
  /** Writes the take's look over `standing.kit`; offered only when edited. */
  onUpdate(): void;
  onStartNew(): void;
  /** Every keystroke. Must not re-render: it fires from a live `input`. */
  onNameInput(text: string): void;
  onConfirmNew(text: string): void;
  onCancelNew(): void;
}

export interface BrandingControlsHandlers {
  onCommit(patch: BrandingPatch): void;
  /** Must not re-render these controls: it fires from a live `input`, and
   *  replacing the element under it ends the gesture (and closes Chrome's
   *  colour picker). */
  onPreview(patch: BrandingPatch): void;
  onLogoFile(file: File): void;
}

const CORNER_LABELS: Record<LogoCorner, string> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
};

/**
 * The tile beside the logo's buttons. Absent the prop with a logo set, it
 * says the page never asked rather than spinning forever: a tile left on
 * "loading" with nothing loading reads exactly like a slow store.
 */
function logoThumbNode(thumb: LogoThumb | null): HTMLElement {
  const tile = el("span", "logo-thumb");
  const state = thumb ?? {
    kind: "failed" as const,
    reason: "this page did not load the logo",
  };
  tile.setAttribute("data-logo-thumb", state.kind);
  if (state.kind === "ready") {
    const img = el("img", "logo-thumb-img");
    img.src = state.url;
    img.alt = "Logo";
    tile.append(img);
  } else if (state.kind === "loading") {
    tile.setAttribute("aria-busy", "true");
    tile.title = "Loading the logo";
  } else {
    tile.append(icon("circleAlert"));
    tile.title = `The logo could not be shown: ${state.reason}`;
    tile.setAttribute("aria-label", tile.title);
    tile.setAttribute("role", "img");
  }
  return tile;
}

export function capNote(
  placement: LogoPlacement | null,
  formatTitle: string,
): string | null {
  if (placement === null || !placement.capped) return null;
  if (placement.effectiveSize === 0) {
    return `No room for the logo in ${formatTitle} — the recording fills the frame`;
  }
  return `Shown at ${Math.round(placement.effectiveSize * 100)}% in ${formatTitle} to stay clear of your recording`;
}

/**
 * The last note a pasted colour earned ("Nearest sRGB is …"), keyed on the
 * hex it produced. Held here rather than in the DOM because the commit that
 * follows re-renders the controls on both pages, which would otherwise wipe
 * the note before it was read. It shows on whichever field now holds that
 * hex, and lapses once the value moves on.
 */
let lastNote: { hex: string; note: string } | null = null;

/**
 * What the author has typed into a colour box and not yet committed — and
 * the refusal it earned, if any — keyed on the field's label, per mounted
 * root. The editor re-renders these controls on every export progress
 * message and every session emit, so a box rebuilt from the stored value
 * lost a half-typed `oklch(…)` and the "not a colour" message beside it. A
 * draft is kept only while the stored value is the one it was typed over
 * (`base`): a Swap, a commit or a change from another tab supersedes it.
 */
interface ColourDraft {
  base: string;
  text: string;
  error: string;
}
const drafts = new WeakMap<HTMLElement, Map<string, ColourDraft>>();
const draftsFor = (root: HTMLElement): Map<string, ColourDraft> => {
  let map = drafts.get(root);
  if (map === undefined) {
    map = new Map();
    drafts.set(root, map);
  }
  return map;
};

/**
 * A brand colour: the native swatch for picking, a text box for pasting.
 * The text commits on `change` (Enter or blur); what does not parse is
 * refused beside the field with the text left in place, and nothing is
 * committed — the silent-grey path this replaces stored anything.
 */
function colourField(
  label: string,
  value: string,
  toPatch: (hex: string) => BrandingPatch,
  handlers: BrandingControlsHandlers,
  fieldDrafts: Map<string, ColourDraft>,
  aside: HTMLElement | null = null,
): HTMLElement {
  const box = el("div", "control-row colour-field");
  box.setAttribute("data-colour-field", "");
  const swatch = el("input");
  swatch.type = "color";
  swatch.value = value;
  swatch.setAttribute("aria-label", `${label} swatch`);
  const text = el("input", "colour-text");
  text.type = "text";
  text.value = value;
  text.spellcheck = false;
  text.setAttribute("aria-label", label);
  text.setAttribute("data-colour-text", "");
  const error = el("p", "colour-error");
  error.setAttribute("data-colour-error", "");
  error.setAttribute("role", "alert");
  const note = el("p", "muted");
  note.setAttribute("data-colour-note", "");
  if (lastNote !== null && lastNote.hex === value)
    note.textContent = lastNote.note;
  const draft = fieldDrafts.get(label);
  if (draft !== undefined && draft.base !== value) fieldDrafts.delete(label);
  else if (draft !== undefined) {
    text.value = draft.text;
    error.textContent = draft.error;
    if (draft.error !== "") {
      note.textContent = "";
      text.setAttribute("aria-invalid", "true");
    }
  }

  text.addEventListener("input", () => {
    const was = fieldDrafts.get(label);
    fieldDrafts.set(label, {
      base: value,
      text: text.value,
      error: was?.error ?? "",
    });
  });
  swatch.addEventListener("input", () => {
    fieldDrafts.delete(label);
    text.value = swatch.value;
    handlers.onPreview(toPatch(swatch.value));
  });
  swatch.addEventListener("change", () =>
    handlers.onCommit(toPatch(swatch.value)),
  );
  text.addEventListener("change", () => {
    const parsed = parseColor(text.value);
    if (!parsed.ok) {
      error.textContent = parsed.reason;
      note.textContent = "";
      text.setAttribute("aria-invalid", "true");
      fieldDrafts.set(label, {
        base: value,
        text: text.value,
        error: parsed.reason,
      });
      return;
    }
    fieldDrafts.delete(label);
    error.textContent = "";
    note.textContent = parsed.note ?? "";
    lastNote =
      parsed.note === null ? null : { hex: parsed.hex, note: parsed.note };
    text.removeAttribute("aria-invalid");
    text.value = parsed.hex;
    swatch.value = parsed.hex;
    handlers.onCommit(toPatch(parsed.hex));
  });

  const row = el("div", "colour-row");
  row.append(swatch, text);
  box.append(el("span", "control-label", label));
  if (aside !== null) {
    aside.classList.add("control-aside");
    box.append(aside);
  }
  box.append(row, error, note);
  return box;
}

/** The Cursor panel's slider row, for branding: preview on `input`,
 *  commit on `change`, the readout maintained in place. */
function sliderRow(
  attr: string,
  label: string,
  value: number,
  range: { min: number; max: number; step: number },
  readout: (v: number) => string,
  toPatch: (v: number) => BrandingPatch,
  handlers: BrandingControlsHandlers,
): HTMLElement {
  const row = el("div", "slider-row");
  const slider = el("input");
  slider.type = "range";
  slider.min = String(range.min);
  slider.max = String(range.max);
  slider.step = String(range.step);
  slider.value = String(value);
  slider.setAttribute(attr, "");
  slider.setAttribute("aria-label", label);
  const shown = el("span", "slider-value", readout(value));
  paintSliderFill(slider);
  slider.addEventListener("input", () => {
    paintSliderFill(slider);
    shown.textContent = readout(Number(slider.value));
    handlers.onPreview(toPatch(Number(slider.value)));
  });
  slider.addEventListener("change", () =>
    handlers.onCommit(toPatch(Number(slider.value))),
  );
  row.append(el("span", "control-label slider-label", label), shown, slider);
  return row;
}

export function renderBrandingControls(
  root: HTMLElement,
  props: BrandingControlsProps,
  handlers: BrandingControlsHandlers,
): void {
  const { branding } = props;
  const bg = branding.background;
  const box = el("div", "branding-controls");
  const fieldDrafts = draftsFor(root);
  const group = (
    key: "background" | "logo" | "frame",
    title: string,
  ): HTMLElement => {
    const g = el("section", "branding-group");
    g.setAttribute("data-group", key);
    if (props.groupTitles) g.append(el("h3", "branding-group-title", title));
    return g;
  };
  const background = group("background", "Background");
  const logoGroup = group("logo", "Logo");
  const frame = group("frame", "Frame");
  if (props.kit !== undefined) box.append(kitRow(root, props.kit));

  // Style: Solid | Gradient.
  const kinds = el("div", "segmented");
  kinds.setAttribute("role", "radiogroup");
  kinds.setAttribute("aria-label", "Background style");
  for (const kind of ["solid", "gradient"] as const) {
    const button = el(
      "button",
      "segment",
      kind === "solid" ? "Solid" : "Gradient",
    );
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("data-bg-kind", kind);
    button.setAttribute("aria-checked", String(bg.kind === kind));
    button.addEventListener("click", () => {
      if (bg.kind === kind) return;
      const next: SceneBackground =
        kind === "gradient" && bg.kind === "solid"
          ? {
              kind: "gradient",
              from: bg.color,
              // White, the author's call on 2026-09-22: a brand colour
              // fading to white is the gradient most people mean.
              to: "#ffffff",
              angle: 135,
            }
          : {
              kind: "solid",
              color: bg.kind === "gradient" ? bg.from : bg.color,
            };
      handlers.onCommit({ background: next });
    });
    kinds.append(button);
  }
  const style = el("div", "control-row");
  style.append(el("span", "control-label", "Style"), kinds);
  background.append(style);

  /** The gradient's Angle row; null for a solid. */
  let angle: HTMLElement | null = null;
  if (bg.kind === "solid") {
    background.append(
      colourField(
        "Colour",
        bg.color,
        (color) => ({ background: { kind: "solid", color } }),
        handlers,
        fieldDrafts,
      ),
    );
  } else {
    const with_ = (gradient: GradientAdjust): BrandingPatch => ({ gradient });
    const swap = el("button", "btn btn-link", "⇅ Swap");
    swap.type = "button";
    swap.setAttribute("data-swap", "");
    swap.setAttribute("aria-label", "Swap From and To");
    swap.title = "Swap From and To";
    swap.addEventListener("click", () =>
      handlers.onCommit(with_({ swap: true })),
    );
    background.append(
      colourField(
        "From",
        bg.from,
        (from) => with_({ from }),
        handlers,
        fieldDrafts,
        swap,
      ),
      colourField("To", bg.to, (to) => with_({ to }), handlers, fieldDrafts),
    );
    angle = sliderRow(
      "data-angle",
      "Angle",
      bg.angle,
      { min: 0, max: 359, step: 1 },
      (v) => `${Math.round(v)}°`,
      (next) => with_({ angle: Math.round(next) }),
      handlers,
    );
    // The editor's panel keeps it with the colours it turns. On the
    // Settings card it sits under Frame, beside Padding, which evens the
    // three columns (the author's call, 2026-10-08).
    if (!props.groupTitles) background.append(angle);
  }

  // Padding: the margin around the recording (spec 2026-10-05 §5).
  frame.append(
    sliderRow(
      "data-padding",
      "Padding",
      branding.padding,
      { min: 0, max: 0.2, step: 0.01 },
      (v) => `${Math.round(v * 100)}%`,
      (padding) => ({ padding: Math.round(padding * 100) / 100 }),
      handlers,
    ),
  );
  if (angle !== null && props.groupTitles) frame.append(angle);

  // Logo.
  const logoBox = el("div", "logo-controls");
  const file = el("input");
  file.type = "file";
  file.accept = "image/svg+xml,image/png,image/webp,image/jpeg";
  file.setAttribute(
    "aria-label",
    branding.logo ? "Replace logo" : "Upload logo",
  );
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    if (chosen) handlers.onLogoFile(chosen);
  });
  const pick = el(
    "label",
    "btn btn-quiet",
    branding.logo ? "Replace" : "Upload logo",
  );
  pick.prepend(icon("upload"));
  pick.append(file);
  const logoRow = el("div", "control-row");
  // Under a titled Logo group the row's own "Logo" would repeat the title.
  if (!props.groupTitles) logoRow.append(el("span", "control-label", "Logo"));
  logoBox.append(logoRow);
  if (branding.logo === null) {
    const actions = el("div", "control-actions");
    actions.append(pick);
    logoRow.append(actions);
  } else {
    const logo = branding.logo;
    const remove = el("button", "btn btn-quiet", "Remove");
    remove.type = "button";
    remove.setAttribute("data-logo-remove", "");
    remove.prepend(icon("trash"));
    remove.addEventListener("click", () => handlers.onCommit({ logo: null }));
    // The logo in a well big enough to read it, Replace and Remove stacked
    // beside it (the author's pick, mockup A, 2026-10-08). Three in one
    // wrapping row broke unevenly at every width the panel has.
    const stack = el("div", "logo-stack");
    stack.append(pick, remove);
    const pair = el("div", "logo-row");
    pair.append(logoThumbNode(props.logoThumb), stack);
    logoRow.append(pair);

    // The corner picker is the video frame itself: the author clicks the
    // corner the logo goes in (mockup A). Wider than the 2x2 swatches it
    // replaced, centred, and it shows what the setting does.
    const grid = el("div", "corner-frame");
    grid.setAttribute("role", "radiogroup");
    grid.setAttribute("aria-label", "Logo corner");
    grid.append(el("div", "corner-frame-rec"));
    for (const corner of LOGO_CORNERS) {
      const button = el("button", "corner");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("data-logo-corner", corner);
      button.setAttribute("aria-checked", String(logo.corner === corner));
      button.setAttribute("aria-label", CORNER_LABELS[corner]);
      button.title = CORNER_LABELS[corner];
      button.addEventListener("click", () =>
        handlers.onCommit({ logo: { corner } }),
      );
      grid.append(button);
    }
    const cornerRow = el("div", "control-row");
    cornerRow.append(el("span", "control-label", "Corner"), grid);
    logoBox.append(
      cornerRow,
      sliderRow(
        "data-logo-size",
        "Size",
        logo.size,
        { min: 0.02, max: 0.2, step: 0.01 },
        (v) => `${Math.round(v * 100)}%`,
        (size) => ({ logo: { size } }),
        handlers,
      ),
      sliderRow(
        "data-logo-opacity",
        "Opacity",
        logo.opacity,
        { min: 0.2, max: 1, step: 0.05 },
        (v) => `${Math.round(v * 100)}%`,
        (opacity) => ({ logo: { opacity } }),
        handlers,
      ),
    );
    const notes = [
      capNote(props.logoPlacement, props.formatTitle),
      ...props.logoNotes,
    ].filter((n): n is string => n !== null);
    if (notes.length > 0) {
      const list = el("div", "muted");
      list.setAttribute("data-logo-notes", "");
      for (const n of notes) list.append(el("p", undefined, n));
      logoBox.append(list);
    }
  }
  logoGroup.append(logoBox);
  // Background, Frame, Logo: the editor's own order since the padding
  // landed (style, colour, padding, then logo — `editor-shell.test.ts`),
  // kept on the Settings card too, where the short Frame column sits
  // between the two taller ones.
  box.append(background, frame, logoGroup);

  // A box the author is typing in keeps the caret across the rebuild.
  const active = document.activeElement;
  const typingIn =
    active instanceof HTMLInputElement &&
    active.hasAttribute("data-colour-text") &&
    root.contains(active)
      ? {
          label: active.getAttribute("aria-label"),
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : null;
  // The "Save as new kit" field before the rebuild: whether it was there,
  // and whether the author was in it. Focus follows the author, never the
  // render — the editor re-renders on every session emit and export tick,
  // and its shortcuts stand down while an input has focus (final review).
  const wasNaming = root.querySelector<HTMLInputElement>("[data-kit-new-name]");
  const namingCaret =
    wasNaming !== null && document.activeElement === wasNaming
      ? { start: wasNaming.selectionStart, end: wasNaming.selectionEnd }
      : null;
  root.replaceChildren(box);
  const naming = box.querySelector<HTMLInputElement>("[data-kit-new-name]");
  if (naming !== null && wasNaming === null) {
    // Just opened: the author pressed "Save as new kit" to type a name.
    naming.focus();
  } else if (naming !== null && namingCaret !== null) {
    naming.focus();
    if (namingCaret.start !== null && namingCaret.end !== null)
      naming.setSelectionRange(namingCaret.start, namingCaret.end);
  }
  if (typingIn !== null) {
    const again = Array.from(
      box.querySelectorAll<HTMLInputElement>("[data-colour-text]"),
    ).find((t) => t.getAttribute("aria-label") === typingIn.label);
    if (again !== undefined) {
      again.focus();
      if (typingIn.start !== null && typingIn.end !== null)
        again.setSelectionRange(typingIn.start, typingIn.end);
    }
  }
}

/** Whether a root's kit menu is open: held here because the editor
 *  rebuilds these controls on every session emit and export tick, and a
 *  menu that shut on each would be unusable. */
const kitMenuOpen = new WeakMap<HTMLElement, boolean>();
/** Roots whose outside-click closer is registered: once each. */
const kitMenuWatched = new WeakSet<HTMLElement>();

/** A kit's background as a CSS swatch, for the picker and its menu. */
function swatchFor(entry: KitEntry | null): HTMLElement {
  const swatch = el("span", "kit-swatch");
  if (entry?.read.state === "ready") {
    const bg = entry.read.kit.background;
    swatch.style.background =
      bg.kind === "solid"
        ? bg.color
        : `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})`;
  } else if (entry !== null) {
    swatch.append(icon("circleAlert"));
  }
  return swatch;
}

/** The editor's kit picker; see `KitRowProps`. */
function kitRow(root: HTMLElement, props: KitRowProps): HTMLElement {
  const { read, standing, naming } = props;
  const row = el("div", "control-row kit-actions");
  row.setAttribute("data-kit-row", "");
  row.append(el("span", "control-label", "Brand kit"));
  if (read.state === "invalid") {
    const error = el(
      "p",
      "colour-error",
      `Your brand kits could not be read: ${read.reason}`,
    );
    error.setAttribute("data-kit-error", "");
    row.append(error);
    return row;
  }
  if (naming !== null) {
    // In the picker's place: the name the take's look will be saved under.
    const field = el("div", "kit-naming");
    const input = el("input", "kit-new-name");
    input.type = "text";
    input.maxLength = KIT_NAME_MAX;
    input.value = naming.text;
    input.placeholder = "Kit name";
    input.setAttribute("aria-label", "New kit name");
    input.setAttribute("data-kit-new-name", "");
    input.addEventListener("input", () => props.onNameInput(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") props.onConfirmNew(input.value);
      else if (event.key === "Escape") props.onCancelNew();
    });
    const save = el("button", "btn btn-primary", "Save");
    save.type = "button";
    save.setAttribute("data-kit-new-save", "");
    save.addEventListener("click", () => props.onConfirmNew(input.value));
    const cancel = el("button", "btn btn-quiet", "Cancel");
    cancel.type = "button";
    cancel.setAttribute("data-kit-new-cancel", "");
    cancel.addEventListener("click", () => props.onCancelNew());
    field.append(input, save, cancel);
    row.append(field);
    if (naming.error !== null) {
      const error = el("p", "colour-error", naming.error);
      error.setAttribute("data-kit-new-error", "");
      row.append(error);
    }
    return row;
  }

  const wrap = el("div", "kit-picker-wrap");
  const picker = el("button", "kit-picker");
  picker.type = "button";
  picker.setAttribute("data-kit-picker", "");
  picker.setAttribute("aria-haspopup", "menu");
  const name =
    standing !== null
      ? standing.kit.name
      : read.kits.length === 0
        ? "No brand kit"
        : "Custom look";
  picker.append(
    swatchFor(standing?.kit ?? null),
    el(
      "span",
      standing === null ? "kit-picker-name kit-picker-none" : "kit-picker-name",
      name,
    ),
  );
  if (standing?.edited) {
    const edited = el("span", "kit-edited", "Edited");
    edited.setAttribute("data-kit-edited", "");
    picker.append(edited);
  }
  picker.append(icon("chevronDown"));

  const menu = el("div", "kit-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("data-kit-menu", "");
  const setOpen = (on: boolean) => {
    kitMenuOpen.set(root, on);
    menu.hidden = !on;
    picker.setAttribute("aria-expanded", String(on));
  };
  const item = (
    cls: string,
    label: string,
    glyph: HTMLElement | SVGSVGElement | null,
  ) => {
    const b = el("button", `kit-menu-item ${cls}`.trim());
    b.type = "button";
    if (glyph !== null) b.append(glyph);
    b.append(el("span", "kit-menu-label", label));
    return b;
  };
  for (const kit of read.kits) {
    const b = item("", kit.name, swatchFor(kit));
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("data-kit-option", kit.id);
    const current = kit.id === standing?.kit.id;
    b.setAttribute("aria-checked", String(current));
    const meta = el("span", "kit-menu-meta");
    if (kit.id === read.defaultId) {
      const star = icon("star");
      star.setAttribute("aria-label", "Default");
      meta.append(star);
    }
    if (current) meta.append(icon("check"));
    b.append(meta);
    if (kit.read.state === "invalid") {
      b.disabled = true;
      b.title = kit.read.reason;
    }
    b.addEventListener("click", () => {
      setOpen(false);
      props.onApply(kit.id);
    });
    menu.append(b);
  }
  if (read.kits.length > 0) menu.append(el("div", "kit-menu-sep"));
  if (standing !== null) {
    const update = item("", `Update "${standing.kit.name}"`, icon("refresh"));
    update.setAttribute("role", "menuitem");
    update.setAttribute("data-kit-update", "");
    if (!standing.edited) update.disabled = true;
    update.addEventListener("click", () => {
      setOpen(false);
      props.onUpdate();
    });
    menu.append(update);
  }
  const add = item("", "Save as new kit…", icon("plus"));
  add.setAttribute("role", "menuitem");
  add.setAttribute("data-kit-new", "");
  add.addEventListener("click", () => {
    setOpen(false);
    props.onStartNew();
  });
  menu.append(add);

  picker.addEventListener("click", () => setOpen(menu.hidden));
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    setOpen(false);
    picker.focus();
  });
  setOpen(kitMenuOpen.get(root) === true);
  if (!kitMenuWatched.has(root)) {
    kitMenuWatched.add(root);
    // Outside the row shuts the menu. Read off the root each time, since
    // every render replaces the row it was registered beside.
    document.addEventListener("pointerdown", (event) => {
      if (kitMenuOpen.get(root) !== true) return;
      const current = root.querySelector("[data-kit-row]");
      if (current?.contains(event.target as Node)) return;
      kitMenuOpen.set(root, false);
      const open = root.querySelector<HTMLElement>("[data-kit-menu]");
      if (open !== null) open.hidden = true;
      root
        .querySelector("[data-kit-picker]")
        ?.setAttribute("aria-expanded", "false");
    });
  }
  wrap.append(picker, menu);
  row.append(wrap);
  return row;
}
