// apps/studio/pages/src/shell/ci-sheet.ts

import { button, ciSteps, ciStepsView, type RepoCiDoor } from "./ci-steps";
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
    title.textContent = "Set up CI";
    const name = document.createElement("p");
    name.className = "repo-sheet-sub";
    name.textContent = a.name;
    const parts: HTMLElement[] = [title, name];
    if (steps.step.k === "setUp") {
      const said = document.createElement("p");
      said.textContent = "CI is set up.";
      said.setAttribute("data-ci-set-up", "");
      parts.push(said);
    }
    const view = ciStepsView(steps);
    const done = button("Done", "check");
    done.setAttribute("data-ci-done", "");
    done.disabled = steps.busy;
    done.addEventListener("click", close);
    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    actions.append(...view.actions, done);
    parts.push(...view.nodes, actions);
    form.replaceChildren(...parts);
    if (view.focus !== undefined) queueMicrotask(() => view.focus?.focus());
  };
  const steps = ciSteps(a.ci, a.root, draw);
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
