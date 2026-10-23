import { commands, page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import editorHtml from "../../../pages/entrypoints/editor/index.html?raw";
import libraryHtml from "../../../pages/entrypoints/library/index.html?raw";
import {
  askToConfirm,
  type ConfirmQuestion,
} from "../../../pages/src/shell/confirm-dialog";
import type { PagePoint } from "../helpers/point-command";
import {
  contrast,
  luminance,
  mountShell,
  over,
  pageParts,
  parse,
  token,
} from "../helpers/shell-css";

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    /** See `test/helpers/point-command.ts`; registered in `vitest.config.ts`. */
    pressBetween: (from: PagePoint, to: PagePoint | null) => Promise<void>;
  }
}

/**
 * The page's own confirmation, in place of `window.confirm`, as Chrome
 * actually runs and paints it: a real `showModal()`, real keys, a real mouse.
 *
 * The node lane cannot hold any of this — jsdom has no `showModal` — so the
 * call sites there mock the module, and every claim about what the dialog
 * itself does lives here.
 */

const DELETE: ConfirmQuestion = {
  glyph: "trash",
  title: "Delete demo",
  body: "This permanently removes the video. It can’t be undone.",
  confirmLabel: "Delete",
  danger: true,
  focus: "cancel",
};

const REPLACE: ConfirmQuestion = {
  glyph: "refresh",
  title: "Replace brand kit",
  body: "This demo's background and logo replace it.",
  confirmLabel: "Replace",
  danger: false,
  focus: "confirm",
};

const dialog = (): HTMLDialogElement | null =>
  document.querySelector("dialog[data-confirm]");

const open = (): HTMLDialogElement => {
  const found = dialog();
  if (found === null || !found.open) throw new Error("no confirm dialog open");
  return found;
};

const cancelButton = (): HTMLButtonElement =>
  open().querySelector("[data-confirm-cancel]") as HTMLButtonElement;
const goButton = (): HTMLButtonElement =>
  open().querySelector("[data-confirm-go]") as HTMLButtonElement;

/** Settles to the answer, or to "pending" if the dialog has not answered —
 *  so a dialog that ignored the gesture fails with what it did instead of a
 *  test timeout. */
async function answer(asked: Promise<boolean>): Promise<boolean | "pending"> {
  return Promise.race([
    asked,
    new Promise<"pending">((resolve) => setTimeout(resolve, 500, "pending")),
  ]);
}

beforeEach(async () => {
  await page.viewport(1155, 896);
  mountShell("light", "");
  document.body.innerHTML = "<main><button id=opener>Delete</button></main>";
});

afterEach(() => {
  for (const d of document.querySelectorAll("dialog")) d.remove();
  vi.restoreAllMocks();
});

describe("askToConfirm", () => {
  it("opens modal, names itself by its title and body, and says both", async () => {
    void askToConfirm(DELETE);
    const d = open();
    expect(d.matches(":modal")).toBe(true);
    const labelled = document.getElementById(
      d.getAttribute("aria-labelledby") ?? "",
    );
    const described = document.getElementById(
      d.getAttribute("aria-describedby") ?? "",
    );
    expect(labelled?.textContent).toBe(DELETE.title);
    expect(described?.textContent).toBe(DELETE.body);
    expect(goButton().textContent).toBe("Delete");
    expect(cancelButton().textContent).toBe("Cancel");
  });

  it("answers true on its confirm button and false on Cancel, and leaves no dialog behind", async () => {
    const yes = askToConfirm(DELETE);
    await userEvent.click(goButton());
    expect(await answer(yes)).toBe(true);
    expect(dialog()).toBeNull();

    const no = askToConfirm(DELETE);
    await userEvent.click(cancelButton());
    expect(await answer(no)).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("answers false on Escape", async () => {
    const asked = askToConfirm(REPLACE);
    // Premise: Escape is pressed with focus on the CONFIRM button, so a
    // false here cannot be Enter-or-Space on Cancel by another name.
    expect(document.activeElement).toBe(goButton());
    await userEvent.keyboard("{Escape}");
    expect(await answer(asked)).toBe(false);
  });

  it("starts on Cancel for a deletion, so Enter cancels", async () => {
    const asked = askToConfirm(DELETE);
    expect(document.activeElement).toBe(cancelButton());
    await userEvent.keyboard("{Enter}");
    expect(await answer(asked)).toBe(false);
  });

  it("starts on the confirm button where the caller says so, so Enter confirms", async () => {
    const asked = askToConfirm(REPLACE);
    expect(document.activeElement).toBe(goButton());
    await userEvent.keyboard("{Enter}");
    expect(await answer(asked)).toBe(true);
  });

  it("answers false on a click on the backdrop, and not on a click inside the panel", async () => {
    const asked = askToConfirm(DELETE);
    const box = open().getBoundingClientRect();
    // Premise: the corner is outside the panel, so the press lands on the
    // backdrop and not on something the panel paints.
    expect(box.left).toBeGreaterThan(20);
    expect(box.top).toBeGreaterThan(20);

    // Inside the panel, on its body text: not a button, not the backdrop.
    const body = open().querySelector(".confirm-body") as HTMLElement;
    const text = body.getBoundingClientRect();
    await commands.pressBetween(
      { x: text.left + 4, y: text.top + text.height / 2 },
      null,
    );
    expect(await answer(asked)).toBe("pending");

    await commands.pressBetween({ x: 10, y: 10 }, null);
    expect(await answer(asked)).toBe(false);
  });

  it("does not cancel on a press that starts inside the panel and is released on the backdrop", async () => {
    // Selecting the body text by dragging past the panel's edge is a
    // gesture inside the dialog; Chrome lands its click on the dialog
    // element, the same target a backdrop click has.
    const asked = askToConfirm(DELETE);
    const body = open().querySelector(".confirm-body") as HTMLElement;
    const text = body.getBoundingClientRect();
    await commands.pressBetween(
      { x: text.left + 4, y: text.top + text.height / 2 },
      { x: 10, y: 10 },
    );
    expect(await answer(asked)).toBe("pending");
    await userEvent.click(cancelButton());
    expect(await answer(asked)).toBe(false);
  });

  it("gives focus back to what opened it", async () => {
    const opener = document.getElementById("opener") as HTMLButtonElement;
    opener.focus();
    expect(document.activeElement).toBe(opener);
    const asked = askToConfirm(DELETE);
    expect(document.activeElement).toBe(cancelButton());
    await userEvent.keyboard("{Escape}");
    expect(await answer(asked)).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("rejects, rather than answering No, when the dialog cannot open", async () => {
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(
      () => {
        throw new DOMException("refused for the test", "InvalidStateError");
      },
    );
    await expect(askToConfirm(DELETE)).rejects.toThrow("refused for the test");
    expect(dialog()).toBeNull();
  });
});

describe("the confirm dialog, as painted", () => {
  // Three windows: the editor's usual size, one short enough that the
  // preview used to overflow (CLAUDE.md), and a phone-narrow one.
  const windows: Array<[number, number]> = [
    [1155, 896],
    [1155, 420],
    [360, 640],
  ];

  for (const scheme of ["light", "dark"] as const) {
    for (const [w, h] of windows) {
      it(`sits inside a ${w}x${h} window in ${scheme}, both buttons painted on top`, async () => {
        await page.viewport(w, h);
        mountShell(scheme, "");
        void askToConfirm(DELETE);
        const d = open();
        const box = d.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(innerWidth);
        expect(box.bottom).toBeLessThanOrEqual(innerHeight);
        // Painted, not just placed: what is on top at each button's centre
        // is that button.
        for (const b of [cancelButton(), goButton()]) {
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          expect(b.contains(hit), `${b.textContent} is covered`).toBe(true);
        }
      });
    }

    it(`separates the panel from the dimmed page in ${scheme}, and fills Delete red under a white word`, async () => {
      mountShell(scheme, "");
      void askToConfirm(DELETE);
      const d = open();
      const page = parse(getComputedStyle(document.body).backgroundColor);
      const scrim = parse(getComputedStyle(d, "::backdrop").backgroundColor);
      // Premise: the scrim is a translucent dim, not nothing.
      expect(scrim[3]).toBeGreaterThan(0.3);
      const panel = parse(getComputedStyle(d).backgroundColor);
      // The floor the shortcuts overlay holds its own panel on a scrim to.
      expect(contrast(panel, over(scrim, page))).toBeGreaterThanOrEqual(1.15);

      // Delete is the one filled button: deep red under a white word, the
      // same red in both themes.
      const go = getComputedStyle(goButton());
      const red = parse(go.backgroundColor);
      expect(red).toEqual(parse("rgb(180, 35, 24)"));
      expect(parse(go.color)).toEqual(parse("rgb(255, 255, 255)"));
      expect(contrast(parse(go.color), red)).toBeGreaterThanOrEqual(4.5);
      // Its glyph is the trash, stroked white with its word.
      const glyph = goButton().querySelector("svg") as SVGSVGElement;
      expect(glyph.getAttribute("data-icon")).toBe("trash");
      expect(parse(getComputedStyle(glyph).stroke)).toEqual(parse(go.color));
      // And Cancel is not: it keeps the quiet fill, so the red is Delete's
      // alone.
      expect(
        parse(getComputedStyle(cancelButton()).backgroundColor),
      ).not.toEqual(red);

      // Darker under a real pointer.
      await userEvent.hover(goButton());
      const hovered = parse(getComputedStyle(goButton()).backgroundColor);
      // Premise: the pointer is on it.
      expect(goButton().matches(":hover")).toBe(true);
      expect(hovered).toEqual(parse("rgb(143, 28, 19)"));
      expect(luminance(hovered)).toBeLessThan(luminance(red));
    });

    it(`leaves a question that destroys nothing in Cancel's tone in ${scheme}`, async () => {
      mountShell(scheme, "");
      void askToConfirm(REPLACE);
      const go = goButton();
      expect(go.querySelector("svg")?.getAttribute("data-icon")).toBe(
        "refresh",
      );
      expect(parse(getComputedStyle(go).color)).toEqual(
        parse(getComputedStyle(cancelButton()).color),
      );
      // Premise: Cancel's tone is the ordinary ink, so the equality above
      // is not two red words agreeing.
      expect(parse(getComputedStyle(cancelButton()).color)).toEqual(
        token("--ink"),
      );
    });
  }

  it("lays out as the consent card's type and buttons, heading first", async () => {
    void askToConfirm(DELETE);
    const d = open();
    const box = d.getBoundingClientRect();
    const title = d.querySelector(".confirm-title") as HTMLElement;
    expect(getComputedStyle(title).fontFamily).toMatch(/^"?Outfit/);
    expect(getComputedStyle(title).textAlign).toBe("center");
    // Nothing above the heading: no avatar, no brand strip. It is the
    // form's first child and sits on the panel's own top padding.
    expect(d.querySelector("form")?.firstElementChild).toBe(title);
    expect(title.getBoundingClientRect().top - box.top).toBe(28);

    const cancel = cancelButton().getBoundingClientRect();
    const go = goButton().getBoundingClientRect();
    expect(Math.abs(cancel.width - go.width)).toBeLessThan(1);
    expect(cancel.top).toBe(go.top);
    expect(cancel.right).toBeLessThan(go.left);
    // Together they span the panel's content, not a corner of it.
    expect(go.right - cancel.left).toBeGreaterThan(box.width - 2 * 28 - 1);
  });

  it("puts a glyph before each answer's word: the close cross on Cancel, the caller's on the other", async () => {
    void askToConfirm(DELETE);
    for (const [button, glyph, word] of [
      [cancelButton(), "close", "Cancel"],
      [goButton(), "trash", "Delete"],
    ] as const) {
      const svg = button.querySelector("svg") as SVGSVGElement;
      expect(svg.getAttribute("data-icon")).toBe(glyph);
      // Decoration: the button's name is still its word alone.
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(button.textContent).toBe(word);
      const mark = svg.getBoundingClientRect();
      expect(mark.width).toBe(16);
      const range = document.createRange();
      range.selectNodeContents(button.lastChild as Text);
      const text = range.getBoundingClientRect();
      // Premise: the word is the button's last node and has a box.
      expect(text.width).toBeGreaterThan(0);
      // Before the word, on its line.
      expect(mark.right).toBeLessThanOrEqual(text.left);
      expect(
        Math.abs(mark.top + mark.height / 2 - (text.top + text.height / 2)),
      ).toBeLessThan(2);
    }
  });

  // The pages that ask, with their own stylesheets. A page's unlayered
  // element rules beat anything in the shell's layer, so a dialog measured
  // with no page CSS is not the dialog those pages paint: the editor's
  // `h2` rule once gave this heading 20px, weight 700 and no top margin
  // under a suite that mounted the shell alone.
  const pages: Array<[string, string, string]> = [
    ["editor", editorHtml, "h2 { margin: 0 0 12px"],
    ["library", libraryHtml, ".section-head"],
  ];
  for (const [name, html, carries] of pages) {
    for (const order of ["source", "build"] as const) {
      it(`keeps its own type and spacing on the ${name} page (${order} order)`, async () => {
        const { css } = pageParts(html, carries);
        mountShell("light", css, order);
        void askToConfirm(DELETE);
        const d = open();
        const title = getComputedStyle(
          d.querySelector(".confirm-title") as HTMLElement,
        );
        expect(title.fontSize).toBe("22px");
        // 700 like the editor's `h2` since titles all went bold
        // (2026-10-04), so the size and margins are what tell a leak apart.
        expect(title.fontWeight).toBe("700");
        // Both margins: the editor's `h2` gives 0 on top and 8px below, so
        // the top alone would agree with it by accident.
        expect(title.marginTop).toBe("0px");
        expect(title.marginBottom).toBe("0px");
        const body = getComputedStyle(
          d.querySelector(".confirm-body") as HTMLElement,
        );
        expect(body.fontSize).toBe("14px");
        expect(body.marginTop).toBe("8px");
        const go = getComputedStyle(goButton());
        expect(go.fontSize).toBe("14px");
        expect(go.paddingTop).toBe("10px");
        const glyph = goButton().querySelector("svg") as SVGSVGElement;
        expect(glyph.getBoundingClientRect().width).toBe(16);
      });
    }
  }

  it("rings the button Enter will press even when a mouse click opened the dialog", async () => {
    // `:focus-visible` drops the ring after a mouse click, and that is
    // exactly how Delete is reached — so the shell's own ring rule alone
    // would leave the author unable to see that Enter means Cancel.
    const opener = document.getElementById("opener") as HTMLButtonElement;
    let asked: Promise<boolean> | null = null;
    opener.addEventListener("click", () => {
      asked = askToConfirm(DELETE);
    });
    await userEvent.click(opener);
    expect(asked).not.toBeNull();
    const ring = getComputedStyle(cancelButton());
    expect(cancelButton().matches(":focus-visible")).toBe(false);
    expect(ring.outlineStyle).toBe("solid");
    expect(Number.parseFloat(ring.outlineWidth)).toBeGreaterThanOrEqual(2);
    // And the other button carries none, so the ring says which one.
    expect(getComputedStyle(goButton()).outlineStyle).toBe("none");
  });
});
