import type { SceneDocument } from "@demoman/scene-schema";
import type { VideoSummary } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refilmLine } from "../../../pages/src/platform/http";
import {
  DELETE_RECORD,
  deleteFlow,
  deleteVideoOf,
} from "../../../pages/src/shell/confirm-dialog";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";
import { captureNavigations } from "../helpers/navigation";

/**
 * The library lists videos (local video library spec §6): one card per
 * video, its versions under it, an expired version saying only how to
 * record it again, and a rename or a delete on the card meaning the video.
 * The real entrypoint over the memory platform.
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
const SIGNUP = "22222222-2222-4222-8222-222222222222";

const take = (id: string, name: string, createdAt: string): SceneDocument =>
  ({
    meta: {
      id,
      name,
      createdAt,
      capture: { originUrl: "https://app.test/invoices" },
    },
  }) as unknown as SceneDocument;

const video = (
  id: string,
  name: string,
  versions: number,
  current: string | null,
  repo: VideoSummary["repo"],
): VideoSummary => ({
  id,
  name,
  repo,
  startPage: "https://app.test/",
  versions,
  current:
    current === null
      ? null
      : {
          version: 1,
          takeId: current,
          recordedAt: "2026-10-01T00:00:00Z",
          expired: false,
        },
  pages: [],
  steps: [],
  exports: [],
});

const KEPT = "/Users/me/Downloads/Create an invoice.mp4";
const GONE = "/Users/me/Downloads/Create an invoice.gif";

/** `signupExpired`: Sign up's one version never completed and its
 *  recording expired, so its card shows an expired take. */
function seed(
  o: {
    signupExpired?: boolean;
    /** Sign up's one version was exported to this file. */
    signupExport?: string;
    unreadable?: Parameters<typeof createMemoryPlatform>[0] extends infer S
      ? S extends { unreadable?: infer U }
        ? U
        : never
      : never;
  } = {},
): MemoryPlatform {
  return createMemoryPlatform({
    ...(o.unreadable === undefined ? {} : { unreadable: o.unreadable }),
    scenes: [
      take("inv-1", "Create an invoice", "2026-09-01T10:00:00Z"),
      take("inv-2", "Create an invoice", "2026-09-20T10:00:00Z"),
      take("inv-3", "Create an invoice", "2026-10-01T10:00:00Z"),
      take("sign-1", "Sign up", "2026-10-02T10:00:00Z"),
    ],
    videos: [
      // inv-3 failed, so inv-2 is current.
      video(INVOICE, "Create an invoice", 3, "inv-2", {
        key: "github.com/acme/web",
      }),
      video(SIGNUP, "Sign up", 1, o.signupExpired ? null : "sign-1", {
        none: "not a git checkout",
      }),
    ],
    videoOf: {
      "inv-1": { videoId: INVOICE, version: 1, expired: true, exports: [] },
      "inv-2": {
        videoId: INVOICE,
        version: 2,
        expired: false,
        exports: [
          { path: KEPT, fileType: "mp4", exists: true },
          { path: GONE, fileType: "gif", exists: false },
        ],
      },
      "inv-3": { videoId: INVOICE, version: 3, expired: false, exports: [] },
      "sign-1": {
        videoId: SIGNUP,
        version: 1,
        expired: o.signupExpired === true,
        exports:
          o.signupExport === undefined
            ? []
            : [{ path: o.signupExport, fileType: "mp4", exists: true }],
      },
    },
  });
}

const card = (videoId: string) =>
  document.querySelector<HTMLElement>(`[data-video="${videoId}"]`);

async function invoiceCard(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const found = card(INVOICE);
    if (found === null) throw new Error("the invoice card is not drawn yet");
    return found;
  });
}

describe("library main — videos", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="notice" class="hidden" role="alert"></div>
      <main id="root"></main>
    `;
    memory = seed();
    state.memory = memory;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("draws one card per video, showing its current version, with its versions newest first", async () => {
    // Red: draw a card per row (drop `cardsOf`) — four cards, and the
    // invoice's three versions are three cards.
    await import("../../../pages/entrypoints/library/main");
    const inv = await invoiceCard();
    expect(document.querySelectorAll("article[data-row]").length).toBe(2);
    expect(inv.getAttribute("data-row")).toBe("inv-2");
    expect(inv.querySelector<HTMLInputElement>("[data-name]")?.value).toBe(
      "Create an invoice",
    );
    expect(inv.querySelector(".versions-count")?.textContent).toBe("3 videos");
    const rows = [...inv.querySelectorAll("[data-version-row]")];
    expect(rows.map((r) => r.getAttribute("data-version-row"))).toEqual([
      "inv-3",
      "inv-2",
      "inv-1",
    ]);
    // A video of one version has nothing to choose between.
    expect(card(SIGNUP)?.querySelector("[data-versions]")).toBeNull();
  });

  it("an expired version says only how to record it again, and cannot be opened", async () => {
    await import("../../../pages/entrypoints/library/main");
    const inv = await invoiceCard();
    const expired = inv.querySelector('[data-version-row="inv-1"]');
    const live = inv.querySelector('[data-version-row="inv-2"]');
    // Red: draw the line on every version, or on none.
    // The call names the video, which the runner records again; never the
    // take (`run({ takeId })` is refused). Red: name the take.
    expect(expired?.querySelector("[data-rerun-line]")?.textContent).toBe(
      // The call is drawn as code, its backticks dropped.
      `Expired — ${refilmLine(INVOICE).replace(/`/g, "").replace(/^A/, "a")}`,
    );
    expect(live?.querySelector("[data-rerun-line]")).toBeNull();
    expect(expired?.querySelector('[data-action="edit"]')).toBeNull();
    expect(live?.querySelector('[data-action="edit"]')).not.toBeNull();
  });

  it("renaming the card renames the video, and a taken name is said on the card with the old name back", async () => {
    // Red: send the card's rename to scenes.put — no videos.rename call, and
    // the studio's nameTaken sentence never reaches the card.
    memory.answer("videos.rename", async () => {
      throw new Error('Another flow is already called "Sign up".');
    });
    await import("../../../pages/entrypoints/library/main");
    const field = (await invoiceCard()).querySelector(
      "[data-name]",
    ) as HTMLInputElement;
    field.value = "Sign up";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    const status = await vi.waitFor(() => {
      const text = card(INVOICE)?.querySelector("[data-status]")?.textContent;
      if (!text) throw new Error("no status yet");
      return text;
    });
    expect(status).toBe(
      'Couldn\'t rename: Another flow is already called "Sign up".',
    );
    expect(
      card(INVOICE)?.querySelector<HTMLInputElement>("[data-name]")?.value,
    ).toBe("Create an invoice");
    expect(
      memory.calls.filter((c) => c.member === "videos").map((c) => c.args),
    ).toEqual([[INVOICE, "Sign up"]]);
    expect(memory.putCalls()).toEqual([]);
  });

  it("a blank name on a video's card puts the name back and sends nothing", async () => {
    await import("../../../pages/entrypoints/library/main");
    const field = (await invoiceCard()).querySelector(
      "[data-name]",
    ) as HTMLInputElement;
    field.value = "   ";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(field.value).toBe("Create an invoice");
    expect(memory.calls.filter((c) => c.member === "videos")).toEqual([]);
  });

  it("Delete on the card deletes the video; Delete on a version deletes that take", async () => {
    // Red: send the card's Delete to scenes.remove with its take's id.
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    await import("../../../pages/entrypoints/library/main");
    const inv = await invoiceCard();
    (
      inv.querySelector(
        '[data-version-row="inv-3"] [data-action="delete"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(
        memory.calls
          .filter((c) => c.member === "scenes" && c.method === "remove")
          .map((c) => c.args),
      ).toEqual([["inv-3"]]);
    });
    // Red: ask DELETE_DEMO for both ("removes the video").
    expect(confirmDialog.ask.mock.calls[0]?.[0]).toEqual(
      deleteVideoOf(3, "Create an invoice"),
    );
    await vi.waitFor(() => {
      const said = document.querySelector("[data-toast-text]")?.textContent;
      if (said !== "Deleted the video") throw new Error(`toast: ${said}`);
    });
    (
      (await invoiceCard()).querySelector(
        '.row-title [data-action="delete"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(
        memory.calls.filter((c) => c.member === "videos").map((c) => c.args),
      ).toEqual([[INVOICE]]);
    });
    // The card says how many recordings go: the video's three.
    expect(confirmDialog.ask.mock.calls[1]?.[0]).toEqual(deleteFlow(3));
    await vi.waitFor(() => {
      if (card(INVOICE) !== null) throw new Error("the card is still drawn");
    });
    await vi.waitFor(() => {
      const said = document.querySelector("[data-toast-text]")?.textContent;
      if (said !== "Deleted the flow") throw new Error(`toast: ${said}`);
    });
  });

  it("an opened video stays open across a re-render", async () => {
    await import("../../../pages/entrypoints/library/main");
    const versions = (await invoiceCard()).querySelector(
      "[data-versions]",
    ) as HTMLDetailsElement;
    // Premise: it starts closed.
    expect(versions.open).toBe(false);
    versions.open = true;
    const before = memory.calls.filter((c) => c.method === "read").length;
    memory.emitTakes();
    await vi.waitFor(() => {
      const reads = memory.calls.filter((c) => c.method === "read").length;
      if (reads === before) throw new Error("no re-render yet");
    });
    await vi.waitFor(() => {
      const now =
        card(INVOICE)?.querySelector<HTMLDetailsElement>("[data-versions]");
      // A new element, still open. Red: drop `openVersions`.
      expect(now).not.toBe(versions);
      expect(now?.open).toBe(true);
    });
  });

  it("the card leads with the video's repo, is dated by its newest version, and each version lists its exports", async () => {
    await import("../../../pages/entrypoints/library/main");
    const inv = await invoiceCard();
    // Red: drop repoLabel from the card's line.
    expect(inv.querySelector("[data-meta]")?.textContent).toMatch(
      /^acme\/web · app\.test\/invoices · /,
    );
    expect(card(SIGNUP)?.querySelector("[data-meta]")?.textContent).toMatch(
      /^no repo · /,
    );
    // Last recorded is inv-3 (Oct 1), not the current inv-2 (Sep 20): the
    // card sits in October. Red: date the card by its current version.
    expect(inv.closest("[data-section]")?.getAttribute("data-section")).toBe(
      "month:2026-10",
    );
    // Premise: the current version is from another month.
    expect(inv.getAttribute("data-row")).toBe("inv-2");
    const files = [
      ...inv.querySelectorAll('[data-version-row="inv-2"] [data-export]'),
    ].map((e) => [e.textContent, e.hasAttribute("data-gone")]);
    // Red: drop exportsList from the version row.
    expect(files).toEqual([
      ["Create an invoice.mp4MP4", false],
      ["Create an invoice.gifGIF · gone", true],
    ]);
  });

  it("a video of one version lists its exports on the card", async () => {
    // Red (final review 14): draw exports only inside the versions fold —
    // a one-version video has no fold, so its export is nowhere.
    memory = seed({ signupExport: "/Users/me/Downloads/Sign up.mp4" });
    state.memory = memory;
    await import("../../../pages/entrypoints/library/main");
    await invoiceCard();
    const signup = card(SIGNUP);
    // Premise: one version, so no fold.
    expect(signup?.querySelector("[data-versions]")).toBeNull();
    expect(
      [...(signup?.querySelectorAll("[data-export]") ?? [])].map(
        (e) => e.textContent,
      ),
    ).toEqual(["Sign up.mp4MP4"]);
  });

  it("an expired recording on the card offers no Edit, and the card does not open it", async () => {
    // Red: draw the card's Edit whatever the take — it opens an editor
    // with nothing to play.
    memory = seed({ signupExpired: true });
    state.memory = memory;
    const nav = captureNavigations();
    await import("../../../pages/entrypoints/library/main");
    const signup = await vi.waitFor(() => {
      const found = card(SIGNUP);
      if (found === null) throw new Error("no card yet");
      return found;
    });
    expect(signup.querySelector('[data-action="edit"]')).toBeNull();
    expect(signup.querySelector("[data-rerun-line]")?.textContent).toBe(
      `Expired — ${refilmLine(SIGNUP).replace(/`/g, "").replace(/^A/, "a")}`,
    );
    try {
      signup.click();
      // Premise: a card that can be opened is, by the same click.
      (await invoiceCard()).click();
      expect(nav.assigned).toEqual(["/editor.html?scene=inv-2"]);
    } finally {
      nav.restore();
    }
  });

  it("a version's status is said on its row, not also on the card", async () => {
    // Red: let the card fall back to the take it shows — the refusal reads
    // twice.
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    memory.answer("scenes.remove", async () => ({
      ok: false,
      error: "takeBusy",
      detail: "This video is being exported by an agent",
    }));
    await import("../../../pages/entrypoints/library/main");
    (
      (await invoiceCard()).querySelector(
        '[data-version-row="inv-2"] [data-action="delete"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      const row = card(INVOICE)?.querySelector(
        '[data-version-row="inv-2"] [data-status]',
      );
      if (!row) throw new Error("no status on the row yet");
    });
    expect(card(INVOICE)?.querySelectorAll("[data-status]").length).toBe(1);
  });

  it("a video delete that stopped part-way says Partly deleted on the page", async () => {
    // Red: drop the `partly` branch — the page reads it as a clean delete.
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    memory.answer("videos.remove", async () => ({
      ok: true,
      partly: "only 1 of its 3 videos went, then one was refused",
    }));
    await import("../../../pages/entrypoints/library/main");
    (
      (await invoiceCard()).querySelector(
        '.row-title [data-action="delete"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(document.querySelector("#notice")?.textContent).toBe(
        "Partly deleted: only 1 of its 3 videos went, then one was refused.",
      );
    });
  });

  it("a Couldn't-read row deletes what it is: a record alone, or nothing for a failed upkeep", async () => {
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    memory = seed({
      unreadable: [
        { folder: "joining videos to flows", reason: "EACCES", kind: "upkeep" },
        { folder: "expiring old videos", reason: "EACCES", kind: "upkeep" },
        {
          folder: "0b5d2a6e-1c3f-4e8a-9b7d-2f4c6a8e0b1d",
          reason: "not JSON",
          kind: "video",
        },
      ],
    });
    state.memory = memory;
    await import("../../../pages/entrypoints/library/main");
    const rows = await vi.waitFor(() => {
      const found = [...document.querySelectorAll("[data-unreadable-row]")];
      if (found.length !== 3) throw new Error(`${found.length} rows`);
      return found;
    });
    // Red: give every row a Delete.
    expect(
      rows.map((r) => [
        r.getAttribute("data-unreadable-row"),
        r.querySelector('[data-action="delete"]') !== null,
      ]),
    ).toEqual([
      ["joining videos to flows", false],
      ["expiring old videos", false],
      ["0b5d2a6e-1c3f-4e8a-9b7d-2f4c6a8e0b1d", true],
    ]);
    (
      (rows[2] as Element).querySelector(
        '[data-action="delete"]',
      ) as HTMLButtonElement
    ).click();
    // Red: send it to the take delete ("There is no take…").
    await vi.waitFor(() => {
      expect(
        memory.calls.filter((c) => c.member === "videos").map((c) => c.args),
      ).toEqual([["0b5d2a6e-1c3f-4e8a-9b7d-2f4c6a8e0b1d"]]);
    });
    expect(confirmDialog.ask.mock.calls[0]?.[0]).toEqual(DELETE_RECORD);
  });
});
