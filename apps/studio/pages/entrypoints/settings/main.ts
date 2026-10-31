// apps/studio/pages/entrypoints/settings/main.ts

import { type FrameImage, logoRasterHeight } from "@demoman/compositor";
import { checkLogoFile, PULL_REQUESTS_DEFAULT } from "@demoman/run-core";
import {
  BRANDING_DEFAULTS,
  BrandingSchema,
  LOGO_DEFAULTS,
  type SceneBranding,
} from "@demoman/scene-schema";
import type {
  ExportQualityChoice,
  PullRequestsChoice,
} from "@demoman/studio-protocol";
import { createPlatform } from "#platform";
import type { StoredKits } from "../../src/adapters/brand-kit-store";
import {
  decodeLogo,
  type LogoSource,
  logoThumbnail,
} from "../../src/adapters/logo";
import type { LogoThumb } from "../../src/branding/controls";
import {
  decodeBackground,
  type ImageBackground,
  isImageBackground,
  uploadedBackground,
  wallpaperKey,
  wallpaperThumbOf,
} from "../../src/branding/wallpaper";
import {
  type BrandKitsRead,
  checkKitName,
  coerceBrandKit,
  defaultKit,
  type KitEntry,
  newKitId,
  nextKitName,
} from "../../src/core/brand-kit";
import {
  applyBrandingPatch,
  type BrandingPatch,
} from "../../src/editor/branding";
import {
  KIT_PREVIEW_BOX,
  kitPlacement,
  paintKitPreview,
} from "../../src/settings/kit-preview";
import { trackSectionNav } from "../../src/settings/section-nav";
import type { Section, SettingsModel } from "../../src/settings/state";
import { renderSettings } from "../../src/settings/view";
import { askToConfirm } from "../../src/shell/confirm-dialog";
import { icon } from "../../src/shell/icons";
import {
  addNoticeAction,
  type NoticeText,
  showNotice,
} from "../../src/shell/notice-line";
import { createRefresher } from "../../src/shell/refresher";
import { showToast } from "../../src/shell/toast";
import { mountTopbar } from "../../src/shell/topbar";

const root = document.querySelector("#root") as HTMLElement;
// The section nav's current mark, kept by scrolling and put back after
// every render, which rebuilds the nav.
const sectionNav = trackSectionNav(root);
const noticeEl = document.querySelector("#notice") as HTMLElement;

// Everything outside the page — the kits, their logos and the studio's
// settings — comes through the platform.
const platform = createPlatform();
const brandKits = platform.kits;

/** The kits as last read, what the card draws. */
let kitsRead: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
  migrationPending: false,
};
/** The kit the card edits; the default on load (`selectFallback`). A
 *  per-page convenience, not stored. */
let selectedKitId: string | null = null;
/** The selected kit's decoded logo, kept per ref so a repaint does not
 *  re-decode. */
let kitLogo: {
  ref: string;
  source: LogoSource | null;
  error: string | null;
} | null = null;
/** The raster the preview draws, at the preview's own logo height. */
let kitLogoImage: FrameImage | null = null;
/** The thumbnail beside the kit's Replace and Remove; null with no logo. */
let kitLogoThumb: LogoThumb | null = null;
/** The JPEG note from the last upload, keyed on the ref it describes. */
let kitUploadNote: { ref: string; note: string } | null = null;

type KitWallpaper =
  | { ok: true; image: FrameImage }
  | { ok: false; error: string };
/** Every background image this page has decoded, by `wallpaperKey`, at the
 *  preview box's size: the hero and the kit tiles share them, and a kit is
 *  decoded once however often the page paints. `kitWallpaperDone` holds
 *  the settled ones for the painter, which does not wait. */
const kitWallpapers = new Map<string, Promise<KitWallpaper>>();
const kitWallpaperDone = new Map<string, KitWallpaper>();
/** The last decode queued: one at a time, since each decodes a full-size
 *  master first (hundreds of MB while it runs). */
let kitDecodeQueue: Promise<unknown> = Promise.resolve();
/** The uploaded image's tile: the selected kit's, or the last one shown. */
let kitWallpaperCustom: { ref: string; thumb: LogoThumb | null } | null = null;

function kitWallpaper(bg: ImageBackground): Promise<KitWallpaper> {
  const key = wallpaperKey(bg, KIT_PREVIEW_BOX);
  let decoding = kitWallpapers.get(key);
  if (decoding === undefined) {
    decoding = kitDecodeQueue
      .then(() => decodeBackground(bg, KIT_PREVIEW_BOX, platform.wallpapers))
      .then(
        (d): KitWallpaper => ({ ok: true, image: d.image }),
        (error: unknown): KitWallpaper => ({
          ok: false,
          error: describe(error),
        }),
      );
    kitDecodeQueue = decoding;
    kitWallpapers.set(key, decoding);
    void decoding.then((done) => kitWallpaperDone.set(key, done));
  }
  return decoding;
}

/** A background's settled image, or null: not an image, not decoded yet,
 *  or failed (which `brandKitWallpaper.loadError` says for the selected
 *  kit, and the tile's title for the others). */
function kitWallpaperImage(bg: SceneBranding["background"]): FrameImage | null {
  if (!isImageBackground(bg)) return null;
  const done = kitWallpaperDone.get(wallpaperKey(bg, KIT_PREVIEW_BOX));
  return done?.ok ? done.image : null;
}

/** Decodes the selected kit's image, and its tile's thumbnail for an
 *  upload; starts the other kits' for their tiles, repainting each one as
 *  it lands. */
async function refreshKitWallpaper(branding: SceneBranding): Promise<void> {
  const bg = branding.background;
  // The selected kit's first in the queue: the page waits for it.
  const selected = isImageBackground(bg) ? kitWallpaper(bg) : null;
  if (kitsRead.state === "ready") {
    for (const kit of kitsRead.kits) {
      if (kit.read.state !== "ready") continue;
      const bg = kit.read.kit.background;
      if (!isImageBackground(bg)) continue;
      const key = wallpaperKey(bg, KIT_PREVIEW_BOX);
      if (kitWallpapers.has(key)) continue;
      void kitWallpaper(bg).then(() => paintTiles(kit.id));
    }
  }
  if (selected === null) return;
  const done = await selected;
  if (bg.kind !== "image") return;
  if (
    kitWallpaperCustom?.ref === bg.ref &&
    kitWallpaperCustom.thumb?.kind === "ready"
  )
    return;
  let thumb: LogoThumb;
  if (!done.ok) thumb = { kind: "failed", reason: done.error };
  else {
    try {
      thumb = { kind: "ready", url: await wallpaperThumbOf(done.image) };
    } catch (error) {
      thumb = { kind: "failed", reason: describe(error) };
    }
  }
  const old = kitWallpaperCustom?.thumb;
  if (old?.kind === "ready" && old !== thumb) URL.revokeObjectURL(old.url);
  kitWallpaperCustom = { ref: bg.ref, thumb };
}

const selectedEntry = (): KitEntry | null =>
  kitsRead.state === "ready"
    ? (kitsRead.kits.find((k) => k.id === selectedKitId) ?? null)
    : null;

const kitBranding = (): SceneBranding => {
  const entry = selectedEntry();
  return entry?.read.state === "ready" ? entry.read.kit : BRANDING_DEFAULTS;
};

/** A selection that names no kit (deleted, or never made) lands on the
 *  default, else the first kit. */
function selectFallback(): void {
  if (kitsRead.state !== "ready") return;
  if (kitsRead.kits.some((k) => k.id === selectedKitId)) return;
  selectedKitId = defaultKit(kitsRead)?.id ?? kitsRead.kits[0]?.id ?? null;
}

/**
 * A kit write, built on the list as stored when it runs — never on the last
 * read, which only a finished render refreshes: releasing the Angle and
 * clicking Swap before the redraw used to build the Swap on the old angle
 * and store that, losing the first change without a word. The store's
 * `update` holds the kit lock across its read, `change` and write, so this
 * page's writes, the editor's and the worker's run one at a time.
 */
/** Bumped by every kit write, so a render whose read started before one
 *  does not put the older list back into `kitsRead`. */
let kitWriteCount = 0;

async function kitWrite(
  change: (current: StoredKits) => Promise<StoredKits | string>,
): Promise<Said> {
  let repaired: string | null = null;
  const refused = await brandKits.update(async (stored) => {
    const changed = await change(stored);
    if (typeof changed === "string") return changed;
    // A default naming no kit (spec §1) is repaired by the next write, to
    // the first kit — and said, never done quietly.
    const heir = changed.kits[0];
    if (
      heir === undefined ||
      changed.kits.some((k) => k.id === changed.defaultId)
    ) {
      return changed;
    }
    repaired = heir.name;
    return { ...changed, defaultId: heir.id };
  });
  if (refused !== null) return refused;
  kitWriteCount += 1;
  kitsRead = await brandKits.read();
  selectFallback();
  return repaired === null
    ? null
    : {
        warn: `Your default kit was missing, so "${repaired}" is the default now.`,
      };
}

/**
 * A kit write that makes a kit, then selects it once the write has landed
 * and `kitsRead` holds it. Selected inside the change instead, a refresh
 * raised by this same write (the storage change, the studio's `kits`
 * event) painted against the list from before it, found no such kit, and
 * `selectFallback` put the default back. `made` records the id the change
 * minted — the last one, since a retried change mints again.
 */
async function selectAfter(
  write: (made: (id: string) => string) => Promise<Said>,
): Promise<Said> {
  let made: string | null = null;
  const said = await write((id) => {
    made = id;
    return id;
  });
  if (typeof said !== "string" && made !== null) {
    selectedKitId = made;
    selectFallback();
  }
  return said;
}

/**
 * A change to one kit's branding: `selected` is the kit selected when the author
 * made the edit, taken by the caller before anything awaits. Read when the
 * write ran instead, a logo still decoding (or a write still queued) while
 * the author clicked another tile landed on that tile's kit.
 *
 * With no kits at all (a fresh install) the first edit saves the
 * defaults-plus-edit as "Brand kit", the default — the single kit's own
 * behaviour, so the first visit is not a card that asks for a kit before
 * it lets the author touch a colour.
 */
/** The kit this page's first edit made on a fresh install. An edit made
 *  in the same instant (Angle released, then Swap) also saw no kit, and
 *  belongs on that one. */
let firstKitId: string | null = null;

function writeKit(
  selected: string | null,
  build: (current: SceneBranding) => Promise<SceneBranding | string>,
): Promise<Said> {
  return kitWrite(async (cur) => {
    if (cur.kits.length === 0) {
      const next = await build(BRANDING_DEFAULTS);
      if (typeof next === "string") return next;
      const fresh = newKitId();
      selectedKitId = fresh;
      firstKitId = fresh;
      return {
        kits: [{ id: fresh, name: "Brand kit", branding: next }],
        defaultId: fresh,
      };
    }
    const id = selected ?? firstKitId;
    const stored = cur.kits.find((k) => k.id === id);
    if (stored === undefined) {
      // No kit selected while kits are stored: another page saved them
      // after this one last read. Nothing was deleted, so say what is true;
      // the render `act` runs next shows the list as it is now.
      return id === null
        ? "this page's kit list was out of date, so nothing was changed — it now shows your kits as they are"
        : "the kit was deleted in another tab";
    }
    const read = coerceBrandKit(stored.branding);
    const next = await build(
      read.state === "ready" ? read.kit : BRANDING_DEFAULTS,
    );
    if (typeof next === "string") return next;
    return {
      ...cur,
      kits: cur.kits.map((k) => (k.id === id ? { ...k, branding: next } : k)),
    };
  });
}

/** Decodes the kit's logo if its ref changed; rasterises it for the preview. */
async function refreshKitLogo(branding: SceneBranding): Promise<void> {
  const ref = branding.logo?.ref ?? null;
  if (ref === null) {
    kitLogo = null;
    kitLogoImage = null;
    kitLogoThumb = null;
    return;
  }
  if (kitLogo?.ref !== ref) {
    const load = await platform.logos.load(ref);
    kitLogo = load.ok
      ? { ref, source: load.source, error: null }
      : { ref, source: null, error: load.error };
  }
  kitLogoImage = null;
  if (kitLogo.source !== null) {
    try {
      kitLogoImage = await kitLogo.source.rasterAt(
        // For the preview's box, not this padding's frame: a Padding drag
        // repaints without re-rasterising, and the box's is the largest.
        logoRasterHeight(branding, KIT_PREVIEW_BOX),
      );
    } catch (error) {
      kitLogo = { ref, source: null, error: describe(error) };
    }
  }
  if (kitLogo.source === null) {
    kitLogoThumb = {
      kind: "failed",
      reason: kitLogo.error ?? "the page did not try to load it",
    };
  } else {
    try {
      kitLogoThumb = {
        kind: "ready",
        url: await logoThumbnail(kitLogo.source),
      };
    } catch (error) {
      kitLogoThumb = { kind: "failed", reason: describe(error) };
    }
  }
}

/**
 * Paints the section's preview canvas, saying so when it cannot, and the
 * kit tiles: every one after a render, only the selected one mid-gesture —
 * nothing else changes during a drag, and each tile is a full paint.
 */
function paintPreview(
  branding: SceneBranding,
  tiles: "all" | "selected" = "all",
): void {
  const canvas =
    document.querySelector<HTMLCanvasElement>("[data-preview-kit]");
  if (canvas === null) return;
  const root = getComputedStyle(document.documentElement);
  const card = root.getPropertyValue("--card").trim() || "#ffffff";
  // The shell's corner, painted on the frame now that the canvas is a box
  // the frame need not fill. Unreadable, the corners are square.
  const radius = Number.parseFloat(root.getPropertyValue("--radius")) || 0;
  if (
    !paintKitPreview(
      canvas,
      branding,
      kitLogoImage,
      card,
      radius,
      kitWallpaperImage(branding.background),
    )
  ) {
    // jsdom, or a browser that refused a 2D context. The controls still
    // work; the preview is what is missing, and this says so.
    console.info("demoman settings: the brand kit preview has no 2D context");
  }
  // The tiles: each kit's background and frame, without its logo — at tile
  // size a logo is a few pixels, and decoding every kit's costs more than it
  // shows (plan deviation 5). The selected tile follows a drag mid-gesture.
  for (const thumb of document.querySelectorAll<HTMLCanvasElement>(
    "[data-kit-thumb]",
  )) {
    const id = thumb.getAttribute("data-kit-thumb");
    if (tiles === "selected" && id !== selectedKitId) continue;
    const entry =
      kitsRead.state === "ready"
        ? kitsRead.kits.find((k) => k.id === id)
        : undefined;
    if (entry?.read.state !== "ready") continue;
    const kit = id === selectedKitId ? branding : entry.read.kit;
    paintTile(thumb, kit, card, radius);
  }
}

/** One kit tile; a background image that failed is named on the tile. */
function paintTile(
  thumb: HTMLCanvasElement,
  kit: SceneBranding,
  card: string,
  radius: number,
): void {
  const bg = kit.background;
  const done = isImageBackground(bg)
    ? kitWallpaperDone.get(wallpaperKey(bg, KIT_PREVIEW_BOX))
    : undefined;
  // Named on the tile: a glyph over the neutral it paints instead, and the
  // reason in its title.
  const pick = thumb.parentElement;
  pick?.querySelector("[data-kit-thumb-alert]")?.remove();
  if (done?.ok === false) {
    thumb.title = `The image could not be loaded: ${done.error}`;
    const alert = document.createElement("span");
    alert.className = "kit-thumb-alert";
    alert.setAttribute("data-kit-thumb-alert", "");
    alert.setAttribute("role", "img");
    alert.setAttribute("aria-label", thumb.title);
    alert.append(icon("circleAlert"));
    pick?.append(alert);
  } else thumb.removeAttribute("title");
  if (!paintKitPreview(thumb, kit, null, card, radius, kitWallpaperImage(bg))) {
    console.info("demoman settings: a kit tile has no 2D context");
  }
}

/** Repaints the tile of `id`, whose image just landed, as stored. The
 *  selected kit's is `paint`'s, which waits for its image. */
function paintTiles(id: string): void {
  if (id === selectedKitId) return;
  const thumb = document.querySelector<HTMLCanvasElement>(
    `[data-kit-thumb="${CSS.escape(id)}"]`,
  );
  const entry =
    kitsRead.state === "ready"
      ? kitsRead.kits.find((k) => k.id === id)
      : undefined;
  if (thumb === null || entry?.read.state !== "ready") return;
  const root = getComputedStyle(document.documentElement);
  paintTile(
    thumb,
    entry.read.kit,
    root.getPropertyValue("--card").trim() || "#ffffff",
    Number.parseFloat(root.getPropertyValue("--radius")) || 0,
  );
}

// The studio: the server asked this window to show another page (a second
// `npx demoman studio <take>` while this one is open). After the writes this
// page still owes, as the editor does.
platform.nav.onOpen?.((path) =>
  leaveAfterOwedWork(
    path,
    () => location.assign(path),
    new URL(path, location.href).searchParams.has("scene")
      ? "Open the video"
      : "Open Flows",
  ),
);

// The bar's Settings tab, pointed at this studio's Settings page.
mountTopbar(platform);

/**
 * Notices are per SECTION and belong to one pass: `render()` reads every
 * section afresh and rebuilds this map from what failed, so a failure
 * that has since cleared does not stand over a section that now works
 * (the Recordings page's `#notice` used to, and told an author their
 * successful delete had failed). An action that has something to say
 * says it AFTER its `render()`, into `after`, or the render wipes it.
 */
const notices = new Map<Section, string>();

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The page's one notice line, at the level the thing being said deserves.
 *
 * It was `notice-error` and nothing else, which was right while the only
 * thing it ever said was a refusal. Reclaim's own report goes through here
 * too now, and painting "Freed 1.8 GB." in the refusal's red would be its
 * own small lie about what happened.
 */
function say(text: NoticeText, level: "info" | "warn" | "error"): void {
  showNotice(noticeEl, text, level, clearNotice);
}

function fail(text: NoticeText): void {
  say(text, "error");
}

function clearNotice(): void {
  noticeEl.replaceChildren();
  noticeEl.className = "notice notice-error hidden";
}

/**
 * Where a fire-and-forget action lands on an outright throw — a rejected
 * `sendMessage`, a store that would not open. `console.error` because this
 * is an extension page, where `error` is the level that reaches the
 * chrome://extensions Errors list, and a store that will not open is a
 * real fault, not an expected outcome that merely owes a reason.
 */
function reportError(context: string, error: unknown): void {
  console.error(`demoman settings: ${context} —`, error);
  // `context` is what was being done, as a verb phrase ("add a kit"), so
  // the title says what did not happen; the error's own words go behind
  // Details.
  fail({ title: `Couldn't ${context}`, detail: describe(error) });
}

/** Adds a sentence to a section's notice. Appended, never set: reads run
 *  side by side, and one that writes two sections must not overwrite, or
 *  be overwritten by, another's reason for either. */
function note(section: Section, text: string): void {
  const said = notices.get(section);
  notices.set(section, said === undefined ? text : `${said}. ${text}`);
}

/** Reads for one or more sections; a throw becomes each one's notice and
 *  `null`. */
async function read<T>(
  sections: Section | Section[],
  what: string,
  fetch: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fetch();
  } catch (error) {
    for (const section of typeof sections === "string" ? [sections] : sections)
      note(section, `Couldn't read ${what}: ${describe(error)}`);
    return null;
  }
}

/**
 * Renders, strictly one after another.
 *
 * Two in flight at once can land OUT OF ORDER — a slow read painting
 * after a fast one, leaving the page showing data older than it has
 * already read. The visibility listener used to carry its own guard, but
 * it only knew about renders IT had started, so the initial render and
 * every action's render could still be overtaken by a tab flip. Chaining
 * here covers all of them, which is what the listener's comment used to
 * claim and did not do.
 *
 * (It is NOT guarding the shared `notices` map against interleaving.
 * `paint` has a single `await`, with no yield point between the map being
 * filled and `renderSettings` reading it, so no DOM task can land in
 * between. Said explicitly because that is the plausible-looking hazard
 * here, and chasing it would be chasing something unreachable.)
 */

const refresher = createRefresher({
  paint: (keepNotice) => paint({ keepNotice }),
  onRefreshFailed: (error) => reportError("refresh Settings", error),
  hold: authorMidEdit,
});

/** An action's own render: after every render asked before it. */
function render(): Promise<void> {
  return refresher.render();
}

async function paint({ keepNotice = false } = {}): Promise<void> {
  // A refresh the author did not ask for must not take away a sentence
  // an action just wrote — switching tabs to go and look at something is
  // not an answer to "the server still holds the session". An action's
  // own render still clears, which is what keeps a stale refusal from
  // standing over the next thing that works.
  if (!keepNotice) clearNotice();
  notices.clear();
  const writesBefore = kitWriteCount;
  // Every section on its own: one store refusing must cost that section
  // its facts and a sentence saying why, never the whole page.
  const [kit, pullRequests, exportQuality] = await Promise.all([
    // Never throws: an unreadable kit comes back `invalid` with the
    // reason, which the section itself says.
    brandKits.read(),
    read("pullRequests", "the Pull requests setting", () =>
      platform.pullRequests.read(),
    ),
    read("export", "the Export quality setting", () =>
      platform.exportQuality.read(),
    ),
  ]);
  if (exportQuality?.unreadable !== undefined) {
    note(
      "export",
      `Couldn't read the Export quality setting: ${exportQuality.unreadable}`,
    );
  }
  // Unreadable is its own sentence and null, never "off": the section then
  // checks nothing. Not set is "off".
  if (pullRequests?.unreadable !== undefined) {
    note(
      "pullRequests",
      `Couldn't read the Pull requests setting: ${pullRequests.unreadable}`,
    );
  }
  // A kit write that landed while this read was in flight is newer than
  // what the read returned.
  if (kitWriteCount === writesBefore) kitsRead = kit;
  selectFallback();
  const branding = kitBranding();
  await refreshKitLogo(branding);
  await refreshKitWallpaper(branding);
  const kitBg = branding.background;
  const kitBgDone = isImageBackground(kitBg)
    ? kitWallpaperDone.get(wallpaperKey(kitBg, KIT_PREVIEW_BOX))
    : undefined;
  const model: SettingsModel = {
    exportQuality:
      exportQuality === null || exportQuality.unreadable !== undefined
        ? null
        : exportQuality.quality,
    pullRequests:
      pullRequests === null || pullRequests.unreadable !== undefined
        ? null
        : (pullRequests.value ?? PULL_REQUESTS_DEFAULT),
    // Read after the kits: the studio's read is what refreshes it.
    kitsUnwatched: brandKits.unwatched(),
    brandKits: kitsRead,
    selectedKitId,
    brandKitLogo:
      branding.logo === null
        ? null
        : kitLogo?.source != null
          ? { ok: true }
          : {
              ok: false,
              error: kitLogo?.error ?? "the page did not try to load it",
            },
    brandKitLogoThumb: branding.logo === null ? null : kitLogoThumb,
    brandKitPlacement: kitPlacement(branding, kitLogoImage),
    brandKitNotes: [
      kitLogo?.error ? `The logo could not be loaded: ${kitLogo.error}` : null,
      kitUploadNote !== null && kitUploadNote.ref === branding.logo?.ref
        ? kitUploadNote.note
        : null,
    ].filter((n): n is string => n !== null),
    brandKitWallpaper: {
      custom: kitWallpaperCustom,
      loadError: kitBgDone?.ok === false ? kitBgDone.error : null,
    },
  };
  renderSettings(root, model, actions, notices);
  sectionNav.mark();
  paintPreview(branding);
}

/** What an action has to say after its render: a refusal (nothing, or not all
 *  of it, was done: "Couldn't <context>: <why>."), a warning for an action
 *  that DID take effect but left something behind, which must not be worded
 *  as a failure, or a plain fact about what it did (`info`). */
type Said = string | null | { warn: string } | { info: string };

/** Runs an action, re-renders, then says what the action's reply refused —
 *  after the render, so the render cannot wipe the sentence. */
/** How an action ended: `failed` when it said a refusal or a fault. */
type Outcome = "done" | "failed";

/** Every action still running, so a way out of the page can wait for the
 *  writes it owes (`leaveAfterOwedWork`). */
const owed = new Set<Promise<Outcome>>();

function act(context: string, run: () => Promise<Said>): void {
  const work = (async (): Promise<Outcome> => {
    let why: Said;
    try {
      why = await run();
    } catch (error) {
      reportError(context, error);
      return "failed";
    }
    // Caught: this runs fire-and-forget, and a render that rejects would
    // otherwise be an unhandled rejection on chrome://extensions' Errors
    // list with nothing on the page saying the action's result is stale.
    try {
      await render();
    } catch (error) {
      reportError(`show the result of: ${context}`, error);
      return "failed";
    }
    if (why === null) return "done";
    if (typeof why === "string") {
      fail(`Couldn't ${context}: ${why}.`);
      return "failed";
    }
    if ("warn" in why) say(why.warn, "warn");
    else showToast(why.info);
    return "done";
  })();
  owed.add(work);
  // Never rejects: every path above returns an outcome.
  void work.then(() => owed.delete(work));
}

/**
 * Leaves this page through `go` once every action still running — a kit
 * write and the render after it — has finished, and stays when one of them
 * failed in the wait, where the notice says why. The editor's
 * `leaveAfterOwedWrites` is the same rule: a colour committed a moment
 * before the studio asked this window to show a take must not be cut off by
 * the navigation, and leaving over a refused write would put the author on a
 * page with nothing to say the kit was not saved.
 *
 * Loops, because an action started during the wait (a commit from the blur
 * the navigation itself causes) is owed too.
 */
function leaveAfterOwedWork(what: string, go: () => void, offer: string): void {
  // Why the window has not moved yet, for whoever is watching the console
  // (and the studio's screenshot lane, which waits on it).
  if (owed.size > 0) {
    console.info(
      `demoman settings: asked to open ${what}; waiting for ${owed.size} change${owed.size === 1 ? "" : "s"} here to save first`,
    );
  }
  void (async () => {
    let failed = false;
    for (;;) {
      const tail = refresher.pending();
      const outcomes = await Promise.all([...owed]);
      if (outcomes.includes("failed")) failed = true;
      // The chain may reject (a paint that threw); its reason is already
      // said by whoever awaited it.
      await tail.then(
        () => undefined,
        () => undefined,
      );
      if (owed.size === 0 && refresher.pending() === tail) break;
    }
    if (failed) {
      // Expected, not a fault: the page's notice holds the failure, and
      // staying is what keeps it in front of the author. But the CLI has
      // already reported the window as opened, so the notice also offers
      // what was asked for — staying must not be the only sign of it.
      console.info(
        `demoman settings: stayed on Settings rather than opening ${what}, because a change here did not save`,
      );
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-quiet";
      button.dataset.openAsked = "";
      button.textContent = offer;
      button.addEventListener("click", () => {
        try {
          go();
        } catch (error) {
          reportError(`open ${what}`, error);
        }
      });
      // Beside the failure that kept the page here. Dismissed while the
      // write was owed, there is no failure line left to sit beside, so the
      // offer brings its own.
      if (!addNoticeAction(noticeEl, button)) {
        fail("A change here didn't save, so this window stayed on Settings.");
        addNoticeAction(noticeEl, button);
      }
      return;
    }
    try {
      go();
    } catch (error) {
      reportError(`open ${what}`, error);
    }
  })();
}

const actions = {
  // Its own field only: the user's settings file holds others.
  setPullRequests: (value: PullRequestsChoice): void =>
    act("save the Pull requests setting", async () => {
      const done = await platform.pullRequests.write(value);
      return done.replaced === undefined ? null : { warn: done.replaced };
    }),
  setExportQuality: (value: ExportQualityChoice): void =>
    act("save the Export quality setting", async () => {
      const done = await platform.exportQuality.write(value);
      return done.replaced === undefined ? null : { warn: done.replaced };
    }),
  /**
   * One Brand kit control. Validated by the same schema a demo's branding
   * is, so the kit cannot hold what a take would refuse; a refusal or a
   * failed write is said, and the kit on screen stays the stored one.
   */
  setBrandKit: (patch: BrandingPatch): void => {
    const id = selectedKitId;
    act("save the brand kit", () =>
      writeKit(id, async (current) => {
        const next = BrandingSchema.safeParse(
          applyBrandingPatch(current, patch),
        );
        return next.success
          ? next.data
          : next.error.issues.map((i) => i.message).join("; ");
      }),
    );
  },
  /** A control mid-gesture: repaint the preview only. */
  previewBrandKit: (patch: BrandingPatch): void => {
    try {
      paintPreview(applyBrandingPatch(kitBranding(), patch), "selected");
    } catch (error) {
      console.info(
        "demoman settings: a brand kit preview did not apply",
        error,
      );
    }
  },
  /** The kit's logo: checked and decoded as the editor's upload is. */
  uploadKitLogo: (file: File): void => {
    // Before the decode awaits: the logo belongs to the kit on screen when
    // the author chose the file, not whichever tile is selected by the time
    // the bytes are stored.
    const id = selectedKitId;
    act("add the logo", async () => {
      const check = checkLogoFile(file);
      if (!check.ok) return check.reason;
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        await decodeLogo(bytes, file.type);
      } catch (error) {
        return `the logo "${file.name}" could not be read as an image: ${describe(error)}`;
      }
      // Stored where this side keeps logos; the ref is whatever it answers
      // (`logo:<uuid>` in the extension's store, `assets/<file>` in the
      // studio's folder).
      const { ref } = await platform.logos.put(file);
      kitUploadNote = check.note === null ? null : { ref, note: check.note };
      return writeKit(id, async (kit) => {
        const current = kit.logo;
        const placement = current
          ? {
              corner: current.corner,
              size: current.size,
              opacity: current.opacity,
            }
          : LOGO_DEFAULTS;
        return applyBrandingPatch(kit, { logo: { ref, ...placement } });
      });
    });
  },
  /** The kit's background image: checked, fitted and stored by the
   *  platform, which refuses a file that is not a usable image and says
   *  which of the two it was. */
  uploadKitWallpaper: (file: File): void => {
    const id = selectedKitId;
    act("add the image", async () => {
      let ref: string;
      try {
        ({ ref } = await platform.wallpapers.put(file));
      } catch (error) {
        return describe(error);
      }
      return writeKit(id, async (kit) =>
        applyBrandingPatch(kit, {
          background: uploadedBackground(ref, kit.background),
        }),
      );
    });
  },
  selectKit: (id: string): void => {
    selectedKitId = id;
    render().catch((error: unknown) => reportError("select the kit", error));
  },
  newKit: (): void =>
    act("add a kit", () =>
      selectAfter((made) =>
        kitWrite(async (cur) => {
          const id = made(newKitId());
          return {
            kits: [
              ...cur.kits,
              {
                id,
                name: nextKitName("Untitled kit", cur.kits),
                branding: BRANDING_DEFAULTS,
              },
            ],
            defaultId: cur.defaultId ?? id,
          };
        }),
      ),
    ),
  duplicateKit: (id: string): void =>
    act("duplicate the kit", () =>
      selectAfter((made) =>
        kitWrite(async (cur) => {
          const from = cur.kits.find((k) => k.id === id);
          if (from === undefined) return "the kit was deleted in another tab";
          const copy = {
            id: made(newKitId()),
            name: nextKitName(`${from.name} copy`, cur.kits),
            branding: structuredClone(from.branding),
          };
          return { ...cur, kits: [...cur.kits, copy] };
        }),
      ),
    ),
  renameKit: (id: string, name: string): void =>
    act("rename the kit", () =>
      kitWrite(async (cur) => {
        const ok = checkKitName(name, cur.kits, id);
        if (!ok.ok) return ok.reason;
        return {
          ...cur,
          kits: cur.kits.map((k) =>
            k.id === id ? { ...k, name: ok.name } : k,
          ),
        };
      }),
    ),
  setDefaultKit: (id: string): void =>
    act("make the kit the default", () =>
      kitWrite(async (cur) =>
        cur.kits.some((k) => k.id === id)
          ? { ...cur, defaultId: id }
          : "the kit was deleted in another tab",
      ),
    ),
  deleteKit: (id: string): void =>
    act("delete the kit", async () => {
      if (kitsRead.state !== "ready") return "the kits could not be read";
      const entry = kitsRead.kits.find((k) => k.id === id);
      if (entry === undefined) return "the kit was deleted in another tab";
      if (kitsRead.kits.length === 1) return "the last kit cannot be deleted";
      const heir = kitsRead.kits.find((k) => k.id !== id);
      const handover =
        kitsRead.defaultId === id && heir !== undefined
          ? ` "${heir.name}" becomes the default kit.`
          : "";
      if (
        !(await askToConfirm({
          glyph: "trash",
          title: `Delete "${entry.name}"`,
          body: `"${entry.name}" will be deleted.${handover} Videos already made keep their look.`,
          confirmLabel: "Delete",
          danger: true,
          focus: "cancel",
        }))
      ) {
        return null;
      }
      return kitWrite(async (cur) => {
        const kits = cur.kits.filter((k) => k.id !== id);
        if (kits.length === 0) return "the last kit cannot be deleted";
        return {
          kits,
          defaultId:
            cur.defaultId === id ? (kits[0]?.id ?? null) : cur.defaultId,
        };
      });
    }),
  resetKits: (): void =>
    act("start a fresh kit list", async () => {
      if (
        !(await askToConfirm({
          glyph: "trash",
          title: "Start a fresh kit list",
          body: "Your brand kits could not be read. Starting fresh replaces them with an empty list; videos already made keep their look.",
          confirmLabel: "Start fresh",
          danger: true,
          focus: "cancel",
        }))
      ) {
        return null;
      }
      // The one write that replaces a list nobody could read — which
      // `update` refuses by design — and only behind the question above.
      const { backup } = await brandKits.reset();
      kitWriteCount += 1;
      kitsRead = await brandKits.read();
      // The studio keeps the file it replaced, and says where: the author's
      // kits are not gone, only set aside.
      return backup === null
        ? null
        : {
            info: `Started a fresh kit list. The old list is kept at ${backup}.`,
          };
    }),
};

/**
 * Re-read when the author looks at this tab again.
 *
 * Every fact on the Sites card is decided somewhere else — Rewind and the
 * analytics rules from the popup, the production override from a drift
 * alert — so a page left open beside that work showed yesterday's answer
 * until it was reloaded. Only the theme followed a change feed.
 *
 * `visibilitychange` rather than the extension storage's change event:
 * the drift store is IndexedDB and emits no storage event, so a storage
 * listener would quietly cover two of the three site facts and miss the third —
 * which is the shape of defect this whole pass is about. Visibility
 * covers all three because it re-runs the same read the load did.
 *
 * Overlap, a flurry of changes and a refresh an action's own read already
 * covers are the refresher's (src/shell/refresher.ts), which chains every
 * render on the page rather than only the ones this listener starts.
 */
const refreshSoon = (): void => refresher.soon();
/**
 * The author mid-edit: a pointer held on the page (a slider's drag), or
 * focus in a field that holds typing. A refresh nobody asked for waits until
 * both end — it replaces every control, so it would end the drag and drop a
 * half-typed kit name. On the studio every kit write also comes back through
 * the file watcher a moment later, so this is the page's own commit, not
 * only another window's, landing on the next control the author picked up.
 * An action's own render does not wait: the author just asked for it.
 */
let pointerHeld = false;
const UNTYPED = new Set([
  "button",
  "checkbox",
  "file",
  "radio",
  "range",
  "reset",
  "submit",
]);
function authorMidEdit(): boolean {
  if (pointerHeld) return true;
  const focused = document.activeElement;
  if (focused === null || !root.contains(focused)) return false;
  return (
    focused instanceof HTMLTextAreaElement ||
    (focused instanceof HTMLInputElement && !UNTYPED.has(focused.type))
  );
}
const resumeRefresh = (): void => refresher.resume();
root.addEventListener("pointerdown", () => {
  pointerHeld = true;
});
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, () => {
    pointerHeld = false;
    resumeRefresh();
  });
}
// After the focus has moved: during `focusout` the next field is not yet
// the active element.
root.addEventListener("focusout", () => setTimeout(resumeRefresh, 0));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshSoon();
});

// A kit written anywhere else — an editor tab, another window — shows here
// too. Where the feed is down, `kits.unwatched` says so in the section.
brandKits.onChange(refreshSoon);

render().catch((error: unknown) => reportError("load Settings", error));
