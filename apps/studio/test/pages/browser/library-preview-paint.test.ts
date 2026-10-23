import { userEvent } from "@vitest/browser/context";
import { describe, expect, it, vi } from "vitest";
import pageHtml from "../../../pages/entrypoints/library/index.html?raw";
import type { PreviewPorts } from "../../../pages/src/library/preview";
import { createPreviewMounter } from "../../../pages/src/library/preview";
import type { LibraryActions } from "../../../pages/src/library/view";
import { renderLibrary } from "../../../pages/src/library/view";
import { shellCss } from "../helpers/shell-css";

const FIXTURE_MADE = "2026-09-01T00:00:00Z";

/**
 * Three keyframes that are three different colours, so "the flipbook
 * advanced" is a claim about pixels rather than about a frame index the
 * renderer might never have drawn.
 */
const COLORS = [
  { css: "#ff0000", rgb: [255, 0, 0] },
  { css: "#00ff00", rgb: [0, 255, 0] },
  { css: "#0000ff", rgb: [0, 0, 255] },
] as const;

const KEYFRAME_WIDTH = 160;
const KEYFRAME_HEIGHT = 90;

async function solid(css: string): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(KEYFRAME_WIDTH, KEYFRAME_HEIGHT);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, KEYFRAME_WIDTH, KEYFRAME_HEIGHT);
  return createImageBitmap(canvas);
}

function centerPixel(canvas: HTMLCanvasElement): number[] {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const d = ctx.getImageData(
    Math.floor(canvas.width / 2),
    Math.floor(canvas.height / 2),
    1,
    1,
  ).data;
  return [...d.slice(0, 3)];
}

async function bitmapPixel(bitmap: ImageBitmap): Promise<number[]> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0);
  const d = ctx.getImageData(1, 1, 1, 1).data;
  return [...d.slice(0, 3)];
}

const model = {
  usedBytes: 1,
  budgetBytes: 10,
  fraction: 0.1,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [
    {
      sceneId: "s-1",
      name: "Checkout",
      label: "Checkout",
      origin: "app.test",
      path: "",
      createdAt: FIXTURE_MADE,
      when: "Sep 13, 2:15 PM",
      time: "2:15 PM",
      hosted: false,
      recoverable: false,
      frameBytes: 1,
      outputBytes: 0,
      state: "Complete" as const,
      canRestore: false,
      authored: false,
      servesReshoot: false,
      needsLook: false,
    },
  ],
};

const bundle = {
  keyframes: COLORS.map((_, i) => ({
    sourceTimeMs: i * 1000,
    ref: `kf:${i}`,
    width: KEYFRAME_WIDTH,
    height: KEYFRAME_HEIGHT,
    actionId: `a${i}`,
    byteLength: 100,
  })),
};

/** Visible the moment it is asked about — the laziness the entrypoint wires
 *  with an IntersectionObserver is not what this test is about. */
/**
 * A FRESH bitmap for the ref, every call — the contract `PreviewPorts.image`
 * states, because the mounter closes what it is given. Serving one shared
 * bitmap twice leaves the second row drawing a detached image and painting
 * nothing, which is a fixture that lies rather than a product that fails.
 *
 * Throws rather than resolving undefined: a port that quietly served nothing
 * would leave the canvas blank and the poll timing out with no reason given.
 */
async function imageFor(ref: string): Promise<ImageBitmap> {
  const color = COLORS[Number(ref.slice(3))];
  if (color === undefined) throw new Error(`fixture has no image for ${ref}`);
  return solid(color.css);
}

const visibleNow: PreviewPorts["whenVisible"] = (_box, paint) => {
  paint();
  return () => {};
};

/** A length port for the tests that are about the picture, not the badge. */
const noLength: PreviewPorts["length"] = async () => ({
  kind: "nothing",
  reason: "this test is about the picture",
});

/** The page's own stylesheet — the shell it links and the rules it keeps
 *  inline — so a real pointer meets the box at the size and position the
 *  shipped page gives it. */
function injectPageStyle(): HTMLStyleElement {
  const match = /<style>([\s\S]*?)<\/style>/.exec(pageHtml);
  if (match?.[1] === undefined) {
    throw new Error("library/index.html has no <style> block");
  }
  const style = document.createElement("style");
  style.textContent = `${shellCss}\n${match[1]}`;
  document.head.append(style);
  return style;
}

function mountRow(ports: PreviewPorts): {
  box: HTMLElement;
  article: HTMLElement;
  canvas: HTMLCanvasElement;
  note: HTMLElement;
  dispose: () => void;
} {
  const root = document.createElement("div");
  document.body.append(root);
  const mounter = createPreviewMounter(ports);
  const actions: LibraryActions = {
    reclaim() {},
    setBudget() {},
    edit() {},
    restore() {},
    backToRecording() {},
    remove() {},
    preview: mounter.mount,
    filter() {},
    rename() {},
    openReview() {},
  };
  // The clock the sections are measured from, beside the fixture's own
  // date: a take from a past month renders inside a folded section, where
  // no pointer reaches it and nothing of it is painted, and this test is
  // about the thumbnail, not the fold.
  renderLibrary(
    root,
    model,
    actions,
    new Map(),
    undefined,
    new Date(FIXTURE_MADE),
  );
  const box = root.querySelector("[data-preview]") as HTMLElement;
  return {
    box,
    article: root.querySelector("article") as HTMLElement,
    canvas: box.querySelector("[data-preview-canvas]") as HTMLCanvasElement,
    note: box.querySelector("[data-preview-note]") as HTMLElement,
    dispose: () => {
      mounter.dispose();
      root.remove();
    },
  };
}

describe("library preview painting", () => {
  it("rests on the take's first keyframe until something asks it to move", async () => {
    const images = await Promise.all(COLORS.map((c) => solid(c.css)));
    // Assert the fixture: if these three ever stopped being three different
    // colours, every pixel assertion below would go green against a preview
    // that never changed.
    const fixture = await Promise.all(images.map(bitmapPixel));
    expect(fixture).toEqual(COLORS.map((c) => [...c.rgb]));

    const { canvas, dispose } = mountRow({
      bundle: async () => bundle,
      image: imageFor,
      whenVisible: visibleNow,
      length: noLength,
    });

    await expect.poll(() => centerPixel(canvas)).toEqual([...COLORS[0].rgb]);
    expect(canvas.hidden).toBe(false);
    dispose();
  });

  it("plays when the pointer enters the card, not only the thumbnail", async () => {
    const { article, canvas, dispose } = mountRow({
      bundle: async () => bundle,
      image: imageFor,
      whenVisible: visibleNow,
      length: noLength,
    });
    await expect.poll(() => centerPixel(canvas)).toEqual([...COLORS[0].rgb]);

    // The whole row is the target: an author reaching for Edit has already
    // said they are interested in this demo, and they should not have to
    // find the thumbnail to see it move.
    article.dispatchEvent(new MouseEvent("mouseenter"));
    await expect.poll(() => centerPixel(canvas)).toEqual([...COLORS[1].rgb]);

    article.dispatchEvent(new MouseEvent("mouseleave"));
    await expect.poll(() => centerPixel(canvas)).toEqual([...COLORS[0].rgb]);
    dispose();
  });

  it("draws the keyframe at its own aspect ratio rather than stretching it", async () => {
    const { canvas, dispose } = mountRow({
      bundle: async () => bundle,
      image: imageFor,
      whenVisible: visibleNow,
      length: noLength,
    });
    // Poll on the paint, not on `canvas.width` — a canvas starts life 300
    // wide, so waiting for a nonzero width would wait for nothing.
    await expect.poll(() => centerPixel(canvas)).toEqual([...COLORS[0].rgb]);
    expect(canvas.width / canvas.height).toBeCloseTo(
      KEYFRAME_WIDTH / KEYFRAME_HEIGHT,
      2,
    );
    dispose();
  });

  it("advances under a real pointer, not only a dispatched event", async () => {
    const style = injectPageStyle();
    const { box, canvas, dispose } = mountRow({
      bundle: async () => bundle,
      image: imageFor,
      whenVisible: visibleNow,
      length: noLength,
    });
    await expect.poll(() => centerPixel(canvas)).toEqual([...COLORS[0].rgb]);

    // A Playwright-driven pointer, not `new MouseEvent("mouseenter")`: the
    // synthetic event names the listener it wants and so can pass against a
    // box no real pointer can reach.
    await userEvent.hover(box);
    await expect.poll(() => centerPixel(canvas)).toEqual([...COLORS[1].rgb]);
    // Park the pointer again before leaving. A real pointer left resting
    // here makes Chrome fire `mouseenter` at whatever the next test mounts
    // under it — the hazard CLAUDE.md records at `2f8dfd3`.
    await userEvent.unhover(box);
    dispose();
    style.remove();
  });

  it("shows a one-frame take's only frame, under the pointer and off it", async () => {
    const { article, canvas, dispose } = mountRow({
      bundle: async () => ({ keyframes: bundle.keyframes.slice(0, 1) }),
      image: imageFor,
      whenVisible: visibleNow,
      length: noLength,
    });
    await expect.poll(() => centerPixel(canvas)).toEqual([...COLORS[0].rgb]);
    article.dispatchEvent(new MouseEvent("mouseenter"));
    // There is no second frame to reach, so this asserts the flipbook does
    // not run off the end or blank the canvas — not that a timer was
    // withheld, which would look identical either way.
    await expect.poll(() => centerPixel(canvas)).toEqual([...COLORS[0].rgb]);
    expect(canvas.hidden).toBe(false);
    dispose();
  });

  it("says a failed read failed, rather than showing an empty box", async () => {
    const { canvas, note, dispose } = mountRow({
      bundle: async () => {
        throw new Error("frames db closed");
      },
      image: async () => {
        throw new Error("never reached");
      },
      whenVisible: visibleNow,
      length: noLength,
    });
    await expect
      .poll(() => note.textContent)
      .toContain("Preview unavailable — frames db closed");
    expect(canvas.hidden).toBe(true);
    dispose();
  });

  it("says a demo with no stored frames has none, distinctly from a failure", async () => {
    const { note, dispose } = mountRow({
      bundle: async () => null,
      image: async () => {
        throw new Error("never reached");
      },
      whenVisible: visibleNow,
      length: noLength,
    });
    await expect
      .poll(() => note.textContent)
      .toBe("No frames stored — nothing to preview.");
    dispose();
  });
});

describe("library preview duration badge", () => {
  const badgeOf = (box: HTMLElement) =>
    box.querySelector("[data-duration]") as HTMLElement;

  // The production change that reddens it: never calling `measure`, or
  // writing the raw milliseconds.
  it("puts the export's length on the thumbnail once it has the frames", async () => {
    const asked: unknown[] = [];
    const { box, canvas, dispose } = mountRow({
      bundle: async () => bundle,
      image: imageFor,
      whenVisible: visibleNow,
      length: async (sceneId, served) => {
        asked.push(sceneId, served);
        return { kind: "measured", ms: 84_000 };
      },
    });
    await expect.poll(() => badgeOf(box).textContent).toBe("1:24");
    expect(badgeOf(box).hidden).toBe(false);
    // Handed the bundle the preview read, not left to read its own.
    expect(asked[1]).toBe(bundle);
    // After the picture, not instead of it.
    expect(canvas.hidden).toBe(false);
    dispose();
  });

  it("shows no length on a take with nothing left to render, and says why at info", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { box, dispose } = mountRow({
      bundle: async () => bundle,
      image: imageFor,
      whenVisible: visibleNow,
      length: async () => ({ kind: "nothing", reason: "every step is cut" }),
    });
    await expect
      .poll(() => info.mock.calls.map((c) => String(c[0])).join("\n"))
      .toContain("every step is cut");
    expect(badgeOf(box).hidden).toBe(true);
    expect(badgeOf(box).textContent).toBe("");
    info.mockRestore();
    dispose();
  });

  it("shows no length when it cannot be worked out, and says so at warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { box, canvas, dispose } = mountRow({
      bundle: async () => bundle,
      image: imageFor,
      whenVisible: visibleNow,
      length: async () => {
        throw new Error("plan refused");
      },
    });
    await expect.poll(() => warn.mock.calls.length).toBeGreaterThan(0);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not work out/);
    expect(warn.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(badgeOf(box).hidden).toBe(true);
    // The picture is unaffected: a length is decoration on it.
    await expect.poll(() => centerPixel(canvas)).toEqual([...COLORS[0].rgb]);
    warn.mockRestore();
    dispose();
  });
});
