import type { SceneDocument } from "@demoman/scene-schema";
import type { Addable, CiState, VideoSummary } from "@demoman/studio-protocol";
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
/** The listing's one answer (DEM-47): a flow recorded with no repo. */
const LOOSE: Addable = {
  ok: false,
  reason: "noCheckout",
  label: "not in a repo",
  detail:
    '"Signup" has no checkout to add to: it was recorded outside a git repo',
};
const NO: Addable = {
  ok: false,
  reason: "hasTrim",
  label: "has a trim",
  detail: "This flow has a trim, which a repo flow cannot carry.",
};

interface Flow {
  id: string;
  name: string;
  /** What the sheet's check answers; OK unless given. */
  addable?: Addable;
  /** What the listing says (only a flow with no repo, since DEM-47). */
  listed?: Addable;
  video?: object;
}

let memory: MemoryPlatform;
let runs = 0;

/** The listing a library over `flows` reads, none of them In repo. */
const listingOf = (flows: Flow[]) => ({
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
    flows.flatMap((f) => (f.listed ? [[f.id, f.listed]] : [])),
  ),
  sizes: {},
  unreadable: [],
  unwatched: null,
});

async function mountLibrary(
  flows: Flow[],
  /** Before the page loads: doors its first paint reads. */
  setup?: (m: MemoryPlatform) => void,
): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = body;
  memory = createMemoryPlatform({ libraryView: CARDS });
  state.memory = memory;
  memory.answer("folder.read", async () => listingOf(flows));
  // A new query string is a new module: the lane keeps modules across tests.
  memory.videos.repo.addable = async (id) =>
    flows.find((f) => f.id === id)?.addable ?? OK;
  setup?.(memory);
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

/** The sheet's Add, once its check answered with the form. */
const addButton = (): Promise<HTMLElement> =>
  vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      "dialog[open] [data-repo-add]",
    );
    if (found === null) throw new Error("no form");
    return found;
  });

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
        { id: "yes", name: "Checkout" },
        { id: "no", name: "Signup", listed: LOOSE },
      ]);
      const off = await button("repo-add", "no");
      const on = await button("repo-add", "yes");
      expect(on.getAttribute("aria-disabled")).toBeNull();
      expect(on.getAttribute("aria-label")).toBe("Add to repo: Checkout");
      expect(off.getAttribute("aria-disabled")).toBe("true");
      expect(off.getAttribute("aria-label")).toBe("Can't add: not in a repo");
      expect(off.title).toBe(LOOSE.ok ? "" : LOOSE.detail);
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
      await mountLibrary([{ id: "yes", name: "Checkout" }]);
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
              marked: true,
              file: "c.json",
              written: ["docs/demos/c.mp4"],
              notes: [],
              root: "/r",
              key: "github.com/o/r",
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
      const folder = await vi.waitFor(() => {
        const f = sheet.querySelector<HTMLInputElement>("[data-repo-folder]");
        if (f === null) throw new Error("no form");
        return f;
      });
      expect(folder.value).toBe("docs/demos");
      expect(
        sheet.querySelector<HTMLInputElement>("[data-repo-name]")?.value,
      ).toBe("c");
      await page.screenshot({ path: `${SHOTS}/sheet-${scheme}.png` });
      await userEvent.click(
        sheet.querySelector('[data-repo-deliver="files"]') as HTMLElement,
      );
      await userEvent.click(await addButton());
      await vi.waitFor(() => {
        expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
          'Added "Checkout" to the repo',
        );
      });
      expect(sent).toEqual([
        { path: "c.mp4", deliver: "files", quality: "share" },
      ]);
      expect(dialog()).toBeNull();
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
      await page.screenshot({ path: `${SHOTS}/remove-confirm-${scheme}.png` });
      await userEvent.click(
        ask.querySelector("[data-confirm-go]") as HTMLElement,
      );
      await vi.waitFor(() => {
        expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
          'Removed "Checkout" from the repo. Its exports stay',
        );
      });
    });

    // Red if the last step's buttons clip instead of scrolling in a short window with many notes.
    it("keeps a long last step's Done inside the dialog by scrolling", async () => {
      await page.viewport(1100, 600);
      await mountLibrary([{ id: "yes", name: "Checkout" }]);
      // A last step with no CI choice, so Done is the way out.
      memory.repoCi.state = async () => ({ kind: "noGh", detail: "No gh." });
      memory.videos.repo.add = async () => ({ jobId: "j1" });
      memory.videos.repo.onRepo = (job, fn) => {
        fn({
          type: "repo",
          videoId: "yes",
          jobId: job,
          phase: "added",
          marked: true,
          file: "c.json",
          written: ["docs/demos/c.mp4", "docs/demos/c.json"],
          notes: Array.from(
            { length: 14 },
            (_, i) =>
              `Note ${i + 1}: the scale was guessed from the recorded window, check it.`,
          ),
          root: "/r",
        } as RepoEvent);
        return () => {};
      };
      (await button("repo-add", "yes")).click();
      await vi.waitFor(() => {
        if (dialog() === null) throw new Error("no sheet");
      });
      await userEvent.click(await addButton());
      const done = await vi.waitFor(() => {
        const d = document.querySelector<HTMLElement>("[data-repo-done]");
        if (d === null) throw new Error("no last step");
        return d;
      });
      const box = dialog() as HTMLDialogElement;
      // Premise: the content is taller than the window, so it has to scroll.
      expect(box.scrollHeight).toBeGreaterThan(window.innerHeight);
      const edge = box.getBoundingClientRect();
      expect(edge.top).toBeGreaterThanOrEqual(0);
      expect(edge.bottom).toBeLessThanOrEqual(window.innerHeight);
      box.scrollTop = box.scrollHeight;
      const at = done.getBoundingClientRect();
      expect(at.bottom).toBeLessThanOrEqual(edge.bottom);
      expect(at.top).toBeGreaterThanOrEqual(edge.top);
      expect(document.elementFromPoint(at.left + 5, at.top + 5)).toBe(
        done.closest("button"),
      );
      await page.screenshot({
        path: `${SHOTS}/sheet-long-notes-${scheme}.png`,
      });
    });
  });
}

describe("a failed add, a refused one and Remove from repo", () => {
  beforeEach(() => mountShell("light", css));

  // Red if a failed add toasts, or stops saying its sentence on the row's status line.
  it("puts a failed add on the row's status line and shows no toast", async () => {
    await mountLibrary([{ id: "yes", name: "Checkout" }]);
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
    await userEvent.click(await addButton());
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
    await mountLibrary([{ id: "yes", name: "Checkout" }]);
    memory.videos.repo.add = async () => {
      throw new Error("That flow is being added.");
    };
    (await button("repo-add", "yes")).click();
    await vi.waitFor(() => {
      if (dialog() === null) throw new Error("no sheet");
    });
    await userEvent.click(await addButton());
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-row="s-yes"] [data-status]')?.textContent,
      ).toBe("Couldn't add: That flow is being added.");
    });
    // A refusal is not a success.
    expect(document.querySelector("[data-toast]")).toBeNull();
  });

  // Red if a running add stops disabling its button, or a second press adds again.
  it("guards a running add: disabled button, one add, Escape inert", async () => {
    await mountLibrary([{ id: "yes", name: "Checkout" }]);
    const adds: unknown[] = [];
    memory.videos.repo.add = async (_id, b) => {
      adds.push(b);
      return { jobId: "j1" };
    };
    let send: (e: RepoEvent) => void = () => {};
    memory.videos.repo.onRepo = (_job, fn) => {
      send = fn;
      return () => {};
    };
    const first = await button("repo-add", "yes");
    first.click();
    await vi.waitFor(() => {
      if (dialog() === null) throw new Error("no sheet");
    });
    await userEvent.click(await addButton());
    await vi.waitFor(() => {
      if (document.querySelector("[data-repo-line]") === null) {
        throw new Error("not running");
      }
    });
    const now = await button("repo-add", "yes");
    expect(now.getAttribute("aria-disabled")).toBe("true");
    expect(now.title).toBe("Adding to repo…");
    now.click();
    await new Promise((r) => setTimeout(r, 100));
    expect(adds).toHaveLength(1);
    expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
    // Escape does not let go of a running add.
    await userEvent.keyboard("{Escape}");
    expect(dialog()).not.toBeNull();
    // The stream failing ends it, in the house sentence, on the row.
    send({
      type: "repo",
      videoId: "yes",
      jobId: "j1",
      phase: "failed",
      reason: "studioGone",
      detail: "The Studio stopped — run npx demoman studio.",
    });
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-row="s-yes"] [data-status]')?.textContent,
      ).toBe("Couldn't add: The Studio stopped — run npx demoman studio.");
    });
    expect(dialog()).toBeNull();
    expect(document.querySelector("[data-toast]")).toBeNull();
  });

  // Red if the row hides Add from a flow the listing no longer checks (DEM-47).
  it("a flow the listing did not check offers Add", async () => {
    await mountLibrary([{ id: "yes", name: "Checkout" }]);
    const on = await button("repo-add", "yes");
    expect(on.getAttribute("aria-disabled")).toBeNull();
    expect(on.getAttribute("aria-label")).toBe("Add to repo: Checkout");
  });

  // Red if Add waits for the library to be read again before its sheet opens (DEM-47: 4–6 s).
  it("the sheet opens before the listing is read again", async () => {
    await mountLibrary([{ id: "yes", name: "Checkout" }]);
    const reads = { n: 0 };
    memory.answer("folder.read", () => {
      reads.n += 1;
      return new Promise(() => {});
    });
    (await button("repo-add", "yes")).click();
    await vi.waitFor(() => {
      if (dialog() === null) throw new Error("no sheet");
    });
    // Premise: had the press read the library first, it would still wait.
    expect(reads.n).toBe(0);
  });

  // Red if a second press while the sheet checks opens a second sheet.
  it("a second press while the sheet checks opens nothing", async () => {
    await mountLibrary([{ id: "yes", name: "Checkout" }]);
    memory.videos.repo.addable = () => new Promise(() => {});
    (await button("repo-add", "yes")).click();
    await vi.waitFor(() => {
      if (dialog() === null) throw new Error("no sheet");
    });
    (await button("repo-add", "yes")).click();
    await new Promise((r) => setTimeout(r, 100));
    expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
  });

  // Red if a check that refuses is not said on the row once the sheet closes.
  it("a refused check is said in the sheet and on the row", async () => {
    await mountLibrary([{ id: "yes", name: "Checkout", addable: NO }]);
    (await button("repo-add", "yes")).click();
    const said = await vi.waitFor(() => {
      const p = document.querySelector("dialog[open] [data-repo-refused]");
      if (p === null) throw new Error("no refusal");
      return p;
    });
    expect(said.textContent).toContain("has a trim");
    await userEvent.click(
      document.querySelector("dialog[open] [data-repo-cancel]") as HTMLElement,
    );
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-row="s-yes"] [data-status]')?.textContent,
      ).toBe(
        "Couldn't add: has a trim. This flow has a trim, which a repo flow cannot carry.",
      );
    });
  });

  // Red if a mark the library refused is painted as In repo (report before
  // you forgive: the add's own note says it will not show).
  it("an add whose mark failed does not show In repo", async () => {
    await mountLibrary([{ id: "yes", name: "Checkout" }]);
    memory.repoCi.state = async () => ({ kind: "noGh", detail: "No gh." });
    memory.videos.repo.add = async () => ({ jobId: "j1" });
    memory.videos.repo.onRepo = (job, fn) => {
      setTimeout(
        () =>
          fn({
            type: "repo",
            videoId: "yes",
            jobId: job,
            phase: "added",
            file: ".demoman/flows/c.json",
            written: ["docs/demos/c.mp4"],
            notes: ["the library could not mark it"],
            marked: false,
            root: "/r",
          } as RepoEvent),
        20,
      );
      return () => {};
    };
    (await button("repo-add", "yes")).click();
    await userEvent.click(await addButton());
    memory.answer("folder.read", () => new Promise(() => {}));
    const done = await vi.waitFor(() => {
      const d = document.querySelector<HTMLElement>("[data-repo-done]");
      if (d === null) throw new Error("no last step");
      return d;
    });
    await userEvent.click(done);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('[data-row="s-yes"] [data-kept]')).toBeNull();
  });

  // Red if a read that began before the mark landed paints the flow Not in
  // repo again after the add's own In repo (DEM-59).
  it("a read from before the mark does not take In repo away", async () => {
    const flows = [{ id: "yes", name: "Checkout" }];
    await mountLibrary(flows);
    memory.repoCi.state = async () => ({ kind: "noGh", detail: "No gh." });
    memory.videos.repo.add = async () => ({ jobId: "j1" });
    memory.videos.repo.onRepo = (job, fn) => {
      setTimeout(
        () =>
          fn({
            type: "repo",
            videoId: "yes",
            jobId: job,
            phase: "added",
            file: ".demoman/flows/c.json",
            written: ["docs/demos/c.mp4"],
            notes: [],
            marked: true,
            root: "/r",
            key: "github.com/o/r",
          } as RepoEvent),
        20,
      );
      return () => {};
    };
    (await button("repo-add", "yes")).click();
    await userEvent.click(await addButton());
    // Every read from here answers as if the mark had not landed yet.
    let stale = 0;
    memory.answer("folder.read", async () => {
      stale += 1;
      return listingOf(flows);
    });
    const done = await vi.waitFor(() => {
      const d = document.querySelector<HTMLElement>("[data-repo-done]");
      if (d === null) throw new Error("no last step");
      return d;
    });
    await userEvent.click(done);
    await vi.waitFor(() =>
      expect(stale, "a stale read landed").toBeGreaterThan(0),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(
      document.querySelector('[data-row="s-yes"] [data-kept]'),
      "In repo still shows",
    ).not.toBeNull();
  });

  // Red if In repo waits for the listing to come back after an add (DEM-59).
  it("In repo shows as soon as the sheet closes after an add", async () => {
    await mountLibrary([{ id: "yes", name: "Checkout" }]);
    // A last step with no CI choice, so Done is the way out.
    memory.repoCi.state = async () => ({ kind: "noGh", detail: "No gh." });
    memory.videos.repo.add = async () => ({ jobId: "j1" });
    memory.videos.repo.onRepo = (job, fn) => {
      setTimeout(
        () =>
          fn({
            type: "repo",
            videoId: "yes",
            jobId: job,
            phase: "added",
            file: ".demoman/flows/c.json",
            written: ["docs/demos/c.mp4"],
            notes: [],
            marked: true,
            root: "/r",
            key: "github.com/o/r",
          } as RepoEvent),
        20,
      );
      return () => {};
    };
    // Premise: before the add, the row is not In repo.
    expect(document.querySelector('[data-row="s-yes"] [data-kept]')).toBeNull();
    (await button("repo-add", "yes")).click();
    await userEvent.click(await addButton());
    // From here the listing never answers again.
    memory.answer("folder.read", () => new Promise(() => {}));
    const done = await vi.waitFor(() => {
      const d = document.querySelector<HTMLElement>("[data-repo-done]");
      if (d === null) throw new Error("no last step");
      return d;
    });
    await userEvent.click(done);
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-row="s-yes"] [data-kept]'),
      ).not.toBeNull();
    });
  });
});

describe("Set up CI beside a project's heading", () => {
  beforeEach(() => mountShell("dark", css));
  afterEach(() => history.replaceState(null, "", "/"));
  const KEY = "github.com/acme/web";
  const inRepo = {
    id: "in",
    name: "Checkout",
    video: {
      repo: { key: KEY },
      kept: {
        file: ".demoman/flows/c.json",
        root: "/r",
        deliver: "commit",
        key: KEY,
      },
    },
  };
  async function mountAt(place: string, state: () => Promise<CiState>) {
    history.replaceState(null, "", `/?project=${encodeURIComponent(place)}`);
    const asked: string[] = [];
    await mountLibrary([inRepo], (m) => {
      m.repoCi.state = async (root) => {
        asked.push(root);
        return state();
      };
    });
    return asked;
  }
  const ciButton = () => document.querySelector<HTMLElement>("[data-ci-setup]");

  // Red if a project with a flow in the repo and no CI offers no way in (DEM-52).
  it("a project with a flow in the repo and no CI offers Set up CI", async () => {
    const asked = await mountAt(KEY, async () => ({ kind: "notSetUp" }));
    const b = await vi.waitFor(() => {
      const found = ciButton();
      if (found === null) throw new Error("no Set up CI");
      return found;
    });
    expect(b.textContent).toBe("Set up CI");
    expect(asked).toContain("/r");
    b.click();
    const sheet = await vi.waitFor(() => {
      const d = document.querySelector("dialog[open][data-ci-sheet]");
      if (d === null) throw new Error("no CI sheet");
      return d;
    });
    expect(sheet.textContent).toContain("acme/web");
  });

  // Red if a repo already set up is offered setup again.
  it("a set-up repo offers no button", async () => {
    let answered = false;
    const asked = await mountAt(KEY, async () => {
      answered = true;
      return { kind: "setUp" };
    });
    await vi.waitFor(() => expect(answered).toBe(true));
    // The read's answer is painted on the task after it: no clock involved.
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toContain("/r");
    expect(ciButton()).toBeNull();
  });

  // Red if a failed state read hides the way in (it would read as set up).
  it("a CI state that cannot be read still offers Set up CI", async () => {
    await mountAt(KEY, async () => {
      throw new Error("gh died");
    });
    await vi.waitFor(() => {
      if (ciButton() === null) throw new Error("no Set up CI");
    });
  });

  // Red if a place that is not one project offers CI setup.
  it("All flows offers no button", async () => {
    const asked = await mountAt("all", async () => ({ kind: "notSetUp" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(asked).toEqual([]);
    expect(ciButton()).toBeNull();
  });
});
