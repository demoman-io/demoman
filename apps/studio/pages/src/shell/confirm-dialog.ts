// apps/studio/pages/src/shell/confirm-dialog.ts
import { type GlyphName, icon } from "./icons";

/** What a confirmation asks, and which way it leans. */
export interface ConfirmQuestion {
  /** The glyph before the yes button's word. Cancel always carries the
   *  close glyph, so the two answers read as a pair. */
  glyph: GlyphName;
  /** The action, as the dialog's heading: "Delete demo". A statement, not
   *  a question — the buttons are where the asking happens. */
  title: string;
  /** What saying yes does, in a sentence or two. */
  body: string;
  /** The verb on the yes button — "Delete", "Replace" — never "OK". */
  confirmLabel: string;
  /** Fills the yes button red, under a white word and glyph. */
  danger: boolean;
  /** Which button holds focus when the dialog opens, and so which one Enter
   *  presses. Required rather than defaulted: a stray Enter on a deletion
   *  must be a decision the caller made, not one it inherited. */
  focus: "cancel" | "confirm";
}

/**
 * Deleting a demo, from Recordings or from the editor. One question for
 * both: the two `window.confirm` strings it replaced had already drifted.
 * Focus starts on Cancel, so an Enter that was meant for something else
 * deletes nothing.
 */
export const DELETE_DEMO: ConfirmQuestion = {
  glyph: "trash",
  title: "Delete video",
  body: "This permanently removes the video. It can’t be undone.",
  confirmLabel: "Delete",
  danger: true,
  focus: "cancel",
};

/** One video of a flow, from its row under the flow's card. */
export const deleteVideoOf = (
  number: number | undefined,
  flow: string,
): ConfirmQuestion => ({
  ...DELETE_DEMO,
  title: "Delete video",
  body: `This permanently removes ${number === undefined ? "this video" : `Video ${number}`} of ${flow}. It can’t be undone.`,
});

/** A whole flow, from its card: every video goes with it. */
export const deleteFlow = (videos: number): ConfirmQuestion => ({
  ...DELETE_DEMO,
  title: "Delete flow",
  body: `This permanently removes the flow and ${videos === 1 ? "its video" : `its ${videos} videos`}. It can’t be undone.`,
});

/** The flows ticked in the library, every video of each going with it
 *  (spec 2026-10-30 flows-and-bulk-delete §1.2). One question for all. */
export const deleteFlows = (flows: number, videos: number): ConfirmQuestion => {
  const f = `${flows} ${flows === 1 ? "flow" : "flows"}`;
  return {
    ...DELETE_DEMO,
    title: `Delete ${f}`,
    body: `This permanently removes ${f} and their ${videos} ${videos === 1 ? "video" : "videos"}. It can’t be undone.`,
  };
};

/** A video record that would not read: only the record goes. */
export const DELETE_RECORD: ConfirmQuestion = {
  ...DELETE_DEMO,
  title: "Delete flow record",
  body: "This removes the unreadable record. Its videos stay.",
};

let opened = 0;

/**
 * The page's own confirmation, in place of `window.confirm`: a modal
 * `<dialog>` in the "Allow an agent?" consent card's type and buttons (a
 * centred Outfit heading, two answers of equal width), with nothing above
 * the heading: no brand strip, which inside the app would only repeat the
 * page, and no avatar — the glyphs sit on the answers instead.
 *
 * Resolves `true` on the confirm button and `false` on Cancel, Escape or a
 * click on the backdrop. It REJECTS when the dialog cannot open at all —
 * an answer of `false` would read as the author having said No, and a
 * deletion that was never asked about would vanish without a word. Callers
 * report the rejection the way they report the action failing.
 *
 * `showModal` gives the rest: the top layer over everything the page
 * stacks, focus held inside, Escape, and focus handed back to whatever
 * opened it on close.
 */
export function askToConfirm(question: ConfirmQuestion): Promise<boolean> {
  opened += 1;
  const id = `confirm-${opened}`;

  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("data-confirm", "");
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", `${id}-body`);

  // `method="dialog"`: a press on either button closes the dialog with that
  // button's `value` as its `returnValue`. Escape closes it with none.
  const form = document.createElement("form");
  form.method = "dialog";

  const title = document.createElement("h2");
  title.className = "confirm-title";
  title.id = `${id}-title`;
  title.textContent = question.title;

  const body = document.createElement("p");
  body.className = "confirm-body";
  body.id = `${id}-body`;
  body.textContent = question.body;

  const cancel = document.createElement("button");
  cancel.className = "btn btn-quiet";
  cancel.value = "cancel";
  cancel.setAttribute("data-confirm-cancel", "");
  cancel.append(icon("close"), "Cancel");

  const go = document.createElement("button");
  // Quiet like Cancel, as the consent card's Deny is like its Allow, unless
  // it destroys something: then it is the one red, filled button.
  go.className = question.danger
    ? "btn btn-quiet confirm-go-danger"
    : "btn btn-quiet";
  go.value = "confirm";
  go.setAttribute("data-confirm-go", "");
  go.append(icon(question.glyph), question.confirmLabel);

  (question.focus === "cancel" ? cancel : go).autofocus = true;

  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  actions.append(cancel, go);
  form.append(title, body, actions);
  dialog.append(form);

  // The backdrop is not an element: a click on it lands on the dialog
  // itself. So does a press that starts on the panel's text and is released
  // past its edge, which is a selection, not a dismissal — hence the press
  // has to have STARTED on the dialog too. The form fills the dialog, so
  // nothing the panel paints is the dialog itself.
  let pressedOnBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => {
    pressedOnBackdrop = event.target === dialog;
  });
  dialog.addEventListener("click", (event) => {
    if (pressedOnBackdrop && event.target === dialog) dialog.close("cancel");
    pressedOnBackdrop = false;
  });

  return new Promise((resolve, reject) => {
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        resolve(dialog.returnValue === "confirm");
      },
      { once: true },
    );
    document.body.append(dialog);
    try {
      dialog.showModal();
    } catch (error) {
      dialog.remove();
      reject(error);
    }
  });
}
