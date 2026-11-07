// apps/studio/pages/src/shell/repo-sheet.ts

import {
  EXPORT_QUALITY_LABELS,
  EXPORT_QUALITY_VALUES,
  type ExportQuality,
} from "@demoman/run-core";
import type { Addable, VideoSummary } from "@demoman/studio-protocol";
import type { Platform, RepoEvent } from "../platform/types";
import {
  button,
  type CiSteps,
  ciSteps,
  ciStepsView,
  field,
  link,
  messageOf,
  type RepoCiDoor,
  shown,
} from "./ci-steps";
import type { ConfirmQuestion } from "./confirm-dialog";
import { showToast } from "./toast";

export { messageOf, type RepoCiDoor };

type RepoDoor = Platform["videos"]["repo"];
type Deliver = "commit" | "files";

export interface RepoSheetArgs {
  video: { id: string; name: string };
  addable: Extract<Addable, { ok: true }>;
  repo: RepoDoor;
  /** Null where the platform has no CI door: the last step then has no CI. */
  ci: RepoCiDoor | null;
  /** Show a written file in the file manager. */
  reveal?: (path: string) => Promise<void>;
}

/** `added`: what was written, null when nothing was. `failed`: why an add
 *  stopped, for the flow's row to say. */
export interface RepoSheetResult {
  added: { written: string[]; notes: string[] } | null;
  prOpened: string | null;
  failed?: string;
}

/** The add's own pull request, on a repo whose CI is set up: offered,
 *  opening (or refused, with why), or opened. */
export type PrStep = { busy: boolean; error?: string } | { url: string };

export type SheetState =
  | { step: "form" }
  | { step: "running"; line: string }
  | {
      step: "last";
      root: string;
      written: string[];
      notes: string[];
      file: string;
      pr: PrStep | null;
    };

const base = (file: string): string => file.split("/").pop() ?? file;

/** Remove from repo's question: the recipe that goes, the exports that stay. */
export function removeQuestion(
  video: VideoSummary,
  file: string,
): ConfirmQuestion {
  const staying = video.exports.flatMap((e) =>
    "path" in e && e.exists ? [e.path] : [],
  );
  return {
    glyph: "gitBranchMinus",
    title: "Remove from repo",
    body: `This removes ${file}.${staying.length === 0 ? "" : ` These exports stay: ${staying.join(", ")}.`}`,
    confirmLabel: "Remove",
    danger: false,
    focus: "cancel",
  };
}

export const removedLine = (name: string): string =>
  `Removed "${name}" from the repo. Its exports stay.`;

/**
 * The sheet's behaviour without its dialog, so it can be driven without a
 * browser: the fields, the step, and the one result. A plain `files` add
 * with nothing to say ends by itself (`autoClosed`); anything else stays on
 * the last step until `close`.
 */
export function repoSheetModel(a: RepoSheetArgs) {
  const fields: { path: string; deliver: Deliver; quality: ExportQuality } = {
    path: a.addable.defaultPath,
    deliver: "commit",
    quality: "share",
  };
  let state: SheetState = { step: "form" };
  let autoClosed = false;
  let stop: (() => void) | undefined;
  let ci: CiSteps | null = null;
  let prUrl: string | null = null;
  let toast: string | null = null;
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const fn of listeners) fn();
  };
  let settle: (r: RepoSheetResult) => void = () => {};
  const result = new Promise<RepoSheetResult>((resolve) => {
    settle = resolve;
  });
  const set = (next: SheetState): void => {
    state = next;
    changed();
  };
  let settled = false;
  const finish = (r: RepoSheetResult): void => {
    settled = true;
    stop?.();
    ci?.stop();
    settle(r);
    changed();
  };

  /** The add's job ended: its listener goes, so a later `gone()` cannot
   *  turn an add that happened into a failure. */
  let addEnded = false;
  function on(e: RepoEvent): void {
    if (e.phase === "added" || e.phase === "failed") {
      addEnded = true;
      stop?.();
    }
    switch (e.phase) {
      case "queued":
        set({
          step: "running",
          line: e.position === 0 ? "Queued…" : `Queued (${e.position} ahead)`,
        });
        return;
      case "adding":
        if (shown(e.line)) set({ step: "running", line: e.line });
        return;
      case "added":
        if (fields.deliver === "files" && e.notes.length === 0) {
          autoClosed = true;
          toast = `Added "${a.video.name}" to the repo.`;
          finish({
            added: { written: e.written, notes: e.notes },
            prOpened: null,
          });
        } else {
          if (a.ci !== null) ci = ciSteps(a.ci, e.root, changed);
          set({
            step: "last",
            root: e.root,
            written: e.written,
            notes: e.notes,
            file: e.file,
            pr: null,
          });
          void ci?.read();
        }
        return;
      case "failed":
        finish({ added: null, prOpened: null, failed: e.detail });
    }
  }

  const setPr = (pr: PrStep): void => {
    if (state.step === "last") set({ ...state, pr });
  };

  return {
    fields,
    result,
    get toast() {
      return toast;
    },
    get state() {
      return state;
    },
    /** The repo's CI setup, once the add lands; null without a CI door. */
    get ci() {
      return ci;
    },
    get autoClosed() {
      return autoClosed;
    },
    onChange(fn: () => void): void {
      listeners.add(fn);
    },
    async submit(): Promise<void> {
      if (state.step !== "form") return;
      set({ step: "running", line: "Adding…" });
      try {
        const { jobId } = await a.repo.add(a.video.id, { ...fields });
        stop = a.repo.onRepo(jobId, on);
        // A terminal event replayed inside `onRepo` ended it already.
        if (settled || addEnded) stop();
      } catch (error) {
        finish({ added: null, prOpened: null, failed: messageOf(error) });
      }
    },
    /** The later add's pull request: only its own files (Decision 5). */
    async openPr(): Promise<void> {
      if (
        a.ci === null ||
        state.step !== "last" ||
        ci?.step.k !== "setUp" ||
        (state.pr !== null && ("url" in state.pr || state.pr.busy))
      )
        return;
      const name = base(state.file).replace(/\.json$/, "");
      setPr({ busy: true });
      try {
        const r = await a.ci.openPr({
          root: state.root,
          branch: `demoman/add-${name}`,
          title: `Add the "${a.video.name}" flow`,
          body: state.written.map((f) => `- ${f}`).join("\n"),
          files: state.written,
        });
        if ("opened" in r) {
          prUrl = r.opened.url;
          setPr({ url: r.opened.url });
        } else setPr({ busy: false, error: r.detail });
      } catch (error) {
        setPr({ busy: false, error: messageOf(error) });
      }
    },
    /** Closes the sheet with CI left alone. */
    notNow(): void {
      if (state.step !== "last") return;
      toast = `Added "${a.video.name}" to the repo. CI is not set up.`;
      finish({
        added: { written: state.written, notes: state.notes },
        prOpened: null,
      });
    },
    /** Cancel on the form, Done on the last step. Not while it runs. */
    close(): void {
      if (state.step === "running") return;
      finish({
        added:
          state.step === "last"
            ? { written: state.written, notes: state.notes }
            : null,
        prOpened: prUrl ?? ci?.prUrl ?? null,
      });
    },
  };
}

/** The add sheet: a modal `<dialog>` built as `askToConfirm`'s is. */
export function openRepoSheet(a: RepoSheetArgs): Promise<RepoSheetResult> {
  const model = repoSheetModel(a);
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog repo-sheet";
  dialog.setAttribute("data-repo-sheet", "");
  const form = document.createElement("form");
  form.addEventListener("submit", (event) => event.preventDefault());
  dialog.append(form);

  /** The add's own pull request, when the repo's CI is set up. */
  const prView = (
    pr: PrStep | null,
  ): { nodes: HTMLElement[]; actions: HTMLElement[]; focus?: HTMLElement } => {
    if (pr !== null && "url" in pr) {
      return { nodes: [link(pr.url, "Pull request")], actions: [] };
    }
    const nodes: HTMLElement[] = [];
    if (pr?.error !== undefined) {
      const p = document.createElement("p");
      p.textContent = pr.error;
      p.setAttribute("data-ci-error", "");
      nodes.push(p);
    }
    const open = button("Open pull request", "gitBranchPlus");
    open.setAttribute("data-repo-pr", "");
    open.disabled = pr?.busy === true;
    open.addEventListener("click", () => void model.openPr());
    return { nodes, actions: [open] };
  };

  const draw = (): void => {
    const s = model.state;
    const title = document.createElement("h2");
    title.className = "confirm-title";
    title.textContent = "Add to repo";
    const parts: HTMLElement[] = [title];
    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    if (s.step === "form") {
      const path = document.createElement("input");
      path.value = model.fields.path;
      path.setAttribute("data-repo-path", "");
      path.addEventListener("input", () => {
        model.fields.path = path.value;
      });
      const deliver = document.createElement("select");
      deliver.setAttribute("data-repo-deliver", "");
      for (const [value, word] of [
        ["commit", "Commit"],
        ["files", "Files"],
      ] as const) {
        deliver.append(new Option(word, value, false, value === "commit"));
      }
      deliver.addEventListener("change", () => {
        model.fields.deliver = deliver.value as Deliver;
      });
      const quality = document.createElement("select");
      quality.setAttribute("data-repo-quality", "");
      for (const q of EXPORT_QUALITY_VALUES) {
        quality.append(
          new Option(EXPORT_QUALITY_LABELS[q], q, false, q === "share"),
        );
      }
      quality.addEventListener("change", () => {
        model.fields.quality = quality.value as ExportQuality;
      });
      const cancel = button("Cancel", "close");
      cancel.setAttribute("data-repo-cancel", "");
      cancel.addEventListener("click", () => model.close());
      const add = button("Add", "gitBranchPlus");
      add.setAttribute("data-repo-add", "");
      add.addEventListener("click", () => void model.submit());
      actions.append(cancel, add);
      parts.push(
        field("Path", path),
        field("Delivery", deliver),
        field("Quality", quality),
        actions,
      );
    } else if (s.step === "running") {
      const line = document.createElement("p");
      line.className = "repo-line";
      line.setAttribute("role", "status");
      line.setAttribute("data-repo-line", "");
      line.textContent = s.line;
      parts.push(line);
    } else {
      const list = document.createElement("ul");
      list.className = "repo-written";
      list.setAttribute("data-repo-written", "");
      for (const file of s.written) {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = file;
        item.append(name);
        if (a.reveal !== undefined) {
          const reveal = button("Reveal", "file");
          reveal.addEventListener("click", () => {
            a.reveal?.(`${s.root}/${file}`).catch((error: unknown) =>
              console.error("demoman: reveal failed —", error),
            );
          });
          item.append(reveal);
        }
        list.append(item);
      }
      parts.push(list);
      for (const note of s.notes) {
        const p = document.createElement("p");
        p.className = "notice notice-warn";
        p.setAttribute("data-repo-note", "");
        p.textContent = note;
        parts.push(p);
      }
      const ci = model.ci;
      const view =
        ci === null
          ? null
          : ci.step.k === "setUp"
            ? prView(s.pr)
            : ciStepsView(ci, { notNow: () => model.notNow() });
      if (view !== null) parts.push(...view.nodes);
      const done = button("Done", "check");
      done.setAttribute("data-repo-done", "");
      done.addEventListener("click", () => model.close());
      // Not now already closes: two ways out would be one too many.
      const closes = view?.actions.some((b) =>
        b.hasAttribute("data-ci-not-now"),
      );
      actions.append(...(view?.actions ?? []), ...(closes ? [] : [done]));
      parts.push(actions);
      queueMicrotask(() => view?.focus?.focus());
    }
    form.replaceChildren(...parts);
  };
  draw();
  model.onChange(draw);

  // Escape and the backdrop cancel, except while it runs.
  dialog.addEventListener("cancel", (event) => {
    if (model.state.step === "running") event.preventDefault();
  });
  let pressedOnBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => {
    pressedOnBackdrop = event.target === dialog;
  });
  dialog.addEventListener("click", (event) => {
    if (pressedOnBackdrop && event.target === dialog) model.close();
    pressedOnBackdrop = false;
  });
  dialog.addEventListener("close", () => model.close());

  void model.result.then(() => {
    if (dialog.open) dialog.close();
    dialog.remove();
    if (model.toast !== null) showToast(model.toast);
  });
  document.body.append(dialog);
  try {
    dialog.showModal();
  } catch (error) {
    dialog.remove();
    return Promise.reject(error);
  }
  return model.result;
}
