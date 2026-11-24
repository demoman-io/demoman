// A library row's parts (name field, tags, buttons, exports, status), which
// the cards (view.ts) and the list (list.ts) both draw with. Apart from
// view.ts so the list does not import the view that renders it (DEM-199).

import { type GlyphName, icon } from "../shell/icons";
import type { Why } from "./search";
import type { LibraryRow, VideoGroup } from "./state";
import { commitLabel } from "./state";
import type { LibraryActions, RowKind } from "./view";

/** The key a row's status is held under in the page's `rowStatus`. */
export const statusKey = (kind: RowKind, id: string): string => `${kind}:${id}`;

/** An expired video's line leads with the fact (spec 2026-10-30
 *  flows-and-bulk-delete §1.1); the platform's line alone is how to film
 *  it again, which the editor also says for a video with no frames. */
export const expiredLine = (
  expired: boolean | undefined,
  line: string,
): string =>
  expired === true
    ? `Expired — ${line.charAt(0).toLowerCase()}${line.slice(1)}`
    : line;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A label on the picture: a glyph and a word. `.tag`, not `.chip`: on
 *  Settings a chip is the round on/off indicator. */
function tag(
  glyph: GlyphName,
  text: string,
  attrs: Record<string, string> = {},
): HTMLElement {
  const span = el("span", { class: "tag", ...attrs });
  span.append(icon(glyph), text);
  return span;
}

/**
 * The tags: only for what departs from the ordinary — "Complete" is what a
 * recording is unless something has happened to it, so it says nothing; the
 * two degraded states and a hosted copy each get a glyph and a word. Null
 * when there are none, so the thumbnail carries no empty strip.
 */
export function tags(
  r: LibraryRow,
  actions: LibraryActions,
  /** The list leaves Hosted out: nothing sets it since the hosted server
   *  was retired, and the word will mean paid links (list spec §2.1). */
  withHosted = true,
): HTMLElement | null {
  const strip = el("div", { class: "row-tags" });
  // First, and the one tag that is a control: a drift check flagged this
  // take, and the flag is the way to Needs a look — which the popup's
  // "N demos need a look" row was until 2026-10-09. A glyph alone, the
  // author's call: the warn tone says it, the name is for the pointer
  // and the screen reader.
  const openReview = actions.openReview;
  if (r.needsLook && openReview !== undefined) {
    const look = el("button", {
      type: "button",
      class: "tag tag-warn tag-look",
      "data-needs-look": "",
      "aria-label": `Needs a look: ${r.label}`,
      title: "Needs a look",
    });
    look.append(icon("circleAlert"));
    look.addEventListener("click", () => openReview(r.sceneId));
    strip.append(look);
  }
  if (r.kept != null) {
    strip.append(
      tag("bookmark", "In repo", {
        "data-kept": "",
        title:
          "unknown" in r.kept
            ? r.kept.unknown
            : `${r.kept.root}/${r.kept.file}${r.keptUnder === undefined ? "" : ` — its repo could not be read, so it is listed under ${r.keptUnder}`}`,
      }),
    );
  }
  if (r.hosted && withHosted) {
    strip.append(
      tag("cloud", "Hosted", {
        "data-hosted": "",
        title: "Hosted copy stays online after a local delete",
      }),
    );
  }
  if (r.state === "Motion reclaimed") {
    strip.append(
      tag("restore", r.state, {
        "data-state-chip": "",
        class: "tag tag-warn",
        title: "Its motion was reclaimed to free space",
      }),
    );
  } else if (r.state === "Keyframes only") {
    strip.append(
      tag("image", r.state, {
        "data-state-chip": "",
        title: "No motion was recorded for this video",
      }),
    );
  }
  return strip.childElementCount > 0 ? strip : null;
}

/** The name field's id, which the card's `aria-labelledby` points at. */
export const nameFieldId = (sceneId: string): string => `name-${sceneId}`;

/**
 * The take's name, as a field on the card: plain text at rest, a ring
 * under the pointer, a control tint while it is being edited. Enter or
 * leaving the field commits; Escape, or the same name again, puts the last
 * committed name back and sends nothing. A blank commits too: it returns
 * the take to untitled, which reads "Untitled" as the placeholder — the
 * row's second line already says where and when it was made, so the
 * heading does not repeat either. `committed` follows a
 * successful commit so a blank typed straight after one restores the new
 * name, not the one the row was rendered with — the page re-renders the
 * row once the store answers, and until then this is the truth.
 */
export function nameField(
  r: LibraryRow,
  actions: LibraryActions,
  /** A video's card names the video: its own name, and a blank puts it
   *  back rather than sending (a video is never untitled). */
  group: VideoGroup | null,
): HTMLInputElement {
  const name = group === null ? r.name : group.video.name;
  const field = el("input", {
    type: "text",
    id: nameFieldId(r.sceneId),
    "data-name": "",
    "aria-label": group === null ? "Video name" : "Flow name",
    // The full name, for the pointer: a long one is clipped at rest.
    title: name,
    placeholder: "Untitled",
    spellcheck: "false",
    autocomplete: "off",
  });
  field.value = name;
  let committed = name;
  field.addEventListener("change", () => {
    const next = field.value.trim();
    if (next === committed || (group !== null && next === "")) {
      field.value = committed;
      return;
    }
    committed = next;
    field.value = next;
    field.title = next;
    if (group === null) actions.rename(r.sceneId, next);
    else actions.renameVideo(group.video.id, next);
  });
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      field.value = committed;
      field.blur();
    } else if (event.key === "Enter") {
      field.blur();
    }
  });
  return field;
}

/** Why a search found a flow, dim, after its name or in Where's place;
 *  `slot` names which, in a list row that carries both. */
export const matchWhy = (why: Why, slot = ""): HTMLElement =>
  el(
    "span",
    { class: "match-why", "data-match-why": slot, title: why.full },
    why.text,
  );

/** A card's buttons — Back to the original footage, Restore, Edit, Delete,
 *  whichever it has — and the sentence that stands where Restore would, or
 *  null. The list row draws the same set (list.ts). */
export function cardButtons(
  r: LibraryRow,
  actions: LibraryActions,
  group: VideoGroup | null,
): { buttons: HTMLElement; rerunLine: string | null } {
  const buttons = el("div", { class: "row-actions" });
  if (r.servesReshoot) {
    const back = el("button", {
      type: "button",
      "data-action": "back-to-recording",
      class: "btn btn-quiet btn-icon",
      "aria-label": `Back to the original footage: ${r.label}`,
      title:
        "Back to the original footage — this video plays its re-shot frames; its original footage is kept",
    });
    back.append(icon("undo"));
    back.addEventListener("click", () => actions.backToRecording(r.sceneId));
    buttons.append(back);
  }
  // An expired recording can only be recorded again, which the same line
  // says.
  const rerunLine =
    r.canRestore || r.expired === true
      ? expiredLine(r.expired, actions.rerunLine(r.sceneId, r.authored))
      : null;

  const edit = el("button", {
    type: "button",
    "data-action": "edit",
    class: "btn btn-quiet btn-icon",
    "aria-label": `Edit ${r.label}`,
    title: "Edit",
  });
  edit.append(icon("clapperboard"));
  edit.addEventListener("click", () => actions.edit(r.sceneId));
  if (r.expired !== true) buttons.append(edit);

  const repoButton = repoActionButton(r, actions, group);
  if (repoButton !== null) buttons.append(repoButton);

  const remove = el("button", {
    type: "button",
    "data-action": "delete",
    class: "btn btn-quiet btn-icon btn-danger",
    "aria-label": `Delete ${r.label}`,
    title: "Delete",
  });
  remove.append(icon("trash"));
  remove.addEventListener("click", () =>
    group === null
      ? actions.remove(r.sceneId, "take")
      : actions.remove(group.video.id, "video"),
  );
  buttons.append(remove);
  return { buttons, rerunLine };
}

/** Add to repo on a flow that is not In repo (disabled, with its reason,
 *  when it cannot be added) and Remove from repo on one that is. */
function repoActionButton(
  r: LibraryRow,
  actions: LibraryActions,
  group: VideoGroup | null,
): HTMLElement | null {
  const repo = actions.repo;
  if (repo === undefined || group === null) return null;
  const id = group.video.id;
  const kept = group.video.kept;
  if (kept != null) {
    if ("unknown" in kept) return null;
    const remove = el("button", {
      type: "button",
      "data-action": "repo-remove",
      class: "btn btn-quiet btn-icon",
      "aria-label": `Remove from repo: ${r.label}`,
      title: "Remove from repo",
    });
    remove.append(icon("gitBranchMinus"));
    remove.addEventListener("click", () => repo.remove(id));
    return remove;
  }
  // No answer from the listing: it checks only what needs no git (DEM-47),
  // so the sheet checks this flow when it opens.
  const can = repo.addable(id);
  const add = el("button", {
    type: "button",
    "data-action": "repo-add",
    class: "btn btn-quiet btn-icon",
  });
  add.append(icon("gitBranchPlus"));
  if (repo.adding(id)) {
    add.setAttribute("aria-disabled", "true");
    add.setAttribute("aria-label", `Adding to repo: ${r.label}`);
    add.title = "Adding to repo…";
  } else if (can === undefined || can.ok) {
    add.setAttribute("aria-label", `Add to repo: ${r.label}`);
    add.title = "Add to repo";
    add.addEventListener("click", () => repo.add(id));
  } else {
    add.setAttribute("aria-disabled", "true");
    add.setAttribute("aria-label", `Can't add: ${can.label}`);
    add.title = can.detail;
  }
  return add;
}

/** The commit a version filmed, short, or null when it filmed none. */
export function commitSpan(v: LibraryRow): HTMLElement | null {
  const label = commitLabel(v.filmedCode);
  if (label === null) return null;
  const code = v.filmedCode as { commit: string };
  return el(
    "span",
    { class: "version-commit", "data-commit": "", title: code.commit },
    label,
  );
}

/** A version's Edit and Delete; Edit only where its footage is here. */
export function versionButtons(
  v: LibraryRow,
  group: VideoGroup,
  actions: LibraryActions,
  editable: boolean,
): HTMLElement {
  const buttons = el("div", { class: "row-actions" });
  if (editable) {
    const edit = el("button", {
      type: "button",
      "data-action": "edit",
      class: "btn btn-quiet btn-icon",
      "aria-label": `Edit video ${v.version ?? ""} of ${group.video.name}`,
      title: "Edit",
    });
    edit.append(icon("clapperboard"));
    edit.addEventListener("click", () => actions.edit(v.sceneId));
    buttons.append(edit);
  }
  const remove = el("button", {
    type: "button",
    "data-action": "delete",
    class: "btn btn-quiet btn-icon btn-danger",
    "aria-label": `Delete video ${v.version ?? ""} of ${group.video.name}`,
    title: "Delete",
  });
  remove.append(icon("trash"));
  remove.addEventListener("click", () => actions.remove(v.sceneId, "take"));
  buttons.append(remove);
  return buttons;
}

/** A version's exported files: each its name and type, a moved or deleted
 *  one marked gone; or why they could not be read. Null when it has none. */
export function exportsList(
  exports: LibraryRow["exports"],
): HTMLElement | null {
  if (exports === undefined) return null;
  if ("unreadable" in exports) {
    return el(
      "p",
      { class: "row-rerun", "data-exports-unreadable": "" },
      `Its exports could not be read: ${exports.unreadable}`,
    );
  }
  if (exports.length === 0) return null;
  const list = el("ul", { class: "version-exports" });
  for (const e of exports) {
    const name = e.path.slice(e.path.lastIndexOf("/") + 1) || e.path;
    const item = el("li", {
      "data-export": e.path,
      title: e.path,
      ...(e.exists ? {} : { "data-gone": "" }),
    });
    item.append(
      el("span", { class: "export-name" }, name),
      el(
        "span",
        { class: "export-type" },
        e.exists
          ? e.fileType.toUpperCase()
          : `${e.fileType.toUpperCase()} · gone`,
      ),
    );
    list.append(item);
  }
  return list;
}

/** The id a section's `<details>` carries, which its jump link names; in
 *  the list, its heading row's. */
export const sectionId = (key: string): string =>
  `when-${key.replace(/:/g, "-")}`;
