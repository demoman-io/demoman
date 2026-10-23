/** Trim and collapse internal whitespace; empty becomes null, never "". */
export function normalizeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? null : collapsed;
}

/**
 * An element whose text is its own: none of its element children carries any.
 * A container's textContent is really its descendants', so only these record
 * text at capture and only these match on the text tier — otherwise a
 * container resolves to its own child. "No element children at all" was the
 * rule until 2026-10-01, and it left a label beside an icon (a `<summary>`
 * with a chevron span, a button with an svg) with no text anywhere: the label
 * is not childless, and the icon has no text.
 */
export function isTextLeaf(el: Element): boolean {
  return Array.from(el.children).every(
    (child) => normalizeText(child.textContent) === null,
  );
}
