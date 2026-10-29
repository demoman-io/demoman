// apps/studio/pages/src/settings/view.ts
import {
  EXPORT_QUALITY_LABELS,
  EXPORT_QUALITY_VALUES,
  PULL_REQUESTS_LABELS,
  PULL_REQUESTS_VALUES,
} from "@demoman/run-core";
import { BRANDING_DEFAULTS, CANVAS_DEFAULTS } from "@demoman/scene-schema";
import type {
  ExportQualityChoice,
  PullRequestsChoice,
} from "@demoman/studio-protocol";
import { renderBrandingControls } from "../branding/controls";
import { wallpaperThumbUrl } from "../branding/wallpaper";
import {
  type BrandKitsRead,
  defaultKit,
  KIT_NAME_MAX,
  type KitEntry,
} from "../core/brand-kit";
import type { BrandingPatch } from "../editor/branding";
import { deliverableTitle } from "../editor/formats";
import { type GlyphName, icon } from "../shell/icons";
import { KIT_PREVIEW_BOX } from "./kit-preview";
import type { Section, SettingsModel } from "./state";

export interface SettingsActions {
  /** The user's Pull requests default. */
  setPullRequests(value: PullRequestsChoice): void;
  setExportQuality(value: ExportQualityChoice): void;
  /** Commits one Brand kit control. */
  setBrandKit(patch: BrandingPatch): void;
  /** A Brand kit control mid-gesture: repaint the preview, nothing else. */
  previewBrandKit(patch: BrandingPatch): void;
  uploadKitLogo(file: File): void;
  uploadKitWallpaper(file: File): void;
  /** Which kit the card edits. */
  selectKit(id: string): void;
  /** Adds "Untitled kit" from the defaults, and selects it. */
  newKit(): void;
  duplicateKit(id: string): void;
  /** Asks first, and names any default it hands over. */
  deleteKit(id: string): void;
  renameKit(id: string, name: string): void;
  /** The star: no question, since one more click undoes it. */
  setDefaultKit(id: string): void;
  /** Only offered when the list itself is unreadable; asks first. */
  resetKits(): void;
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

/** Settings' and the editor's Export panel's names for each quality. */
export { EXPORT_QUALITY_LABELS };

/** The page's sections, in the order the nav lists them and the page
 *  draws them. `id` is the anchor the nav links to. */
const NAV: ReadonlyArray<{
  section: Section;
  id: string;
  label: string;
  glyph: GlyphName;
}> = [
  {
    section: "brandKit",
    id: "brand-kit",
    label: "Brand kit",
    glyph: "palette",
  },
  { section: "export", id: "export", label: "Export", glyph: "download" },
  {
    section: "pullRequests",
    id: "pull-requests",
    label: "Pull requests",
    glyph: "upload",
  },
];

/** One Settings section: its title on the page, then `body` — the card
 *  everything else is appended to — under it. The title stands alone
 *  since 2026-10-08: the line of description under each one went, at the
 *  author's call. `data-section` stays on the outer `box`, so a query
 *  for a section reaches its title and its controls alike. */
function section(
  id: Section,
  title: string,
): { box: HTMLElement; body: HTMLElement } {
  const anchor = NAV.find((n) => n.section === id)?.id ?? id;
  const box = el("section", { "data-section": id, id: anchor });
  const head = el("div", { class: "section-head" });
  head.append(el("h2", {}, title));
  const body = el("div", { class: "card section-body" });
  box.append(head, body);
  return { box, body };
}

/** The section nav: one link per section. `aria-current` is the
 *  tracker's (`section-nav.ts`), put back after every render. */
function sectionNav(): HTMLElement {
  const nav = el("nav", {
    class: "section-nav",
    "aria-label": "Settings sections",
  });
  const list = el("ul");
  for (const item of NAV) {
    const link = el("a", { href: `#${item.id}`, "data-nav": item.id });
    link.append(icon(item.glyph), el("span", {}, item.label));
    const li = el("li");
    li.append(link);
    list.append(li);
  }
  nav.append(list);
  return nav;
}

function quiet(text: string, attrs: Record<string, string>): HTMLButtonElement {
  return el(
    "button",
    { type: "button", class: "btn btn-quiet", ...attrs },
    text,
  );
}

function notice(text: string): HTMLElement {
  return el("p", { class: "notice notice-error", "data-notice": "" }, text);
}

export function renderSettings(
  root: HTMLElement,
  model: SettingsModel,
  actions: SettingsActions,
  notices: ReadonlyMap<Section, string>,
): void {
  const content = el("div", { class: "content" });
  // ---- Brand kits
  {
    const kit = section("brandKit", "Brand kit");
    const kitNotice = notices.get("brandKit");
    if (kitNotice !== undefined) kit.body.append(notice(kitNotice));
    // The kits' change feed is down (the studio's watcher): an edit made in
    // another window will not show here until a reload, and the page says so
    // rather than showing a list that has quietly stopped following.
    if (model.kitsUnwatched !== null) {
      kit.body.append(
        el(
          "p",
          {
            class: "notice notice-warn",
            "data-notice": "",
            "data-unwatched": "",
          },
          `Kits changed outside this window will not show until you reload — ${model.kitsUnwatched}.`,
        ),
      );
    }
    renderKits(kit.body, model, actions);
    content.append(kit.box);
  }

  // ---- Export
  {
    const ex = section("export", "Export");
    const exNotice = notices.get("export");
    if (exNotice !== undefined) ex.body.append(notice(exNotice));
    // Null is an unreadable setting: both choices are offered, none checked.
    const current = model.exportQuality;
    const row = el("div", { class: "switch-row export-quality" });
    const group = el("div", {
      class: "segmented",
      role: "radiogroup",
      "aria-label": "Export quality",
    });
    for (const choice of EXPORT_QUALITY_VALUES) {
      const button = el(
        "button",
        {
          type: "button",
          class: "segment",
          role: "radio",
          "data-export-quality": choice,
          "aria-checked": String(choice === current),
        },
        EXPORT_QUALITY_LABELS[choice],
      );
      button.addEventListener("click", () => {
        if (choice !== current) actions.setExportQuality(choice);
      });
      group.append(button);
    }
    row.append(group);
    ex.body.append(row);
    content.append(ex.box);
  }

  // ---- Pull requests
  {
    const pr = section("pullRequests", "Pull requests");
    const prNotice = notices.get("pullRequests");
    if (prNotice !== undefined) pr.body.append(notice(prNotice));
    // Null is an unreadable setting: the choices are still offered, with
    // none checked, so "Off" is never painted over a file nobody could read.
    const current = model.pullRequests;
    const row = el("div", { class: "switch-row pull-requests" });
    const group = el("div", {
      class: "segmented",
      role: "radiogroup",
      "aria-label": "Pull requests",
    });
    for (const choice of PULL_REQUESTS_VALUES) {
      const button = el(
        "button",
        {
          type: "button",
          class: "segment",
          role: "radio",
          "data-pull-requests": choice,
          "aria-checked": String(choice === current),
        },
        PULL_REQUESTS_LABELS[choice],
      );
      button.addEventListener("click", () => {
        if (choice !== current) actions.setPullRequests(choice);
      });
      group.append(button);
    }
    row.append(group);
    pr.body.append(row);
    content.append(pr.box);
  }

  // The title heads the nav's column rather than the page (2026-10-08),
  // so the two are held in view together and nothing is laid over the
  // sections as they scroll. A full-width title held there cut the
  // sections off under it.
  const side = el("div", { class: "settings-side" });
  side.append(el("h1", {}, "Settings"), sectionNav());
  const layout = el("div", { class: "settings" });
  layout.append(side, content);
  root.replaceChildren(layout);
}

/**
 * The Brand kit card (spec 2026-10-08 §2): the kits as a strip of live tiles,
 * the selected kit's name and actions, its picture full width, and its
 * controls in three groups under it. The tiles' canvases are painted by the
 * page (`paintPreview`), as the hero is: this file is DOM only.
 */
function renderKits(
  body: HTMLElement,
  model: SettingsModel,
  actions: SettingsActions,
): void {
  const read = model.brandKits;
  if (read.state === "invalid") {
    // Nothing to edit: a list nobody can read is offered back only as a
    // fresh start, behind a question — never overwritten by an edit.
    body.append(notice(`Your brand kits could not be read: ${read.reason}`));
    if (read.storageRefused) {
      // Storage refused, not a broken list: the kits may read fine next
      // time, and a refused move still holds the old kit — so no fresh
      // start, which would delete both (final review).
      body.append(
        el(
          "p",
          { class: "hint" },
          "Nothing was changed. Reload this page to try again.",
        ),
      );
      return;
    }
    const reset = quiet("Start a fresh kit list", {
      "data-kit-reset-list": "",
    });
    reset.addEventListener("click", () => actions.resetKits());
    body.append(reset);
    return;
  }
  const selected = read.kits.find((k) => k.id === model.selectedKitId) ?? null;
  body.append(kitStrip(read, selected, actions));
  if (selected !== null) body.append(kitHead(selected, read, actions));
  if (selected?.read.state === "invalid") {
    // A broken kit still shows controls, from the defaults: saving is how
    // the author fixes it.
    body.append(
      notice(`"${selected.name}" could not be read: ${selected.read.reason}`),
    );
  }
  const branding =
    selected?.read.state === "ready" ? selected.read.kit : BRANDING_DEFAULTS;
  const hero = el("div", { class: "kit-hero" });
  hero.append(
    el("canvas", {
      "data-preview-kit": "",
      width: String(KIT_PREVIEW_BOX.width),
      height: String(KIT_PREVIEW_BOX.height),
      class: "kit-preview",
    }),
  );
  const controls = el("div", { class: "kit-controls" });
  renderBrandingControls(
    controls,
    {
      branding,
      logoThumb: model.brandKitLogoThumb,
      logoPlacement: model.brandKitPlacement,
      // A new take's MP4, in the shape it starts on: the preview above
      // frames the kit the way that take will.
      formatTitle: deliverableTitle("mp4", CANVAS_DEFAULTS.aspect),
      logoNotes: model.brandKitNotes,
      groupTitles: true,
      wallpaper: { thumbUrl: wallpaperThumbUrl, ...model.brandKitWallpaper },
    },
    {
      onCommit: (patch) => actions.setBrandKit(patch),
      onPreview: (patch) => actions.previewBrandKit(patch),
      onLogoFile: (file) => actions.uploadKitLogo(file),
      onWallpaperFile: (file) => actions.uploadKitWallpaper(file),
    },
  );
  body.append(hero, controls);
}

/** One tile per kit, each a live picture with its name and a star, then
 *  New kit. Wraps rather than scrolling sideways. */
function kitStrip(
  read: Extract<BrandKitsRead, { state: "ready" }>,
  selected: KitEntry | null,
  actions: SettingsActions,
): HTMLElement {
  const strip = el("div", { class: "kit-strip", role: "list" });
  const def = defaultKit(read);
  for (const k of read.kits) {
    const tile = el("div", {
      class: "kit-tile",
      role: "listitem",
      "data-kit-tile": k.id,
    });
    const pick = el("button", {
      type: "button",
      class: "kit-pick",
      "data-kit-select": k.id,
      "aria-pressed": String(k.id === selected?.id),
    });
    if (k.read.state === "ready") {
      pick.append(
        el("canvas", {
          class: "kit-thumb",
          "data-kit-thumb": k.id,
          width: String(KIT_PREVIEW_BOX.width),
          height: String(KIT_PREVIEW_BOX.height),
        }),
      );
    } else {
      const broken = el("span", { class: "kit-thumb kit-thumb-broken" });
      broken.append(icon("circleAlert"));
      pick.append(broken);
      pick.title = k.read.reason;
    }
    pick.append(el("span", { class: "kit-tile-name" }, k.name));
    pick.addEventListener("click", () => actions.selectKit(k.id));
    const isDefault = k.id === def?.id;
    const star = el("button", {
      type: "button",
      class: "kit-star",
      "data-kit-star": k.id,
      "aria-pressed": String(isDefault),
      "aria-label": isDefault
        ? `"${k.name}" is the default kit`
        : `Make "${k.name}" the default kit`,
    });
    star.append(icon("star"));
    star.addEventListener("click", () => {
      if (!isDefault) actions.setDefaultKit(k.id);
    });
    tile.append(pick, star);
    strip.append(tile);
  }
  const add = el("button", {
    type: "button",
    class: "kit-tile kit-new",
    "data-kit-new": "",
  });
  add.append(icon("plus"), el("span", {}, "New kit"));
  add.addEventListener("click", () => actions.newKit());
  strip.append(add);
  return strip;
}

/** The selected kit's name, edited in place, and its Duplicate and Delete. */
function kitHead(
  selected: KitEntry,
  read: Extract<BrandKitsRead, { state: "ready" }>,
  actions: SettingsActions,
): HTMLElement {
  const head = el("div", { class: "kit-head" });
  const name = el("input", {
    type: "text",
    class: "kit-name",
    "data-kit-name": "",
    maxlength: String(KIT_NAME_MAX),
    "aria-label": "Kit name",
  });
  name.value = selected.name;
  name.addEventListener("change", () =>
    actions.renameKit(selected.id, name.value),
  );
  name.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      name.value = selected.name;
      name.blur();
    }
  });
  const duplicate = quiet("Duplicate", { "data-kit-duplicate": "" });
  duplicate.prepend(icon("copy"));
  duplicate.addEventListener("click", () => actions.duplicateKit(selected.id));
  const remove = quiet("Delete", { "data-kit-delete": "" });
  remove.prepend(icon("trash"));
  if (read.kits.length === 1) {
    remove.disabled = true;
    remove.title = "The last kit cannot be deleted";
  }
  remove.addEventListener("click", () => actions.deleteKit(selected.id));
  head.append(name, duplicate, remove);
  return head;
}
