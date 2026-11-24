// apps/studio/test/pages/node/footage.test.ts
// DEM-179: the Studio's Storage panel, as the author picked it (placement 1,
// variant A of what a cleanup removed).
import { describe, expect, it, vi } from "vitest";
import {
  type FootageActions,
  type FootageRead,
  footageBody,
  keepHint,
  REMOVED_SHOWN,
  sinceWords,
} from "../../../pages/src/library/footage";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const video = (i: number) => ({
  videoId: `v${i}`,
  name: `Flow ${i}`,
  recordedAt: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
  bytes: 1_000_000 * (i + 1),
});
const removal = (n: number, more = 0) => ({
  at: "2026-11-24T10:00:00.000Z",
  videos: Array.from({ length: n }, (_, i) => video(i)),
  more,
  bytes: 9_000_000,
});
const settle = () => new Promise((r) => setTimeout(r, 0));

async function drawn(
  read: FootageRead | (() => Promise<FootageRead>),
  setKeep = vi.fn(async () => {}),
) {
  const actions: FootageActions = {
    read: typeof read === "function" ? read : async () => read,
    setKeep,
  };
  const body = footageBody(actions, () => NOW);
  body.setUsed("4.2 GB of videos in the library");
  await body.refresh();
  return { el: body.element, setKeep, body };
}
const text = (root: Element, sel: string) =>
  root.querySelector(sel)?.textContent ?? null;
const rows = (root: Element) =>
  [...root.querySelectorAll("[data-removed-list] li .name")].map(
    (n) => n.textContent,
  );

describe("the Storage panel", () => {
  it("names what the last cleanup removed: three rows, then the rest on request", async () => {
    // The premise: more removals than the rows shown.
    expect(REMOVED_SHOWN).toBe(3);
    const { el } = await drawn({
      keep: "30d",
      expiry: {
        lastRanAt: "2026-11-24T10:00:00.000Z",
        lastRemoval: removal(8),
      },
    });
    expect(text(el, "[data-footage-used]")).toBe(
      "4.2 GB of videos in the library",
    );
    // The total in the library's own units (formatBytes: 9,000,000 bytes).
    expect(text(el, ".removed-head")).toBe("Removed 2 hours ago8.6 MB");
    expect(rows(el)).toEqual(["Flow 0", "Flow 1", "Flow 2"]);
    const more = el.querySelector<HTMLButtonElement>("[data-removed-more]");
    expect(more?.textContent).toBe("and 5 more");
    more?.click();
    expect(rows(el)).toHaveLength(8);
    expect(text(el, "[data-removed-more]")).toBe("Show fewer");
    el.querySelector<HTMLButtonElement>("[data-removed-more]")?.click();
    expect(rows(el)).toHaveLength(3);
  });

  it("counts removals past the listed ones, and says them when opened", async () => {
    const { el } = await drawn({
      keep: "30d",
      expiry: { lastRanAt: null, lastRemoval: removal(5, 7) },
    });
    expect(text(el, "[data-removed-more]")).toBe("and 9 more");
    el.querySelector<HTMLButtonElement>("[data-removed-more]")?.click();
    expect(el.textContent).toContain("and 7 more, not listed");
  });

  // The author's copy rule: under Forever nothing is removed, so the help
  // line never says it is.
  it("says Forever removes nothing, in the help line and the empty state", async () => {
    const { el } = await drawn({
      keep: "forever",
      expiry: { lastRanAt: "2026-11-24T11:00:00.000Z", lastRemoval: null },
    });
    expect(text(el, "[data-keep-hint]")).not.toMatch(/removed/i);
    expect(text(el, "[data-removed-empty]")).toBe(
      "Footage is kept forever, so nothing is removed.",
    );
    expect(keepHint("30d")).toMatch(/removed after this/);
    const checked = el.querySelector('[data-keep-footage="forever"]');
    expect(checked?.getAttribute("aria-checked")).toBe("true");
  });

  it("says a cleanup that found nothing, and one that never ran", async () => {
    const checked = await drawn({
      keep: "90d",
      expiry: {
        lastRanAt: "2026-11-24T11:00:00.000Z",
        ranUnder: "90d",
        lastRemoval: null,
      },
    });
    expect(text(checked.el, "[data-removed-empty]")).toBe(
      "Checked 1 hour ago: nothing was older than 90 days.",
    );
    const never = await drawn({
      keep: "30d",
      expiry: { lastRanAt: null, lastRemoval: null },
    });
    expect(text(never.el, "[data-removed-empty]")).toBe("Nothing removed yet.");
  });

  // Report before you forgive: each failure is its own sentence, never
  // "nothing removed".
  it("says a failed cleanup, an unreadable setting, a failed read and a failed save", async () => {
    const problem = await drawn({
      keep: null,
      keepUnreadable: "settings.json: keepFootage must be 30d, 90d, forever",
      expiry: {
        lastRanAt: "2026-11-24T11:00:00.000Z",
        lastRemoval: null,
        problem: "could not remove x",
      },
    });
    expect(text(problem.el, "[data-expiry-problem]")).toBe(
      "The last cleanup did not finish: could not remove x",
    );
    expect(text(problem.el, "[data-keep-unreadable]")).toContain(
      "keepFootage must be",
    );
    expect(
      [...problem.el.querySelectorAll("[data-keep-footage]")].map((b) =>
        b.getAttribute("aria-checked"),
      ),
    ).toEqual(["false", "false", "false"]);

    const failed = await drawn(async () => {
      throw new Error("the Studio did not answer");
    });
    expect(text(failed.el, "[data-footage-failed]")).toBe(
      "Couldn't read how long footage is kept: the Studio did not answer",
    );

    const refused = vi.fn(async () => {
      throw new Error("settings.json could not be written");
    });
    const save = await drawn(
      { keep: "30d", expiry: { lastRanAt: null, lastRemoval: null } },
      refused,
    );
    save.el
      .querySelector<HTMLButtonElement>('[data-keep-footage="90d"]')
      ?.click();
    await settle();
    await settle();
    expect(refused).toHaveBeenCalledWith("90d");
    expect(text(save.el, "[data-footage-save]")).toBe(
      "Keep footage was not saved: settings.json could not be written",
    );
  });

  it("saves a new choice and reads again; the chosen one is not saved again", async () => {
    let keep: "30d" | "forever" = "30d";
    const setKeep = vi.fn(async (v: "30d" | "forever") => {
      keep = v;
    });
    const { el } = await drawn(
      async () => ({ keep, expiry: { lastRanAt: null, lastRemoval: null } }),
      setKeep as FootageActions["setKeep"] & typeof setKeep,
    );
    el.querySelector<HTMLButtonElement>('[data-keep-footage="30d"]')?.click();
    expect(setKeep).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>(
      '[data-keep-footage="forever"]',
    )?.click();
    await settle();
    await settle();
    expect(setKeep).toHaveBeenCalledWith("forever");
    expect(
      el
        .querySelector('[data-keep-footage="forever"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("says when a cleanup ran in words", () => {
    expect(sinceWords("2026-11-24T11:59:40.000Z", NOW)).toBe("just now");
    expect(sinceWords("2026-11-24T11:00:00.000Z", NOW)).toBe("1 hour ago");
    expect(sinceWords("2026-11-23T12:00:00.000Z", NOW)).toBe("yesterday");
    expect(sinceWords("2026-11-20T12:00:00.000Z", NOW)).toBe("4 days ago");
  });
});

// Review of DEM-179: "checked, nothing old" only for a pass that finished
// under the setting shown, and no stale words left on screen.
describe("the Storage panel, after review", () => {
  it("never says a failed pass, or one under another setting, checked", async () => {
    const failed = await drawn({
      keep: "30d",
      expiry: {
        lastRanAt: "2026-11-24T11:00:00.000Z",
        ranUnder: "30d",
        lastRemoval: null,
        problem: "the Keep footage setting cannot be used",
      },
    });
    expect(text(failed.el, "[data-removed-empty]")).toBe(
      "Nothing removed yet.",
    );
    expect(text(failed.el, "[data-expiry-problem]")).toContain(
      "cannot be used",
    );
    const changed = await drawn({
      keep: "30d",
      expiry: {
        lastRanAt: "2026-11-24T11:00:00.000Z",
        ranUnder: "forever",
        lastRemoval: null,
      },
    });
    expect(text(changed.el, "[data-removed-empty]")).toBe(
      "Not checked at 30 days yet: the next cleanup runs when a video is recorded or the Studio opens.",
    );
  });

  it("dates a row from another year with its year", async () => {
    const { el } = await drawn({
      keep: "30d",
      expiry: {
        lastRanAt: null,
        lastRemoval: {
          at: "2026-11-24T10:00:00.000Z",
          videos: [
            { ...video(0), recordedAt: "2025-11-20T12:00:00.000Z" },
            { ...video(1), recordedAt: "2026-11-20T12:00:00.000Z" },
          ],
          more: 0,
          bytes: 2,
        },
      },
    });
    expect(
      [...el.querySelectorAll("[data-removed-list] .date")].map(
        (d) => d.textContent,
      ),
    ).toEqual(["Nov 20, 2025", "Nov 20"]);
  });

  it("clears a save's error on the next open, and paints only the newest read", async () => {
    let answer: FootageRead = {
      keep: "30d",
      expiry: { lastRanAt: null, lastRemoval: null },
    };
    const slow: Array<(r: FootageRead) => void> = [];
    const refused = vi.fn(async () => {
      throw new Error("locked");
    });
    const actions: FootageActions = {
      read: () =>
        slow.length > 0
          ? new Promise<FootageRead>((r) => slow.push(r))
          : Promise.resolve(answer),
      setKeep: refused,
    };
    const body = footageBody(actions, () => NOW);
    await body.refresh();
    body.element
      .querySelector<HTMLButtonElement>('[data-keep-footage="90d"]')
      ?.click();
    await settle();
    await settle();
    expect(text(body.element, "[data-footage-save]")).toContain("locked");
    // The panel opens again: a fresh read, and the old error goes.
    await body.refresh();
    expect(body.element.querySelector("[data-footage-save]")).toBeNull();

    // An older read that answers after a newer one is dropped.
    slow.push(() => {});
    slow.length = 0;
    let release: (r: FootageRead) => void = () => {};
    actions.read = () =>
      new Promise<FootageRead>((r) => {
        release = r;
      });
    const older = body.refresh();
    const releaseOlder = release;
    answer = {
      keep: "forever",
      expiry: { lastRanAt: null, lastRemoval: null },
    };
    actions.read = async () => answer;
    await body.refresh();
    releaseOlder({
      keep: "30d",
      expiry: { lastRanAt: null, lastRemoval: null },
    });
    await older;
    expect(
      body.element
        .querySelector('[data-keep-footage="forever"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });
});
