// apps/studio/pages/src/shell/empty-state.ts
import { type GlyphName, icon } from "./icons";

/**
 * An empty list, said as a glyph beside a title and one line, flat on the
 * card that holds it (`.empty` in shell.css). Settings' sites and agents
 * and the Recordings library all say "nothing here" this way, so a third
 * page has one shape to follow. No button by default: nothing on those
 * pages can make the first entry. A hint may carry a control when the
 * empty state is one the author can leave — a filter that matched nothing
 * — which is why it takes nodes as well as text.
 */
export function emptyState(
  glyph: GlyphName,
  title: string,
  hint: string | readonly (string | Node)[],
  attrs: Record<string, string> = {},
): HTMLElement {
  const box = document.createElement("div");
  box.className = "empty";
  for (const [k, v] of Object.entries(attrs)) box.setAttribute(k, v);
  const strong = document.createElement("strong");
  strong.textContent = title;
  const line = document.createElement("p");
  line.className = "hint";
  line.append(...(typeof hint === "string" ? [hint] : hint));
  const text = document.createElement("div");
  text.append(strong, line);
  box.append(icon(glyph), text);
  return box;
}
