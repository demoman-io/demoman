export type DriftPair = { before: string; after: string };

const pairs = import.meta.glob("../fixtures/**/*.html", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

// Loaded through import.meta.glob rather than node:fs so the same helper works
// in the browser lane, where there is no filesystem.
export function loadPair(name: string): DriftPair {
  const before = pairs[`../fixtures/${name}/before.html`];
  const after = pairs[`../fixtures/${name}/after.html`];
  if (before === undefined || after === undefined) {
    throw new Error(`fixture pair "${name}" not found`);
  }
  return { before, after };
}

/**
 * Parse a fixture into its own Document. Backed by an iframe rather than
 * DOMParser because a DOMParser document has no browsing context — its
 * defaultView is null, and dom-accessibility-api needs a window. Two mounted
 * documents coexist independently, which the drift-pair tests rely on.
 */
export function mount(html: string): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (doc === null) throw new Error("mount: iframe produced no document");
  doc.open();
  doc.write(html);
  doc.close();
  return doc;
}
