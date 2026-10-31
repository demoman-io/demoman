import { LANDSCAPE_1440P } from "@demoman/compositor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import {
  renderBundleBanner,
  renderExport,
  renderExportHistory,
  renderFailure,
  renderTransport,
  shortTime,
} from "../../../pages/entrypoints/editor/view";
import { exportButtonLabel } from "../../../pages/src/editor/export-run";
import { RECLAIMED_SPAN_REASON } from "../../../pages/src/editor/jobs";
import {
  buildLaneModel,
  MOTION_RECLAIMED_LABEL,
} from "../../../pages/src/editor/lanes";
import { createSections } from "../../../pages/src/editor/sections";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import type { OutputRow } from "../../../pages/src/platform/types";
import { rerunAdvice, rerunLineOf } from "../../../pages/src/shell/runs-link";

/**
 * The export panel drawing what the studio answers: a queued export, a
 * saved outcome with a reveal target and a summary, file rows from
 * `outputs.json`, and the re-film line in place of the Runs links. Chrome
 * side only; nothing here reaches the studio.
 *
 * Production changes that redden these, each made and watched go red:
 * - drawFileRow always drawing the Show in Finder button: "moved or deleted"
 *   and its no-`data-reveal` assertions fail.
 * - runsRouteLink ignoring `rerun.kind === "line"`: the re-film cases find
 *   an `a[data-runs-route]` and no `[data-rerun-line]`. (The Export
 *   button's own line moved to Take info on 2026-10-19: take-info.test.ts.)
 * - exportButtonLabel's `queued` case returning "Queued…" for any position:
 *   "Queued (2 ahead)" fails.
 */

const REFILM = 'Ask your agent to film it again: `run({ flow: { id: "v1" } })`';
const line = { kind: "line" as const, text: REFILM };
/** What a reader sees: the words, the span's backticks gone (ruling R20). */
const REFILM_WORDS = REFILM.replaceAll("`", "");
const REFILM_CODE = 'run({ flow: { id: "v1" } })';
/** The drawn line: no literal backtick, and the call is a `code` element. */
const expectDrawnLine = (node: Element | null | undefined): void => {
  expect(node, "the line was drawn").toBeTruthy();
  expect(node?.textContent).toBe(REFILM_WORDS);
  expect(node?.textContent).not.toContain("`");
  const codes = [...(node?.querySelectorAll("code") ?? [])];
  expect(codes.map((c) => c.textContent)).toEqual([REFILM_CODE]);
};

const handlers = {
  onExport: vi.fn(),
  onFileType: vi.fn(),
  onRetry: vi.fn(),
  onQuality: vi.fn(),
  onDownload: vi.fn(),
  onSaveAgain: vi.fn(),
  onReveal: vi.fn(),
  onShare: vi.fn(),
  onConfirm: vi.fn(),
  onCopy: vi.fn(),
  onTargetChange: vi.fn(),
};

const base = {
  outputs: [] as OutputRow[],
  fileTypes: ["mp4" as const],
  files: [],
  aspect: "16:9" as const,
  targets: {
    mp4: LANDSCAPE_1440P,
    gif: LANDSCAPE_1440P,
    stills: LANDSCAPE_1440P,
  },
  recording: { width: 1512, height: 820 },
  durationMs: 24_400,
  run: { phase: "idle" as const },
  save: null,
  readiness: { kind: "exact" as const },
  runsRoute: {
    takeId: "t1",
    authored: false,
    rerun: {
      kind: "link" as const,
      href: "run.html?take=t1",
      label: "Re-shoot this video in Runs",
    },
  },
  replacementExposures: [],
  currentDigest: "d-now",
  hosting: false,
  sections: createSections(),
  beatAt: () => null,
  share: {
    phase: "idle" as const,
    hosted: null,
    blocking: [],
    advisory: [],
    posterFailed: false,
    telemetryDropped: false,
    error: null,
    ref: null,
  },
  hostedDemos: [],
  hostedDemosListed: true,
  shareTarget: undefined,
  hasReclaimedMotion: false,
  forceShareOpen: false,
};

const file = (over: Partial<Extract<OutputRow, { kind: "file" }>> = {}) =>
  ({
    kind: "file" as const,
    key: "k1",
    name: "demo.mp4",
    byteLength: 2 * 1024 * 1024,
    path: "/Users/me/Movies/demo.mp4",
    exists: true,
    sceneDigest: "d-now",
    renderedAt: "2026-10-19T14:14:00.000Z",
    detail: "1920×1080 · 30 fps",
    caveats: [],
    ...over,
  }) satisfies OutputRow;

/** The take's export history, as Take info draws it (the export panel's
 *  Recent exports until 2026-10-19). */
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
    { warningsOpen: new Set(), reportContext: base, ...state, showAll: false },
    { onWarnings: vi.fn(), ...h, onShowAll: vi.fn() },
  );

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  base.sections = createSections();
  for (const fn of Object.values(handlers)) fn.mockClear();
});

describe("a file row from outputs.json", () => {
  it("says moved or deleted, and offers no reveal, when the file is gone", () => {
    drawHistory(
      root,
      { ...base, outputs: [file({ exists: false })] },
      handlers,
    );
    // Premise: the row drew at all.
    expect(root.querySelector(".output-name")?.textContent).toBe("demo.mp4");
    expect(root.querySelector("[data-output-gone]")?.textContent).toBe(
      "moved or deleted",
    );
    expect(root.querySelector("[data-reveal]")).toBeNull();
    expect(root.querySelector("[data-download]")).toBeNull();
  });

  it("offers Show in Finder for a file that is there, with its path", () => {
    drawHistory(root, { ...base, outputs: [file()] }, handlers);
    const reveal = root.querySelector<HTMLButtonElement>("[data-reveal]");
    expect(reveal?.textContent).toBe("Show in Finder");
    expect(root.querySelector("[data-output-gone]")).toBeNull();
    expect(root.querySelector("[data-download]")).toBeNull();
    reveal?.click();
    expect(handlers.onReveal).toHaveBeenCalledWith({
      kind: "path",
      path: "/Users/me/Movies/demo.mp4",
    });
  });

  // The author, 2026-10-19: the row said the studio's whole sentence, path
  // and all, and "made before your last edit" on a line of its own. Red:
  // draw the sentence back, or the stale line.
  it("says its size and time on one line, and Outdated as a chip", () => {
    drawHistory(
      root,
      {
        ...base,
        outputs: [
          file({ key: "old", sceneDigest: "d-then" }),
          file({ key: "now", sceneDigest: "d-now" }),
        ],
      },
      handlers,
    );
    const meta = root.querySelector<HTMLElement>('[data-output-meta="old"]');
    expect(meta?.textContent).toBe(
      `2 MB · ${shortTime("2026-10-19T14:14:00.000Z")}`,
    );
    // The frame and rate on hover, not on the line (the author: too dense).
    expect(meta?.title).toBe("1920×1080 · 30 fps");
    // Each export its own block, so a hairline can sit between them.
    expect(root.querySelectorAll(".output")).toHaveLength(2);
    expect(
      root
        .querySelector('[data-stale-export="old"]')
        ?.closest(".output")
        ?.getAttribute("data-output"),
    ).toBe("old");
    const chip = root.querySelector<HTMLElement>('[data-stale-export="old"]');
    expect(chip?.textContent).toBe("Outdated");
    expect(chip?.title).toBe("Made before your last edit");
    // On the name's line, not a line of its own.
    expect(chip?.closest(".beat")?.textContent).toContain("demo.mp4");
    expect(root.querySelector('[data-stale-export="now"]')).toBeNull();
    expect(root.textContent).not.toContain("/Users/me/Movies");
  });

  // Review 2026-10-19: the studio's rows dropped the summary and with it
  // every warning, so an export an agent made, or one made before a reload,
  // said nothing on any surface about a missing logo or frozen motion. Red:
  // drop the chip or its unfolded caveats from `drawFileRow`.
  it("carries what the export came with behind a chip, one line each", () => {
    const onWarnings = vi.fn();
    const caveats = [
      "the logo is missing (not found)",
      "2 stretches of motion are stills",
    ];
    const outputs = [
      file({ key: "w", caveats }),
      file({ key: "c", caveats: [] }),
    ];
    drawHistory(root, { ...base, outputs }, { ...handlers, onWarnings });
    const chip = root.querySelector<HTMLButtonElement>(
      '[data-output-warnings="w"]',
    );
    expect(chip?.textContent).toBe("2 warnings");
    expect(root.querySelector('[data-output-warnings-body="w"]')).toBeNull();
    // Fixture guard: the clean row drew, with no chip.
    expect(root.querySelector('[data-output="c"]')).not.toBeNull();
    expect(root.querySelector('[data-output-warnings="c"]')).toBeNull();
    chip?.click();
    expect(onWarnings).toHaveBeenCalledWith("w");
    drawHistory(
      root,
      { ...base, outputs, warningsOpen: new Set(["w"]) },
      handlers,
    );
    const lines = [
      ...(root.querySelector('[data-output-warnings-body="w"]')?.children ??
        []),
    ].map((n) => n.textContent);
    expect(lines).toEqual([
      "The logo is missing (not found).",
      "2 stretches of motion are stills.",
    ]);
  });

  it("shows a stamp it cannot read as stored", () => {
    expect(shortTime("not a time")).toBe("not a time");
  });

  // Review 2026-10-19: the stamp dropped the year, as the library's does
  // under a heading that says it; nothing in Take info says it, so last
  // October's export read like this one's. Red: drop the year from
  // `shortTime`, or put it on every stamp.
  it("says the year of a stamp from another year, and only then", () => {
    const now = new Date("2026-10-19T12:00:00.000Z");
    expect(shortTime("2025-10-19T14:14:00.000Z", now)).toMatch(/2025/);
    expect(shortTime("2026-03-02T14:14:00.000Z", now)).not.toMatch(/2026/);
  });
});

describe("a saved outcome", () => {
  const saved = {
    kind: "saved" as const,
    names: ["demo.mp4"],
    byteLength: 2 * 1024 * 1024,
    reveal: { kind: "path" as const, path: "/Users/me/Movies/demo.mp4" },
    outputRefs: [],
  };

  it("shows the Studio's summary sentence under Saved", () => {
    renderExport(
      root,
      { ...base, save: { ...saved, summary: "Made at 1080p; one zoom." } },
      handlers,
    );
    const row = root.querySelector('[data-save-outcome="saved"]');
    expect(row?.textContent).toContain("Saved demo.mp4 · 2 MB");
    expect(row?.querySelector(".muted")?.textContent).toBe(
      "Made at 1080p; one zoom.",
    );
    root.querySelector<HTMLButtonElement>("[data-show-in-folder]")?.click();
    expect(handlers.onReveal).toHaveBeenCalledWith(saved.reveal);
  });

  // R20: a path is revealed in Finder, a download keeps the extension's
  // "folder". Red: draw "Show in folder" for both again.
  it("reads Show in Finder for a path reveal, Show in folder for a download", () => {
    renderExport(
      root,
      { ...base, save: { ...saved, summary: null } },
      handlers,
    );
    expect(root.querySelector("[data-show-in-folder]")?.textContent).toBe(
      "Show in Finder",
    );
    renderExport(
      root,
      {
        ...base,
        save: { ...saved, reveal: { kind: "download", id: 7 }, summary: null },
      },
      handlers,
    );
    expect(root.querySelector("[data-show-in-folder]")?.textContent).toBe(
      "Show in folder",
    );
  });

  it("draws no summary line and no folder button when there is neither", () => {
    renderExport(
      root,
      { ...base, save: { ...saved, reveal: null, summary: null } },
      handlers,
    );
    const row = root.querySelector('[data-save-outcome="saved"]');
    expect(row?.textContent).toContain("Saved demo.mp4");
    expect(row?.querySelector(".muted")).toBeNull();
    expect(row?.querySelector("[data-show-in-folder]")).toBeNull();
  });
});

describe("the re-film line", () => {
  // The author, 2026-10-19: the line moved to Take info's Re-film row
  // (take-info.test.ts). Red: draw it back under the button.
  it("draws no re-film line under the Export button", () => {
    renderExport(
      root,
      { ...base, runsRoute: { takeId: "t1", authored: false, rerun: line } },
      handlers,
    );
    expect(root.querySelector("[data-export-start]")).not.toBeNull();
    expect(root.querySelector("[data-rerun-line]")).toBeNull();
    expect(root.querySelector("a[data-runs-route]")).toBeNull();
  });
  it("replaces the no-frames route in the banner and under the button", () => {
    const route = { takeId: "t1", authored: false, rerun: line };
    renderBundleBanner(root, { hasFrames: false, route });
    expectDrawnLine(root.querySelector("[data-rerun-line]"));
    expect(root.textContent).toContain("This video has no frames — ");
    expect(root.querySelector("a[data-runs-route]")).toBeNull();

    renderExport(
      root,
      { ...base, readiness: { kind: "noFrames" }, runsRoute: route },
      handlers,
    );
    expectDrawnLine(
      root.querySelector("[data-export-no-frames] [data-rerun-line]"),
    );
    expect(root.querySelector("a[data-runs-route]")).toBeNull();
  });

  it("replaces the link in the re-shoot failure box", () => {
    renderFailure(root, {
      error: null,
      replaySentence: "The page did not load.",
      captureSentence: null,
      renderError: null,
      previewError: null,
      hoverRemovalError: null,
      logoLoadError: null,
      takeNotice: null,
      runsRoute: { takeId: "t1", authored: false, rerun: line },
    } as Parameters<typeof renderFailure>[1]);
    expectDrawnLine(
      root.querySelector("[data-replay-runs-route] [data-rerun-line]"),
    );
    expect(root.querySelector("a[data-runs-route]")).toBeNull();
  });
});

describe("a queued export", () => {
  it("labels the button by how many are ahead", () => {
    const exact = { kind: "exact" as const };
    expect(
      exportButtonLabel({ phase: "queued", position: 0 }, ["mp4"], exact),
    ).toBe("Queued…");
    expect(
      exportButtonLabel({ phase: "queued", position: 2 }, ["mp4"], exact),
    ).toBe("Queued (2 ahead)");
  });

  it("holds the button disabled with that label", () => {
    renderExport(
      root,
      { ...base, run: { phase: "queued", position: 2 } },
      handlers,
    );
    const start = root.querySelector<HTMLButtonElement>("[data-export-start]");
    expect(start?.textContent).toBe("Queued (2 ahead)");
    expect(start?.disabled).toBe(true);
  });
});

describe("the other places that name Runs", () => {
  const link = {
    kind: "link" as const,
    href: "run.html?take=t1",
    label: "Re-shoot this video in Runs",
  };
  // Said under the outcome row of the export just made (the history does
  // not repeat warnings since 2026-10-19).
  const reclaimed = (rerun: typeof line | typeof link, authored: boolean) => {
    renderExport(
      root,
      {
        ...base,
        save: {
          kind: "saved",
          names: ["a.mp4"],
          byteLength: 1,
          reveal: null,
          summary: null,
          outputRefs: ["r1"],
        },
        runsRoute: { takeId: "t1", authored, rerun },
        outputs: [
          {
            kind: "stored",
            output: {
              ref: "r1",
              name: "a.mp4",
              byteLength: 1,
              contentType: "video/mp4",
              detailViolations: [],
              renderedAt: "2026-10-16T00:00:00.000Z",
              unavailableSpans: [
                { ref: "1000-2000ms", reason: RECLAIMED_SPAN_REASON },
              ],
            },
          },
        ],
      },
      handlers,
    );
    return root.querySelector("[data-unavailable='r1'] strong");
  };

  it("says the re-film line, whole, not a Runs page, in the reclaimed-motion headline", () => {
    const headline = reclaimed(line, true);
    const said = headline?.textContent;
    // Premise: the headline drew, as the reclaimed one.
    expect(said).toContain("Motion was reclaimed to free space");
    // Its own sentence, nothing spliced after the code span (R18), the
    // call drawn as code with no literal backtick (R20).
    expect(said).toBe(
      `Motion was reclaimed to free space and shown as a still. ${REFILM_WORDS}`,
    );
    expect(
      [...(headline?.querySelectorAll("code") ?? [])].map((c) => c.textContent),
    ).toEqual([REFILM_CODE]);
    expect(said).not.toMatch(/in Runs/);
  });

  it("keeps the Runs wording when the answer is a link", () => {
    expect(reclaimed(link, true)?.textContent).toContain(
      "Run its script again in Runs to restore.",
    );
    expect(reclaimed(link, false)?.textContent).toContain(
      "Re-shoot it in Runs to restore.",
    );
  });

  it("says the line whole, or the Runs words with the tail (the trim refusal's advice)", () => {
    // main.ts's trim refusal ends with this, tail "first".
    const advice = (route: Parameters<typeof rerunLineOf>[0]) =>
      rerunAdvice(route.authored, rerunLineOf(route), "first");
    expect(advice({ takeId: "t1", authored: false, rerun: line })).toBe(REFILM);
    expect(advice({ takeId: "t1", authored: true, rerun: link })).toBe(
      "Run its script again in Runs first.",
    );
    expect(advice({ takeId: "t1", authored: false, rerun: link })).toBe(
      "Re-shoot it in Runs first.",
    );
  });

  // R18 (b): the no-frames tooltips on Play, Jump to start and Zoom, and the
  // timeline's own notices, said "… in Runs" whatever the platform answered.
  // Red: drop `rerunLine` from `renderTransport`'s/`renderStageBar`'s
  // sentences, or from `buildLaneModel`'s `advise`.
  it("puts the line, not Runs, in the no-frames tooltips", () => {
    const transport = document.createElement("div");
    const handlersT = {
      onToggle: vi.fn(),
      onSkipToStart: vi.fn(),
      onLooping: vi.fn(),
      onShuttle: vi.fn(),
    };
    const state = {
      authored: false,
      rerunLine: REFILM,
      playing: false,
      enabled: false,
      rate: 1,
      looping: false,
    };
    renderTransport(transport, state, handlersT);
    const play = transport.querySelector<HTMLButtonElement>(
      "[data-transport-play]",
    );
    // Premise: the tooltip drew, as the no-frames one.
    expect(play?.title).toContain("nothing to play");
    expect(play?.title).toBe(
      `This video has no frames yet, so there is nothing to play. ${REFILM_WORDS}`,
    );
    // And the link side keeps today's words.
    renderTransport(transport, { ...state, rerunLine: null }, handlersT);
    expect(play?.title).toBe(
      "This video has no frames yet, so there is nothing to play. Re-shoot it in Runs first.",
    );
  });

  it("puts the line, not Runs, in the reclaimed-motion lane notice", () => {
    const scene = readonlyScene();
    const bundle = proceduralBundle({
      degradations: [
        {
          startMs: 0,
          endMs: 1,
          kind: "motionReclaimed",
          note: MOTION_RECLAIMED_LABEL,
        },
      ],
    });
    const view = buildTimelineView({ scene, bundle, resolved: null });
    const notices = (rerunLine: string | null) =>
      buildLaneModel({
        scene,
        view,
        bundle,
        resolved: null,
        hoverReport: null,
        rerunLine,
      }).notices;
    // Premise: the stored note is relabelled at read time at all.
    expect(notices(null)).toContain(
      "Motion reclaimed to free space. Re-shoot it in Runs to restore.",
    );
    expect(notices(REFILM)).toContain(
      `Motion reclaimed to free space. ${REFILM}`,
    );
    expect(notices(REFILM).join("\n")).not.toMatch(/in Runs/);
  });
});
