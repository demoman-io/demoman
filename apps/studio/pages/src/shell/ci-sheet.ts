// apps/studio/pages/src/shell/ci-sheet.ts

import { ciActions, ciSteps, ciStepsView, type RepoCiDoor } from "./ci-steps";
import { showSheet } from "./sheet-dialog";

/**
 * CI setup on its own (DEM-52): the add sheet's CI section in a dialog of
 * its own, opened from beside a project's heading, with no flow being
 * added. Resolves with the pull request an apply opened, or null.
 */
export function openCiSheet(a: {
  root: string;
  /** The project's name, said under the title. */
  name: string;
  ci: RepoCiDoor;
  /** Opened as Update CI (DEM-269): titled so before its own read lands. */
  updating?: boolean;
}): Promise<{ prOpened: string | null }> {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog repo-sheet";
  dialog.setAttribute("data-repo-sheet", "");
  dialog.setAttribute("data-ci-sheet", "");
  const form = document.createElement("form");
  form.addEventListener("submit", (event) => event.preventDefault());
  dialog.append(form);

  let settle: (r: { prOpened: string | null }) => void = () => {};
  const result = new Promise<{ prOpened: string | null }>((resolve) => {
    settle = resolve;
  });
  let ended = false;
  const close = (): void => {
    if (ended || steps.busy) return;
    ended = true;
    steps.stop();
    settle({ prOpened: steps.prUrl });
  };

  const draw = (): void => {
    const title = document.createElement("h2");
    title.className = "confirm-title";
    const update = steps.update;
    // The opener's word only until the sheet's own read lands.
    const updating =
      update !== null || (steps.step.k === "reading" && a.updating === true);
    title.textContent = updating ? "Update CI" : "Set up CI";
    const name = document.createElement("p");
    name.className = "repo-sheet-sub";
    name.textContent = a.name;
    const parts: HTMLElement[] = [title, name];
    // What an update does, before it is done: not over its pull request.
    if (
      update !== null &&
      (steps.step.k === "form" || steps.step.k === "planned")
    ) {
      const said = document.createElement("p");
      said.setAttribute("data-ci-update-said", "");
      said.textContent = `CI is set up with the workflow Demoman ${update.from} wrote. This is ${update.to}: updating opens one pull request, "Update Demoman's workflow", and keeps how it runs. The whole file is replaced, so anything added to it by hand is dropped.`;
      parts.push(said);
    }
    if (steps.step.k === "setUp") {
      const said = document.createElement("p");
      said.textContent = "CI is set up.";
      said.setAttribute("data-ci-set-up", "");
      parts.push(said);
    }
    const view = ciStepsView(steps);
    parts.push(
      ...view.nodes,
      ciActions(view.actions, {
        primary: "Done",
        quiet: "Close",
        attr: "data-ci-done",
        fn: close,
        disabled: steps.busy,
      }),
    );
    form.replaceChildren(...parts);
    if (view.focus !== undefined) queueMicrotask(() => view.focus?.focus());
  };
  const steps = ciSteps(a.ci, a.root, draw, { offerUpdate: true });
  draw();
  void steps.read();

  // A close the browser makes anyway (a second Escape) still settles, so
  // the page reads the repo's state again.
  const closed = (): void => {
    if (ended) return;
    ended = true;
    steps.stop();
    settle({ prOpened: steps.prUrl });
  };
  try {
    showSheet(dialog, { ask: close, closed, ended: result });
  } catch (error) {
    return Promise.reject(error);
  }
  return result;
}
