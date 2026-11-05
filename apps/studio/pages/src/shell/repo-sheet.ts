// apps/studio/pages/src/shell/repo-sheet.ts

import type { AppSpec } from "@demoman/run-core";
import {
  EXPORT_QUALITY_LABELS,
  EXPORT_QUALITY_VALUES,
  type ExportQuality,
} from "@demoman/run-core";
import type {
  Addable,
  CiAppliedWire,
  CiChoicesWire,
  CiPlannedWire,
  CiState,
  CiStopWire,
  VideoSummary,
} from "@demoman/studio-protocol";
import type { CiEvent, Platform, RepoEvent } from "../platform/types";
import type { ConfirmQuestion } from "./confirm-dialog";
import { icon } from "./icons";
import { showToast } from "./toast";

type RepoDoor = Platform["videos"]["repo"];
export type RepoCiDoor = Platform["repoCi"];
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

/** What the last step says and offers about CI. `progress` is the check's or
 *  the watch's lines, kept under the verdict that follows them. */
export type CiStep =
  | { k: "reading" }
  | { k: "note"; text: string }
  | { k: "pr"; busy: boolean; error?: string }
  | { k: "prDone"; url: string }
  | { k: "form"; stop?: CiStopWire }
  | { k: "working"; lines: string[] }
  | { k: "planned"; planned: CiPlannedWire; progress: string[]; stale: boolean }
  | { k: "applied"; applied: CiAppliedWire; progress: string[] }
  | { k: "stopped"; stop: CiStopWire };

/** The draft with the person's filled holes laid over it: only the fields
 *  they gave, so a good `start` or `url` is never blanked. `env.NAME` goes
 *  into `env`. */
function appFrom(
  draft: NonNullable<CiStopWire["proposal"]>["draft"],
  holes: Record<string, string>,
): AppSpec {
  const app: Record<string, unknown> = { ...draft, env: { ...draft.env } };
  const env = app.env as Record<string, string>;
  for (const [field, value] of Object.entries(holes)) {
    if (value.trim() === "") continue;
    if (field.startsWith("env.")) env[field.slice(4)] = value;
    else if (field === "timeoutSeconds") app[field] = Number(value);
    else if (field === "install") {
      app[field] = value
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean);
    } else app[field] = value;
  }
  return app as unknown as AppSpec;
}

const holeLabel = (field: string): string =>
  field === "start"
    ? "Start command"
    : field === "url"
      ? "URL"
      : field.startsWith("env.")
        ? field.slice(4)
        : field;

export type SheetState =
  | { step: "form" }
  | { step: "running"; line: string }
  | {
      step: "last";
      root: string;
      written: string[];
      notes: string[];
      file: string;
      ci: CiStep | null;
    };

const base = (file: string): string => file.split("/").pop() ?? file;

/** A line for the sheet's panels: the timings and the refresh's renames are
 *  the terminal's and studio.log's alone. */
const shown = (line: string): boolean =>
  !line.startsWith("timing ") && !line.startsWith("refresh: renamed ");

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
  let stopCi: (() => void) | undefined;
  let prUrl: string | null = null;
  let toast: string | null = null;
  // The choices and the app's holes are not secrets; a password never lands here.
  const ciChoices: CiChoicesWire = {};
  const holes: Record<string, string> = {};
  let proposal: CiStopWire["proposal"];
  const door = a.ci;
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
    stopCi?.();
    settle(r);
    for (const fn of listeners) fn();
  };

  function on(e: RepoEvent): void {
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
          set({
            step: "last",
            root: e.root,
            written: e.written,
            notes: e.notes,
            file: e.file,
            ci: door === null ? null : { k: "reading" },
          });
          if (door !== null) void readCi(e.root, door);
        }
        return;
      case "failed":
        finish({ added: null, prOpened: null, failed: e.detail });
    }
  }

  const setCi = (ci: CiStep): void => {
    if (state.step === "last") set({ ...state, ci });
  };
  const current = (): CiStep | null =>
    state.step === "last" ? state.ci : null;

  function stopped(s: CiStopWire): void {
    if (s.proposal !== undefined) {
      proposal = s.proposal;
      for (const h of s.proposal.holes) {
        holes[h.field] ??= String(
          (s.proposal.draft as Record<string, unknown>)[h.field] ?? "",
        );
      }
    }
    // Both come back to the fields they name; anything else is said, with
    // Check to try again.
    setCi(
      s.reason === "appHoles" || s.reason === "secretMissing"
        ? { k: "form", stop: s }
        : { k: "stopped", stop: s },
    );
  }

  /** `replayed`: the job was not this sheet's, so a plan it answers is from
   *  before this add and needs a fresh Check (R16). */
  function onCi(e: CiEvent, replayed = false): void {
    const ci = current();
    if (e.phase === "progress") {
      if (ci?.k === "working" && shown(e.line))
        setCi({ k: "working", lines: [...ci.lines, e.line] });
      return;
    }
    const progress = ci?.k === "working" ? ci.lines : [];
    const answer = e.answer;
    if ("planId" in answer)
      setCi({ k: "planned", planned: answer, progress, stale: replayed });
    else if ("pr" in answer) {
      prUrl = "opened" in answer.pr ? answer.pr.opened.url : null;
      setCi({ k: "applied", applied: answer, progress });
    } else stopped(answer);
  }

  /** Listens to one job; a terminal event replayed inside `onCi` ends it. */
  function listen(door: RepoCiDoor, jobId: string, replayed = false): void {
    stopCi?.();
    let ended = false;
    const off = door.onCi(jobId, (e) => {
      if (e.phase === "done") ended = true;
      onCi(e, replayed);
    });
    stopCi = off;
    if (ended || settled) off();
  }

  async function readCi(root: string, door: RepoCiDoor): Promise<void> {
    let ci: CiState;
    try {
      ci = await door.state(root);
    } catch (error) {
      setCi({ k: "note", text: messageOf(error) });
      return;
    }
    if (settled) return;
    switch (ci.kind) {
      case "setUp":
        setCi({ k: "pr", busy: false });
        return;
      case "notSetUp":
        setCi({ k: "form" });
        return;
      case "noGh":
      case "unreadable":
        setCi({ k: "note", text: ci.detail });
        return;
      case "running":
        setCi({ k: "working", lines: [] });
        listen(door, ci.jobId, true);
        return;
      case "finished":
        setCi({ k: "working", lines: [] });
        onCi(
          {
            type: "ci",
            jobId: ci.jobId,
            phase: "done",
            step: ci.step,
            answer: ci.answer,
          },
          true,
        );
    }
  }

  const failedStop = (error: unknown): CiStopWire => ({
    reason: "request",
    detail: messageOf(error),
  });

  return {
    fields,
    ciChoices,
    holes,
    result,
    get toast() {
      return toast;
    },
    get proposal() {
      return proposal;
    },
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
    /** Check the setup. The secrets are read by the caller from its password
     *  fields and go straight into the request: nothing here keeps them. */
    async check(secrets: Record<string, string>): Promise<void> {
      const ci = current();
      if (door === null || state.step !== "last") return;
      if (ci?.k !== "form" && ci?.k !== "planned" && ci?.k !== "stopped")
        return;
      if (proposal !== undefined) {
        ciChoices.app = appFrom(proposal.draft, holes);
        ciChoices.appBy = "person";
      }
      setCi({ k: "working", lines: [] });
      try {
        const { jobId } = await door.plan({
          root: state.root,
          choices: { ...ciChoices },
          secrets,
        });
        listen(door, jobId);
      } catch (error) {
        setCi({ k: "stopped", stop: failedStop(error) });
      }
    },
    /** Trigger or Route changed: the held plan no longer matches, so it
     *  cannot be applied until a fresh Check (R16). */
    markStale(): void {
      const ci = current();
      if (ci?.k === "planned") setCi({ ...ci, stale: true });
    },
    /** Apply the plan the server holds (`planId`). */
    async apply(): Promise<void> {
      const ci = current();
      if (
        door === null ||
        state.step !== "last" ||
        ci?.k !== "planned" ||
        ci.stale
      )
        return;
      const { planId } = ci.planned;
      setCi({ k: "working", lines: [] });
      try {
        const { jobId } = await door.apply({ root: state.root, planId });
        listen(door, jobId);
      } catch (error) {
        setCi({ k: "stopped", stop: failedStop(error) });
      }
    },
    /** The later add's pull request: only its own files (Decision 5). */
    async openPr(): Promise<void> {
      const ci = current();
      if (door === null || state.step !== "last" || ci?.k !== "pr") return;
      const name = base(state.file).replace(/\.json$/, "");
      setCi({ k: "pr", busy: true });
      try {
        const r = await door.openPr({
          root: state.root,
          branch: `demoman/add-${name}`,
          title: `Add the "${a.video.name}" flow`,
          body: state.written.map((f) => `- ${f}`).join("\n"),
          files: state.written,
        });
        if ("opened" in r) {
          prUrl = r.opened.url;
          setCi({ k: "prDone", url: r.opened.url });
        } else setCi({ k: "pr", busy: false, error: r.detail });
      } catch (error) {
        setCi({ k: "pr", busy: false, error: messageOf(error) });
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
        prOpened: prUrl,
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

const text = (tag: "p" | "pre", content: string, attr?: string) => {
  const el = document.createElement(tag);
  el.textContent = content;
  if (attr !== undefined) el.setAttribute(attr, "");
  return el;
};

/** A link only to an https address; anything else is plain text. */
const link = (url: string, label: string): HTMLElement => {
  if (!/^https:\/\//.test(url)) return text("p", `${label}: ${url}`);
  const p = document.createElement("p");
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.textContent = label;
  p.append(a);
  return p;
};

const statusPanel = (lines: string[]): HTMLElement => {
  const panel = document.createElement("div");
  panel.className = "repo-status";
  panel.setAttribute("role", "status");
  panel.setAttribute("data-ci-status", "");
  for (const line of lines) panel.append(text("p", line));
  return panel;
};

const lineList = (lines: string[], attr: string): HTMLElement => {
  const list = document.createElement("ul");
  list.className = "repo-lines";
  list.setAttribute(attr, "");
  for (const line of lines) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }
  return list;
};

/** How a finished apply reads. An unknown outcome says so and names the run;
 *  it is never called a failure. */
function appliedNodes(r: CiAppliedWire): HTMLElement[] {
  const out: HTMLElement[] = [];
  if ("opened" in r.pr) {
    out.push(link(r.pr.opened.url, `Pull request #${r.pr.opened.number}`));
  } else {
    out.push(text("p", r.pr.detail, "data-ci-pr-failed"));
    if (r.pr.branchUrl !== undefined) out.push(link(r.pr.branchUrl, "Branch"));
  }
  for (const f of r.secrets.failed) {
    out.push(text("p", `Secret ${f.name}: ${f.said}`));
  }
  if (
    r.setting !== null &&
    (r.setting.kind === "refused" || r.setting.kind === "unknown")
  ) {
    out.push(
      text(
        "p",
        `Actions setting ${r.setting.kind === "refused" ? "refused" : "unknown"}: ${r.setting.detail}`,
        "data-ci-setting",
      ),
      link(r.setting.url, "Actions settings"),
    );
  }
  const w = r.watched;
  if ("passed" in w) {
    out.push(
      text("p", "The run passed.", "data-ci-verdict"),
      link(w.passed.runUrl, "Run"),
      link(w.passed.artifactUrl, "Video"),
    );
  } else if ("failed" in w) {
    out.push(
      text("p", `The run failed at ${w.failed.step}.`, "data-ci-verdict"),
      link(w.failed.runUrl, "Run"),
      text("pre", w.failed.tail),
    );
  } else if ("cancelled" in w) {
    out.push(
      text("p", "The run was cancelled.", "data-ci-verdict"),
      link(w.cancelled.runUrl, "Run"),
    );
  } else {
    out.push(
      text("p", "Its outcome is unknown.", "data-ci-verdict"),
      text("p", w.unknown.why),
    );
    if (w.unknown.runUrl !== null) out.push(link(w.unknown.runUrl, "Run"));
  }
  return out;
}

const verdictOf = (c: CiPlannedWire["plan"]["check"]): string =>
  "skipped" in c ? `Check skipped: ${c.skipped}` : `Check passed: ${c.outcome}`;

/** The add sheet: a modal `<dialog>` built as `askToConfirm`'s is. */
export function openRepoSheet(a: RepoSheetArgs): Promise<RepoSheetResult> {
  const model = repoSheetModel(a);
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog repo-sheet";
  dialog.setAttribute("data-repo-sheet", "");
  const form = document.createElement("form");
  form.addEventListener("submit", (event) => event.preventDefault());
  dialog.append(form);

  /** The CI part of the last step: its nodes, its buttons, what to focus. */
  const ciView = (
    ci: CiStep,
  ): { nodes: HTMLElement[]; actions: HTMLElement[]; focus?: HTMLElement } => {
    const nodes: HTMLElement[] = [];
    const acts: HTMLElement[] = [];
    let focus: HTMLElement | undefined;
    const act = (
      word: string,
      glyph: Parameters<typeof icon>[0],
      attr: string,
      fn: () => void,
    ) => {
      const b = button(word, glyph);
      b.setAttribute(attr, "");
      b.addEventListener("click", fn);
      acts.push(b);
    };
    const notNow = (): void =>
      act("Not now", "close", "data-ci-not-now", () => model.notNow());
    switch (ci.k) {
      case "reading":
        nodes.push(text("p", "Reading CI…", "data-ci-reading"));
        break;
      case "note":
        nodes.push(text("p", ci.text, "data-ci-note"));
        break;
      case "pr":
        if (ci.error !== undefined) {
          nodes.push(text("p", ci.error, "data-ci-error"));
        }
        act(
          "Open pull request",
          "gitBranchPlus",
          "data-repo-pr",
          () => void model.openPr(),
        );
        if (ci.busy) {
          (acts[0] as HTMLButtonElement).disabled = true;
        }
        break;
      case "prDone":
        nodes.push(link(ci.url, "Pull request"));
        break;
      case "working":
        nodes.push(statusPanel(ci.lines));
        break;
      case "stopped":
        nodes.push(text("p", ci.stop.detail, "data-ci-stop"));
        if (ci.stop.tail !== undefined) nodes.push(text("pre", ci.stop.tail));
        act(
          "Check",
          "shieldCheck",
          "data-ci-check",
          () => void model.check({}),
        );
        break;
      case "applied":
        nodes.push(statusPanel(ci.progress), ...appliedNodes(ci.applied));
        break;
      case "form":
      case "planned": {
        const planned = ci.k === "planned" ? ci.planned : null;
        const stop = ci.k === "form" ? ci.stop : undefined;
        if (stop !== undefined)
          nodes.push(text("p", stop.detail, "data-ci-stop"));
        if (planned !== null) {
          nodes.push(
            statusPanel(ci.k === "planned" ? ci.progress : []),
            text("p", verdictOf(planned.plan.check), "data-ci-verdict"),
            lineList(planned.lines, "data-ci-plan-lines"),
          );
          const offered = planned.plan.offers.filter((o) => o.offered);
          const trigger = document.createElement("select");
          trigger.setAttribute("data-ci-trigger", "");
          offered.forEach((o, i) => {
            trigger.append(
              new Option(
                o.label,
                String(i),
                false,
                JSON.stringify(o.trigger) ===
                  JSON.stringify(
                    model.ciChoices.trigger ?? planned.plan.trigger,
                  ),
              ),
            );
          });
          trigger.addEventListener("change", () => {
            model.ciChoices.trigger = offered[Number(trigger.value)]?.trigger;
            model.markStale();
          });
          const route = document.createElement("select");
          route.setAttribute("data-ci-route", "");
          for (const [value, word] of [
            ["pr", "Pull request"],
            ["main", "Straight to the default branch"],
          ] as const) {
            route.append(
              new Option(
                word,
                value,
                false,
                value === (model.ciChoices.route ?? planned.plan.route),
              ),
            );
          }
          route.addEventListener("change", () => {
            model.ciChoices.route = route.value as "pr" | "main";
            model.markStale();
          });
          nodes.push(field("Trigger", trigger), field("Route", route));
        }
        const needed =
          stop?.reason === "appHoles" ? (model.proposal?.holes ?? []) : [];
        for (const h of needed) {
          const input = document.createElement("input");
          input.value = model.holes[h.field] ?? "";
          input.setAttribute("data-ci-hole", h.field);
          input.addEventListener("input", () => {
            model.holes[h.field] = input.value;
          });
          const wrap = field(holeLabel(h.field), input);
          const why = document.createElement("small");
          why.className = "repo-why";
          why.textContent = h.why;
          input.before(why);
          nodes.push(wrap);
          focus ??= input;
        }
        const secrets: Array<[string, HTMLInputElement]> = [];
        for (const n of stop?.reason === "secretMissing"
          ? (stop.secrets ?? [])
          : []) {
          const input = document.createElement("input");
          input.type = "password";
          input.autocomplete = "new-password";
          input.setAttribute("data-ci-secret", n.name);
          secrets.push([n.name, input]);
          const wrap = field(n.name, input);
          const why = document.createElement("small");
          why.className = "repo-why";
          why.textContent = n.why;
          input.before(why);
          nodes.push(wrap);
          focus ??= input;
        }
        act("Check", "shieldCheck", "data-ci-check", () => {
          // Read once into the request, then cleared: nothing keeps a value.
          const values = Object.fromEntries(
            secrets
              .filter(([, i]) => i.value !== "")
              .map(([n, i]) => [n, i.value]),
          );
          for (const [, i] of secrets) i.value = "";
          void model.check(values);
        });
        if (planned !== null && ci.k === "planned" && !ci.stale) {
          act(
            "Open pull request",
            "gitBranchPlus",
            "data-ci-apply",
            () => void model.apply(),
          );
        }
        notNow();
      }
    }
    return { nodes, actions: acts, focus };
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
      const ci = s.ci === null ? null : ciView(s.ci);
      if (ci !== null) parts.push(...ci.nodes);
      const done = button("Done", "check");
      done.setAttribute("data-repo-done", "");
      done.addEventListener("click", () => model.close());
      // Not now already closes: two ways out would be one too many.
      const closes = ci?.actions.some((b) => b.hasAttribute("data-ci-not-now"));
      actions.append(...(ci?.actions ?? []), ...(closes ? [] : [done]));
      parts.push(actions);
      queueMicrotask(() => ci?.focus?.focus());
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
