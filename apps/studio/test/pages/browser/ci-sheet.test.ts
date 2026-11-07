import type { CiState } from "@demoman/studio-protocol";
import { page } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import libraryHtml from "../../../pages/entrypoints/library/index.html?raw";
import { openCiSheet } from "../../../pages/src/shell/ci-sheet";
import type { RepoCiDoor } from "../../../pages/src/shell/ci-steps";
import { mountShell, pageParts } from "../helpers/shell-css";

/**
 * CI setup on its own (DEM-52): the sheet "Set up CI" beside a project's
 * heading opens, with no flow being added.
 */
const { css } = pageParts(libraryHtml, "article.card:hover");
const SHOTS = "__screenshots__/ci-sheet";

function door(state: CiState | Error): RepoCiDoor & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    state: async (root) => {
      asked.push(root);
      if (state instanceof Error) throw state;
      return state;
    },
    plan: async () => ({ jobId: "j" }),
    apply: async () => ({ jobId: "j" }),
    openPr: async () => ({ failed: "pr", detail: "" }),
    onCi: () => () => {},
  };
}

const el = <T extends Element>(sel: string): Promise<T> =>
  vi.waitFor(() => {
    const found = document.querySelector<T>(sel);
    if (found === null) throw new Error(`no ${sel}`);
    return found;
  });

afterEach(() => {
  for (const d of document.querySelectorAll("dialog")) d.remove();
});

for (const scheme of ["light", "dark"] as const) {
  describe(`the CI sheet, ${scheme}`, () => {
    beforeEach(async () => {
      await page.viewport(1280, 800);
      mountShell(scheme, css);
    });

    // Red if the CI sheet stops reading its repo's state, or a not-set-up repo offers no Check.
    it("opens on reading, then the form for a repo that is not set up", async () => {
      const d = door({ kind: "notSetUp" });
      const result = openCiSheet({ root: "/r", name: "acme/web", ci: d });
      const dialog = await el<HTMLDialogElement>("dialog[open][data-ci-sheet]");
      expect(dialog.querySelector(".confirm-title")?.textContent).toBe(
        "Set up CI",
      );
      expect(dialog.textContent).toContain("acme/web");
      await el("dialog[open] [data-ci-check]");
      expect(d.asked).toEqual(["/r"]);
      await page.screenshot({ path: `${SHOTS}/form-${scheme}.png` });
      (dialog.querySelector("[data-ci-done]") as HTMLElement).click();
      expect(await result).toEqual({ prOpened: null });
    });

    // Red if a close the sheet did not ask for (the browser's second Escape)
    // leaves its result hanging, and the page's CI state never read again.
    it("a forced close while a job runs still settles", async () => {
      const result = openCiSheet({
        root: "/r",
        name: "acme/web",
        ci: door({ kind: "running", jobId: "j" }),
      });
      const dialog = await el<HTMLDialogElement>("dialog[open][data-ci-sheet]");
      await el("dialog[open] [data-ci-status]");
      // Premise: a job runs, so Done is held.
      expect(
        (dialog.querySelector("[data-ci-done]") as HTMLButtonElement).disabled,
      ).toBe(true);
      dialog.close();
      expect(await result).toEqual({ prOpened: null });
    });

    // Red if a set-up repo is offered setup again, or not told it is set up.
    it("a set-up repo says so with Done only", async () => {
      openCiSheet({
        root: "/r",
        name: "acme/web",
        ci: door({ kind: "setUp" }),
      });
      const said = await el("dialog[open] [data-ci-set-up]");
      expect(said.textContent).toBe("CI is set up.");
      const buttons = [
        ...document.querySelectorAll("dialog[open] .confirm-actions button"),
      ].map((b) => b.textContent);
      expect(buttons).toEqual(["Done"]);
    });

    // Red if a state that cannot be read is hidden instead of said (report before you forgive).
    it("a noGh state says its detail", async () => {
      openCiSheet({
        root: "/r",
        name: "acme/web",
        ci: door({ kind: "noGh", detail: "Run gh auth login." }),
      });
      const note = await el("dialog[open] [data-ci-note]");
      expect(note.textContent).toBe("Run gh auth login.");
    });
  });
}
