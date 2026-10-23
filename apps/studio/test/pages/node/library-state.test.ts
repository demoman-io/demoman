// apps/studio/test/pages/node/library-state.test.ts
import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { StorageSummary } from "../../../pages/src/core/storage/types";
import type {
  LibraryFilter,
  LibraryRow,
} from "../../../pages/src/library/state";
import {
  buildLibraryModel,
  facetsOf,
  filterRows,
  formatBytes,
  NO_FILTER,
  reclaimSentence,
  sectionsOf,
} from "../../../pages/src/library/state";

// `meta.capture.originUrl` is where @demoman/scene-schema's SceneDocument
// actually nests it (`capture` is a field of `meta`, not a sibling) — the
// path this fixture builds must match what `buildLibraryModel` reads, or
// the origin assertions below would pass against `undefined` for the wrong
// reason.
const scene = (id: string, name: string) =>
  ({
    meta: {
      id,
      name,
      createdAt: "2026-09-01T00:00:00Z",
      capture: { originUrl: "https://app.test/x" },
    },
  }) as never;
const demo = (
  sceneId: string,
  extra: Partial<Record<string, unknown>> = {},
) => ({
  sceneId,
  frameBytes: 100,
  spanBytes: 80,
  outputBytes: 20,
  hosted: false,
  recoverable: false,
  motion: "complete" as const,
  createdAt: "2026-09-01T00:00:00Z",
  ...extra,
});

describe("buildLibraryModel", () => {
  it("joins footprints to scenes and computes the meter", () => {
    const m = buildLibraryModel({
      summary: {
        budgetBytes: 1000,
        usedBytes: 250,
        assetBytes: 0,
        demos: [demo("a", { motion: "reclaimed" })],
      },
      scenes: [scene("a", "Checkout")],
      migrating: false,
      migrationFailed: false,
      needsLook: new Set(),
      notice: null,
    });
    expect(m.fraction).toBe(0.25);
    expect(m.rows[0]).toMatchObject({
      name: "Checkout",
      origin: "app.test",
      state: "Motion reclaimed",
      canRestore: true,
      authored: false,
    });
  });

  it("says what is holding the space when reclaim could not clear pressure", () => {
    const m = buildLibraryModel({
      summary: {
        budgetBytes: 100,
        usedBytes: 150,
        assetBytes: 0,
        demos: [demo("a")],
      },
      scenes: [scene("a", "A")],
      migrating: false,
      migrationFailed: false,
      needsLook: new Set(),
      notice: {
        reason: "budget",
        freedBytes: 0,
        pressureRemains: true,
        failed: false,
      },
    });
    expect(m.notice).toMatch(/over budget/i);
    expect(m.notice).toMatch(/A/);
  });

  it("flags Chrome's limit as the binding constraint", () => {
    const m = buildLibraryModel({
      summary: { budgetBytes: 1000, usedBytes: 1, assetBytes: 0, demos: [] },
      scenes: [],
      migrating: false,
      migrationFailed: false,
      needsLook: new Set(),
      notice: {
        reason: "quota",
        freedBytes: 0,
        pressureRemains: true,
        failed: false,
      },
    });
    expect(m.chromeNearLimit).toBe(true);
  });

  // Untitled is `name: ""`, and its label is where it was recorded. The
  // time is on every row — two takes of one page on one day are told apart
  // by it. Reddens if `when` goes back to being withheld, or drops the
  // minute, or if an untitled row's label comes out blank.
  it("dates every row to the minute, and labels an untitled one by its place", () => {
    const createdAt = "2026-09-01T10:30:00Z";
    const untitled = scene("a", "");
    const named = scene("b", "Checkout");
    for (const s of [untitled, named] as { meta: { createdAt: string } }[]) {
      s.meta.createdAt = createdAt;
    }
    const m = buildLibraryModel({
      summary: {
        budgetBytes: 1000,
        usedBytes: 0,
        assetBytes: 0,
        demos: [],
      },
      scenes: [untitled, named],
      migrating: false,
      migrationFailed: false,
      needsLook: new Set(),
      notice: null,
    });
    const byId = new Map(m.rows.map((r) => [r.sceneId, r]));
    const stamp = new Date(createdAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    // The formatter's output carries the minute, or the assertions below
    // would pass on a date-only `when` too.
    expect(stamp).toMatch(/30/);
    expect(byId.get("a")?.when).toBe(stamp);
    expect(byId.get("b")?.when).toBe(stamp);
    // Under a heading that names the day, a row shows only its time. The
    // premise: the date formatter's day of the month is in `when` and the
    // time formatter's output is not, so a `time` that were `when` again
    // fails the second check.
    const time = new Date(createdAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    const day = new Date(createdAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(stamp).toContain(day);
    expect(byId.get("a")?.time).toBe(time);
    expect(byId.get("a")?.time).not.toContain(day);
    expect(byId.get("a")?.name).toBe("");
    expect(byId.get("a")?.label).toBe("app.test/x");
    expect(byId.get("b")?.label).toBe("Checkout");
  });

  it("keeps the host and the start path apart, dropping query and hash", () => {
    const at = (url: string) =>
      ({
        meta: {
          id: url,
          name: "x",
          createdAt: "2026-09-01T00:00:00Z",
          capture: { originUrl: url },
        },
      }) as never;
    const m = buildLibraryModel({
      summary: { budgetBytes: 1, usedBytes: 0, assetBytes: 0, demos: [] },
      scenes: [
        at("http://localhost:4000/checkout/?step=2#pay"),
        at("http://localhost:4000/"),
        at("not a url"),
      ],
      migrating: false,
      migrationFailed: false,
      needsLook: new Set(),
      notice: null,
    });
    const by = new Map(m.rows.map((r) => [r.sceneId, r]));
    expect(by.get("http://localhost:4000/checkout/?step=2#pay")).toMatchObject({
      origin: "localhost:4000",
      path: "/checkout",
    });
    expect(by.get("http://localhost:4000/")).toMatchObject({
      origin: "localhost:4000",
      path: "",
    });
    expect(by.get("not a url")).toMatchObject({
      origin: "not a url",
      path: "",
    });
  });

  it("facets rows by host and state, and filters by either", () => {
    const row = (
      sceneId: string,
      origin: string,
      state: "Complete" | "Motion reclaimed" | "Keyframes only",
    ) => ({
      sceneId,
      name: sceneId,
      label: sceneId,
      origin,
      path: "",
      createdAt: "2026-09-01T00:00:00Z",
      when: "Sep 1, 12:00 AM",
      time: "12:00 AM",
      hosted: false,
      recoverable: false,
      frameBytes: 0,
      outputBytes: 0,
      state,
      canRestore: state === "Motion reclaimed",
      authored: false,
      servesReshoot: false,
      needsLook: false,
    });
    const rows = [
      row("a", "localhost:4000", "Complete"),
      row("b", "localhost:4000", "Motion reclaimed"),
      row("c", "staging.test", "Complete"),
    ];
    expect(facetsOf(rows)).toEqual({
      hosts: [
        { value: "localhost:4000", count: 2 },
        { value: "staging.test", count: 1 },
      ],
      states: [
        { value: "Complete", count: 2 },
        { value: "Motion reclaimed", count: 1 },
      ],
    });
    const ids = (f: LibraryFilter) => filterRows(rows, f).map((r) => r.sceneId);
    expect(ids(NO_FILTER)).toEqual(["a", "b", "c"]);
    expect(ids({ host: "localhost:4000", state: null })).toEqual(["a", "b"]);
    expect(ids({ host: null, state: "Motion reclaimed" })).toEqual(["b"]);
    expect(ids({ host: "staging.test", state: "Motion reclaimed" })).toEqual(
      [],
    );
  });

  it("formats bytes for people", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 MB");
    expect(formatBytes(1.4 * 1024 * 1024 * 1024)).toBe("1.4 GB");
  });

  // Coordinator amendment: a reclaim that CRASHED (`failed: true`) and a
  // reclaim that ran fine and simply found nothing to free must not read
  // the same to the author — that collapse was the Critical finding against
  // Task 10. This asserts the two notices differ in more than which bytes
  // they cite, and that the failed one never claims "nothing could be
  // freed" (the working-but-exhausted wording), which is exactly what a
  // test asserting only "some notice appears" would miss.
  it("says the cleanup itself is broken when the notice carries failed: true", () => {
    const base = {
      summary: {
        budgetBytes: 100,
        usedBytes: 150,
        assetBytes: 0,
        demos: [demo("a")],
      },
      scenes: [scene("a", "A")],
      migrating: false,
      migrationFailed: false,
      needsLook: new Set<string>(),
    };
    const working = buildLibraryModel({
      ...base,
      notice: {
        reason: "budget",
        freedBytes: 0,
        pressureRemains: true,
        failed: false,
      },
    });
    const broken = buildLibraryModel({
      ...base,
      notice: {
        reason: "budget",
        freedBytes: 0,
        pressureRemains: true,
        failed: true,
      },
    });
    expect(broken.notice).not.toBe(working.notice);
    expect(broken.notice).toMatch(/could not run/i);
    expect(broken.notice).not.toMatch(/nothing more can be reclaimed/i);
    expect(working.notice).toMatch(/nothing more can be reclaimed/i);
  });
});

describe("sectionsOf", () => {
  // Local-time construction throughout: the sections are calendar days
  // and months in the author's own zone, and a fixture built in UTC would
  // straddle midnight differently on every machine the lane runs on.
  const at = (y: number, m: number, d: number, h = 12): string =>
    new Date(y, m - 1, d, h).toISOString();
  const row = (sceneId: string, createdAt: string): LibraryRow => ({
    sceneId,
    name: sceneId,
    label: sceneId,
    origin: "localhost:4000",
    path: "",
    createdAt,
    when: "",
    time: "",
    hosted: false,
    recoverable: false,
    frameBytes: 0,
    outputBytes: 0,
    state: "Complete",
    canRestore: false,
    authored: false,
    servesReshoot: false,
    needsLook: false,
  });
  // A Monday at 9am, so the seven-day window crosses a weekend.
  const now = new Date(2026, 8, 14, 9);
  // Weekday and month names come from the process locale, so they are
  // read through the same formatter rather than written in English —
  // the file's own precedent above, and what keeps a de_DE machine green.
  // A day of the last week is headed with its date, "Sat, Sep 12": a bare
  // weekday left the author counting back from today.
  const weekday = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  const month = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });

  it("puts today's takes first, then yesterday's, then the last week by weekday, then months", () => {
    const sections = sectionsOf(
      [
        row("t", at(2026, 9, 14, 8)),
        row("y", at(2026, 9, 13)),
        row("sat", at(2026, 9, 12)),
        row("tue", at(2026, 9, 8)),
        row("aug", at(2026, 8, 30)),
      ],
      now,
    );
    expect(sections.map((s) => [s.key, s.label])).toEqual([
      ["today", "Today"],
      ["yesterday", "Yesterday"],
      ["day:2026-09-12", weekday(at(2026, 9, 12))],
      ["day:2026-09-08", weekday(at(2026, 9, 8))],
      ["month:2026-08", month(at(2026, 8, 30))],
    ]);
    expect(sections.map((s) => s.rows.map((r) => r.sceneId))).toEqual([
      ["t"],
      ["y"],
      ["sat"],
      ["tue"],
      ["aug"],
    ]);
    // The premise of the label assertions above: the formatter puts the
    // day of the month in, which a weekday-only label would not carry.
    expect(weekday(at(2026, 9, 12))).toMatch(/12/);
    // A heading that names one day lets its rows drop their date; a month
    // does not.
    expect(sections.map((s) => [s.key, s.namesDay])).toEqual([
      ["today", true],
      ["yesterday", true],
      ["day:2026-09-12", true],
      ["day:2026-09-08", true],
      ["month:2026-08", false],
    ]);
  });

  // The boundaries. Seven days ago is the same weekday as today, so a
  // weekday label there would read as "today"; it goes to its month.
  it("draws the day line at midnight and the week line at seven days", () => {
    const sections = sectionsOf(
      [
        row("late", at(2026, 9, 13, 23)),
        row("early", at(2026, 9, 14, 0)),
        row("six", at(2026, 9, 8, 0)),
        row("seven", at(2026, 9, 7, 23)),
      ],
      now,
    );
    const of = (id: string) =>
      sections.find((s) => s.rows.some((r) => r.sceneId === id))?.key;
    expect(of("early")).toBe("today");
    expect(of("late")).toBe("yesterday");
    expect(of("six")).toBe("day:2026-09-08");
    expect(of("seven")).toBe("month:2026-09");
  });

  it("folds the months before this one, and nothing newer", () => {
    const sections = sectionsOf(
      [
        row("t", at(2026, 9, 14, 8)),
        row("earlier-this-month", at(2026, 9, 1)),
        row("aug", at(2026, 8, 3)),
        row("jan", at(2026, 1, 3)),
      ],
      now,
    );
    expect(sections.map((s) => [s.key, s.folded])).toEqual([
      ["today", false],
      ["month:2026-09", false],
      ["month:2026-08", true],
      ["month:2026-01", true],
    ]);
  });

  it("keeps rows in the order given within a section", () => {
    const sections = sectionsOf(
      [row("b", at(2026, 8, 20)), row("a", at(2026, 8, 25))],
      now,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.rows.map((r) => r.sceneId)).toEqual(["b", "a"]);
  });

  // A row whose date will not parse is still a recording the author owns.
  // It gets a section that says so rather than an "Invalid Date" heading
  // or a place in whichever month the arithmetic happened to land on.
  it("gives an unparseable date its own section, and says so", () => {
    const sections = sectionsOf([row("x", "not a date")], now);
    expect(sections).toEqual([
      {
        key: "undated",
        label: "Undated",
        folded: false,
        // No day to name, so its rows keep whatever date they carry.
        namesDay: false,
        rows: [row("x", "not a date")],
      },
    ]);
  });

  it("returns nothing for nothing", () => {
    expect(sectionsOf([], now)).toEqual([]);
  });
});

// `storage:reclaim` answers with `freedBytes` and `pressureRemains`, and
// until 2026-09-14 both pages threw the whole result away and merely
// re-rendered — so "freed 1.8 GB" and "nothing could be freed" were the
// same silence. The three branches are stated once, here, because both
// the Recordings page and Settings press the same button.
describe("reclaimSentence", () => {
  it("says how much it freed when the pressure is gone", () => {
    const said = reclaimSentence({
      freedBytes: 1932735283,
      pressureRemains: false,
    });
    expect(said.text).toBe("Freed 1.8 GB.");
    expect(said.level).toBe("info");
  });

  it("warns when it freed something and the library is still over", () => {
    const said = reclaimSentence({
      freedBytes: 1932735283,
      pressureRemains: true,
    });
    expect(said.text).toBe(
      "Freed 1.8 GB, but the library is still over its budget.",
    );
    expect(said.level).toBe("warn");
  });

  /**
   * The healthy press, and the one the first cut of this got wrong: under
   * budget, `reclaim`'s `done()` is true before the first tier, so the
   * result is `{freedBytes: 0, pressureRemains: false}`. Warning there
   * tells an author with nothing wrong that nothing could be freed — the
   * inverse of the rule this whole change is about, with the do-nothing
   * path reporting like a fault.
   */
  it("says there was nothing to free when nothing needed freeing", () => {
    const said = reclaimSentence({ freedBytes: 0, pressureRemains: false });
    expect(said.text).toBe("Nothing to free — you are inside the budget.");
    expect(said.level).toBe("info");
  });

  // The button's most confusing outcome: it ran, it worked, and nothing
  // moved while the library is still over. Silence here reads as a button
  // that does nothing at all.
  it("warns when it could free nothing and the library is still over", () => {
    const said = reclaimSentence({ freedBytes: 0, pressureRemains: true });
    expect(said.text).toBe(
      "Nothing could be freed. Every recording left is one Demoman will not delete on its own.",
    );
    expect(said.level).toBe("warn");
  });

  it("marks exactly the takes a drift check flagged", () => {
    const mk = (id: string) =>
      ({
        meta: {
          id,
          name: id,
          createdAt: "2026-09-01T00:00:00Z",
          capture: { originUrl: "https://app.test/", mode: "record" },
        },
      }) as unknown as SceneDocument;
    const model = buildLibraryModel({
      summary: {
        budgetBytes: 1,
        usedBytes: 0,
        assetBytes: 0,
        demos: [],
      } as unknown as StorageSummary,
      scenes: [mk("flagged"), mk("fine")],
      migrating: false,
      migrationFailed: false,
      // "gone" names a take that is no longer stored: a record can outlive
      // its scene, and it must not invent a row.
      needsLook: new Set(["flagged", "gone"]),
      notice: null,
    });
    expect(
      Object.fromEntries(model.rows.map((r) => [r.sceneId, r.needsLook])),
    ).toEqual({ flagged: true, fine: false });
  });

  it("offers the way back only on a take explicitly on its re-shot frames", () => {
    const mk = (id: string, meta: Record<string, unknown>) =>
      ({
        meta: {
          id,
          name: id,
          createdAt: "2026-09-01T00:00:00Z",
          capture: { originUrl: "https://app.test/", mode: "record" },
          ...meta,
        },
      }) as unknown as SceneDocument;
    const model = buildLibraryModel({
      summary: {
        budgetBytes: 1,
        usedBytes: 0,
        assetBytes: 0,
        demos: [],
      } as unknown as StorageSummary,
      scenes: [
        mk("demo", { renderMode: "demo" }),
        mk("screen", { renderMode: "screen" }),
        // Absent means "demo" to `renderModeOf`, and would offer the way back
        // on every take recorded before the field existed.
        mk("absent", {}),
        mk("authored", {
          renderMode: "demo",
          capture: { originUrl: "https://app.test/", mode: "authored" },
        }),
      ],
      migrating: false,
      migrationFailed: false,
      needsLook: new Set(),
      notice: null,
    });
    // The fixture's claim: all four rows exist to be told apart.
    expect(model.rows).toHaveLength(4);
    const serves = Object.fromEntries(
      model.rows.map((r) => [r.sceneId, r.servesReshoot]),
    );
    expect(serves).toEqual({
      demo: true,
      screen: false,
      absent: false,
      authored: false,
    });
    // M1: the row knows a script made it, so Restore and the reclaimed chip
    // can name the script route instead of a re-shoot Runs refuses.
    expect(
      Object.fromEntries(model.rows.map((r) => [r.sceneId, r.authored])),
    ).toEqual({ demo: false, screen: false, absent: false, authored: true });
  });
});
