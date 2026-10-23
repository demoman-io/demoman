import { LANDSCAPE_1080P, LANDSCAPE_1440P } from "@demoman/compositor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_SHOWN,
  patchExportProgress,
  renderExport,
  renderExportHistory,
} from "../../../pages/entrypoints/editor/view";
import { RECLAIMED_SPAN_REASON } from "../../../pages/src/editor/jobs";
import { createSections } from "../../../pages/src/editor/sections";
import { runsHref, runsRouteLabel } from "../../../pages/src/shell/runs-link";

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  // A fresh `Sections` per test. It is deliberately stateful — a section
  // the author opens stays open across renders — so one shared across the
  // whole file would carry the Share section's forced-open state out of the
  // single test that forces it and into every test that ran after it.
  idle.sections = createSections();
});

const handlers = {
  onExport: vi.fn(),
  onFileType: vi.fn(),
  onDownload: vi.fn(),
  onSaveAgain: vi.fn(),
  onReveal: vi.fn(),
};
const idle = {
  outputs: [],
  fileType: "mp4" as const,
  aspect: "16:9" as const,
  target: LANDSCAPE_1440P,
  recording: { width: 1512, height: 820 },
  durationMs: 24_400,
  run: { phase: "idle" as const },
  save: null,
  readiness: { kind: "exact" as const },
  runsRoute: {
    takeId: "take 1&x",
    authored: false,
    rerun: {
      kind: "link" as const,
      href: runsHref("take 1&x"),
      label: runsRouteLabel(false),
    },
  },
  replacementExposures: [],
  currentDigest: "d-now",
  sections: createSections(),
  beatAt: () => "Checkout",
  hasReclaimedMotion: false,
  // Forcing a section open over the author's stored preference is
  // `main.ts`'s call — it is the only thing that can see what the previous
  // render already showed — so the default here is "do not force", and the
  // cases below that are about forcing pass it explicitly.
};

/** The take's export history, as Take info draws it: this panel's Recent
 *  exports list until 2026-10-19. */
const drawHistory = (
  into: HTMLElement,
  state: Omit<
    Parameters<typeof renderExportHistory>[1],
    "showAll" | "warningsOpen" | "reportContext"
  > &
    Partial<Parameters<typeof renderExportHistory>[1]>,
  h: typeof handlers & { onWarnings?: (key: string) => void },
): void =>
  renderExportHistory(
    into,
    { warningsOpen: new Set(), reportContext: idle, ...state, showAll: false },
    { onWarnings: vi.fn(), ...h, onShowAll: vi.fn() },
  );

/** A save of these stored outputs, as `aggregateSaves` reports one. */
const savedOf = (...refs: string[]) => ({
  kind: "saved" as const,
  names: refs.map((ref) => `${ref}.mp4`),
  byteLength: 1024,
  reveal: null,
  summary: null,
  outputRefs: refs,
});

/** The panel after this page saved its newest export: that output's
 *  warnings under the outcome row. */
const drawLatest = (
  into: HTMLElement,
  state: Parameters<typeof renderExport>[1],
  h: typeof handlers,
): void => {
  const newest = state.outputs[0];
  if (newest?.kind !== "stored") throw new Error("no stored output to save");
  renderExport(into, { ...state, save: savedOf(newest.output.ref) }, h);
};

const oneOutput = {
  ref: "r1",
  name: "landscape.mp4",
  byteLength: 1024,
  contentType: "video/mp4",
  detailViolations: [],
  renderedAt: "2026-08-25T00:00:00.000Z",
};

describe("renderExport", () => {
  it("sums up the file and names the type on the button", () => {
    renderExport(root, idle, handlers);
    expect(root.querySelector("[data-export-summary]")?.textContent).toBe(
      "MP4 · 0:24",
    );
    expect(root.querySelector("[data-aspect-note]")?.textContent).toBe(
      "16:9, set under the preview",
    );
    expect(root.querySelector("[data-export-start]")?.textContent).toBe(
      "Export MP4",
    );
    (root.querySelector("[data-export-start]") as HTMLButtonElement).click();
    expect(handlers.onExport).toHaveBeenCalledTimes(1);
  });

  it("picks the file type from three segments", () => {
    renderExport(root, { ...idle, fileType: "gif" }, handlers);
    const buttons = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-file-type]"),
    ];
    expect(
      buttons.map((b) => [
        b.dataset.fileType,
        b.textContent,
        b.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["mp4", "MP4", "false"],
      ["gif", "GIF", "true"],
      ["stills", "PNG stills", "false"],
    ]);
    buttons[2]?.click();
    expect(handlers.onFileType).toHaveBeenCalledWith("stills");
  });

  it("shows real progress while encoding, and locks the file type", () => {
    renderExport(
      root,
      { ...idle, run: { phase: "encoding", done: 248, total: 576 } },
      handlers,
    );
    const start = root.querySelector<HTMLButtonElement>("[data-export-start]");
    expect(start?.textContent).toBe("Exporting · 43%");
    expect(start?.disabled).toBe(true);
    const bar = root.querySelector<HTMLProgressElement>(
      "[data-export-progress]",
    );
    expect([bar?.value, bar?.max]).toEqual([248, 576]);
    expect(
      [...root.querySelectorAll<HTMLButtonElement>("[data-file-type]")].every(
        (b) => b.disabled,
      ),
    ).toBe(true);
  });

  it("moves progress without rebuilding the panel", () => {
    // Per-frame progress arrives at whole percents, so a hundred-odd times
    // per export. Driving `render` from there rebuilt the whole inspector
    // that many times — and a render takes the Cursor panel's
    // `<input type="range">` with it, killing a drag mid-gesture with no
    // `change` to follow (see `render`'s own comment in main.ts).
    //
    // The load-bearing assertion is NODE IDENTITY: the button and bar the
    // author is looking at have to be the same objects afterwards. A test
    // that only read the label would pass against a full re-render.
    renderExport(
      root,
      { ...idle, run: { phase: "encoding", done: 0, total: 0 } },
      handlers,
    );
    const start = root.querySelector<HTMLButtonElement>("[data-export-start]");
    // The premise, asserted: this render draws NO bar, `total` being 0. So
    // the patch below is also the case where the bar first appears.
    expect(start?.textContent).toBe("Exporting…");
    expect(root.querySelector("[data-export-progress]")).toBeNull();

    expect(
      patchExportProgress(
        root,
        { phase: "encoding", done: 248, total: 576 },
        "mp4",
        { kind: "exact" },
      ),
    ).toBe(true);
    expect(root.querySelector("[data-export-start]")).toBe(start);
    expect(start?.textContent).toBe("Exporting · 43%");
    const bar = root.querySelector<HTMLProgressElement>(
      "[data-export-progress]",
    );
    expect([bar?.value, bar?.max]).toEqual([248, 576]);
    // Where `renderExport` puts it: straight after the button's row, not
    // appended to whatever happened to be last.
    expect(
      bar?.previousElementSibling?.querySelector("[data-export-start]"),
    ).toBe(start);

    expect(
      patchExportProgress(
        root,
        { phase: "encoding", done: 512, total: 576 },
        "mp4",
        { kind: "exact" },
      ),
    ).toBe(true);
    expect(root.querySelector("[data-export-progress]")).toBe(bar);
    expect(bar?.value).toBe(512);
    expect(start?.disabled).toBe(true);
  });

  it("takes the bar away when the encode is over", () => {
    renderExport(
      root,
      { ...idle, run: { phase: "encoding", done: 248, total: 576 } },
      handlers,
    );
    expect(root.querySelector("[data-export-progress]")).not.toBeNull();
    expect(
      patchExportProgress(root, { phase: "saving" }, "mp4", { kind: "exact" }),
    ).toBe(true);
    // `renderExport` draws no bar while saving, so neither may the patch
    // leave one behind at whatever fraction the encode stopped at.
    expect(root.querySelector("[data-export-progress]")).toBeNull();
    expect(
      root.querySelector<HTMLButtonElement>("[data-export-start]")?.textContent,
    ).toBe("Saving…");
  });

  it("says so rather than going quiet when there is no button to patch", () => {
    // Report before you forgive: the caller reaches here with the Export
    // panel's own container in hand, so a missing button is a panel that
    // rendered without its control — not a closed panel. Returning true
    // would leave a bar that never moves and nothing saying why.
    const empty = document.createElement("div");
    expect(
      patchExportProgress(
        empty,
        { phase: "encoding", done: 1, total: 2 },
        "mp4",
        { kind: "exact" },
      ),
    ).toBe(false);
  });

  it("names the Runs route, with this take's id, when there are no frames", () => {
    renderExport(root, { ...idle, readiness: { kind: "noFrames" } }, handlers);
    const link = root.querySelector<HTMLAnchorElement>("[data-runs-route]");
    expect(link?.getAttribute("href")).toBe("run.html?take=take%201%26x");
    expect(root.textContent).toContain(
      "This take has no frames — re-shoot it in Runs",
    );
    const start = root.querySelector<HTMLButtonElement>("[data-export-start]");
    // Disabled WITH its reason beside it — never a disabled Export alone.
    expect(start?.disabled).toBe(true);
    // The plain label: nothing is rebuilt on the way out any more.
    expect(start?.textContent).toBe("Export MP4");
  });

  it("keeps a frameless take's Export disabled when progress is patched in place", () => {
    // `patchExportProgress` owns `disabled` between renders too, and it must
    // not hand an idle, frameless button back as pressable.
    renderExport(root, { ...idle, readiness: { kind: "noFrames" } }, handlers);
    expect(
      patchExportProgress(root, { phase: "idle" }, "mp4", {
        kind: "noFrames",
      }),
    ).toBe(true);
    const start = root.querySelector<HTMLButtonElement>("[data-export-start]");
    expect(start?.disabled).toBe(true);
  });

  it("offers no second export and no rebuild", () => {
    renderExport(root, { ...idle, readiness: { kind: "exact" } }, handlers);
    // Premise: the panel drew its button, so the absences below are about a
    // panel that rendered, not an empty root.
    expect(root.querySelector("[data-export-start]")?.textContent).toBe(
      "Export MP4",
    );
    expect(root.textContent).not.toMatch(/rebuild|as previewed/i);
    expect(
      root.querySelector("[data-rebuild-failure], [data-export-as-previewed]"),
    ).toBeNull();
    // A take with frames draws no no-frames line, and no route to Runs:
    // that is Take info's Re-film row now (pinned in the case below).
    expect(root.querySelector("[data-export-no-frames]")).toBeNull();
    expect(
      root.querySelector<HTMLButtonElement>("[data-export-start]")?.disabled,
    ).toBe(false);
  });
  // The author, 2026-10-19: the panel is for exporting, and the way to film
  // a take again is Take info's Re-film row. It was one quiet line here
  // (final review I3(b)). Red: draw it back under the button.
  it("draws no route to Runs under Export for a take with frames", () => {
    renderExport(root, { ...idle, readiness: { kind: "exact" } }, handlers);
    expect(root.querySelector("[data-export-start]")).not.toBeNull();
    expect(root.querySelector("[data-export-runs-route]")).toBeNull();
    expect(root.querySelector("[data-runs-route]")).toBeNull();
  });
  // Final review M1: Runs refuses to re-shoot a script-made take.
  it("names the script route for an authored take with no frames", () => {
    const authored = {
      takeId: "take 1&x",
      authored: true,
      rerun: {
        kind: "link" as const,
        href: runsHref("take 1&x"),
        label: runsRouteLabel(true),
      },
    };
    renderExport(
      root,
      { ...idle, readiness: { kind: "noFrames" }, runsRoute: authored },
      handlers,
    );
    const noFrames = root.querySelector("[data-export-no-frames]");
    expect(noFrames?.textContent).toBe(
      "This take has no frames — run its script again in Runs",
    );
    expect(noFrames?.textContent).not.toMatch(/re-shoot/i);
    expect(
      noFrames?.querySelector("a[data-runs-route]")?.getAttribute("href"),
    ).toBe("run.html?take=take%201%26x");
  });
  it("says what was saved, and offers the folder", () => {
    renderExport(
      root,
      {
        ...idle,
        save: {
          kind: "saved",
          names: ["Checkout flow.mp4"],
          byteLength: 13_002_342,
          reveal: { kind: "download", id: 7 },
          summary: null,
          outputRefs: [],
        },
      },
      handlers,
    );
    const row = root.querySelector('[data-save-outcome="saved"]');
    expect(row?.textContent).toContain("Saved Checkout flow.mp4 · 12.4 MB");
    (root.querySelector("[data-show-in-folder]") as HTMLButtonElement).click();
    expect(handlers.onReveal).toHaveBeenCalledWith({ kind: "download", id: 7 });
  });

  it("says a cancelled save was cancelled, and offers it again", () => {
    renderExport(
      root,
      {
        ...idle,
        save: { kind: "cancelled", refs: ["r1"], saved: 0, total: 1 },
      },
      handlers,
    );
    expect(
      root.querySelector('[data-save-outcome="cancelled"]')?.textContent,
    ).toContain("You cancelled the save.");
    (root.querySelector("[data-save-again]") as HTMLButtonElement).click();
    expect(handlers.onSaveAgain).toHaveBeenCalledWith(["r1"]);
  });

  it("says how much of a set saved before the author cancelled", () => {
    renderExport(
      root,
      {
        ...idle,
        save: { kind: "cancelled", refs: ["r2", "r3"], saved: 1, total: 3 },
      },
      handlers,
    );
    const row = root.querySelector('[data-save-outcome="cancelled"]');
    expect(row?.textContent).toContain("You cancelled the save.");
    expect(row?.textContent).toContain("Saved 1 of 3 files.");
  });

  it("says a failed save failed, how much of it saved, and why", () => {
    renderExport(
      root,
      {
        ...idle,
        save: {
          kind: "failed",
          error: "s/b.png: Chrome stopped the download: the disk is full.",
          refs: ["r2"],
          saved: 2,
          total: 3,
        },
      },
      handlers,
    );
    const row = root.querySelector('[data-save-outcome="failed"]');
    expect(row?.textContent).toContain(
      "Exported, but the browser didn't save it.",
    );
    expect(row?.textContent).toContain("Saved 2 of 3 files.");
    expect(row?.textContent).toContain("the disk is full");
    (root.querySelector("[data-save-again]") as HTMLButtonElement).click();
    expect(handlers.onSaveAgain).toHaveBeenCalledWith(["r2"]);
  });

  it("marks an export made before the last edit, and only that one", () => {
    const outputs = [
      { ...oneOutput, ref: "old", sceneDigest: "d-then" },
      { ...oneOutput, ref: "now", sceneDigest: "d-now" },
      { ...oneOutput, ref: "unknown" },
    ].map((output) => ({ kind: "stored" as const, output }));
    drawHistory(root, { ...idle, outputs }, handlers);
    expect(root.querySelector('[data-stale-export="old"]')?.textContent).toBe(
      "Outdated",
    );
    expect(root.querySelector('[data-stale-export="now"]')).toBeNull();
    // A row from before digests existed makes no claim either way.
    expect(root.querySelector('[data-stale-export="unknown"]')).toBeNull();
  });
  it("has no share surface at all (the Studio has no hosted service)", () => {
    renderExport(
      root,
      {
        ...idle,
        outputs: [{ kind: "stored" as const, output: oneOutput }],
      },
      handlers,
    );
    expect(root.querySelector('[data-section="share"]')).toBeNull();
    expect(root.querySelector("[data-share-target]")).toBeNull();
    expect(root.querySelector("[data-share]")).toBeNull();
  });

  // The author, 2026-10-19: the panel is for exporting. Red: draw the list
  // back into `renderExport`.
  it("keeps finished exports out of the panel; the history lists them, with Download only", () => {
    const state = {
      ...idle,
      outputs: [{ kind: "stored" as const, output: oneOutput }],
    };
    renderExport(root, state, handlers);
    // Premise: the panel drew, so the absences are about a drawn panel.
    expect(root.querySelector("[data-export-start]")).not.toBeNull();
    expect(root.querySelector('details[data-section="recent"]')).toBeNull();
    expect(root.querySelector("[data-download]")).toBeNull();
    drawHistory(root, state, handlers);
    expect(root.querySelector("[data-download='r1']")).not.toBeNull();
    expect(root.querySelector("[data-share]")).toBeNull();
  });

  it("lists the newest five, and says how many there are in all", () => {
    const outputs = ["a", "b", "c", "d", "e", "f", "g"].map((ref) => ({
      kind: "stored" as const,
      output: { ...oneOutput, ref },
    }));
    const onShowAll = vi.fn();
    renderExportHistory(
      root,
      {
        ...idle,
        outputs,
        showAll: false,
        warningsOpen: new Set(),
        reportContext: idle,
      },
      { ...handlers, onShowAll, onWarnings: vi.fn() },
    );
    const drawn = [...root.querySelectorAll("[data-download]")].map((b) =>
      b.getAttribute("data-download"),
    );
    expect(drawn).toEqual(["a", "b", "c", "d", "e"]);
    expect(drawn).toHaveLength(HISTORY_SHOWN);
    const all = root.querySelector<HTMLButtonElement>("[data-history-all]");
    expect(all?.textContent).toBe("Show all 7");
    all?.click();
    expect(onShowAll).toHaveBeenCalledTimes(1);
    renderExportHistory(
      root,
      {
        ...idle,
        outputs,
        showAll: true,
        warningsOpen: new Set(),
        reportContext: idle,
      },
      { ...handlers, onShowAll, onWarnings: vi.fn() },
    );
    expect(root.querySelectorAll("[data-download]")).toHaveLength(7);
    expect(root.querySelector("[data-history-all]")).toBeNull();
  });

  // The author, 2026-10-19: the history is for finding a file; a warning
  // is said when the export is made. Red: draw `drawOutputReports` in the
  // history again.
  it("repeats no warning in the history", () => {
    drawHistory(
      root,
      {
        ...idle,
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              logoWarning: "The logo was left out",
              unavailableSpans: [{ ref: "span-7", reason: "could not decode" }],
            },
          },
        ],
      },
      handlers,
    );
    // Premise: the row drew.
    expect(root.querySelector("[data-download='r1']")).not.toBeNull();
    expect(
      root.querySelector("[data-logo-warning], [data-unavailable], .notice"),
    ).toBeNull();
  });

  it("offers no Show all when every export is already listed", () => {
    const outputs = ["a", "b"].map((ref) => ({
      kind: "stored" as const,
      output: { ...oneOutput, ref },
    }));
    drawHistory(root, { ...idle, outputs }, handlers);
    // Premise: both rows drew.
    expect(root.querySelectorAll("[data-download]")).toHaveLength(2);
    expect(root.querySelector("[data-history-all]")).toBeNull();
  });

  it("offers a download per finished output", () => {
    drawHistory(
      root,
      { ...idle, outputs: [{ kind: "stored" as const, output: oneOutput }] },
      handlers,
    );
    expect(root.querySelector("button[data-download='r1']")).not.toBeNull();
  });

  it("says which motion an export could not decode, beside its output", () => {
    // A span the frame source could not serve was drawn as a still of the
    // preceding keyframe, which looks exactly like a page holding still.
    // The row is the only place the author can learn that the freeze in
    // the deliverable is a decode failure and not their page.
    drawLatest(
      root,
      {
        ...idle,
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              unavailableSpans: [{ ref: "span-7", reason: "could not decode" }],
            },
          },
        ],
      },
      handlers,
    );
    const notice = root.querySelector("[data-unavailable='r1']");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/could not be decoded/i);
    expect(notice?.textContent).toContain("span-7");
    expect(notice?.textContent).toContain("could not decode");
  });

  // FINDING 6 (whole-branch review). Every span in the list is a reclaimed
  // one, not a decode failure — the headline must say so instead of the
  // generic "could not be decoded" wording, which was accurate for the
  // ORIGINAL decode-failure case but reads as the wrong reason here, in
  // the one place the author actually reads it.
  // A stills export delivers one file per step, so a cut makes it deliver
  // FEWER than the take has steps. The reason lived on the offscreen
  // document's console first, which is a surface that does not exist by the
  // time anyone looks: `offscreen-host.ts` closes that document in a
  // `finally` as soon as its last job settles. It belongs on the row.
  it("says which steps got no still, beside the output that is short of them", () => {
    drawLatest(
      root,
      {
        ...idle,
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              unplacedStills: [
                { actionId: "act-2", reason: "the step is cut" },
                {
                  actionId: "act-3",
                  reason: "the video holds no frame of this step",
                },
              ],
            },
          },
        ],
      },
      handlers,
    );
    const notice = root.querySelector("[data-unplaced-stills='r1']");
    expect(notice).not.toBeNull();
    const said = notice?.textContent ?? "";
    // Both steps named, and each with its OWN reason: "you cut it" needs no
    // action and "the video holds no frame of it" might.
    expect(said).toContain("act-2");
    expect(said).toContain("act-3");
    expect(said).toContain("the step is cut");
    expect(said).toContain("the video holds no frame of this step");
    // A mixed list must not claim every one of them was the author's edit.
    expect(said).toMatch(/Some steps got no still/);
  });

  it("names the author's own cut when that is all it was", () => {
    drawLatest(
      root,
      {
        ...idle,
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              unplacedStills: [
                { actionId: "act-2", reason: "the step is cut" },
              ],
            },
          },
        ],
      },
      handlers,
    );
    const said =
      root.querySelector("[data-unplaced-stills='r1']")?.textContent ?? "";
    // Headline says it was the cut — nothing here is wrong, and the row
    // must not read as a fault. The mixed case above is what proves this
    // branch is not just the same sentence twice.
    expect(said).toMatch(/a step you cut/i);
    expect(said).not.toMatch(/Some steps got no still/);
  });

  it("draws no such notice for an output with every still in place", () => {
    // The positive control: without it, a notice that rendered
    // unconditionally would satisfy both cases above.
    drawLatest(
      root,
      { ...idle, outputs: [{ kind: "stored" as const, output: oneOutput }] },
      handlers,
    );
    expect(root.querySelector("[data-unplaced-stills='r1']")).toBeNull();
  });

  it("says motion was reclaimed, not that it could not be decoded, when every span is reclaimed", () => {
    drawLatest(
      root,
      {
        ...idle,
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              unavailableSpans: [
                { ref: "1000-2000ms", reason: RECLAIMED_SPAN_REASON },
              ],
            },
          },
        ],
      },
      handlers,
    );
    const notice = root.querySelector("[data-unavailable='r1']");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).not.toMatch(/could not be decoded/i);
    expect(notice?.textContent).toMatch(/reclaimed/i);
  });

  // The headline names the way back to frames, and for an authored take that
  // is its script: Runs refuses to re-shoot it. Goes red if the headline
  // stops reading `state.runsRoute.authored`.
  it("routes an authored take's reclaimed-motion headline through its script", () => {
    const withRoute = (authored: boolean) => {
      root = document.createElement("div");
      drawLatest(
        root,
        {
          ...idle,
          runsRoute: {
            takeId: "t1",
            authored,
            rerun: {
              kind: "link" as const,
              href: runsHref("t1"),
              label: runsRouteLabel(authored),
            },
          },
          outputs: [
            {
              kind: "stored" as const,
              output: {
                ...oneOutput,
                unavailableSpans: [
                  { ref: "1000-2000ms", reason: RECLAIMED_SPAN_REASON },
                ],
              },
            },
          ],
        },
        handlers,
      );
      return root.querySelector("[data-unavailable='r1'] strong")?.textContent;
    };
    expect(withRoute(true)).toBe(
      "Motion was reclaimed to free space and shown as a still. Run its script again in Runs to restore.",
    );
    expect(withRoute(false)).toBe(
      "Motion was reclaimed to free space and shown as a still. Re-shoot it in Runs to restore.",
    );
  });

  // A mix of a real decode failure and a reclaimed span must keep the
  // generic headline — it names a genuine decode failure that the
  // reclaimed-only wording would misreport just as badly in the other
  // direction.
  it("keeps the decode-failure headline when only SOME spans in the list are reclaimed", () => {
    drawLatest(
      root,
      {
        ...idle,
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              unavailableSpans: [
                { ref: "span-7", reason: "could not decode" },
                { ref: "1000-2000ms", reason: RECLAIMED_SPAN_REASON },
              ],
            },
          },
        ],
      },
      handlers,
    );
    const notice = root.querySelector("[data-unavailable='r1']");
    expect(notice?.textContent).toMatch(/could not be decoded/i);
  });

  it("warns before exporting when the bundle has a reclaimed range", () => {
    renderExport(root, { ...idle, hasReclaimedMotion: true }, handlers);
    const notice = root.querySelector("[data-reclaimed-motion-notice]");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toBe(
      "This export will use still frames where motion was reclaimed.",
    );
  });

  it("says nothing about reclaimed motion when the bundle has none", () => {
    renderExport(root, idle, handlers);
    expect(root.querySelector("[data-reclaimed-motion-notice]")).toBeNull();
  });

  it("reports detail violations beside their output, and keeps them there", () => {
    // SP6 returns these instead of silently upscaling. A toast would be a
    // slower way of swallowing them.
    drawLatest(
      root,
      {
        ...idle,
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              detailViolations: [
                {
                  outputTimeMs: 4200,
                  requestedScale: 1.8,
                  grantedScale: 1.31,
                  sourceWidth: 1280,
                  // Clamped exactly to the available detail: sampling 1.0, so
                  // this fixture is a cut zoom and NOT an under-sampled one.
                  // The heading below depends on that being true.
                  neededWidth: 1280,
                },
              ],
            },
          },
        ],
      },
      handlers,
    );
    const report = root.querySelector("[data-violations='r1']");
    expect(report).not.toBeNull();
    expect(report?.textContent).toMatch(/1\.8/);
    expect(report?.textContent).toMatch(/source frames/i);
    // The heading follows the list. This fixture is a cut zoom with no
    // under-sampling, so the reduction heading is the true one here — and
    // `violationReport`'s own tests cover the case where it is not.
    expect(report?.querySelector("strong")?.textContent).toMatch(/reduced/i);
  });

  it("says nothing about violations when there are none", () => {
    drawLatest(
      root,
      {
        ...idle,
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              name: "preview.gif",
              byteLength: 10,
              contentType: "image/gif",
            },
          },
        ],
      },
      handlers,
    );
    expect(root.querySelector("[data-violations='r1']")).toBeNull();
  });

  // The export just made: its warnings under the outcome row, where the
  // author is looking when it lands. The list they used to be forced open in
  // moved to Take info (the author, 2026-10-19). Red: drop the
  // `outputRefs` block from `renderExport`.
  it("draws the warnings of the export just made under its outcome row", () => {
    renderExport(
      root,
      {
        ...idle,
        save: savedOf("r1"),
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              detailViolations: [
                {
                  outputTimeMs: 4200,
                  requestedScale: 1.8,
                  grantedScale: 1.31,
                  sourceWidth: 1280,
                  neededWidth: 1280,
                },
              ],
            },
          },
        ],
      },
      handlers,
    );
    const outcome = root.querySelector("[data-save-outcome]");
    const report = root.querySelector("[data-violations='r1']");
    expect(outcome, "the outcome row drew").not.toBeNull();
    expect(report, "the report drew").not.toBeNull();
    // Beneath the outcome row, in the panel's own order.
    expect(
      (outcome as Node).compareDocumentPosition(report as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws an unavailable span of the export just made too", () => {
    drawLatest(
      root,
      {
        ...idle,
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              unavailableSpans: [{ ref: "span-7", reason: "could not decode" }],
            },
          },
        ],
      },
      handlers,
    );
    expect(root.querySelector("[data-unavailable='r1']")).not.toBeNull();
  });
  // The other half: without these the block above could draw every warned
  // export, which is the clutter the author asked to be rid of.
  it("draws no warning in the panel before this page has saved an export", () => {
    renderExport(
      root,
      {
        ...idle,
        save: null,
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              detailViolations: [
                {
                  outputTimeMs: 4200,
                  requestedScale: 1.8,
                  grantedScale: 1.31,
                  sourceWidth: 1280,
                  neededWidth: 1280,
                },
              ],
            },
          },
        ],
      },
      handlers,
    );
    expect(root.querySelector("[data-export-start]")).not.toBeNull();
    expect(root.querySelector("[data-violations]")).toBeNull();
  });

  // Review 2026-10-19: the block drew `outputs[0]`'s warnings whichever
  // save the outcome row described, so a Download of an older export from
  // Take info's history showed the newest file's warnings under it. Red:
  // draw the newest stored row's reports instead of the save's own refs.
  it("draws the warnings of the file the save describes, not the newest's", () => {
    const warned = {
      ...oneOutput,
      detailViolations: [
        {
          outputTimeMs: 4200,
          requestedScale: 1.8,
          grantedScale: 1.31,
          sourceWidth: 1280,
          neededWidth: 1280,
        },
      ],
    };
    // The newest export is the warned one; the save is of the older one.
    renderExport(
      root,
      {
        ...idle,
        save: savedOf("old"),
        outputs: [
          { kind: "stored" as const, output: { ...warned, ref: "new" } },
          { kind: "stored" as const, output: { ...oneOutput, ref: "old" } },
        ],
      },
      handlers,
    );
    expect(root.querySelector("[data-save-outcome]")).not.toBeNull();
    expect(root.querySelector("[data-violations]")).toBeNull();
    // And the other way round: the older export is the warned one, and its
    // warnings are said under its own save.
    renderExport(
      root,
      {
        ...idle,
        save: savedOf("old"),
        outputs: [
          { kind: "stored" as const, output: { ...oneOutput, ref: "new" } },
          { kind: "stored" as const, output: { ...warned, ref: "old" } },
        ],
      },
      handlers,
    );
    expect(root.querySelector("[data-violations='old']")).not.toBeNull();
    // Fixture guard: the warned row draws its notice when it is the save's.
    renderExport(
      root,
      {
        ...idle,
        save: savedOf("new"),
        outputs: [
          { kind: "stored" as const, output: { ...warned, ref: "new" } },
        ],
      },
      handlers,
    );
    expect(root.querySelector("[data-violations='new']")).not.toBeNull();
  });

  // The window between a `saved` event and the re-list that brings its row:
  // the save names a ref the list does not hold yet, and the panel draws no
  // other file's warnings meanwhile.
  it("draws nothing for a saved row the list does not hold yet", () => {
    renderExport(
      root,
      {
        ...idle,
        save: savedOf("just-made"),
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ...oneOutput,
              ref: "earlier",
              logoWarning: "The logo was left out: gone",
            },
          },
        ],
      },
      handlers,
    );
    expect(root.querySelector("[data-save-outcome]")).not.toBeNull();
    expect(root.querySelector("[data-logo-warning]")).toBeNull();
  });

  it("reads out the recording's size and the file's, for every shape", () => {
    renderExport(
      root,
      {
        ...idle,
        aspect: "auto",
        target: { ...LANDSCAPE_1080P, width: 1920, height: 1042 },
      },
      handlers,
    );
    expect(root.querySelector("[data-size-readout]")?.textContent).toBe(
      "Recording 1512 × 820 · Video 1920 × 1042",
    );
    // Review 2026-10-06: the summary repeated the file's size as
    // "1920×1042". Red if the panel names it twice.
    expect(root.textContent?.split("1042").length).toBe(2);
  });
});

describe("a history row's warnings chip", () => {
  // Review 2026-10-19: the history rows dropped every warning, so after a
  // reload — or for an export an agent made — nothing on any surface said
  // a file has no logo or frozen motion. The author's ruling: one chip on
  // the row, like Outdated, that unfolds them. Red: drop `warningsChip`
  // from `renderExportHistory`, or the unfolded block beneath the row.
  const warned = {
    ...oneOutput,
    logoWarning: "The logo was left out: gone",
    unavailableSpans: [{ ref: "span-7", reason: "could not decode" }],
  };

  it("counts what the export came with, and is absent on a clean row", () => {
    drawHistory(
      root,
      {
        ...idle,
        outputs: [
          { kind: "stored" as const, output: { ...warned, ref: "w" } },
          { kind: "stored" as const, output: { ...oneOutput, ref: "c" } },
        ],
      },
      handlers,
    );
    const chip = root.querySelector("[data-output-warnings='w']");
    expect(chip?.textContent).toBe("2 warnings");
    expect(chip?.getAttribute("aria-expanded")).toBe("false");
    // Folded: the notices themselves are not drawn.
    expect(root.querySelector("[data-logo-warning]")).toBeNull();
    // Fixture guard: the clean row is drawn, with no chip on it.
    expect(root.querySelector("[data-output='c']")).not.toBeNull();
    expect(root.querySelector("[data-output-warnings='c']")).toBeNull();
  });

  it("says the row's own key when pressed, and unfolds its notices when open", () => {
    const onWarnings = vi.fn();
    const outputs = [
      { kind: "stored" as const, output: { ...warned, ref: "w" } },
    ];
    drawHistory(root, { ...idle, outputs }, { ...handlers, onWarnings });
    root
      .querySelector<HTMLButtonElement>("[data-output-warnings='w']")
      ?.click();
    expect(onWarnings).toHaveBeenCalledWith("w");
    drawHistory(
      root,
      { ...idle, outputs, warningsOpen: new Set(["w"]) },
      handlers,
    );
    expect(
      root
        .querySelector("[data-output-warnings='w']")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    const body = root.querySelector("[data-output-warnings-body='w']");
    expect(body?.querySelector("[data-logo-warning='w']")?.textContent).toBe(
      "The logo was left out: gone",
    );
    expect(body?.querySelector("[data-unavailable='w']")).not.toBeNull();
  });
});

describe("an export that left the logo out", () => {
  // Spec §5: a logo that failed to load must not fail the export — it is
  // decoration — but the row has to say the file has no logo, or the author
  // ships a deliverable missing its brand mark with nothing on screen saying so.
  const warned = {
    ...oneOutput,
    logoWarning:
      'The logo was left out: the logo "logo:gone" is not in this browser\'s storage',
  };

  it("says so on the output's row", () => {
    drawLatest(
      root,
      { ...idle, outputs: [{ kind: "stored" as const, output: warned }] },
      handlers,
    );
    const notice = root.querySelector("[data-logo-warning='r1']");
    expect(notice?.textContent).toContain(
      'The logo was left out: the logo "logo:gone" is not in this browser\'s storage',
    );
  });

  it("is said under the outcome row when it is the export just made", () => {
    renderExport(
      root,
      {
        ...idle,
        save: savedOf("r1"),
        outputs: [{ kind: "stored" as const, output: warned }],
      },
      handlers,
    );
    expect(root.querySelector("[data-logo-warning='r1']")).not.toBeNull();
  });
});
