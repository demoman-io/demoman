// apps/studio/pages/src/shell/repo-sheet.ts
import {
  EXPORT_QUALITY_LABELS,
  EXPORT_QUALITY_VALUES,
  type ExportQuality,
} from "@demoman/run-core";
import type { Addable, VideoSummary } from "@demoman/studio-protocol";
import type { Platform, RepoEvent } from "../platform/types";
import type { ConfirmQuestion } from "./confirm-dialog";
import { icon } from "./icons";
import { showToast } from "./toast";

type RepoDoor = Platform["videos"]["repo"];
type Deliver = "commit" | "files";

export interface RepoSheetArgs {
  video: { id: string; name: string };
  addable: Extract<Addable, { ok: true }>;
  repo: RepoDoor;
  /** Task 7 widens this to the CI door. */
  ci: null;
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

export type SheetState =
  | { step: "form" }
  | { step: "running"; line: string }
  | { step: "last"; root: string; written: string[]; notes: string[] };

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

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

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
  const listeners = new Set<() => void>();
  let settle: (r: RepoSheetResult) => void = () => {};
  const result = new Promise<RepoSheetResult>((resolve) => {
    settle = resolve;
  });
  const set = (next: SheetState): void => {
    state = next;
    for (const fn of listeners) fn();
  };
  let settled = false;
  const finish = (r: RepoSheetResult): void => {
    settled = true;
    stop?.();
    settle(r);
    for (const fn of listeners) fn();
  };

  function on(e: RepoEvent): void {
    switch (e.phase) {
      case "queued":
        set({ step: "running", line: `Queued (${e.position})` });
        return;
      case "adding":
        set({ step: "running", line: e.line });
        return;
      case "added":
        if (fields.deliver === "files" && e.notes.length === 0) {
          autoClosed = true;
          finish({
            added: { written: e.written, notes: e.notes },
            prOpened: null,
          });
        } else {
          set({
            step: "last",
            root: e.root,
            written: e.written,
            notes: e.notes,
          });
        }
        return;
      case "failed":
        finish({ added: null, prOpened: null, failed: e.detail });
    }
  }

  return {
    fields,
    result,
    get state() {
      return state;
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
        // A terminal event replayed inside `onRepo` finished already.
        if (settled) stop();
      } catch (error) {
        finish({ added: null, prOpened: null, failed: messageOf(error) });
      }
    },
    /** Cancel on the form, Done on the last step. Not while it runs. */
    close(): void {
      if (state.step === "running") return;
      finish({
        added:
          state.step === "last"
            ? { written: state.written, notes: state.notes }
            : null,
        prOpened: null,
      });
    },
  };
}

const field = (label: string, control: HTMLElement): HTMLLabelElement => {
  const wrap = document.createElement("label");
  wrap.append(label, control);
  return wrap;
};

const button = (word: string, glyph: Parameters<typeof icon>[0]) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-quiet";
  b.append(icon(glyph), word);
  return b;
};

/** The add sheet: a modal `<dialog>` built as `askToConfirm`'s is. */
export function openRepoSheet(a: RepoSheetArgs): Promise<RepoSheetResult> {
  const model = repoSheetModel(a);
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog repo-sheet";
  dialog.setAttribute("data-repo-sheet", "");
  const form = document.createElement("form");
  form.addEventListener("submit", (event) => event.preventDefault());
  dialog.append(form);

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
      const done = button("Done", "check");
      done.setAttribute("data-repo-done", "");
      done.addEventListener("click", () => model.close());
      actions.append(done);
      parts.push(actions);
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
    if (model.autoClosed) showToast(`Added "${a.video.name}" to the repo.`);
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
