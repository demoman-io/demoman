// apps/studio/test/pages/node/library-main-bulk-delete.test.ts
import type { SceneDocument } from "@demoman/scene-schema";
import type { LibraryViewChoice, VideoSummary } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteFlows } from "../../../pages/src/shell/confirm-dialog";
import {
  CARDS,
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

/**
 * Bulk delete through the real library entrypoint (spec 2026-10-30
 * flows-and-bulk-delete §1.2): one confirmation for the ticked flows, then
 * each deleted through the flow's own route, and every flow that stayed
 * named with its reason and left ticked.
 */

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));
const confirmDialog = vi.hoisted(() => ({
  ask: vi.fn<(question: unknown) => Promise<boolean>>(),
}));
vi.mock("../../../pages/src/shell/confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askToConfirm: (question: unknown) => confirmDialog.ask(question),
}));

const INVOICE = "11111111-1111-4111-8111-111111111111";
const REPORT = "22222222-2222-4222-8222-222222222222";
const SIGNUP = "33333333-3333-4333-8333-333333333333";

const take = (id: string, name: string): SceneDocument =>
  ({
    meta: {
      id,
      name,
      createdAt: new Date().toISOString(),
      capture: { originUrl: "https://app.test/" },
    },
  }) as unknown as SceneDocument;

const video = (
  id: string,
  name: string,
  versions: number,
  kept: VideoSummary["kept"] = null,
): VideoSummary => ({
  id,
  name,
  repo: { unknown: true },
  startPage: "https://app.test/",
  versions,
  current: null,
  pages: [],
  steps: [],
  exports: [],
  kept,
  addedTo: kept != null && "key" in kept ? kept.key : null,
});

const KEPT_FILE = ".demoman/videos/create-invoice.json";
const KEPT_SAID = `"Create an invoice" stays in the repo (${KEPT_FILE}); only this machine's videos are deleted.`;

function seed(
  libraryView: LibraryViewChoice = CARDS,
  invoiceKept: VideoSummary["kept"] = null,
): MemoryPlatform {
  return createMemoryPlatform({
    libraryView,
    scenes: [
      take("inv-1", "Create an invoice"),
      take("inv-2", "Create an invoice"),
      take("rep-1", "Export a report"),
      take("sign-1", "Sign up"),
    ],
    videos: [
      video(INVOICE, "Create an invoice", 2, invoiceKept),
      video(REPORT, "Export a report", 1),
      video(SIGNUP, "Sign up", 1),
    ],
    videoOf: {
      "inv-1": {
        videoId: INVOICE,
        version: 1,
        expired: false,
        exports: [],
        filmedCode: null,
      },
      "inv-2": {
        videoId: INVOICE,
        version: 2,
        expired: false,
        exports: [],
        filmedCode: null,
      },
      "rep-1": {
        videoId: REPORT,
        version: 1,
        expired: false,
        exports: [],
        filmedCode: null,
      },
      "sign-1": {
        videoId: SIGNUP,
        version: 1,
        expired: false,
        exports: [],
        filmedCode: null,
      },
    },
  });
}

const box = (flow: string) =>
  document.querySelector(`[data-select="${flow}"]`) as HTMLInputElement | null;

async function tick(...flows: string[]): Promise<void> {
  for (const flow of flows) {
    await vi.waitFor(() => {
      if (box(flow) === null) throw new Error(`no checkbox for ${flow} yet`);
    });
    box(flow)?.click();
    await vi.waitFor(() => {
      if (!box(flow)?.checked) throw new Error(`${flow} not ticked yet`);
    });
  }
}

const bar = () => document.querySelector("[data-selection-bar]");
const pressDelete = () =>
  (
    document.querySelector(
      '[data-action="delete-selected"]',
    ) as HTMLButtonElement
  ).click();
const removes = (memory: MemoryPlatform) =>
  memory.calls.filter((c) => c.member === "videos" && c.method === "remove");

describe("library main — bulk delete", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="notice" class="hidden" role="alert"></div>
      <main id="root"></main>
    `;
    memory = seed();
    state.memory = memory;
    confirmDialog.ask.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function open(): Promise<void> {
    await import("../../../pages/entrypoints/library/main");
    await vi.waitFor(() => {
      if (document.querySelectorAll("[data-select]").length !== 3) {
        throw new Error("three flows not drawn yet");
      }
    });
  }

  it("the fixture draws three flows with a checkbox each", async () => {
    await open();
    expect(document.querySelectorAll("article[data-video]")).toHaveLength(3);
  });

  it("ticks two flows and deletes both with one confirmation", async () => {
    await open();
    await tick(INVOICE, REPORT);
    expect(bar()?.textContent).toContain("2 flows selected");
    pressDelete();
    await vi.waitFor(() => {
      if (box(INVOICE) !== null || box(REPORT) !== null) {
        throw new Error("not deleted yet");
      }
    });
    expect(confirmDialog.ask).toHaveBeenCalledTimes(1);
    expect(confirmDialog.ask).toHaveBeenCalledWith(deleteFlows(2, 3));
    expect(deleteFlows(2, 3).body).toContain("2 flows and their 3 videos");
    expect(deleteFlows(1, 2).body).toContain("1 flow and its 2 videos");
    expect(removes(memory).map((c) => c.args[0])).toEqual([INVOICE, REPORT]);
    expect(bar()).toBeNull();
    expect(box(SIGNUP)).not.toBeNull();
    // A plain success toasts and goes; the notice line stays for what
    // needs reading.
    expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
      "Deleted 2 flows",
    );
    expect(document.querySelector("#notice")?.textContent).toBe("");
  });

  describe("a kept flow", () => {
    const KEPT = {
      root: "/repo",
      file: KEPT_FILE,
      deliver: "commit",
      key: null,
    } as const;
    beforeEach(() => {
      memory = seed(CARDS, KEPT);
      state.memory = memory;
    });

    it("its delete asks and answers that its recipe stays", async () => {
      await open();
      // Premise: the fixture's flow is drawn as kept.
      expect(
        document.querySelector(`article[data-video="${INVOICE}"] [data-kept]`),
      ).not.toBeNull();
      // Red: drop keptSentence from questionFor, then from the toast.
      (
        document.querySelector(
          `article[data-video="${INVOICE}"] [data-action="delete"]`,
        ) as HTMLButtonElement
      ).click();
      await vi.waitFor(() => {
        if (box(INVOICE) !== null) throw new Error("not deleted yet");
      });
      const asked = confirmDialog.ask.mock.calls[0]?.[0] as { body: string };
      expect(asked.body).toBe(
        `This permanently removes the flow and its 2 videos. It can’t be undone. ${KEPT_SAID}`,
      );
      // A toast drops its last full stop.
      expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
        `Deleted the flow. ${KEPT_SAID.replace(/\.$/, "")}`,
      );
    });

    it("one whose recipe will not read says so, asked and done", async () => {
      const why = ".demoman/videos/create-invoice.json in /gone is gone";
      memory = seed(CARDS, { unknown: why });
      state.memory = memory;
      await open();
      // Premise: the fixture's flow is drawn as kept, with the reason.
      expect(
        document
          .querySelector(`article[data-video="${INVOICE}"] [data-kept]`)
          ?.getAttribute("title"),
      ).toBe(why);
      // Red: answer null for an unknown recipe in keptSentence.
      (
        document.querySelector(
          `article[data-video="${INVOICE}"] [data-action="delete"]`,
        ) as HTMLButtonElement
      ).click();
      await vi.waitFor(() => {
        if (box(INVOICE) !== null) throw new Error("not deleted yet");
      });
      const said = `"Create an invoice" is in the repo, but its recipe could not be read (${why}); only this machine's videos are deleted.`;
      const asked = confirmDialog.ask.mock.calls[0]?.[0] as { body: string };
      expect(asked.body).toBe(
        `This permanently removes the flow and its 2 videos. It can’t be undone. ${said}`,
      );
      expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
        `Deleted the flow. ${said.replace(/\.$/, "")}`,
      );
    });

    it("a bulk delete with it asks and answers the same sentence", async () => {
      await open();
      await tick(INVOICE, REPORT);
      pressDelete();
      await vi.waitFor(() => {
        if (!document.querySelector("#notice")?.textContent) {
          throw new Error("nothing said yet");
        }
      });
      const asked = confirmDialog.ask.mock.calls[0]?.[0] as { body: string };
      expect(asked.body).toBe(`${deleteFlows(2, 3).body} ${KEPT_SAID}`);
      // A note stays on the notice line rather than a toast that goes.
      expect(document.querySelector("#notice")?.textContent).toBe(
        `Deleted 2 flows. ${KEPT_SAID}`,
      );
    });
  });

  it("a note on what a delete left behind stays on the notice line, not a toast", async () => {
    await open();
    memory.answer("videos.remove", async () => ({
      ok: true as const,
      note: "/tmp/.trash-x could not be removed — delete it by hand.",
    }));
    await tick(SIGNUP);
    pressDelete();
    await vi.waitFor(() => {
      if (!document.querySelector("#notice")?.textContent) {
        throw new Error("nothing said yet");
      }
    });
    expect(document.querySelector("#notice")?.textContent).toBe(
      "Deleted 1 flow. /tmp/.trash-x could not be removed — delete it by hand.",
    );
    expect(document.querySelector("[data-toast]")).toBeNull();
  });

  it("a leased flow stays ticked and is named", async () => {
    await open();
    // The override deletes nothing, so a flow that "went" keeps its card;
    // what the page did is read off the selection and the bar.
    memory.answer("videos.remove", async (id: string) =>
      id === INVOICE
        ? {
            ok: false as const,
            error: "takeBusy",
            detail: "This video is being exported by an agent.",
          }
        : { ok: true as const },
    );
    await tick(INVOICE, REPORT);
    pressDelete();
    await vi.waitFor(() => {
      if (!document.querySelector("[data-selection-said]")?.textContent) {
        throw new Error("nothing said yet");
      }
    });
    expect(document.querySelector("[data-selection-said]")?.textContent).toBe(
      "Deleted 1 of 2 flows. Create an invoice stayed: This video is being exported by an agent.",
    );
    expect(removes(memory).map((c) => c.args[0])).toEqual([INVOICE, REPORT]);
    expect(box(INVOICE)?.checked).toBe(true);
    expect(box(REPORT)?.checked).toBe(false);
    expect(bar()?.textContent).toContain("1 flow selected");
  });

  it("a flow that stayed with no card left is said on the notice line", async () => {
    await open();
    // Its video went, its record did not: the flow has no card to tick, so
    // the bar that would name it goes with the selection.
    memory.answer("videos.remove", async () => {
      await memory.scenes.remove("sign-1");
      return {
        ok: true as const,
        partly: "its 1 video went, but its record could not be removed",
      };
    });
    await tick(SIGNUP);
    pressDelete();
    await vi.waitFor(() => {
      if (!document.querySelector("#notice")?.textContent) {
        throw new Error("nothing said yet");
      }
    });
    // Premise: the card is gone, and the bar with it.
    expect(box(SIGNUP)).toBeNull();
    expect(bar()).toBeNull();
    expect(document.querySelector("#notice")?.textContent).toBe(
      "No flows were deleted. Sign up stayed: only part of it went: its 1 video went, but its record could not be removed.",
    );
    expect(document.querySelector("[data-toast]")).toBeNull();
  });

  it("a thrown request is a flow that stayed", async () => {
    await open();
    memory.answer("videos.remove", async () => {
      throw new Error("the studio did not answer");
    });
    await tick(SIGNUP);
    pressDelete();
    await vi.waitFor(() => {
      if (!document.querySelector("[data-selection-said]")?.textContent) {
        throw new Error("nothing said yet");
      }
    });
    expect(document.querySelector("[data-selection-said]")?.textContent).toBe(
      "No flows were deleted. Sign up stayed: the studio did not answer.",
    );
    expect(box(SIGNUP)?.checked).toBe(true);
  });

  it("a flow gone before its turn counts as deleted", async () => {
    await open();
    memory.answer("videos.remove", async (id: string) =>
      id === REPORT
        ? {
            ok: false as const,
            error: "videoNotFound",
            detail: `There is no flow "${id}".`,
          }
        : { ok: true as const },
    );
    await tick(INVOICE, REPORT);
    pressDelete();
    await vi.waitFor(() => {
      if (bar() !== null) throw new Error("bar still up");
    });
    expect(bar()).toBeNull();
    // A plain success toasts and goes; the notice line stays for what
    // needs reading.
    expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
      "Deleted 2 flows",
    );
    expect(document.querySelector("#notice")?.textContent).toBe("");
  });

  it("a confirmation that cannot open deletes nothing and says so", async () => {
    await open();
    confirmDialog.ask.mockRejectedValue(
      new Error("showModal is not a function"),
    );
    await tick(SIGNUP);
    pressDelete();
    await vi.waitFor(() => {
      if (!document.querySelector("[data-selection-said]")?.textContent) {
        throw new Error("nothing said yet");
      }
    });
    expect(document.querySelector("[data-selection-said]")?.textContent).toBe(
      "Not deleted: the confirmation could not open — showModal is not a function.",
    );
    expect(removes(memory)).toHaveLength(0);
    expect(box(SIGNUP)?.checked).toBe(true);
  });

  it("Cancel on the confirmation deletes nothing and keeps the selection", async () => {
    await open();
    confirmDialog.ask.mockResolvedValue(false);
    await tick(SIGNUP);
    pressDelete();
    await vi.waitFor(() => {
      if (confirmDialog.ask.mock.calls.length === 0)
        throw new Error("not asked");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removes(memory)).toHaveLength(0);
    expect(box(SIGNUP)?.checked).toBe(true);
  });

  it("a tick changes the cards in place: the clicked box and its card stay the same nodes", async () => {
    // A tick that re-rendered the whole list replaced the box under the
    // pointer, and Chrome then threw the page screens up (the author,
    // 2026-10-30); studio-bulk-scroll.test.ts measures the scroll itself.
    await open();
    const clicked = box(SIGNUP) as HTMLInputElement;
    const card = clicked.closest("article");
    const other = box(REPORT);
    await tick(SIGNUP);
    expect(box(SIGNUP)).toBe(clicked);
    expect(clicked.closest("article")).toBe(card);
    expect(box(REPORT)).toBe(other);
    (
      document.querySelector(
        '[data-action="cancel-selection"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      if (bar() !== null) throw new Error("bar still up");
    });
    expect(box(SIGNUP)).toBe(clicked);
    expect(clicked.checked).toBe(false);
  });

  it("a gone flow's note is said beside a flow that stayed", async () => {
    await open();
    memory.answer("videos.remove", async (id: string) =>
      id === INVOICE
        ? {
            ok: false as const,
            error: "takeBusy",
            detail: "This video is being exported by an agent.",
          }
        : {
            ok: true as const,
            note: "/t/.trash-x could not be removed — delete it by hand.",
          },
    );
    await tick(INVOICE, REPORT);
    pressDelete();
    await vi.waitFor(() => {
      if (!document.querySelector("[data-selection-said]")?.textContent) {
        throw new Error("nothing said yet");
      }
    });
    expect(
      document.querySelector("[data-selection-said]")?.textContent,
    ).toContain("/t/.trash-x could not be removed — delete it by hand.");
  });

  it("while a bulk delete runs, the boxes cannot be changed", async () => {
    await open();
    let release: () => void = () => {};
    memory.answer(
      "videos.remove",
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true as const });
        }),
    );
    await tick(SIGNUP);
    pressDelete();
    await vi.waitFor(() => {
      if (
        !document
          .querySelector("[data-selection-count]")
          ?.textContent?.startsWith("Deleting")
      ) {
        throw new Error("not busy yet");
      }
    });
    // Every box is shut while the run goes, so none can look spared.
    expect(
      [...document.querySelectorAll<HTMLInputElement>("[data-select]")].map(
        (b) => b.disabled,
      ),
    ).toEqual([true, true, true]);
    // A flow's own Delete (the list's Cmd+Backspace takes the same road)
    // asks nothing while the run goes: one question, the run's.
    expect(confirmDialog.ask).toHaveBeenCalledTimes(1);
    (
      document.querySelector(
        `article[data-video="${INVOICE}"] [data-action="delete"]`,
      ) as HTMLButtonElement
    ).click();
    // `remove` asks before its first await: a call would be seen here.
    expect(confirmDialog.ask).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => {
      if (bar() !== null) throw new Error("bar still up");
    });
    expect(
      [...document.querySelectorAll<HTMLInputElement>("[data-select]")].every(
        (b) => !b.disabled,
      ),
    ).toBe(true);
  });

  it("Back while a bulk delete runs repaints the place and keeps the run's lock and ticks", async () => {
    await open();
    let release: () => void = () => {};
    memory.answer(
      "videos.remove",
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true as const });
        }),
    );
    await tick(SIGNUP);
    pressDelete();
    await vi.waitFor(() => {
      if (
        !document
          .querySelector("[data-selection-count]")
          ?.textContent?.startsWith("Deleting")
      ) {
        throw new Error("not busy yet");
      }
    });
    try {
      // Every flow here is in no repo, so No project still draws all three.
      history.pushState({}, "", "/?project=none");
      window.dispatchEvent(new PopStateEvent("popstate"));
      // Premise: the popstate repainted the place it names.
      expect(
        document
          .querySelector('[data-rail] [aria-current="true"]')
          ?.getAttribute("data-place"),
      ).toBe("?project=none");
      // Red: clear the selection and the run on every popstate — the boxes
      // open mid-run and a second Delete asks again.
      expect(
        [...document.querySelectorAll<HTMLInputElement>("[data-select]")].map(
          (b) => b.disabled,
        ),
      ).toEqual([true, true, true]);
      expect(box(SIGNUP)?.checked).toBe(true);
      pressDelete();
      expect(confirmDialog.ask).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => {
        if (bar() !== null) throw new Error("bar still up");
      });
      expect(removes(memory).map((c) => c.args[0])).toEqual([SIGNUP]);
      expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
        "Deleted 1 flow",
      );
    } finally {
      history.replaceState({}, "", "/");
    }
  });

  it("Back while the confirmation asks deletes nothing", async () => {
    await open();
    await tick(SIGNUP, REPORT);
    confirmDialog.ask.mockImplementation(async () => {
      history.pushState({}, "", "/?project=all");
      window.dispatchEvent(new PopStateEvent("popstate"));
      return true;
    });
    try {
      pressDelete();
      await vi.waitFor(() => {
        if (confirmDialog.ask.mock.calls.length === 0) {
          throw new Error("not asked yet");
        }
      });
      // Premise: the Back took effect, clearing the ticks.
      await vi.waitFor(() => {
        if (bar() !== null) throw new Error("bar still up");
      });
      // Nothing happening has no condition to wait for: one macrotask lets
      // deleteSelected run on past its question (the red run shows it does).
      await new Promise((r) => setTimeout(r, 0));
      // Red: delete the ids read before the question, not those still ticked.
      expect(removes(memory)).toEqual([]);
      expect(box(SIGNUP)).not.toBeNull();
      expect(box(REPORT)).not.toBeNull();
    } finally {
      history.replaceState({}, "", "/");
    }
  });

  it("Esc clears the selection", async () => {
    await open();
    await tick(SIGNUP);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await vi.waitFor(() => {
      if (bar() !== null) throw new Error("bar still up");
    });
    expect(box(SIGNUP)?.checked).toBe(false);
  });

  /**
   * Shift+↓ in the list from a flow with nothing ticked ticks that flow
   * and the next, as Finder does: the row the move started from is the
   * anchor when there is none. Red if list.ts's keys stop sending that row
   * (`from`) or main.ts stops passing it to `clickSelect` — either way
   * only the next flow is ticked.
   */
  it("Shift+↓ in the list with nothing ticked ticks the flow it starts from and the next", async () => {
    state.memory = seed({
      layout: "list",
      sort: { column: "name", descending: false },
      project: null,
    });
    // jsdom has no layout, and no scroll into view for the keys to call.
    Element.prototype.scrollIntoView ??= () => undefined;
    await open();
    const rows = [
      ...document.querySelectorAll<HTMLElement>(
        "[role=treegrid] [role=row][data-flow]:not([hidden])",
      ),
    ];
    // Premise: the list is drawn, and nothing is ticked.
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Create an invoice",
      "Export a report",
      "Sign up",
    ]);
    expect(bar()).toBeNull();
    const [first] = rows as [HTMLElement];
    first.focus();
    first.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        shiftKey: true,
        bubbles: true,
      }),
    );
    await vi.waitFor(() => {
      if (bar() === null) throw new Error("nothing ticked yet");
    });
    expect(
      [
        ...document.querySelectorAll<HTMLElement>(
          '[role=treegrid] [role=row][aria-selected="true"]',
        ),
      ].map((r) => r.getAttribute("aria-label")),
    ).toEqual(["Create an invoice", "Export a report"]);
  });
});
