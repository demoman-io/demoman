// apps/studio/pages/src/shell/ci-steps.ts

import type { AppSpec } from "@demoman/run-core";
import type {
  CiAppliedWire,
  CiChoicesWire,
  CiPlannedWire,
  CiState,
  CiStopWire,
} from "@demoman/studio-protocol";
import type { CiEvent, Platform } from "../platform/types";
import { icon, spinner } from "./icons";

export type RepoCiDoor = Platform["repoCi"];

/** What CI setup says and offers for one repo. `progress` is the check's or
 *  the watch's lines, kept under the verdict that follows them. `setUp`:
 *  the repo has the workflow on its default branch; the caller decides what
 *  that offers (the add sheet: its own pull request). */
export type CiStep =
  | { k: "reading" }
  | { k: "note"; text: string }
  | { k: "setUp" }
  | { k: "form"; stop?: CiStopWire }
  | { k: "working"; lines: string[] }
  | { k: "planned"; planned: CiPlannedWire; progress: string[]; stale: boolean }
  | { k: "applied"; applied: CiAppliedWire; progress: string[] }
  | { k: "stopped"; stop: CiStopWire };

export const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** A line for the panels: the timings and the refresh's renames are the
 *  terminal's and studio.log's alone. */
export const shown = (line: string): boolean =>
  !line.startsWith("timing ") && !line.startsWith("refresh: renamed ");

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

/**
 * CI setup for `root`, without a dialog: the add sheet's second section and
 * the CI sheet both drive one. `read` starts it from the repo's state.
 */
export function ciSteps(door: RepoCiDoor, root: string, onChange: () => void) {
  let step: CiStep = { k: "reading" };
  let stopCi: (() => void) | undefined;
  let stopped = false;
  let prUrl: string | null = null;
  // The choices and the app's holes are not secrets; a password never lands here.
  const ciChoices: CiChoicesWire = {};
  const holes: Record<string, string> = {};
  let proposal: CiStopWire["proposal"];
  const set = (next: CiStep): void => {
    if (stopped) return;
    step = next;
    onChange();
  };

  function stoppedAt(s: CiStopWire): void {
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
    set(
      s.reason === "appHoles" || s.reason === "secretMissing"
        ? { k: "form", stop: s }
        : { k: "stopped", stop: s },
    );
  }

  /** `replayed`: the job was not this one's, so a plan it answers is from
   *  before and needs a fresh Check (R16). */
  function onCi(e: CiEvent, replayed = false): void {
    if (e.phase === "progress") {
      if (step.k === "working" && shown(e.line))
        set({ k: "working", lines: [...step.lines, e.line] });
      return;
    }
    const progress = step.k === "working" ? step.lines : [];
    const answer = e.answer;
    if ("planId" in answer)
      set({ k: "planned", planned: answer, progress, stale: replayed });
    else if ("pr" in answer) {
      prUrl = "opened" in answer.pr ? answer.pr.opened.url : null;
      set({ k: "applied", applied: answer, progress });
    } else stoppedAt(answer);
  }

  /** Listens to one job; a terminal event replayed inside `onCi` ends it. */
  function listen(jobId: string, replayed = false): void {
    stopCi?.();
    let ended = false;
    let off: (() => void) | undefined;
    off = door.onCi(jobId, (e) => {
      // Ended: unheard from now on.
      if (e.phase === "done") {
        ended = true;
        off?.();
      }
      onCi(e, replayed);
    });
    stopCi = off;
    if (ended || stopped) off();
  }

  const failedStop = (error: unknown): CiStopWire => ({
    reason: "request",
    detail: messageOf(error),
  });

  return {
    ciChoices,
    holes,
    get step() {
      return step;
    },
    get proposal() {
      return proposal;
    },
    /** The pull request an apply opened, or null. */
    get prUrl() {
      return prUrl;
    },
    async read(): Promise<void> {
      let ci: CiState;
      try {
        ci = await door.state(root);
      } catch (error) {
        set({ k: "note", text: messageOf(error) });
        return;
      }
      switch (ci.kind) {
        case "setUp":
          set({ k: "setUp" });
          return;
        case "notSetUp":
          set({ k: "form" });
          return;
        case "noGh":
        case "unreadable":
          set({ k: "note", text: ci.detail });
          return;
        case "running":
          set({ k: "working", lines: [] });
          listen(ci.jobId, true);
          return;
        case "finished":
          set({ k: "working", lines: [] });
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
    },
    /** Check the setup. The secrets are read by the caller from its password
     *  fields and go straight into the request: nothing here keeps them. */
    async check(secrets: Record<string, string>): Promise<void> {
      if (step.k !== "form" && step.k !== "planned" && step.k !== "stopped")
        return;
      if (proposal !== undefined) {
        ciChoices.app = appFrom(proposal.draft, holes);
        ciChoices.appBy = "person";
      }
      set({ k: "working", lines: [] });
      try {
        const { jobId } = await door.plan({
          root,
          choices: { ...ciChoices },
          secrets,
        });
        listen(jobId);
      } catch (error) {
        set({ k: "stopped", stop: failedStop(error) });
      }
    },
    /** Trigger or Route changed: the held plan no longer matches, so it
     *  cannot be applied until a fresh Check (R16). */
    markStale(): void {
      if (step.k === "planned") set({ ...step, stale: true });
    },
    /** Apply the plan the server holds (`planId`). */
    async apply(): Promise<void> {
      if (step.k !== "planned" || step.stale) return;
      const { planId } = step.planned;
      set({ k: "working", lines: [] });
      try {
        const { jobId } = await door.apply({ root, planId });
        listen(jobId);
      } catch (error) {
        set({ k: "stopped", stop: failedStop(error) });
      }
    },
    /** Whether a job of this one's runs: a sheet does not close under it. */
    get busy(): boolean {
      return step.k === "working";
    },
    /** Unheard from here: the sheet closed. */
    stop(): void {
      stopped = true;
      stopCi?.();
    },
  };
}

export type CiSteps = ReturnType<typeof ciSteps>;

export const field = (
  label: string,
  control: HTMLElement,
): HTMLLabelElement => {
  const wrap = document.createElement("label");
  wrap.append(label, control);
  return wrap;
};

export const button = (
  word: string,
  glyph: Parameters<typeof icon>[0] | null,
  cls = "btn btn-quiet",
) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  if (glyph !== null) b.append(icon(glyph));
  b.append(word);
  return b;
};

export const text = (tag: "p" | "pre", content: string, attr?: string) => {
  const el = document.createElement(tag);
  el.textContent = content;
  if (attr !== undefined) el.setAttribute(attr, "");
  return el;
};

/** An anchor to an https address, opened in a new tab; null for any
 *  other address, which the caller says as plain words. */
export const anchor = (
  url: string,
  label: string,
): HTMLAnchorElement | null => {
  if (!/^https:\/\//.test(url)) return null;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.textContent = label;
  return a;
};

/** A link only to an https address; anything else is plain text. */
export const link = (url: string, label: string): HTMLElement => {
  const a = anchor(url, label);
  if (a === null) return text("p", `${label}: ${url}`);
  const p = document.createElement("p");
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

/** A wait the sheet is in (DEM-80): its words beside a turning spinner. */
const waiting = (words: string, attr: string): HTMLElement => {
  const line = text("p", words, attr);
  line.className = "repo-line";
  line.prepend(spinner());
  return line;
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

/** What a CI step draws: its nodes, its buttons, what to focus. `setUp`
 *  draws nothing: its caller says what a set-up repo offers. `notNow` adds
 *  that button where a check can still be made. */
export function ciStepsView(
  s: CiSteps,
  o: { notNow?: () => void } = {},
): { nodes: HTMLElement[]; actions: HTMLElement[]; focus?: HTMLElement } {
  const ci = s.step;
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
  const notNow = (): void => {
    const go = o.notNow;
    if (go !== undefined) act("Not now", "close", "data-ci-not-now", go);
  };
  switch (ci.k) {
    case "reading":
      nodes.push(waiting("Reading CI…", "data-ci-reading"));
      break;
    case "note":
      nodes.push(text("p", ci.text, "data-ci-note"));
      break;
    case "setUp":
      break;
    case "working":
      nodes.push(waiting("Working…", "data-ci-working"), statusPanel(ci.lines));
      break;
    case "stopped":
      nodes.push(text("p", ci.stop.detail, "data-ci-stop"));
      if (ci.stop.tail !== undefined) nodes.push(text("pre", ci.stop.tail));
      act("Check", "shieldCheck", "data-ci-check", () => void s.check({}));
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
        const offered = planned.plan.offers.filter((x) => x.offered);
        const trigger = document.createElement("select");
        trigger.setAttribute("data-ci-trigger", "");
        offered.forEach((x, i) => {
          trigger.append(
            new Option(
              x.label,
              String(i),
              false,
              JSON.stringify(x.trigger) ===
                JSON.stringify(s.ciChoices.trigger ?? planned.plan.trigger),
            ),
          );
        });
        trigger.addEventListener("change", () => {
          s.ciChoices.trigger = offered[Number(trigger.value)]?.trigger;
          s.markStale();
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
              value === (s.ciChoices.route ?? planned.plan.route),
            ),
          );
        }
        route.addEventListener("change", () => {
          s.ciChoices.route = route.value as "pr" | "main";
          s.markStale();
        });
        nodes.push(field("Trigger", trigger), field("Route", route));
      }
      const needed =
        stop?.reason === "appHoles" ? (s.proposal?.holes ?? []) : [];
      for (const h of needed) {
        const input = document.createElement("input");
        input.value = s.holes[h.field] ?? "";
        input.setAttribute("data-ci-hole", h.field);
        input.addEventListener("input", () => {
          s.holes[h.field] = input.value;
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
        void s.check(values);
      });
      if (planned !== null && ci.k === "planned" && !ci.stale) {
        act(
          "Open pull request",
          "gitBranchPlus",
          "data-ci-apply",
          () => void s.apply(),
        );
      }
      notNow();
    }
  }
  return { nodes, actions: acts, focus };
}
