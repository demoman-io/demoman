import { el } from "../../src/editor/dom";
import { formatLength } from "../../src/library/length";
import { hostOf, pathOf } from "../../src/library/state";
import type { RevealTarget } from "../../src/platform/types";
import { icon } from "../../src/shell/icons";
import type { RunsRoute } from "../../src/shell/runs-link";
import { type HistoryState, renderExportHistory, shortTime } from "./view";

/**
 * Take info: the popover off the header's length-and-size button (the
 * author, 2026-10-19). One list of what the take is — when and where it was
 * recorded, how long, at what size — then the take's id with a copy, the
 * extension's link to Runs, and the take's exports. The Recent exports list
 * lived in the export panel until then; the panel is for exporting.
 */
export interface TakeInfoState {
  /** `meta.createdAt`, ISO. */
  recordedAt: string;
  /** `meta.capture.originUrl`: the page the recording started on. */
  site: string;
  /** The deliverable's length after trim. */
  durationMs: number;
  steps: number;
  recording: { width: number; height: number };
  target: { width: number; height: number };
  aspect: "auto" | "16:9" | "9:16";
  takeId: string;
  rerun: RunsRoute["rerun"];
  history: HistoryState;
  /** Why the last Show in Finder press showed nothing, or null. Drawn here
   *  as well as in the export panel: a press from a row here is answered
   *  where it was made, whichever panel is open. */
  revealError: string | null;
}

export interface TakeInfoHandlers {
  /** Resolves once the clipboard has the text; rejects with the browser's
   *  reason when it refused. The button reports either. */
  onCopy(text: string): Promise<void>;
  onDownload(ref: string): void;
  onReveal(target: RevealTarget): void;
  onShowAll(): void;
  /** A history row's warnings chip: fold or unfold what it came with. */
  onWarnings(key: string): void;
}

/** The page without its scheme: "northwind.example/checkout", the library's
 *  host and path. A URL the parser does not take is shown as recorded. */
function siteLabel(url: string): string {
  return `${hostOf(url)}${pathOf(url)}`;
}

function row(key: string, value: string, mono = false): HTMLElement {
  const r = el("div", "info-row");
  r.append(el("span", "info-key", key));
  const v = el("span", mono ? "info-value mono" : "info-value", value);
  v.title = value;
  r.append(v);
  return r;
}

/**
 * A row whose value goes to the clipboard. The button is the report: a
 * check while the copy held, the browser's reason under the row when it
 * refused — never a quiet button over a paste with nothing in it.
 */
function copyRow(
  key: string,
  value: string,
  what: string,
  onCopy: TakeInfoHandlers["onCopy"],
): HTMLElement {
  const r = row(key, value, true);
  const button = el("button", "btn btn-quiet btn-icon info-copy");
  button.type = "button";
  button.setAttribute("aria-label", `Copy ${what}`);
  button.title = `Copy ${what}`;
  button.setAttribute("data-copy", what);
  button.append(icon("copy"));
  const failed = el("div", "info-error");
  failed.setAttribute("data-copy-error", what);
  failed.hidden = true;
  button.addEventListener("click", () => {
    onCopy(value).then(
      () => {
        failed.hidden = true;
        button.replaceChildren(icon("check"));
        button.setAttribute("aria-label", "Copied");
        button.title = "Copied";
      },
      (error: unknown) => {
        failed.textContent = `Couldn't copy: ${
          error instanceof Error ? error.message : String(error)
        }`;
        failed.hidden = false;
      },
    );
  });
  r.append(button);
  const wrap = el("div");
  wrap.append(r, failed);
  return wrap;
}

export function renderTakeInfo(
  root: HTMLElement,
  state: TakeInfoState,
  handlers: TakeInfoHandlers,
): void {
  const facts = el("div", "info-group");
  facts.setAttribute("data-info-facts", "");
  const length = `${formatLength(state.durationMs)} · ${state.steps} ${
    state.steps === 1 ? "step" : "steps"
  }`;
  const aspect = state.aspect === "auto" ? "Auto" : state.aspect;
  facts.append(
    row("Recorded", shortTime(state.recordedAt)),
    row("Site", siteLabel(state.site)),
    row("Length", length),
    row("Recording", `${state.recording.width} × ${state.recording.height}`),
    row("Video", `${state.target.width} × ${state.target.height} · ${aspect}`),
  );

  const ids = el("div", "info-group");
  ids.setAttribute("data-info-ids", "");
  ids.append(copyRow("Take ID", state.takeId, "take ID", handlers.onCopy));
  // How a studio take is filmed again is parked (the author, 2026-10-19):
  // the agent call this row copied read as plumbing, and re-filming is not
  // a priority. The extension keeps its link to Runs, the one way there for
  // a take with frames that its own notes ("Re-shoot it in Runs") send the
  // author.
  if (state.rerun.kind === "link") {
    const r = el("div", "info-row");
    r.append(el("span", "info-key", "Re-record"));
    const link = el("a", "info-value", state.rerun.label);
    link.setAttribute("href", state.rerun.href);
    link.setAttribute("data-runs-route", "");
    r.append(link);
    ids.append(r);
  }

  const parts: HTMLElement[] = [facts, ids];
  if (state.history.outputs.length > 0) {
    const exports = el("div", "info-group info-exports");
    exports.setAttribute("data-info-exports", "");
    exports.append(el("div", "info-label", "Exports"));
    if (state.revealError !== null) {
      const line = el("p", "notice notice-warn", state.revealError);
      line.setAttribute("data-reveal-error", "");
      exports.append(line);
    }
    const list = el("div", "info-history");
    renderExportHistory(list, state.history, handlers);
    exports.append(list);
    parts.push(exports);
  }
  root.replaceChildren(...parts);
}
