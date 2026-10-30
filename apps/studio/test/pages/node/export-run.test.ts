import { describe, expect, it } from "vitest";
import {
  aggregateSaves,
  exportButtonLabel,
  formatBytes,
} from "../../../pages/src/editor/export-run";
import { exportLabel } from "../../../pages/src/editor/formats";

describe("exportButtonLabel", () => {
  const exact = { kind: "exact" } as const;

  it("names the file type at rest, then the phase", () => {
    expect(exportButtonLabel({ phase: "idle" }, ["gif"], exact)).toBe(
      "Export GIF",
    );
    // Before the first frame report there is no fraction to show, and "0%"
    // would claim a measurement that has not happened.
    expect(
      exportButtonLabel(
        { phase: "encoding", done: 0, total: 0 },
        ["mp4"],
        exact,
      ),
    ).toBe("Exporting…");
    expect(
      exportButtonLabel(
        { phase: "encoding", done: 248, total: 576 },
        ["mp4"],
        exact,
      ),
    ).toBe("Exporting · 43%");
    expect(exportButtonLabel({ phase: "saving" }, ["mp4"], exact)).toBe(
      "Saving…",
    );
  });

  // Red if a press of several stops saying which file is being made, or a
  // press of one starts saying it (its label is as it always was).
  it("names the file being made when a press makes several", () => {
    const run = { phase: "encoding", done: 248, total: 576 } as const;
    expect(exportButtonLabel(run, ["mp4", "gif"], exact, "gif")).toBe(
      "Exporting GIF · 43%",
    );
    expect(
      exportButtonLabel(
        { phase: "encoding", done: 0, total: 0 },
        ["mp4", "gif"],
        exact,
        "mp4",
      ),
    ).toBe("Exporting MP4…");
    expect(
      exportButtonLabel(
        { phase: "saving" },
        ["gif", "stills"],
        exact,
        "stills",
      ),
    ).toBe("Saving PNG stills…");
    expect(exportButtonLabel(run, ["gif"], exact)).toBe("Exporting · 43%");
  });

  it("exports plainly when nothing is approximated", () => {
    expect(exportButtonLabel({ phase: "idle" }, ["gif"], exact)).toBe(
      "Export GIF",
    );
  });

  it("keeps a frameless take on the plain label, for every file type", () => {
    // Nothing is rebuilt on the way out any more, so there is no second
    // label: the reason the button is disabled is said beside it, by the
    // panel, as the Runs route.
    for (const fileType of ["mp4", "gif", "stills"] as const) {
      expect(
        exportButtonLabel({ phase: "idle" }, [fileType], { kind: "noFrames" }),
      ).toBe(exportLabel([fileType]));
    }
  });

  it("never offers a rebuild, in any phase or readiness", () => {
    const readinesses = [exact, { kind: "noFrames" } as const];
    const runs = [
      { phase: "idle" } as const,
      { phase: "encoding", done: 0, total: 0 } as const,
      { phase: "encoding", done: 1, total: 2 } as const,
      { phase: "saving" } as const,
    ];
    const labels: string[] = [];
    for (const fileType of ["mp4", "gif", "stills"] as const)
      for (const readiness of readinesses)
        for (const run of runs)
          labels.push(exportButtonLabel(run, [fileType], readiness));
    // Premise: every combination produced a label to inspect.
    expect(labels).toHaveLength(3 * 2 * 4);
    expect(labels.filter((l) => /rebuild|previewed/i.test(l))).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("reads like a file size", () => {
    expect(formatBytes(900)).toBe("1 KB");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(formatBytes(12.4 * 1024 * 1024)).toBe("12.4 MB");
  });
});

describe("aggregateSaves", () => {
  const ok = (ref: string, savedAs: string, id: number) => ({
    ref,
    name: savedAs,
    byteLength: 1024,
    outcome: {
      kind: "saved" as const,
      downloadId: id,
      savedAs,
      path: `/D/${savedAs}`,
    },
  });

  it("names what was saved, under the names Chrome gave them", () => {
    expect(aggregateSaves([ok("r1", "Checkout flow (1).mp4", 7)])).toEqual({
      kind: "saved",
      names: ["Checkout flow (1).mp4"],
      byteLength: 1024,
      reveal: { kind: "download", id: 7 },
      summary: null,
      outputRefs: ["r1"],
    });
  });

  // The outcome row draws the warnings of the rows a save names, so a save
  // must name the ones it saved — every one, not the newest. Red: return
  // `outputRefs: []`, or the first ref alone.
  it("names every stored output the save is of", () => {
    const view = aggregateSaves([ok("r1", "a.png", 1), ok("r2", "b.png", 2)]);
    expect(view).toMatchObject({ kind: "saved", outputRefs: ["r1", "r2"] });
  });

  it("says how many of a set saved and which one did not", () => {
    // Review Focus 5.
    const view = aggregateSaves([
      ok("r1", "s/a.png", 1),
      {
        ref: "r2",
        name: "s/b.png",
        byteLength: 10,
        outcome: {
          kind: "failed",
          error: "Chrome stopped the download: the disk is full.",
        },
      },
      ok("r3", "s/c.png", 3),
    ]);
    expect(view).toEqual({
      kind: "failed",
      error: "s/b.png: Chrome stopped the download: the disk is full.",
      refs: ["r2"],
      saved: 2,
      total: 3,
    });
  });

  it("reports a cancel only when nothing failed", () => {
    expect(
      aggregateSaves([
        {
          ref: "r1",
          name: "a.mp4",
          byteLength: 1,
          outcome: { kind: "cancelled" },
        },
      ]),
    ).toEqual({ kind: "cancelled", refs: ["r1"], saved: 0, total: 1 });
  });

  it("says how much of a set saved before the author cancelled", () => {
    // Review finding 5: a cancelled stills set must not hide the files
    // that did save.
    const cancelled = (ref: string) => ({
      ref,
      name: `s/${ref}.png`,
      byteLength: 1,
      outcome: { kind: "cancelled" as const },
    });
    expect(
      aggregateSaves([
        ok("r1", "s/a.png", 1),
        cancelled("r2"),
        cancelled("r3"),
      ]),
    ).toEqual({ kind: "cancelled", refs: ["r2", "r3"], saved: 1, total: 3 });
  });

  it("offers every unsaved file again when a set both failed and was cancelled", () => {
    // A set can hold both: file 1's bytes are gone from the store, and the
    // author then cancels file 2, which counts 3 onward as cancelled too.
    // `refs` is what "Download again" is handed, and sending only the
    // failure retried one file while the row read "Saved 0 of 5" and the
    // button promised the set.
    const cancelled = (ref: string) => ({
      ref,
      name: `s/${ref}.png`,
      byteLength: 1,
      outcome: { kind: "cancelled" as const },
    });
    const view = aggregateSaves([
      {
        ref: "r1",
        name: "s/a.png",
        byteLength: 1,
        outcome: { kind: "failed", error: "its bytes are no longer stored" },
      },
      cancelled("r2"),
      cancelled("r3"),
      cancelled("r4"),
      cancelled("r5"),
    ]);
    expect(view).toEqual({
      kind: "failed",
      error: "s/a.png: its bytes are no longer stored",
      refs: ["r1", "r2", "r3", "r4", "r5"],
      saved: 0,
      total: 5,
    });
  });

  it("does not offer the files that DID save", () => {
    // The positive control for the line above: "every file that did not
    // save" must not become "every file". Without this, `refs: results.map`
    // passes the case above.
    const view = aggregateSaves([
      ok("r1", "s/a.png", 1),
      {
        ref: "r2",
        name: "s/b.png",
        byteLength: 1,
        outcome: { kind: "failed", error: "the disk is full" },
      },
      {
        ref: "r3",
        name: "s/c.png",
        byteLength: 1,
        outcome: { kind: "cancelled" },
      },
    ]);
    expect(view).toMatchObject({ refs: ["r2", "r3"], saved: 1, total: 3 });
  });
});
