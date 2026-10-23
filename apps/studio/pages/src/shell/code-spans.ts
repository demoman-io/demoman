// apps/studio/pages/src/shell/code-spans.ts

/**
 * Backtick spans in a sentence the product wrote ("run `npx demoman studio`")
 * are drawn as `<code>` elements, never as literal backticks and never through
 * `innerHTML`: the text is a text node, the span a `code` element holding a
 * text node. A stray, unpaired backtick stays what it is — text.
 */
const SPAN = /`([^`]*)`/g;

/** The sentence as DOM children: strings and `code` elements. */
export function codeSpans(
  text: string,
  doc: Document = document,
): Array<string | HTMLElement> {
  const out: Array<string | HTMLElement> = [];
  let at = 0;
  for (const m of text.matchAll(SPAN)) {
    const index = m.index ?? 0;
    if (index > at) out.push(text.slice(at, index));
    const code = doc.createElement("code");
    code.textContent = m[1] ?? "";
    out.push(code);
    at = index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** The sentence with its backticks dropped: for a `title` or any other place
 *  that holds text and cannot hold markup. */
export const withoutTicks = (text: string): string => text.replace(SPAN, "$1");

/** Replaces `node`'s children with the sentence, spans drawn as code. */
export function setCodeText(node: HTMLElement, text: string): void {
  node.replaceChildren(...codeSpans(text, node.ownerDocument));
}
