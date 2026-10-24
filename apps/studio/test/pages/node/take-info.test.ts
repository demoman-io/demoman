import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderTakeInfo,
  type TakeInfoState,
} from "../../../pages/entrypoints/editor/take-info";

/**
 * Take info, the popover off the header's length-and-size button (the
 * author, 2026-10-19): what the take is, its id with a copy, the
 * extension's link to Runs, and its exports.
 *
 * Production changes that redden these, each made and watched go red:
 * - a Re-film row drawn for the studio's line answer: its absence case
 *   finds one.
 * - the copy's rejection handler dropped: the refused-copy case finds no
 *   reason under the row.
 * - the Exports group drawn with no outputs: its absence case fails.
 */

const REFILM = 'run({ video: { id: "scene-1" } })';

const ROUTE = {
  takeId: "scene-1",
  authored: true,
  rerun: {
    kind: "line" as const,
    text: `Ask your agent to re-record this take — \`${REFILM}\``,
  },
};

const base = (): TakeInfoState => ({
  recordedAt: "2026-10-19T15:42:00.000Z",
  site: "https://northwind.example/checkout?step=2",
  durationMs: 9_400,
  steps: 14,
  recording: { width: 1280, height: 800 },
  target: { width: 1920, height: 1080 },
  aspect: "16:9",
  takeId: "scene-1",
  rerun: {
    kind: "line",
    text: `Ask your agent to re-record this take — \`${REFILM}\``,
  },
  revealError: null,
  history: {
    outputs: [],
    currentDigest: "d-now",
    showAll: false,
    warningsOpen: new Set(),
    reportContext: { beatAt: () => null, runsRoute: ROUTE },
  },
});

const handlers = {
  onCopy: vi.fn<(text: string) => Promise<void>>(),
  onDownload: vi.fn(),
  onReveal: vi.fn(),
  onShowAll: vi.fn(),
  onWarnings: vi.fn(),
};

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  for (const fn of Object.values(handlers)) fn.mockReset();
});

const rows = () =>
  [...root.querySelectorAll(".info-row")].map((r) => [
    r.querySelector(".info-key")?.textContent,
    r.querySelector(".info-value")?.textContent,
  ]);

describe("Take info", () => {
  it("lists what the take is: when, where, how long, at what size", () => {
    renderTakeInfo(root, base(), handlers);
    const facts = Object.fromEntries(rows());
    expect(facts.Site).toBe("northwind.example/checkout");
    expect(facts.Length).toBe("0:09 · 14 steps");
    expect(facts.Recording).toBe("1280 × 800");
    expect(facts.Video).toBe("1920 × 1080 · 16:9");
    // In the reader's locale; the day and the minute are in any of them.
    expect(facts.Recorded).toMatch(/19/);
    expect(facts.Recorded).toMatch(/42/);
  });

  it("says one step, and Auto for the recording's own shape", () => {
    renderTakeInfo(root, { ...base(), steps: 1, aspect: "auto" }, handlers);
    const facts = Object.fromEntries(rows());
    expect(facts.Length).toBe("0:09 · 1 step");
    expect(facts.Video).toBe("1920 × 1080 · Auto");
  });

  it("shows a site it cannot parse as recorded, not blank", () => {
    renderTakeInfo(root, { ...base(), site: "not a url" }, handlers);
    expect(Object.fromEntries(rows()).Site).toBe("not a url");
  });

  it("copies the take id, and says it did", async () => {
    handlers.onCopy.mockResolvedValue(undefined);
    renderTakeInfo(root, base(), handlers);
    const id = root.querySelector<HTMLButtonElement>('[data-copy="take ID"]');
    // Premise: the row drew, its value shown.
    expect(Object.fromEntries(rows())["Take ID"]).toBe("scene-1");
    id?.click();
    expect(handlers.onCopy.mock.calls).toEqual([["scene-1"]]);
    await vi.waitFor(() => {
      if (id?.getAttribute("aria-label") !== "Copied") {
        throw new Error(`not reported yet: ${id?.getAttribute("aria-label")}`);
      }
    });
    expect(id?.querySelector('svg[data-icon="check"]')).not.toBeNull();
  });

  // The author, 2026-10-19: how a studio take is filmed again is parked;
  // the row copied an agent call that read as plumbing. Red: draw a row
  // for the studio's line answer again.
  it("draws no Re-film row in the Studio", () => {
    renderTakeInfo(root, base(), handlers);
    // Premise: the id row drew, so the absence is in a drawn group.
    expect(Object.fromEntries(rows())["Take ID"]).toBe("scene-1");
    expect(Object.fromEntries(rows())["Re-record"]).toBeUndefined();
    expect(root.textContent).not.toContain("run(");
  });

  it("says why a copy the browser refused did not happen", async () => {
    handlers.onCopy.mockRejectedValue(new Error("Document is not focused."));
    renderTakeInfo(root, base(), handlers);
    const error = root.querySelector<HTMLElement>(
      '[data-copy-error="take ID"]',
    );
    // Premise: nothing is said before the press.
    expect(error?.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-copy="take ID"]')?.click();
    await vi.waitFor(() => {
      if (error?.hidden !== false) throw new Error("not said yet");
    });
    expect(error?.textContent).toBe("Couldn't copy: Document is not focused.");
    // And the button did not claim success.
    expect(
      root.querySelector('[data-copy="take ID"]')?.getAttribute("aria-label"),
    ).toBe("Copy take ID");
  });

  it("draws the extension's Runs link, not a copy, when the answer is a link", () => {
    renderTakeInfo(
      root,
      {
        ...base(),
        rerun: {
          kind: "link",
          href: "run.html?take=scene-1",
          label: "Re-shoot this take in Runs",
        },
      },
      handlers,
    );
    const link = root.querySelector<HTMLAnchorElement>("a[data-runs-route]");
    expect(link?.getAttribute("href")).toBe("run.html?take=scene-1");
    expect(link?.textContent).toBe("Re-shoot this take in Runs");
    expect(root.querySelector('[data-copy="re-film call"]')).toBeNull();
  });

  it("draws no Exports group before the take has any", () => {
    renderTakeInfo(root, base(), handlers);
    // Premise: the popover drew.
    expect(root.querySelector("[data-info-facts]")).not.toBeNull();
    expect(root.querySelector("[data-info-exports]")).toBeNull();
  });

  it("lists the take's exports, and a Show in Finder that showed nothing", () => {
    const state = base();
    state.revealError = "That file was moved or deleted.";
    state.history.outputs = [
      {
        kind: "file",
        key: "k1",
        name: "demo.mp4",
        byteLength: 2 * 1024 * 1024,
        path: "/Users/me/Movies/demo.mp4",
        exists: true,
        sceneDigest: "d-now",
        renderedAt: "2026-10-19T14:14:00.000Z",
        detail: "1920×1080 · 30 fps",
        caveats: [],
      },
    ];
    renderTakeInfo(root, state, handlers);
    const group = root.querySelector("[data-info-exports]");
    expect(group?.querySelector(".info-label")?.textContent).toBe("Exports");
    expect(group?.textContent).toContain("demo.mp4");
    expect(group?.querySelector("[data-reveal-error]")?.textContent).toBe(
      "That file was moved or deleted.",
    );
    group?.querySelector<HTMLButtonElement>("[data-reveal]")?.click();
    expect(handlers.onReveal).toHaveBeenCalledWith({
      kind: "path",
      path: "/Users/me/Movies/demo.mp4",
    });
  });
});
