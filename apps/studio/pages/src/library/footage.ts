// apps/studio/pages/src/library/footage.ts
//
// The Studio's Storage panel (the author's placement 1): what the
// library's "Storage" figure opens. How long old footage is kept, and what
// the last cleanup removed, named video by video (variant A). DOM only: the
// page passes how to read and save.

import {
  KEEP_FOOTAGE_LABELS,
  KEEP_FOOTAGE_VALUES,
  type KeepFootage,
  keepFootageDays,
} from "@demoman/run-core";
import type { ExpiryAnswer } from "@demoman/studio-protocol";
import { formatBytes } from "./state";

/** What the panel shows: the setting and what expiry last did, or why
 *  they could not be read. */
export type FootageRead =
  | { keep: KeepFootage | null; keepUnreadable?: string; expiry: ExpiryAnswer }
  | { failed: string };

export interface FootageActions {
  read(): Promise<FootageRead>;
  /** Resolves once saved; rejects with why it was not. */
  setKeep(value: KeepFootage): Promise<void>;
}

/** Rows shown before "and N more". */
export const REMOVED_SHOWN = 3;

const RECORDED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const RECORDED_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Oct 12", or "Oct 12, 2025" when it is not this year's: footage kept
 *  for 90 days or Forever can be older than a year when it goes. */
export function recordedWords(iso: string, now: Date): string {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear()
    ? RECORDED.format(d)
    : RECORDED_YEAR.format(d);
}

/** "2 hours ago": when the cleanup ran, as the panel says it. */
export function sinceWords(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return `at ${iso}`;
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** The line under the choice. Forever removes nothing, so it never says
 *  footage is removed (the author, 2026-11-24). */
export function keepHint(keep: KeepFootage | null): string {
  if (keep === null)
    return "This setting could not be read, so nothing is removed until one is chosen.";
  if (keep === "forever") return "Every video keeps its frames and previews.";
  return "Older videos' frames and previews are removed after this. Edited videos, each flow's current video and the one last exported are kept.";
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * The panel's body, below its title: `used` is the figure line, the rest is
 * read on `refresh` (each time the panel opens). Every read or save that
 * fails is said in the panel, never shown as "nothing removed".
 */
export function footageBody(
  actions: FootageActions,
  now: () => Date = () => new Date(),
): {
  element: HTMLElement;
  refresh(keepSaveError?: boolean): Promise<void>;
  setUsed(text: string): void;
} {
  const element = el("div", { class: "footage", "data-footage": "" });
  const used = el("p", { class: "storage-used", "data-footage-used": "" });
  const body = el("div");
  element.append(used, body);
  let read: FootageRead | null = null;
  let saving: string | null = null;
  /** A save in flight: the choices wait for it. */
  let pending = false;
  /** Only the newest read paints: an older one that answers late is stale. */
  let reads = 0;
  let expanded = false;

  const paint = (): void => {
    const parts: HTMLElement[] = [];
    if (read === null) {
      parts.push(el("p", { class: "storage-hint" }, "Reading…"));
    } else if ("failed" in read) {
      parts.push(
        el(
          "p",
          { class: "notice notice-error", "data-footage-failed": "" },
          `Couldn't read how long footage is kept: ${read.failed}`,
        ),
      );
    } else {
      parts.push(keepField(read), ...removedBlock(read));
    }
    if (saving !== null) {
      parts.push(
        el(
          "p",
          { class: "notice notice-error", "data-footage-save": "" },
          `Keep footage was not saved: ${saving}`,
        ),
      );
    }
    body.replaceChildren(...parts);
  };

  const keepField = (
    r: Extract<FootageRead, { keep: unknown }>,
  ): HTMLElement => {
    const field = el("div", { class: "storage-field keep-footage" });
    const label = el("span", { class: "label", id: "keep-footage-label" });
    label.textContent = "Keep footage";
    const group = el("div", {
      class: "segmented",
      role: "radiogroup",
      "aria-labelledby": "keep-footage-label",
    });
    for (const value of KEEP_FOOTAGE_VALUES) {
      const b = el(
        "button",
        {
          type: "button",
          class: "segment",
          role: "radio",
          "data-keep-footage": value,
          "aria-checked": String(value === r.keep),
        },
        KEEP_FOOTAGE_LABELS[value],
      );
      b.disabled = pending;
      b.addEventListener("click", () => {
        if (value === r.keep || pending) return;
        saving = null;
        pending = true;
        paint();
        actions.setKeep(value).then(
          () => {
            pending = false;
            return refresh();
          },
          (e: unknown) => {
            pending = false;
            saving = messageOf(e);
            return refresh(true);
          },
        );
      });
      group.append(b);
    }
    field.append(label, group);
    if (r.keepUnreadable !== undefined) {
      field.append(
        el(
          "p",
          { class: "notice notice-warn", "data-keep-unreadable": "" },
          r.keepUnreadable,
        ),
      );
    }
    field.append(
      el(
        "p",
        { class: "storage-hint", "data-keep-hint": "" },
        keepHint(r.keep),
      ),
    );
    return field;
  };

  const removedBlock = (
    r: Extract<FootageRead, { keep: unknown }>,
  ): HTMLElement[] => {
    const box = el("div", { class: "removed", "data-removed": "" });
    const out: HTMLElement[] = [box];
    const last = r.expiry.lastRemoval;
    if (last === null) {
      const days = r.keep === null ? null : keepFootageDays(r.keep);
      // "Checked" only for a pass that finished under the setting shown: a
      // failed one is said below, and one under another setting checked
      // something else.
      const checked =
        r.expiry.problem === undefined &&
        r.expiry.lastRanAt !== null &&
        days !== null &&
        r.expiry.ranUnder === r.keep;
      box.append(
        el(
          "p",
          { class: "removed-empty", "data-removed-empty": "" },
          r.keep === "forever"
            ? "Footage is kept forever, so nothing is removed."
            : checked
              ? `Checked ${sinceWords(r.expiry.lastRanAt as string, now())}: nothing was older than ${days} days.`
              : r.expiry.lastRanAt !== null &&
                  r.expiry.problem === undefined &&
                  days !== null
                ? `Not checked at ${days} days yet: the next cleanup runs when a video is recorded or the Studio opens.`
                : "Nothing removed yet.",
        ),
      );
    } else {
      const head = el("p", { class: "removed-head" });
      head.append(
        el("span", {}, `Removed ${sinceWords(last.at, now())}`),
        el("span", { class: "total" }, formatBytes(last.bytes)),
      );
      const list = el("ul", { class: "removed-list", "data-removed-list": "" });
      const rows = expanded ? last.videos : last.videos.slice(0, REMOVED_SHOWN);
      for (const v of rows) {
        const li = el("li");
        li.append(
          el("span", { class: "name", title: v.name }, v.name),
          el("span", { class: "date" }, recordedWords(v.recordedAt, now())),
          el("span", { class: "size" }, formatBytes(v.bytes)),
        );
        list.append(li);
      }
      box.append(head, list);
      const hidden = last.videos.length - REMOVED_SHOWN;
      if (expanded && last.more > 0) {
        box.append(
          el(
            "p",
            { class: "removed-empty" },
            `and ${last.more} more, not listed`,
          ),
        );
      }
      if (hidden > 0 || (!expanded && last.more > 0)) {
        const toggle = el(
          "button",
          { type: "button", class: "removed-more", "data-removed-more": "" },
          expanded
            ? "Show fewer"
            : `and ${Math.max(hidden, 0) + last.more} more`,
        );
        toggle.addEventListener("click", () => {
          expanded = !expanded;
          paint();
        });
        box.append(toggle);
      }
    }
    if (r.expiry.problem !== undefined) {
      out.push(
        el(
          "p",
          { class: "notice notice-error", "data-expiry-problem": "" },
          `The last cleanup did not finish: ${r.expiry.problem}`,
        ),
      );
    }
    return out;
  };

  /** Reads and paints. A save's own error stays only for the read that
   *  follows it (`keepSaveError`); a fresh open clears it. */
  async function refresh(keepSaveError = false): Promise<void> {
    if (!keepSaveError) saving = null;
    const mine = ++reads;
    let got: FootageRead;
    try {
      got = await actions.read();
    } catch (error) {
      got = { failed: messageOf(error) };
    }
    if (mine !== reads) return;
    read = got;
    paint();
  }

  paint();
  return {
    element,
    refresh,
    setUsed(text) {
      used.textContent = text;
    },
  };
}
