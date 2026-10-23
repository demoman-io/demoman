import { el } from "../../src/editor/dom";
import { type GlyphName, icon } from "../../src/shell/icons";

export type RailEntry =
  | "export"
  | "background"
  | "selection"
  | "cursor"
  | "shortcuts";

export interface RailState {
  rail: RailEntry;
  panelOpen: boolean;
  /** Whether the selection names something the take still has. */
  hasSelection: boolean;
}

// Export is not here: its door is the header's `#export-open` since
// 2026-10-07 (spec: editor refresh), drawn by `renderExportDoor` below. The
// panel identity stays `"export"` so the rail's open/close state and
// `railBeforeSelection` keep one vocabulary. Selection is last because it is
// the entry that is usually disabled, so the two that always work sit
// together.
// Keyboard shortcuts is not here either: its door is the header's ? button
// (`renderShortcutsDoor`), as Export's is the header's Export button, since
// 2026-10-19 when the list moved into the inspector from a panel of its own.
const ENTRIES: ReadonlyArray<{
  entry: Exclude<RailEntry, "export" | "shortcuts">;
  label: string;
  glyph: GlyphName;
}> = [
  { entry: "background", label: "Background", glyph: "image" },
  { entry: "cursor", label: "Cursor", glyph: "mousePointer2" },
  { entry: "selection", label: "Selection", glyph: "mousePointerClick" },
];

const SELECTION_DISABLED = "Select a step, zoom or mask on the timeline";

/**
 * The rail: one icon button per panel except Export, between the stage and the panel.
 *
 * The pressed entry is the open panel; nothing is pressed while the panel
 * is closed. Selection is contextual — disabled, with the reason in its
 * title, until the author has picked something on the timeline. The rail
 * knows the icons and nothing else about what the panels hold.
 */
export function renderRail(
  root: HTMLElement,
  state: RailState,
  handlers: { onPick(entry: RailEntry): void },
): void {
  const buttons = ENTRIES.map(({ entry, label, glyph }) => {
    const button = el("button", "btn btn-icon");
    button.type = "button";
    button.setAttribute("data-rail", entry);
    button.setAttribute("aria-label", label);
    button.setAttribute(
      "aria-pressed",
      String(state.panelOpen && state.rail === entry),
    );
    const disabled = entry === "selection" && !state.hasSelection;
    button.disabled = disabled;
    // Spec §1: every entry carries both an `aria-label` and a `title`.
    // An empty title on the enabled entries left the icon-only rail with no
    // tooltip at all for a pointer user — the label reached a screen reader
    // and nobody else.
    button.title = disabled ? SELECTION_DISABLED : label;
    button.append(icon(glyph));
    button.addEventListener("click", () => handlers.onPick(entry));
    return button;
  });
  root.replaceChildren(...buttons);
}

/**
 * The Export panel's door: the header's primary button. It toggles the
 * panel exactly as a rail entry does — `onPick("export")`, the pressed
 * door closing it — and is pressed while Export is the open panel.
 *
 * Patched in place, like every control `render` touches each edit: the
 * glyph and word are built once, `onclick` is assigned rather than added so
 * renders do not stack handlers.
 */
export function renderExportDoor(
  button: HTMLButtonElement,
  state: Pick<RailState, "rail" | "panelOpen">,
  handlers: { onPick(entry: RailEntry): void },
): void {
  if (button.querySelector("svg[data-icon]") === null) {
    button.replaceChildren(icon("download"), el("span", undefined, "Export"));
  }
  button.setAttribute(
    "aria-pressed",
    String(state.panelOpen && state.rail === "export"),
  );
  button.onclick = () => handlers.onPick("export");
}

/**
 * The Keyboard shortcuts panel's door: the header's ? button, which toggles
 * the panel exactly as Export's door does — pressed while the panel is the
 * open one. Its glyph is the header's (`renderHeaderIcons`).
 */
export function renderShortcutsDoor(
  button: HTMLButtonElement,
  state: Pick<RailState, "rail" | "panelOpen">,
  handlers: { onPick(entry: RailEntry): void },
): void {
  button.setAttribute(
    "aria-pressed",
    String(state.panelOpen && state.rail === "shortcuts"),
  );
  button.onclick = () => handlers.onPick("shortcuts");
}
