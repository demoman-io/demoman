// apps/studio/pages/src/shell/sheet-dialog.ts

/**
 * A sheet's modal `<dialog>`, the add sheet's and CI setup's alike: Escape
 * and a press that starts and ends on the backdrop `ask` the sheet to close
 * (it refuses while busy); a close the browser makes anyway (a second
 * Escape) is `closed`, which settles the sheet. The dialog is taken down once
 * `ended` settles. Throws, with nothing left on the page, when it cannot be
 * shown.
 */
export function showSheet(
  dialog: HTMLDialogElement,
  o: { ask(): void; closed(): void; ended: Promise<unknown> },
): void {
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    o.ask();
  });
  let pressedOnBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => {
    pressedOnBackdrop = event.target === dialog;
  });
  dialog.addEventListener("click", (event) => {
    if (pressedOnBackdrop && event.target === dialog) o.ask();
    pressedOnBackdrop = false;
  });
  dialog.addEventListener("close", () => o.closed());
  void o.ended.then(() => {
    if (dialog.open) dialog.close();
    dialog.remove();
  });
  document.body.append(dialog);
  try {
    dialog.showModal();
  } catch (error) {
    dialog.remove();
    throw error;
  }
}
