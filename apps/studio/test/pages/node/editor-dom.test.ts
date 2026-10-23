import { describe, expect, it } from "vitest";
import { editorDom, editorMarkup } from "../helpers/editor-dom";

/**
 * The extraction in `helpers/editor-dom.ts`, not the page it reads.
 *
 * `editor-shell-ids.test.ts` already asks whether `index.html` declares the
 * ids `main.ts` demands, reading the file as text. It cannot see this: the
 * helper slices `<body>` out of that file and strips its `<script>`, and a
 * slice that took the wrong span — or nothing — would leave that test green
 * while every `editor-main-*.test.ts` mounted a page missing the elements
 * the real one has. This file is the mount-side half.
 */
describe("the editor fixture's extraction", () => {
  it("mounts the body's own structure, not the whole document", () => {
    editorDom();
    // The nesting the copies used to flatten: `main.ts`'s stage arithmetic
    // reads `#stage-frame` through `#stage-box`, and for ten months no node
    // test had the middle element at all.
    const frame = document.getElementById("stage-frame");
    expect(frame?.parentElement?.id).toBe("stage-box");
    expect(frame?.closest("#stage")).not.toBeNull();
    // `<head>` is not in the slice: a body regex that ran greedy from the
    // start of the document would drag the stylesheet links in with it.
    expect(document.querySelector("link")).toBeNull();
  });

  it("strips main.ts's own script tag", () => {
    // Left in, jsdom fetches and evaluates the entrypoint itself, before
    // any test here has stubbed `chrome`.
    expect(editorMarkup).toContain('id="timeline-tools"');
    expect(editorMarkup).not.toContain("<script");
  });
});
