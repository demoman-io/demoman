import type { CiState, RepoFoldersAnswer } from "@demoman/studio-protocol";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import libraryHtml from "../../../pages/entrypoints/library/index.html?raw";
import type { CiEvent, RepoEvent } from "../../../pages/src/platform/types";
import { spinner } from "../../../pages/src/shell/icons";
import {
  openRepoSheet,
  type RepoCiDoor,
  type RepoSheetResult,
} from "../../../pages/src/shell/repo-sheet";
import { mountShell, pageParts } from "../helpers/shell-css";

/**
 * The Add to repo sheet itself in Chromium (DEM-47, 49, 50, 56, 59): the
 * form, the folder list, the added state with its labelled files, and the
 * finished state after Open pull request. The CI steps have their own file.
 */
const { css } = pageParts(libraryHtml, "article.card:hover");
const SHOTS = "__screenshots__/repo-sheet-add";

const WRITTEN = [
  "docs/demos/filter-invoices.mp4",
  ".demoman/flows/filter-invoice.json",
  ".demoman/receipts/filter-invoice.json",
  ".demoman/receipts/filter-invoice.screens",
];
const PR = "https://github.com/o/r/pull/8";

interface Opened {
  dialog: HTMLDialogElement;
  result: Promise<RepoSheetResult>;
  reveals: string[];
  /** Ends the add; the sheet then draws its added state. */
  land(notes?: string[]): void;
  /** Whether the sheet listens to its add's events yet. */
  listening(): boolean;
}

async function open(o: {
  folders?: () => Promise<RepoFoldersAnswer>;
  reveal?: (path: string) => Promise<void>;
  ci?: CiState;
}): Promise<Opened> {
  const reveals: string[] = [];
  let tell: ((e: RepoEvent) => void) | null = null;
  const ci: RepoCiDoor = {
    state: async () => o.ci ?? { kind: "setUp" },
    plan: async () => ({ jobId: "j" }),
    apply: async () => ({ jobId: "j" }),
    openPr: async (b) => ({
      opened: { number: 8, url: PR, branch: b.branch, sha: "s" },
    }),
    onCi: (_job, _f: (e: CiEvent) => void) => () => {},
  };
  const result = openRepoSheet({
    video: { id: "v1", name: "Filter invoices" },
    repo: {
      folders:
        o.folders ??
        (async () => ({
          folders: ["docs", "docs/demos", "public/media"],
          more: false,
        })),
      addable: async () => ({
        ok: true,
        root: "/r",
        defaultPath: "docs/demos/filter-invoices.mp4",
      }),
      add: async () => ({ jobId: "a" }),
      remove: async () => ({ removed: [], exportsLeft: [], notes: [] }),
      onRepo: (_job, fn) => {
        tell = fn;
        return () => {};
      },
    },
    ci,
    reveal:
      o.reveal ??
      (async (p) => {
        reveals.push(p);
      }),
  });
  const dialog = await vi.waitFor(() => {
    const d = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (d === null) throw new Error("no sheet");
    return d;
  });
  return {
    dialog,
    result,
    reveals,
    listening: () => tell !== null,
    land: (notes = []) =>
      tell?.({
        type: "repo",
        videoId: "v1",
        jobId: "a",
        phase: "added",
        marked: true,
        file: ".demoman/flows/filter-invoice.json",
        written: WRITTEN,
        notes,
        root: "/r",
        key: null,
      }),
  };
}

const el = <T extends Element>(d: ParentNode, sel: string): Promise<T> =>
  vi.waitFor(() => {
    const found = d.querySelector<T>(sel);
    if (found === null) throw new Error(`no ${sel}`);
    return found;
  });

/** No child of the dialog runs past its sides, and the dialog is on screen. */
function inside(dialog: HTMLDialogElement): void {
  expect(dialog.scrollWidth, "no sideways scroll").toBeLessThanOrEqual(
    dialog.clientWidth,
  );
  const box = dialog.getBoundingClientRect();
  for (const c of dialog.querySelectorAll<HTMLElement>("form *")) {
    const r = c.getBoundingClientRect();
    if (r.width === 0) continue;
    expect(r.right, `${c.tagName}.${c.className} right`).toBeLessThanOrEqual(
      box.right + 0.5,
    );
  }
}

async function added(o: Parameters<typeof open>[0] = {}, notes?: string[]) {
  const s = await open(o);
  (await el<HTMLButtonElement>(s.dialog, "[data-repo-add]")).click();
  await vi.waitFor(() => expect(s.listening()).toBe(true));
  s.land(notes);
  await el(s.dialog, "[data-repo-written]");
  return s;
}

afterEach(() => {
  for (const d of document.querySelectorAll("dialog")) d.remove();
  for (const p of document.querySelectorAll("[popover]")) p.remove();
  document.querySelector("[data-toast]")?.remove();
});

for (const scheme of ["light", "dark"] as const) {
  describe(`the add sheet, ${scheme}, 1280×800`, () => {
    beforeEach(async () => {
      await page.viewport(1280, 800);
      mountShell(scheme, css);
    });
    const shot = (name: string) =>
      page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });

    // Red if the form loses a field, the .mp4, or the Video line stops following the toggle (DEM-50).
    it("the form draws Folder, File name with .mp4, the Video toggle with its line, and Quality", async () => {
      const { dialog } = await open({});
      const folder = await el<HTMLInputElement>(dialog, "[data-repo-folder]");
      expect(folder.value).toBe("docs/demos");
      const name = await el<HTMLInputElement>(dialog, "[data-repo-name]");
      expect(name.value).toBe("filter-invoices");
      expect(dialog.querySelector("[data-repo-ext]")?.textContent).toBe(".mp4");
      const words = [...dialog.querySelectorAll(".repo-field-label")].map(
        (n) => n.textContent,
      );
      expect(words).toEqual(["Folder", "File name", "Video", "Quality"]);
      const said = () => dialog.querySelector("[data-repo-said]")?.textContent;
      expect(said()).toBe(
        "The video goes in the repo. A refresh commits a new one when the picture changes.",
      );
      inside(dialog);
      await shot("form");
      (
        dialog.querySelector('[data-repo-deliver="files"]') as HTMLElement
      ).click();
      await vi.waitFor(() =>
        expect(said()).toBe(
          "The video stays out of git. A refresh writes it to a folder for you to upload.",
        ),
      );
      expect(
        dialog
          .querySelector('[data-repo-deliver="files"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");
      // Files writes a file name only: no Folder to fill.
      expect(dialog.querySelector("[data-repo-folder]")).toBeNull();
    });

    // Red if a toggle's redraw drops keyboard focus to the body.
    it("a toggle pressed from the keyboard keeps focus on the new toggle", async () => {
      const { dialog } = await open({});
      const files = await el<HTMLElement>(
        dialog,
        '[data-repo-deliver="files"]',
      );
      files.focus();
      expect(document.activeElement, "premise: Files has focus").toBe(files);
      await userEvent.keyboard(" ");
      await vi.waitFor(() =>
        expect(
          dialog
            .querySelector('[data-repo-deliver="files"]')
            ?.getAttribute("aria-checked"),
        ).toBe("true"),
      );
      const now = dialog.querySelector('[data-repo-deliver="files"]');
      expect(now, "premise: the redraw replaced the button").not.toBe(files);
      expect(document.activeElement).toBe(now);
    });

    // Red if the folder button stops listing the repo's folders, or a pick does not fill Folder (DEM-50).
    it("the folder button lists the repo's folders and a pick fills Folder", async () => {
      const { dialog } = await open({});
      (await el<HTMLElement>(dialog, '[aria-label="Choose folder"]')).click();
      const list = await el<HTMLElement>(document, "[data-repo-folders]");
      await vi.waitFor(() =>
        expect(list.querySelectorAll("button")).toHaveLength(3),
      );
      expect(list.matches(":popover-open")).toBe(true);
      const box = list.getBoundingClientRect();
      expect(box.height, "the list is painted").toBeGreaterThan(40);
      await shot("picker");
      const media = [...list.querySelectorAll("button")].find(
        (b) => b.textContent === "public/media",
      ) as HTMLElement;
      media.click();
      const folder = await el<HTMLInputElement>(dialog, "[data-repo-folder]");
      expect(folder.value).toBe("public/media");
      expect(list.matches(":popover-open")).toBe(false);
    });

    // Red if a folder list that fails is silent, or locks the field (report before you forgive).
    it("a folder list that fails says so in the picker", async () => {
      const { dialog } = await open({
        folders: async () => {
          throw new Error(
            "The repo's folders could not be listed: no commits yet.",
          );
        },
      });
      (await el<HTMLElement>(dialog, '[aria-label="Choose folder"]')).click();
      const list = await el<HTMLElement>(document, "[data-repo-folders]");
      await vi.waitFor(() =>
        expect(list.textContent).toContain("no commits yet"),
      );
      const folder = await el<HTMLInputElement>(dialog, "[data-repo-folder]");
      expect(folder.disabled).toBe(false);
    });

    // Red if a failed folder read is kept, so the picker repeats it and never asks again.
    it("a folder list that failed is read again on the next open", async () => {
      let asked = 0;
      const { dialog } = await open({
        folders: async () => {
          asked += 1;
          if (asked === 1) throw new Error("index.lock exists");
          return { folders: ["docs"], more: false };
        },
      });
      const choose = await el<HTMLElement>(
        dialog,
        '[aria-label="Choose folder"]',
      );
      choose.click();
      const list = await el<HTMLElement>(document, "[data-repo-folders]");
      await vi.waitFor(() =>
        expect(list.textContent).toContain("index.lock exists"),
      );
      list.hidePopover();
      choose.click();
      await vi.waitFor(() =>
        expect(list.querySelectorAll("button")).toHaveLength(1),
      );
      expect(asked).toBe(2);
    });

    // Red if a written file loses its label, or Reveal stops naming the whole path (DEM-49, DEM-56).
    it("the added state labels each file and reveals it", async () => {
      const s = await added();
      const labels = [
        ...s.dialog.querySelectorAll("[data-repo-written] dt"),
      ].map((n) => n.textContent);
      expect(labels).toEqual(["Video", "Recipe", "Receipt", "Screens"]);
      expect(
        s.dialog.querySelector("[data-repo-added]")?.textContent,
      ).toContain("4 files");
      inside(s.dialog);
      await shot("added");
      (
        s.dialog.querySelector('[aria-label="Reveal Recipe"]') as HTMLElement
      ).click();
      await vi.waitFor(() =>
        expect(s.reveals).toEqual(["/r/.demoman/flows/filter-invoice.json"]),
      );
    });

    // Red if a refused reveal is only logged (DEM-56: Reveal did nothing).
    it("a refused reveal is said under its row", async () => {
      const s = await added({
        reveal: async () => {
          throw new Error(
            "/r/.demoman/flows/filter-invoice.json is not an export any video lists, so it is not shown.",
          );
        },
      });
      (
        s.dialog.querySelector('[aria-label="Reveal Recipe"]') as HTMLElement
      ).click();
      const said = await el<HTMLElement>(s.dialog, "[data-reveal-error]");
      expect(said.textContent).toContain("is not an export any video lists");
      expect(
        said.previousElementSibling?.getAttribute("aria-label"),
        "under the Recipe row",
      ).toBe("Reveal Recipe");
    });

    // Red if the sheet draws a note twice or drops the one it is given (DEM-49).
    it("draws each note it is given once", async () => {
      const s = await added({}, ["1x is a guess: set scale in the recipe."]);
      expect(s.dialog.querySelectorAll("[data-repo-note]")).toHaveLength(1);
    });

    // Red if Open pull request leaves anything but Done, or loses the link (DEM-59).
    it("after Open pull request only Done is left", async () => {
      const s = await added();
      (await el<HTMLElement>(s.dialog, "[data-repo-pr]")).click();
      const link = await el<HTMLAnchorElement>(s.dialog, `a[href="${PR}"]`);
      expect(link.textContent).toBe("Pull request #8");
      const buttons = [
        ...s.dialog.querySelectorAll(".confirm-actions button"),
      ].map((b) => b.textContent);
      expect(buttons).toEqual(["Done"]);
      expect(s.dialog.querySelector("details[data-repo-added]")).not.toBeNull();
      inside(s.dialog);
      await shot("finished");
      (s.dialog.querySelector("[data-repo-done]") as HTMLElement).click();
      expect((await s.result).prOpened).toBe(PR);
    });

    it("shoots the checking state", async () => {
      const result = openRepoSheet({
        video: { id: "v1", name: "Filter invoices" },
        repo: {
          folders: async () => ({ folders: [], more: false }),
          addable: () => new Promise(() => {}),
          add: async () => ({ jobId: "a" }),
          remove: async () => ({ removed: [], exportsLeft: [], notes: [] }),
          onRepo: () => () => {},
        },
        ci: null,
      });
      const dialog = await el<HTMLDialogElement>(document, "dialog[open]");
      expect(dialog.textContent).toContain("Checking…");
      // DEM-80: the wait has a spinner beside its words, painted and turning.
      // Red without repo-sheet.ts's `line.prepend(spinner())`.
      const spin = dialog.querySelector<SVGElement>(
        "[data-repo-line] .spinner",
      );
      expect(spin, "a spinner on the wait's line").not.toBeNull();
      // Computed, not the rect: a turning square's rect grows with its angle.
      const css = spin === null ? null : getComputedStyle(spin);
      expect([css?.width, css?.height]).toEqual(["16px", "16px"]);
      expect(spin?.checkVisibility({ opacityProperty: true })).toBe(true);
      expect(
        spin?.getAnimations().map((a) => a.playState),
        "the spinner turns",
      ).toEqual(["running"]);
      // A rebuilt spinner carries on where the last one was: both turn on
      // the document's clock. Red without `turn.startTime = 0`.
      const later = spinner();
      document.body.append(later);
      const at = (svg: SVGElement | null) =>
        Number(svg?.getAnimations()[0]?.currentTime);
      expect(at(later)).toBeGreaterThan(0);
      expect(Math.abs(at(later) - at(spin))).toBeLessThan(50);
      later.remove();
      await shot("checking");
      (dialog.querySelector("[data-repo-cancel]") as HTMLElement).click();
      expect((await result).added).toBeNull();
    });
  });
}
