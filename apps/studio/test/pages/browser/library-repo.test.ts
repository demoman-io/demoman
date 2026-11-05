import type { SceneDocument } from "@demoman/scene-schema";
import type { Addable, VideoSummary } from "@demoman/studio-protocol";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import libraryHtml from "../../../pages/entrypoints/library/index.html?raw";
import type { RepoEvent } from "../../../pages/src/platform/types";
import {
  CARDS,
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";
import { mountShell, pageParts } from "../helpers/shell-css";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

/**
 * The library's Add to repo and Remove from repo, through the real page and
 * the real dialogs in Chromium. The shots go to the scratchpad the task named.
 */

const { css, body } = pageParts(libraryHtml, "article.card:hover");
const SHOTS = "__screenshots__/library-repo";

const scene = (id: string, name: string): SceneDocument =>
  ({
    meta: {
      id,
      name,
      createdAt: "2026-09-01T00:00:00Z",
      capture: { originUrl: "https://app.test/x" },
    },
  }) as unknown as SceneDocument;

const video = (id: string, name: string, extra: object = {}): VideoSummary =>
  ({
    id,
    name,
    repo: { unknown: true },
    startPage: "https://app.test/",
    versions: 1,
    current: null,
    pages: [],
    steps: [],
    exports: [],
    kept: null,
    addedTo: null,
    ...extra,
  }) as unknown as VideoSummary;

const OK: Addable = { ok: true, root: "/r", defaultPath: "docs/demos/c.mp4" };
const NO: Addable = {
  ok: false,
  reason: "hasTrim",
  label: "has a trim",
  detail: "This flow has a trim, which a repo flow cannot carry.",
};

interface Flow {
  id: string;
  name: string;
  addable?: Addable;
  video?: object;
}

let memory: MemoryPlatform;
let runs = 0;

async function mountLibrary(flows: Flow[]): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = body;
  memory = createMemoryPlatform({ libraryView: CARDS });
  state.memory = memory;
  memory.answer("folder.read", async () => ({
    scenes: flows.map((f) => scene(`s-${f.id}`, f.name)),
    videos: flows.map((f) => video(f.id, f.name, f.video)),
    videoOf: Object.fromEntries(
      flows.map((f) => [
        `s-${f.id}`,
        {
          videoId: f.id,
          version: 1,
          expired: false,
          exports: [],
          filmedCode: null,
        },
      ]),
    ),
    addable: Object.fromEntries(
      flows.flatMap((f) => (f.addable ? [[f.id, f.addable]] : [])),
    ),
    sizes: {},
    unreadable: [],
    unwatched: null,
  }));
  // A new query string is a new module: the lane keeps modules across tests.
  runs += 1;
  await import(
    /* @vite-ignore */ `../../../pages/entrypoints/library/main.ts?run=${runs}`
  );
}

const button = (action: string, flow: string): Promise<HTMLButtonElement> =>
  vi.waitFor(() => {
    const found = document.querySelector<HTMLButtonElement>(
      `[data-row="s-${flow}"] [data-action="${action}"]`,
    );
    if (found === null) throw new Error(`no ${action} on ${flow}`);
    return found;
  });

const dialog = (): HTMLDialogElement | null =>
  document.querySelector("dialog[open]");

/** How much the element's screenshot differs from its own corner pixel: its
 *  painted ink, so a dimmed glyph reads lower than a full one. */
async function paintedInk(el: Element): Promise<number> {
  const shot = await page.screenshot({
    element: el,
    save: false,
    base64: true,
  } as never);
  const base64 = (shot as unknown as { base64?: string }).base64 ?? shot;
  const bitmap = await createImageBitmap(
    await (await fetch(`data:image/png;base64,${base64}`)).blob(),
  );
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs((data[i + c] ?? 0) - (data[c] ?? 0));
    }
  }
  return sum;
}

beforeEach(async () => {
  await page.viewport(1100, 720);
});

afterEach(() => {
  for (const d of document.querySelectorAll("dialog")) d.remove();
  document.querySelector("[data-toast]")?.remove();
  vi.restoreAllMocks();
  vi.resetModules();
});

for (const scheme of ["light", "dark"] as const) {
  describe(`Add to repo, ${scheme}, in a 720 px window`, () => {
    beforeEach(() => mountShell(scheme, css));

    // Red if the disabled button loses aria-disabled, its label or its tooltip, or opens the sheet.
    it("shows a flow that cannot be added as a disabled button with its reason", async () => {
      await mountLibrary([
        { id: "yes", name: "Checkout", addable: OK },
        { id: "no", name: "Signup", addable: NO },
      ]);
      const off = await button("repo-add", "no");
      const on = await button("repo-add", "yes");
      expect(on.getAttribute("aria-disabled")).toBeNull();
      expect(on.getAttribute("aria-label")).toBe("Add to repo: Checkout");
      expect(off.getAttribute("aria-disabled")).toBe("true");
      expect(off.getAttribute("aria-label")).toBe("Can't add: has a trim");
      expect(off.title).toBe(NO.ok ? "" : NO.detail);
      off.click();
      await new Promise((r) => setTimeout(r, 100));
      expect(dialog()).toBeNull();

      // The painted result: both buttons draw, the disabled one dimmer.
      const article = document.querySelector<HTMLElement>('[data-row="s-yes"]');
      article?.dispatchEvent(new PointerEvent("pointerenter"));
      for (const el of document.querySelectorAll<HTMLElement>(".row-actions")) {
        el.style.opacity = "1";
      }
      const live = await paintedInk(on);
      const dim = await paintedInk(off);
      expect(dim).toBeGreaterThan(0);
      expect(dim).toBeLessThan(live);
      await page.screenshot({ path: `${SHOTS}/buttons-${scheme}.png` });
    });

    // Red if the full add stops ending on the toast's words.
    it("adds a flow through the sheet and ends on the toast", async () => {
      await mountLibrary([{ id: "yes", name: "Checkout", addable: OK }]);
      const sent: unknown[] = [];
      memory.videos.repo.add = async (_id, b) => {
        sent.push(b);
        return { jobId: "j1" };
      };
      memory.videos.repo.onRepo = (job, fn) => {
        const at = { type: "repo", videoId: "yes", jobId: job } as const;
        fn({ ...at, phase: "queued", position: 1 } as RepoEvent);
        setTimeout(
          () =>
            fn({
              ...at,
              phase: "added",
              file: "c.json",
              written: ["docs/demos/c.mp4"],
              notes: [],
              root: "/r",
            } as RepoEvent),
          50,
        );
        return () => {};
      };
      (await button("repo-add", "yes")).click();
      const sheet = await vi.waitFor(() => {
        const d = dialog();
        if (d === null) throw new Error("no sheet");
        return d;
      });
      expect(
        sheet.querySelector<HTMLInputElement>("[data-repo-path]")?.value,
      ).toBe("docs/demos/c.mp4");
      await page.screenshot({ path: `${SHOTS}/sheet-${scheme}.png` });
      const deliver = sheet.querySelector<HTMLSelectElement>(
        "[data-repo-deliver]",
      ) as HTMLSelectElement;
      await userEvent.selectOptions(deliver, "files");
      await userEvent.click(
        sheet.querySelector("[data-repo-add]") as HTMLElement,
      );
      await vi.waitFor(() => {
        expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
          'Added "Checkout" to the repo',
        );
      });
      expect(sent).toEqual([
        { path: "docs/demos/c.mp4", deliver: "files", quality: "share" },
      ]);
      expect(dialog()).toBeNull();
    });
  });
}

describe("a failed add, a refused one and Remove from repo", () => {
  beforeEach(() => mountShell("light", css));

  // Red if a failed add toasts, or stops saying its sentence on the row's status line.
  it("puts a failed add on the row's status line and shows no toast", async () => {
    await mountLibrary([{ id: "yes", name: "Checkout", addable: OK }]);
    memory.videos.repo.add = async () => ({ jobId: "j1" });
    memory.videos.repo.onRepo = (job, fn) => {
      setTimeout(
        () =>
          fn({
            type: "repo",
            videoId: "yes",
            jobId: job,
            phase: "failed",
            reason: "x",
            detail: "The repo is full.",
          }),
        20,
      );
      return () => {};
    };
    (await button("repo-add", "yes")).click();
    await vi.waitFor(() => {
      if (dialog() === null) throw new Error("no sheet");
    });
    await userEvent.click(
      document.querySelector("[data-repo-add]") as HTMLElement,
    );
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-row="s-yes"] [data-status]')?.textContent,
      ).toBe("Couldn't add: The repo is full.");
    });
    expect(document.querySelector("[data-toast]")).toBeNull();
    expect(dialog()).toBeNull();
  });

  // Red if a refusal after the click stops landing on the row's status line.
  it("says a refused add on the row's status line", async () => {
    await mountLibrary([{ id: "yes", name: "Checkout", addable: OK }]);
    memory.videos.repo.add = async () => {
      throw new Error("That flow is being added.");
    };
    (await button("repo-add", "yes")).click();
    await vi.waitFor(() => {
      if (dialog() === null) throw new Error("no sheet");
    });
    await userEvent.click(
      document.querySelector("[data-repo-add]") as HTMLElement,
    );
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-row="s-yes"] [data-status]')?.textContent,
      ).toBe("Couldn't add: That flow is being added.");
    });
  });

  // Red if Remove's confirmation stops naming the recipe or the exports that stay.
  it("asks before removing, names the exports, and toasts the removal", async () => {
    await mountLibrary([
      {
        id: "in",
        name: "Checkout",
        video: {
          kept: {
            file: "checkout.json",
            root: "/r",
            deliver: "commit",
            key: "k",
          },
          exports: [
            {
              takeId: "s-in",
              path: "docs/demos/checkout.mp4",
              fileType: "mp4",
              exists: true,
            },
          ],
        },
      },
    ]);
    // Premise: an In repo flow offers Remove and no Add.
    expect(document.querySelector('[data-action="repo-add"]')).toBeNull();
    memory.videos.repo.remove = async () => ({
      removed: ["checkout.json"],
      exportsLeft: ["docs/demos/checkout.mp4"],
      notes: [],
    });
    (await button("repo-remove", "in")).click();
    const ask = await vi.waitFor(() => {
      const d = dialog();
      if (d === null) throw new Error("no confirm");
      return d;
    });
    expect(ask.querySelector(".confirm-title")?.textContent).toBe(
      "Remove from repo",
    );
    const said = ask.querySelector(".confirm-body")?.textContent ?? "";
    expect(said).toContain("checkout.json");
    expect(said).toContain("docs/demos/checkout.mp4");
    await page.screenshot({ path: `${SHOTS}/remove-confirm-light.png` });
    await userEvent.click(
      ask.querySelector("[data-confirm-go]") as HTMLElement,
    );
    await vi.waitFor(() => {
      expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
        'Removed "Checkout" from the repo. Its exports stay',
      );
    });
  });
});
