// apps/studio/pages/src/shell/repo-sheet.ts

import {
  EXPORT_QUALITY_LABELS,
  EXPORT_QUALITY_VALUES,
  type ExportQuality,
  FLOWS_DIR,
  LEGACY_FLOWS_DIR,
  RECEIPT_DIR,
} from "@demoman/run-core";
import type { VideoSummary } from "@demoman/studio-protocol";
import type { Platform, RepoEvent } from "../platform/types";
import {
  anchor,
  button,
  type CiSteps,
  ciSteps,
  ciStepsView,
  messageOf,
  type RepoCiDoor,
  shown,
} from "./ci-steps";
import type { ConfirmQuestion } from "./confirm-dialog";
import { icon } from "./icons";
import { showSheet } from "./sheet-dialog";
import { showToast } from "./toast";

export { messageOf, type RepoCiDoor };

type RepoDoor = Platform["videos"]["repo"];
type Deliver = "commit" | "files";

export interface RepoSheetArgs {
  video: { id: string; name: string };
  repo: RepoDoor;
  /** Null where the platform has no CI door: the last step then has no CI. */
  ci: RepoCiDoor | null;
  /** Show a written file in the file manager. */
  reveal?: (path: string) => Promise<void>;
}

/** `added`: what was written and where, null when nothing was. `failed`:
 *  why the sheet could not add, for the flow's row to say. */
export interface RepoSheetResult {
  added: {
    written: string[];
    notes: string[];
    root: string;
    file: string;
    deliver: Deliver;
    /** Whether the library marked the flow In repo; false when it could
     *  not (its note says so), and the row then waits for the read. */
    marked: boolean;
    /** The repo key the mark records: the flow's project. */
    key: string | null;
  } | null;
  prOpened: string | null;
  failed?: string;
}

/** The add's own pull request, on a repo whose CI is set up: offered,
 *  opening (or refused, with why), or opened. */
export type PrStep = { busy: boolean; error?: string } | { url: string };

export type SheetState =
  | { step: "checking" }
  | { step: "refused"; said: string }
  | { step: "form"; root: string }
  | { step: "running"; line: string }
  | {
      step: "last";
      root: string;
      written: string[];
      notes: string[];
      file: string;
      marked: boolean;
      key: string | null;
      pr: PrStep | null;
    };

export interface SheetFields {
  folder: string;
  name: string;
  deliver: Deliver;
  quality: ExportQuality;
}

/** The file name as it is written: no slash around it, no `.mp4`. */
const nameOf = (f: SheetFields): string =>
  f.name
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.mp4$/i, "")
    .trim();

/** Whether the name makes a file: something left once `.mp4` and the
 *  slashes around it go, and no slash inside it. Add follows this. */
export const nameOk = (f: SheetFields): boolean => {
  const name = nameOf(f);
  return name !== "" && !name.includes("/");
};

/** The path the add writes the video to: `folder/name.mp4`, each slash and
 *  `.mp4` said once however they were typed. Files writes a file name only
 *  (the add refuses a folder there), so it has none. */
export function pathOf(f: SheetFields): string {
  const folder =
    f.deliver === "files" ? "" : f.folder.trim().replace(/^\/+|\/+$/g, "");
  const name = nameOf(f);
  return folder === "" ? `${name}.mp4` : `${folder}/${name}.mp4`;
}

/** What each file an add wrote is, from where it lives. */
export function writtenLabel(
  path: string,
): "Video" | "Recipe" | "Receipt" | "Screens" {
  if (
    path.startsWith(`${FLOWS_DIR}/`) ||
    path.startsWith(`${LEGACY_FLOWS_DIR}/`)
  )
    return "Recipe";
  if (path.startsWith(`${RECEIPT_DIR}/`))
    return path.endsWith(".json") ? "Receipt" : "Screens";
  return "Video";
}

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
 * browser. It opens checking whether the flow can be added (DEM-47: the
 * listing no longer does), then the form. A plain `files` add with nothing
 * to say ends by itself (`autoClosed`); anything else stays on the last
 * step until `close`.
 */
export function repoSheetModel(a: RepoSheetArgs) {
  const fields: SheetFields = {
    folder: "",
    name: "",
    deliver: "commit",
    quality: "share",
  };
  let state: SheetState = { step: "checking" };
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

  const ready = (async (): Promise<void> => {
    try {
      const can = await a.repo.addable(a.video.id);
      if (settled) return;
      if (!can.ok) {
        set({
          step: "refused",
          said: [can.label, can.detail].filter((x) => x !== "").join(". "),
        });
        return;
      }
      const at = can.defaultPath.lastIndexOf("/");
      fields.folder = at < 0 ? "" : can.defaultPath.slice(0, at);
      fields.name = can.defaultPath.slice(at + 1).replace(/\.mp4$/i, "");
      set({ step: "form", root: can.root });
    } catch (error) {
      if (!settled) set({ step: "refused", said: messageOf(error) });
    }
  })();

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
            added: {
              written: e.written,
              notes: e.notes,
              root: e.root,
              file: e.file,
              deliver: fields.deliver,
              marked: e.marked,
              key: e.key,
            },
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
            marked: e.marked,
            key: e.key,
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
  const addedOf = (): RepoSheetResult["added"] =>
    state.step === "last"
      ? {
          written: state.written,
          notes: state.notes,
          root: state.root,
          file: state.file,
          deliver: fields.deliver,
          marked: state.marked,
          key: state.key,
        }
      : null;

  return {
    fields,
    result,
    /** Settles once the sheet's check answered (the form or the refusal). */
    ready,
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
      if (state.step !== "form" || !nameOk(fields)) return;
      const body = {
        path: pathOf(fields),
        deliver: fields.deliver,
        quality: fields.quality,
      };
      set({ step: "running", line: "Adding…" });
      try {
        const { jobId } = await a.repo.add(a.video.id, body);
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
      finish({ added: addedOf(), prOpened: null });
    },
    /** Cancel and Done. Not while the add or a CI job runs, unless
     *  `force`: the browser closed the dialog anyway (a second Escape). */
    close(force = false): void {
      if (settled) return;
      if (!force && (state.step === "running" || ci?.busy === true)) return;
      finish({
        added: addedOf(),
        prOpened: prUrl ?? ci?.prUrl ?? null,
        ...(state.step === "refused" ? { failed: state.said } : {}),
      });
    },
  };
}

type Model = ReturnType<typeof repoSheetModel>;
type Folders = Promise<{ folders: string[]; more: boolean }>;

const SAID: Record<Deliver, string> = {
  commit:
    "The video goes in the repo. A refresh commits a new one when the picture changes.",
  files:
    "The video stays out of git. A refresh writes it to a folder for you to upload.",
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  words?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (words !== undefined) n.textContent = words;
  return n;
};

/** A field: its label word over its controls (a `div`, so a click on the
 *  word does not press a toggle's first button). */
const fieldOf = (word: string, ...controls: HTMLElement[]): HTMLElement => {
  const box = el("div", "repo-field");
  box.append(el("span", "repo-field-label", word), ...controls);
  return box;
};

/** A one-of-many toggle, the Export panel's `.segmented`. */
function toggle<T extends string>(
  name: string,
  attr: string,
  values: ReadonlyArray<readonly [T, string]>,
  on: T,
  pick: (v: T) => void,
): HTMLElement {
  const group = el("div", "segmented");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", name);
  for (const [value, word] of values) {
    const b = el("button", "segment", word);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute(attr, value);
    b.setAttribute("aria-checked", String(value === on));
    b.addEventListener("click", () => pick(value));
    group.append(b);
  }
  return group;
}

/** A section's heading: an optional check, its words, and what sits at its
 *  end (a count, a branch, a link). */
function heading(
  done: boolean,
  words: string,
  end?: HTMLElement | string,
): HTMLElement {
  const h = el("h3", "repo-section-head");
  if (done) h.append(icon("circleCheck"));
  h.append(el("span", undefined, words));
  if (end !== undefined)
    h.append(typeof end === "string" ? el("small", undefined, end) : end);
  return h;
}

const prNumber = (url: string): string => {
  const n = /\/pull\/(\d+)\/?$/.exec(url)?.[1];
  return n === undefined ? "Pull request" : `Pull request #${n}`;
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
  /** Each Reveal's refusal, by path, said under its row (DEM-56). */
  const revealErrors = new Map<string, string>();
  /** The repo's folders, read once when the list first opens; a failed
   *  read is asked again on the next open. */
  let folders: Folders | null = null;
  const readFolders = (): Folders | null => {
    if (model.state.step !== "form") return null;
    folders ??= a.repo.folders(model.state.root).catch((error: unknown) => {
      folders = null;
      throw error;
    });
    return folders;
  };
  const draw = (): void =>
    drawSheet(model, a, form, revealErrors, draw, readFolders);
  draw();
  model.onChange(draw);

  // Escape and the backdrop ask; the model refuses while the add or a CI
  // job runs.
  try {
    showSheet(dialog, {
      ask: () => model.close(),
      closed: () => model.close(true),
      ended: model.result,
    });
  } catch (error) {
    return Promise.reject(error);
  }
  void model.result.then(() => {
    if (model.toast !== null) showToast(model.toast);
  });
  return model.result;
}

function drawSheet(
  model: Model,
  a: RepoSheetArgs,
  form: HTMLFormElement,
  revealErrors: Map<string, string>,
  redraw: () => void,
  readFolders: () => Folders | null,
): void {
  const s = model.state;
  const parts: HTMLElement[] = [el("h2", "confirm-title", "Add to repo")];
  const actions = el("div", "confirm-actions");
  let focus: HTMLElement | undefined;
  const cancel = (): HTMLButtonElement => {
    const b = button("Cancel", "close");
    b.setAttribute("data-repo-cancel", "");
    b.addEventListener("click", () => model.close());
    return b;
  };
  const done = (primary: boolean): HTMLButtonElement => {
    const b = primary
      ? button("Done", null, "btn btn-primary")
      : button("Done", "check");
    b.setAttribute("data-repo-done", "");
    b.disabled = model.ci?.busy === true;
    b.addEventListener("click", () => model.close());
    return b;
  };

  if (s.step === "checking" || s.step === "running") {
    const line = el(
      "p",
      "repo-line",
      s.step === "checking" ? "Checking…" : s.line,
    );
    line.setAttribute("role", "status");
    line.setAttribute("data-repo-line", "");
    parts.push(line);
    if (s.step === "checking") {
      actions.append(cancel());
      parts.push(actions);
    }
  } else if (s.step === "refused") {
    const said = el("p", "notice notice-error", s.said);
    said.setAttribute("data-repo-refused", "");
    actions.append(cancel());
    parts.push(said, actions);
  } else if (s.step === "form") {
    parts.push(...formParts(model, readFolders, redraw));
    const add = button("Add", "gitBranchPlus", "btn btn-primary");
    add.setAttribute("data-repo-add", "");
    add.disabled = !nameOk(model.fields);
    add.addEventListener("click", () => void model.submit());
    actions.append(cancel(), add);
    parts.push(actions);
  } else {
    const opened = s.pr !== null && "url" in s.pr ? s.pr.url : null;
    const files = filesList(s, a, revealErrors, redraw);
    const notes = s.notes.map((note) => {
      const p = el("p", "notice notice-warn", note);
      p.setAttribute("data-repo-note", "");
      return p;
    });
    const count = `${s.written.length} file${s.written.length === 1 ? "" : "s"}`;
    if (opened !== null) {
      // Finished (DEM-59): both parts fold to a checked line; Done alone.
      const fold = el("details", "repo-section");
      fold.setAttribute("data-repo-added", "");
      const summary = el("summary");
      const head = heading(true, "Added", count);
      head.append(icon("chevronDown"));
      summary.append(head);
      fold.append(summary, files, ...notes);
      const pr = el("section", "repo-section");
      pr.append(
        heading(
          true,
          "Pull request opened",
          anchor(opened, prNumber(opened)) ?? el("span", undefined, opened),
        ),
      );
      parts.push(fold, el("div", "repo-rule"), pr);
      actions.append(done(true));
    } else {
      const added = el("section", "repo-section");
      added.setAttribute("data-repo-added", "");
      added.append(heading(true, "Added", count), files, ...notes);
      parts.push(added);
      const ci = model.ci;
      if (ci === null) {
        actions.append(done(false));
      } else if (ci.step.k === "setUp") {
        const pr = el("section", "repo-section");
        const name = base(s.file).replace(/\.json$/, "");
        pr.append(heading(false, "Pull request", `branch demoman/add-${name}`));
        if (s.pr !== null && "busy" in s.pr && s.pr.error !== undefined) {
          const err = el("p", "notice notice-error", s.pr.error);
          err.setAttribute("data-ci-error", "");
          pr.append(err);
        }
        parts.push(el("div", "repo-rule"), pr);
        const open = button(
          "Open pull request",
          "gitBranchPlus",
          "btn btn-primary",
        );
        open.setAttribute("data-repo-pr", "");
        open.disabled = s.pr !== null && "busy" in s.pr && s.pr.busy;
        open.addEventListener("click", () => void model.openPr());
        actions.append(done(false), open);
      } else {
        const view = ciStepsView(ci, { notNow: () => model.notNow() });
        const sec = el("section", "repo-section");
        sec.append(heading(false, "CI"), ...view.nodes);
        parts.push(el("div", "repo-rule"), sec);
        // Not now already closes: two ways out would be one too many.
        const closes = view.actions.some((b) =>
          b.hasAttribute("data-ci-not-now"),
        );
        actions.append(...view.actions, ...(closes ? [] : [done(false)]));
        focus = view.focus;
      }
    }
    parts.push(actions);
  }
  // A redraw replaces the control that was pressed: focus its successor, so
  // a keyboard user is not dropped to the body after every toggle.
  const had = document.activeElement;
  const again =
    had instanceof HTMLElement && form.contains(had) ? selectorOf(had) : "";
  form.replaceChildren(...parts);
  if (focus !== undefined) queueMicrotask(() => focus?.focus());
  else if (again !== "") form.querySelector<HTMLElement>(again)?.focus();
}

/** The element's tag and its `data-*` and `aria-label` attributes, as a
 *  selector; "" when it has none of them to be found by. */
function selectorOf(n: HTMLElement): string {
  const attrs = [...n.attributes]
    .filter((a) => a.name.startsWith("data-") || a.name === "aria-label")
    .map((a) => `[${a.name}="${CSS.escape(a.value)}"]`);
  return attrs.length === 0 ? "" : n.tagName.toLowerCase() + attrs.join("");
}

/** Folder (with the repo's folders a click away), File name with its fixed
 *  `.mp4`, the Video toggle and its line, Quality (DEM-50). */
function formParts(
  model: Model,
  readFolders: () => Folders | null,
  redraw: () => void,
): HTMLElement[] {
  const f = model.fields;
  const folder = el("input");
  folder.value = f.folder;
  folder.setAttribute("data-repo-folder", "");
  folder.setAttribute("aria-label", "Folder");
  folder.addEventListener("input", () => {
    f.folder = folder.value;
  });
  const choose = button("", "folder", "btn btn-quiet btn-icon");
  choose.setAttribute("aria-label", "Choose folder");
  choose.title = "Choose folder";
  const list = el("div", "repo-folders");
  list.setAttribute("popover", "");
  list.setAttribute("data-repo-folders", "");
  const said = (words: string): HTMLElement =>
    el("p", "repo-folders-said", words);
  choose.addEventListener("click", () => {
    const r = folder.getBoundingClientRect();
    list.style.left = `${r.left}px`;
    list.style.top = `${r.bottom + 6}px`;
    list.style.width = `${r.width}px`;
    list.replaceChildren(said("Reading folders…"));
    list.showPopover();
    readFolders()?.then(
      (got) => {
        const items = got.folders.map((name) => {
          const b = el("button");
          b.type = "button";
          b.append(icon("folder"), name);
          if (name === f.folder) b.setAttribute("aria-current", "true");
          b.addEventListener("click", () => {
            f.folder = name;
            folder.value = name;
            list.hidePopover();
          });
          return b;
        });
        list.replaceChildren(
          ...(items.length === 0 ? [said("No folders yet. Type one.")] : items),
          ...(got.more ? [said("The first 500 folders.")] : []),
        );
      },
      (error: unknown) => {
        const p = said(messageOf(error));
        p.setAttribute("data-repo-folders-error", "");
        list.replaceChildren(p);
      },
    );
  });
  const folderRow = el("div", "repo-folder");
  folderRow.append(folder, choose, list);

  const name = el("input");
  name.value = f.name;
  name.setAttribute("data-repo-name", "");
  name.setAttribute("aria-label", "File name");
  // Add follows the name as it is typed: an empty name adds nothing.
  name.addEventListener("input", () => {
    f.name = name.value;
    const add = name
      .closest("form")
      ?.querySelector<HTMLButtonElement>("[data-repo-add]");
    if (add) add.disabled = !nameOk(f);
  });
  const ext = el("span", "repo-ext", ".mp4");
  ext.setAttribute("data-repo-ext", "");
  const nameRow = el("div", "repo-name");
  nameRow.append(name, ext);

  const line = el("p", "repo-said", SAID[f.deliver]);
  line.setAttribute("data-repo-said", "");
  const deliver = toggle(
    "Video",
    "data-repo-deliver",
    [
      ["commit", "Commit"],
      ["files", "Files"],
    ] as const,
    f.deliver,
    (v) => {
      f.deliver = v;
      redraw();
    },
  );
  const quality = toggle(
    "Quality",
    "data-repo-quality",
    EXPORT_QUALITY_VALUES.map((q) => [q, EXPORT_QUALITY_LABELS[q]] as const),
    f.quality,
    (v) => {
      f.quality = v;
      redraw();
    },
  );
  return [
    // Files writes a file name only: there is no folder to choose.
    ...(f.deliver === "files" ? [] : [fieldOf("Folder", folderRow)]),
    fieldOf("File name", nameRow),
    fieldOf("Video", deliver, line),
    fieldOf("Quality", quality),
  ];
}

/** Each written file: what it is, its path, its Reveal, and a refused
 *  Reveal's words under it (DEM-49, DEM-56). */
function filesList(
  s: Extract<SheetState, { step: "last" }>,
  a: RepoSheetArgs,
  revealErrors: Map<string, string>,
  redraw: () => void,
): HTMLElement {
  const list = el("dl", "repo-files");
  list.setAttribute("data-repo-written", "");
  for (const file of s.written) {
    const label = writtenLabel(file);
    const path = `${s.root}/${file}`;
    const dd = el("dd", undefined, file);
    dd.title = file;
    list.append(el("dt", undefined, label), dd);
    const reveal = a.reveal;
    if (reveal === undefined) {
      list.append(el("span"));
    } else {
      const b = button("", "folder", "btn btn-quiet btn-icon");
      b.setAttribute("aria-label", `Reveal ${label}`);
      b.title = "Reveal";
      b.addEventListener("click", () => {
        revealErrors.delete(path);
        reveal(path).then(
          () => redraw(),
          (error: unknown) => {
            revealErrors.set(path, messageOf(error));
            redraw();
          },
        );
      });
      list.append(b);
    }
    const err = revealErrors.get(path);
    if (err !== undefined) {
      const p = el("p", "notice notice-error", err);
      p.setAttribute("data-reveal-error", "");
      list.append(p);
    }
  }
  return list;
}
