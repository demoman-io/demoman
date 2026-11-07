// apps/studio/pages/entrypoints/library/main.ts

import type { FrameBundle } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import {
  type Addable,
  type CiState,
  DEFAULT_LIBRARY_VIEW,
  type LibraryViewChoice,
} from "@demoman/studio-protocol";
import { createPlatform } from "#platform";
import { editedLength } from "../../src/library/length";
import { createLengthCache, paintLength } from "../../src/library/length-cache";
import type { ListSort } from "../../src/library/list-model";
import type { PreviewMounter, PreviewPorts } from "../../src/library/preview";
import { createPreviewMounter } from "../../src/library/preview";
import {
  narrow,
  type Place,
  parsePlace,
  placeSearch,
  projectKeyOf,
  railOf,
  showsTabs,
  type Tab,
  tabCounts,
} from "../../src/library/projects";
import { elsewhere, searching, searchModel } from "../../src/library/search";
import {
  clickSelect,
  emptySelection,
  pruneSelection,
  type Selection,
  selectAll,
  toggleGroup,
} from "../../src/library/selection";
import type { BulkOutcome, LibraryModel } from "../../src/library/state";
import {
  buildLibraryModel,
  bulkSentence,
  cardsOf,
  keptSentence,
} from "../../src/library/state";
import {
  applySelection,
  type LibraryActions,
  type RowKind,
  renderLibrary,
  statusKey,
  unreadableKind,
} from "../../src/library/view";
import type { FolderListing } from "../../src/platform/types";
import { takeNote, VIDEO_DELETED } from "../../src/shell/carried-note";
import { openCiSheet } from "../../src/shell/ci-sheet";
import {
  askToConfirm,
  type ConfirmQuestion,
  DELETE_DEMO,
  DELETE_RECORD,
  deleteFlow,
  deleteFlows,
  deleteVideoOf,
} from "../../src/shell/confirm-dialog";
import { createRefresher } from "../../src/shell/refresher";
import {
  messageOf,
  openRepoSheet,
  type RepoSheetResult,
  removedLine,
  removeQuestion,
} from "../../src/shell/repo-sheet";
import { showToast } from "../../src/shell/toast";
import { mountTopbar } from "../../src/shell/topbar";

const root = document.querySelector("#root") as HTMLElement;
const noticeEl = document.querySelector("#notice") as HTMLElement;
// Everything outside the page — the stores, the background's commands, the
// other pages' URLs — comes through the platform.
const platform = createPlatform();
const scenes = platform.scenes;
// The studio: the server asked this window to show a take (a second
// `npx demoman studio <take>` while this one is open). The library owes no
// writes, so it goes at once.
platform.nav.onOpen?.((path) => location.assign(path));
// The bar's Settings tab, pointed at this studio's Settings page.
mountTopbar(platform);

const rowStatus = new Map<string, string>();

/**
 * The page's one notice line, at the level the thing being said deserves.
 *
 * It was `notice-error` and nothing else, which was right while the only
 * thing it ever said was a refusal. Reclaim's own report goes through here
 * too now, and painting "Freed 1.8 GB." in the refusal's red would be its
 * own small lie about what happened. Bare `.notice` for info: the shell
 * has no `.notice-info` because the base class IS the neutral panel.
 */
function say(text: string, level: "info" | "warn" | "error"): void {
  noticeEl.textContent = text;
  noticeEl.className = level === "info" ? "notice" : `notice notice-${level}`;
  noticeEl.classList.remove("hidden");
}

function fail(text: string): void {
  say(text, "error");
}

/**
 * The page-level notice belongs to ONE pass over the page, and `render()`
 * below is what starts a pass.
 *
 * Nothing used to take it down again: `fail()` revealed `#notice` and no
 * path ever hid it, so a partial delete or a dropped `sendMessage` left its
 * red banner standing over every later clean reclaim, budget change and
 * delete. The author was told the demo they had just deleted successfully
 * could not be removed.
 *
 * The order that follows from this: an action that has something to say
 * says it AFTER its `render()`, never before, or the render it triggered
 * wipes the sentence it was written for.
 */
function clearNotice(): void {
  noticeEl.textContent = "";
  noticeEl.className = "notice notice-error hidden";
}

/**
 * Where every fire-and-forget action below lands on an outright failure —
 * a thrown error from `sendMessage`, the scene store, or the tabs API, not
 * a replied refusal (those have their own, more specific wording). Without
 * this, the async IIFEs the actions below use to await a reply would leave
 * an unhandled rejection, which on an extension page reaches the
 * chrome://extensions Errors list as an uncaught error rather than
 * anything the author can act on. `console.error`, not `warn`: this is a
 * real fault, not an expected outcome that merely owes a reason.
 */
function reportError(context: string, error: unknown): void {
  console.error(`demoman library: ${context} —`, error);
  fail(`Something went wrong (${context}). Try again.`);
}

/**
 * Go to another of the extension's pages in THIS tab.
 *
 * `location.assign` throws synchronously on a URL the browser refuses,
 * where the tabs-API `create` this replaced rejected instead — so the
 * failure needs a `try`, not a `.catch`, and it does need one: an extension
 * page's uncaught error lands on the chrome://extensions Errors list, and
 * an author who clicked Edit and stayed put would otherwise be told
 * nothing at all. `fail`, through `reportError`, says it on the page.
 */
function openInThisTab(url: string, context: string): void {
  try {
    location.assign(url);
  } catch (error) {
    reportError(context, error);
  }
}

/**
 * Previews read frames directly rather than over the runtime's messages, for the
 * reason `bundle-source.ts` already gives: sendMessage serialises as JSON,
 * so a Uint8Array would arrive as {"0":255,…}. Only the bundle row — which
 * is JSON, and whose replay-supersedes-capture rule belongs to the
 * background — comes back over a message.
 */
const bundles = platform.bundles;

/** Paint pending for a box that has not yet come near the viewport. */
const pendingPaints = new Map<Element, () => void>();

const visibility =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const paint = pendingPaints.get(entry.target);
            if (paint === undefined) continue;
            pendingPaints.delete(entry.target);
            visibility?.unobserve(entry.target);
            paint();
          }
        },
        // Ahead of the fold rather than at it: a thumbnail that starts
        // decoding as its row crosses the edge is a grey box for as long as
        // the decode takes.
        { rootMargin: "200px" },
      )
    : null;

let saidNoObserver = false;

/**
 * Laziness is an optimisation here, not a behaviour: with no
 * IntersectionObserver every row simply paints at once, which is correct
 * and merely more work. So the control flow is forgiven — and the reason
 * still gets said, once, at `info`. `info` and not `warn` because this page
 * is an extension page, where `warn` and above reach the
 * chrome://extensions Errors list, and this is an expected outcome rather
 * than a fault.
 */
const whenVisible: PreviewPorts["whenVisible"] = (box, paint) => {
  if (visibility === null) {
    if (!saidNoObserver) {
      saidNoObserver = true;
      console.info(
        "demoman library: no IntersectionObserver here, so every preview paints at once",
      );
    }
    paint();
    return () => {};
  }
  pendingPaints.set(box, paint);
  visibility.observe(box);
  return () => {
    pendingPaints.delete(box);
    visibility.unobserve(box);
  };
};

/** The documents the last pass listed, by id, for the length port. */
let scenesById = new Map<string, SceneDocument>();

const previewPorts: PreviewPorts<FrameBundle> = {
  bundle: async (sceneId) => (await bundles.active(sceneId)).bundle,
  length: async (sceneId, bundle) => {
    const scene = scenesById.get(sceneId);
    // Thrown, so the mounter says it: every card is built from this same
    // list, so a card whose document is missing means the two drifted.
    if (scene === undefined) {
      throw new Error(`no document for ${sceneId} in the last listing`);
    }
    return editedLength(scene, bundle, bundles.load);
  },
  // The studio makes the card's frame small itself (`folder.thumb`); it
  // refuses a take this page has not asked `bundles.active` for, and the
  // mounter's `bundle` port above always does first. Elsewhere the page
  // decodes the keyframe from the store, as it always has.
  image: async (ref) => {
    if (platform.folder !== undefined) return platform.folder.thumb(ref);
    const frame = await bundles.load(ref);
    // `load` serves raw container bytes for a `span:` ref and a decoded
    // image for a `kf:` one. A preview only ever samples keyframes, so
    // either branch below means the sampler handed over a ref of the wrong
    // kind — which the box must say, not draw as a blank.
    if (frame instanceof Uint8Array) {
      throw new Error(`${ref} loaded as motion bytes, not a keyframe`);
    }
    if (!(frame.image instanceof ImageBitmap)) {
      throw new Error(`${ref} decoded to something other than an ImageBitmap`);
    }
    return frame.image;
  },
  whenVisible,
};

/**
 * The mounter for the CURRENT pass. `renderLibrary` replaces every row on
 * each render, so without disposing this first, each pass would leave the
 * previous pass's flipbook intervals running against detached canvases.
 */
let mounter: PreviewMounter | null = null;

/** The model of the last pass, so a refused rename can repaint without
 *  asking the background for the summary again. */
let lastModel: LibraryModel | null = null;

/** Drops a status whose row is gone. Keyed by the kind of row it was said
 *  on (`statusKey`), so a take that became a "Couldn't read" folder leaves
 *  its card's status here and the folder's row never shows it. */
function dropStatusesWithNoRow(model: LibraryModel): void {
  const rows = new Set([
    ...model.rows.map((r) => statusKey("take", r.sceneId)),
    ...(model.groups ?? []).map((g) => statusKey("video", g.video.id)),
    ...(model.unreadable ?? []).flatMap((u) => {
      const kind = unreadableKind(u);
      return kind === null ? [] : [statusKey(kind, u.folder)];
    }),
  ]);
  for (const key of rowStatus.keys()) {
    if (!rows.has(key)) rowStatus.delete(key);
  }
}

/** The flows ticked for a bulk delete, and the bulk delete under way or
 *  what the last one left behind (spec 2026-10-30 flows-and-bulk-delete
 *  §1.2). */
let selection: Selection = emptySelection();
let bulk: { busy: boolean; said: string | null } | undefined;

/**
 * List or Grid and the list's sort, as the studio serves it (list spec §1),
 * read once before the first paint. The studio decides the default; a read
 * that fails outright draws that same default and says why.
 */
let view: LibraryViewChoice = DEFAULT_LIBRARY_VIEW;
const viewRead = platform.libraryView.read().then(
  (got) => {
    view = got.view;
    if (got.unreadable !== undefined) {
      console.warn(
        `demoman library: the stored view could not be used, so it is the default: ${got.unreadable}`,
      );
    }
  },
  (error: unknown) => {
    console.warn(
      `demoman library: the stored view could not be read, so it is the default: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  },
);

/**
 * Where the library is (spec 2026-11-01 library-projects-design, "Where the
 * Studio lands"): the take the editor came back from (`?from=`, when it is
 * in the listing), else the address's `?project=`, else the saved pick,
 * else All flows. Decided at the first paint, which has the flows to read
 * a take's project from, and written into the address so Back returns to
 * it. Only a rail click saves a pick.
 */
let place: Place | null = null;
const asked = parsePlace(location.search);
const cameFrom = new URLSearchParams(location.search).get("from");
let tab: Tab = "all";
/** The search box's text, kept in the address as `q`, and the order a
 *  heading click chose for this search alone (never saved). */
let query = new URLSearchParams(location.search).get("q") ?? "";
let searchSort: ListSort | null = null;

/** The flows a place, tab and query show. */
const shownIn = (model: LibraryModel, p: Place): LibraryModel =>
  searchModel(narrow(model, p, tab), query);

/** The saved pick, or All flows when there is none or its place has
 *  nothing left (a project, No project or Couldn't read): a known, normal
 *  state, said nowhere. */
function pickedPlace(model: LibraryModel): Place {
  const picked =
    view.project === null
      ? null
      : parsePlace(`?project=${encodeURIComponent(view.project)}`);
  if (picked === null || picked === "all") return "all";
  const left =
    picked === "unreadable"
      ? (model.unreadable ?? []).length
      : cardsOf(model).filter(
          (c) =>
            projectKeyOf(c) === (picked === "none" ? null : picked.project),
        ).length;
  return left > 0 ? picked : "all";
}

function landing(model: LibraryModel): Place {
  if (cameFrom !== null) {
    const card = cardsOf(model).find((c) =>
      (c.group?.versions ?? [c.row]).some((r) => r.sceneId === cameFrom),
    );
    if (card !== undefined) {
      const key = projectKeyOf(card);
      return key === null ? "none" : { project: key };
    }
  }
  return asked ?? pickedPlace(model);
}

/** The address of `p`, keeping the rest of the query but `from`. */
function addressOf(p: Place): string {
  const url = new URL(location.href);
  url.searchParams.delete("from");
  url.searchParams.delete("project");
  const rest = url.searchParams.toString();
  return `${url.pathname}${placeSearch(p)}${rest === "" ? "" : `&${rest}`}${url.hash}`;
}

/** Switching place or tab drops the selection: a flow ticked where the
 *  author can no longer see it must not be deleted. */
function clearForSwitch(): void {
  selection = emptySelection();
  bulk = undefined;
}

function paint(model: LibraryModel): void {
  dropStatusesWithNoRow(model);
  // A ticked flow another window or an agent deleted leaves the selection.
  // Not while a bulk delete runs: its own deletes would empty the bar under
  // it, and it settles the selection itself when it ends.
  if (bulk?.busy !== true) {
    selection = pruneSelection(
      selection,
      new Set((model.groups ?? []).map((g) => g.video.id)),
    );
  }
  mounter?.dispose();
  for (const stop of lengthWaits.splice(0)) stop();
  mounter = createPreviewMounter(previewPorts);
  if (place === null) {
    place = landing(model);
    history.replaceState(history.state, "", addressOf(place));
  }
  const cards = cardsOf(model);
  renderLibrary(
    root,
    shownIn(model, place),
    actions,
    rowStatus,
    undefined,
    selection,
    bulk,
    view,
    {
      place,
      tab,
      rail: railOf(cards, (model.unreadable ?? []).length, place),
      // Each tab says what it would show with this query.
      tabs: showsTabs(cards, place)
        ? tabCounts(cardsOf(searchModel(model, query)), place)
        : null,
      search: {
        query,
        sort: searchSort,
        // Counted under All: a link there lands on All (`goPlace`).
        elsewhere: elsewhere(cards, place, "all", query),
      },
    },
  );
}

/** Shows the selection on the cards in place: a tick is this page's own
 *  state, and re-rendering the list for it moved the page (view.ts,
 *  `applySelection`). */
function showSelection(): void {
  applySelection(root, actions, selection, bulk);
}

/** Renders run one at a time, in the order asked (src/shell/refresher.ts).
 *  The watcher's refresh and an action's own render would otherwise read the
 *  folder at once, and the older read could paint last. */
const refresher = createRefresher({
  paint: (keepNotice) => paintFresh({ keepNotice }),
  onRefreshFailed: (error) => reportError("refreshing the library", error),
});

/** An action's own render: after every render asked before it. */
function render(): Promise<void> {
  return refresher.render();
}

async function paintFresh({ keepNotice = false } = {}): Promise<void> {
  if (!keepNotice) clearNotice();
  // Both at once; the first paint still draws the view served.
  const [, studio] = await Promise.all([viewRead, platform.folder.read()]);
  paintListing(studio);
}

/** The listing the page last painted: an add marks its flow In repo in it
 *  at once (DEM-59), before the next read says so. */
let lastListing: FolderListing | null = null;

function paintListing(studio: FolderListing): void {
  lastListing = studio;
  const listed = studio.scenes;
  scenesById = new Map(listed.map((scene) => [scene.meta.id, scene]));
  const model = buildLibraryModel({
    videos: studio.videos,
    videoOf: studio.videoOf,
    sizes: studio.sizes,
    unreadable: studio.unreadable,
    unwatched: studio.unwatched,
    emptyHint: platform.nav.firstTakeHint(),
    scenes: listed,
    migrating: false,
    migrationFailed: false,
    notice: null,
    needsLook: new Set(),
  });
  lastModel = model;
  addables = studio.addable ?? {};
  paint(model);
}

/** Whether each flow can be added to its repo, as the last listing said. */
let addables: Record<string, Addable> = {};
/** The flows whose add is under way in this window: their button says so
 *  and a second press does nothing. */
const addingNow = new Set<string>();

const unperiod = (text: string): string => text.replace(/\.$/, "");

/** Add to repo: the sheet, then the row says how it went. A plain success
 *  is the sheet's own toast; a failure is the row's status line. */
async function addToRepo(id: string): Promise<void> {
  const can = addables[id];
  const flow = lastModel?.groups?.find((g) => g.video.id === id);
  // No answer from the listing offers Add: the sheet checks (DEM-47).
  if (addingNow.has(id) || can?.ok === false || flow === undefined) return;
  const key = statusKey("video", id);
  rowStatus.delete(key);
  addingNow.add(id);
  // The row's button says so now; the sheet opens without a read (DEM-47).
  repaint();
  let added: RepoSheetResult["added"] = null;
  try {
    const done = await openRepoSheet({
      video: { id, name: flow.video.name },
      repo: platform.videos.repo,
      ci: platform.repoCi,
      reveal: (path) => platform.files.reveal({ kind: "path", path }),
    });
    added = done.added;
    if (done.failed !== undefined) {
      rowStatus.set(key, `Couldn't add: ${unperiod(done.failed)}.`);
    }
  } catch (error) {
    console.error("demoman library: opening the add sheet —", error);
    rowStatus.set(key, `Couldn't add: ${unperiod(messageOf(error))}.`);
  } finally {
    addingNow.delete(id);
  }
  // In repo from the add's own answer (DEM-59); the read confirms it.
  if (added !== null) ciStates.delete(added.root);
  // Only an add the library marked: a failed mark's note says it will not
  // show In repo, and the read says what is true.
  if (added?.marked === true && lastListing !== null) {
    const { root, file } = added;
    paintListing({
      ...lastListing,
      videos: lastListing.videos.map((v) =>
        v.id === id
          ? {
              ...v,
              kept: {
                root,
                file,
                deliver: added.deliver,
                key: "key" in v.repo ? v.repo.key : null,
              },
            }
          : v,
      ),
    });
  } else repaint();
  void render().catch((error: unknown) => reportError("adding it", error));
}

/** Each checkout's CI state, read once per page load, read again after a
 *  CI sheet closes or an add lands. "reading" while the read is out. */
const ciStates = new Map<string, CiState | "reading">();

/** The checkout a project's flows are in the repo of: the first In repo
 *  flow's. Null when none of its flows is. */
function rootOf(project: string): string | null {
  for (const v of lastListing?.videos ?? []) {
    const kept = v.kept;
    if (kept === null || "unknown" in kept) continue;
    const key = kept.key ?? ("key" in v.repo ? v.repo.key : null);
    if (key === project) return kept.root;
  }
  return null;
}

/** Set up CI beside a project's heading (DEM-52): offered for a project
 *  with a flow in the repo whose CI is anything but set up. A state that
 *  will not read still offers it, and the sheet says why. */
function ciSetupFor(p: Place): (() => void) | null {
  if (typeof p !== "object") return null;
  const root = rootOf(p.project);
  if (root === null) return null;
  const st = ciStates.get(root);
  if (st === undefined) {
    ciStates.set(root, "reading");
    platform.repoCi
      .state(root)
      .then(
        (got) => ciStates.set(root, got),
        (error: unknown) =>
          ciStates.set(root, { kind: "unreadable", detail: messageOf(error) }),
      )
      .finally(repaint);
    return null;
  }
  if (st === "reading" || st.kind === "setUp") return null;
  return () => void openCi(root, p.project);
}

async function openCi(root: string, project: string): Promise<void> {
  try {
    await openCiSheet({
      root,
      name: project.split("/").slice(1).join("/") || project,
      ci: platform.repoCi,
    });
  } catch (error) {
    reportError("opening CI setup", error);
  }
  ciStates.delete(root);
  repaint();
}

/** Paints the last listing again: a row's state changed, the folder did not. */
function repaint(): void {
  if (lastListing !== null) paintListing(lastListing);
}

/** Remove from repo: asks, names the recipe that goes and the exports that
 *  stay, then says it was done. */
async function removeFromRepo(id: string): Promise<void> {
  const flow = lastModel?.groups?.find((g) => g.video.id === id);
  const kept = flow?.video.kept;
  if (flow === undefined || kept == null || "unknown" in kept) return;
  const key = statusKey("video", id);
  let go: boolean;
  try {
    go = await askToConfirm(removeQuestion(flow.video, kept.file));
  } catch (error) {
    rowStatus.set(
      key,
      `Couldn't remove: the confirmation could not open — ${unperiod(messageOf(error))}.`,
    );
    await render();
    return;
  }
  if (!go) return;
  try {
    const done = await platform.videos.repo.remove(id);
    rowStatus.delete(key);
    await render();
    const said = removedLine(flow.video.name);
    if (done.notes.length === 0) showToast(said);
    else say([said, ...done.notes].join(" "), "info");
  } catch (error) {
    rowStatus.set(key, `Couldn't remove: ${unperiod(messageOf(error))}.`);
    await render().catch((e: unknown) => reportError("removing it", e));
  }
}

/** A refusal's reason, in the author's terms — one of three distinct
 *  outcomes `demo:delete` can produce (refused / partly deleted / deleted),
 *  each of which must read differently. Every reason the background can
 *  send needs a line here: an unmapped one falls through to the raw
 *  identifier below. */
const REFUSAL_TEXT: Record<string, string> = {
  recording: "a video is being recorded",
  rendering: "a render is running",
  sharing: "a share is in progress",
  // A hold the background takes while a take is being replayed — since
  // 2026-09-28 only by a re-shoot on the run page: `src/run/develop.ts` is
  // the one sender of `replay:gate`, which takes it. An authored script run
  // sends no `replay:gate` and takes no hold, and the editor takes none.
  replaying: "a video is being run in Runs",
};

/** A rename in flight, per row, resolving to whether it landed. A Delete on
 *  the same card waits for it: the mousedown that pressed Delete blurred the
 *  name field and committed a rename, and a `scene:put` landing after
 *  `demo:delete` would re-create the scene the delete just removed. Edit and
 *  Restore wait for it too — see `openAfterRename`. */
const renaming = new Map<string, Promise<boolean>>();

/**
 * Open the editor for `sceneId` once any rename on its card has landed.
 *
 * Edit leaves this page, and the rename its own mousedown committed is two
 * round trips (`scene:get`, then `scene:put`) that had not been sent when
 * the navigation started — so the rename was dropped with nothing to say
 * so, and the editor opened on the old name. A rename that FAILS keeps the
 * author here, on the card whose row already says why; leaving would carry
 * them to an editor showing a name nothing explains.
 */
function openAfterRename(sceneId: string, url: string, context: string): void {
  const pending = renaming.get(sceneId) ?? renaming.get(videoOf(sceneId) ?? "");
  if (pending === undefined) {
    openInThisTab(url, context);
    return;
  }
  void pending.then((landed) => {
    if (landed) openInThisTab(url, context);
  });
}

/** The video `sceneId` is a version of, in the last pass, if any. */
function videoOf(sceneId: string): string | undefined {
  return lastModel?.groups?.find((g) =>
    g.versions.some((v) => v.sceneId === sceneId),
  )?.video.id;
}

/** What Delete asks, by what it removes: one video of a flow, a whole
 *  flow and how many videos go with it, an unreadable record alone, or (a
 *  take in no flow, a folder) the video. */
function questionFor(id: string, kind: RowKind): ConfirmQuestion {
  if (kind === "record") return DELETE_RECORD;
  if (kind === "video") {
    const group = lastModel?.groups?.find((g) => g.video.id === id);
    if (group === undefined) return DELETE_DEMO;
    const asked = deleteFlow(group.video.versions);
    const kept = keptSentence(group.video);
    return kept === null ? asked : { ...asked, body: `${asked.body} ${kept}` };
  }
  if (kind === "take") {
    const group = lastModel?.groups?.find((g) =>
      g.versions.some((v) => v.sceneId === id),
    );
    if (group !== undefined) {
      const number = group.versions.find((v) => v.sceneId === id)?.version;
      return deleteVideoOf(number, group.video.name);
    }
  }
  return DELETE_DEMO;
}

/** What a clean single Delete says, by what it removed. */
const DELETED: Record<RowKind, string> = {
  video: "Deleted the flow",
  take: "Deleted the video",
  folder: "Deleted the folder",
  record: "Deleted the flow record",
};

/** Whether a take was made by a script, for the route that films it again. */
function isAuthored(sceneId: string): boolean {
  return scenesById.get(sceneId)?.meta.capture.mode === "authored";
}

const lengths = createLengthCache();
/** Let-goes for the current pass's unmeasured Length cells; `paint` runs
 *  them before the next draw so a replaced cell is not held observed. */
const lengthWaits: (() => void)[] = [];

const actions: LibraryActions = {
  /** Kept for this session at once; a write that fails or replaced the
   *  settings file is said, and the view stays as chosen. */
  setView: (next) => {
    // A heading click sorts this search's results, not the saved view.
    if (searching(query) && next.layout === view.layout) {
      searchSort = { ...next.sort };
      if (lastModel !== null) paint(lastModel);
      return;
    }
    view = next;
    if (lastModel !== null) paint(lastModel);
    platform.libraryView.write(next).then(
      (done) => {
        if (done.replaced === undefined) return;
        console.warn(`demoman library: ${done.replaced}`);
        say(done.replaced, "warn");
      },
      (error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        console.warn(`demoman library: the view was not saved: ${why}`);
        say(`The view was not saved: ${why.replace(/\.$/, "")}.`, "warn");
      },
    );
  },
  goPlace: (p) => {
    if (bulk?.busy === true) return;
    place = p;
    tab = "all";
    clearForSwitch();
    if (location.search !== new URL(addressOf(p), location.href).search) {
      history.pushState(history.state, "", addressOf(p));
    }
    if (lastModel !== null) paint(lastModel);
    // Only a click in the rail saves the pick. Kept for this session at
    // once; a write that fails is said on the console, as a view that
    // could not be read is; a settings file it replaced, on the notice.
    view = { ...view, project: typeof p === "string" ? p : p.project };
    platform.libraryView.write(view).then(
      (done) => {
        if (done.replaced === undefined) return;
        console.warn(`demoman library: ${done.replaced}`);
        say(done.replaced, "warn");
      },
      (error: unknown) => {
        console.warn(
          `demoman library: the project picked was not saved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
  },
  search: (q) => {
    query = q;
    if (!searching(q)) searchSort = null;
    // A ticked flow the results hide is not deleted: as a place switch,
    // but only what went out of sight.
    if (bulk?.busy !== true && lastModel !== null && place !== null) {
      selection = pruneSelection(
        selection,
        new Set(
          (shownIn(lastModel, place).groups ?? []).map((g) => g.video.id),
        ),
      );
    }
    // Replaced, not pushed: Back leaves the search as a whole.
    const url = new URL(location.href);
    if (q === "") url.searchParams.delete("q");
    else url.searchParams.set("q", q);
    history.replaceState(history.state, "", url);
    if (lastModel !== null) paint(lastModel);
  },
  goTab: (t) => {
    if (bulk?.busy === true) return;
    tab = t;
    clearForSwitch();
    if (lastModel !== null) paint(lastModel);
  },
  measure: (sceneId: string, cell: HTMLElement): void => {
    // Said each time, and painted `—`: nothing about a failure is kept, so
    // the next paint after a redraw measures again.
    const failed = (err: unknown): void => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `demoman library: length of ${sceneId} could not be measured: ${e.message}`,
      );
      paintLength(cell, e);
    };
    const scene = scenesById.get(sceneId);
    if (scene === undefined) {
      // Every row is built from this same listing: the two drifted.
      failed(new Error(`no document for ${sceneId} in the last listing`));
      return;
    }
    // A known length paints at once: a redraw never blanks it.
    const known = lengths.get(scene);
    if (known !== undefined) {
      paintLength(cell, known);
      return;
    }
    const stop = whenVisible(cell, () => {
      void bundles
        .active(sceneId)
        .then(({ bundle }) =>
          // A video without frames (expired) has no length: a state, not a
          // fault, and not kept, as its frames may come back.
          bundle === null
            ? ({ kind: "nothing", reason: "it has no frames" } as const)
            : lengths.measure(scene, () =>
                editedLength(scene, bundle, bundles.load),
              ),
        )
        .then((got) => paintLength(cell, got), failed);
    });
    lengthWaits.push(stop);
  },
  preview: (sceneId: string, box: HTMLElement): void => {
    if (mounter === null) {
      // Unreachable as written — `render()` makes the mounter immediately
      // before `renderLibrary` calls this — but a row that silently skipped
      // its preview would sit on "Loading preview…" forever with nothing
      // anywhere saying why.
      console.error(
        "demoman library: a row asked for a preview before the page had a mounter",
      );
      return;
    }
    mounter.mount(sceneId, box);
  },
  /**
   * Open a take for editing, IN THIS TAB.
   *
   * It used to be the tabs API's `create`, which left a Recordings tab behind
   * every take the author opened. The editor carries a Back control to
   * here, so the pair reads as one page moving between two views rather
   * than as a tab per demo — and the browser's own Back works on top of it,
   * which it never did across a `tabs.create`.
   */
  edit: (sceneId: string): void => {
    openAfterRename(
      sceneId,
      platform.nav.editor(sceneId),
      "opening the editor",
    );
  },
  rename: (sceneId: string, name: string): void => {
    const run = (async () => {
      try {
        // Through the platform's scene write, not straight into the store:
        // on the extension that is the background's `scene:put`, which
        // validates the document, marks it edited-after-host and refreshes
        // the drift index, the same as an editor rename. Read back first
        // so the rest of the document travels untouched.
        let why: string | null = null;
        try {
          const got = await scenes.get(sceneId);
          if (got === null) {
            why = "the video is no longer stored";
          } else {
            const scene = {
              ...got.scene,
              meta: { ...got.scene.meta, name },
            };
            await scenes.put(scene, got.revision);
          }
        } catch (error) {
          // A refusal and a channel that failed both reject here; either
          // way the row says what the platform said.
          why = error instanceof Error ? error.message : String(error);
        }
        // The row is re-rendered either way: from the store's new name on
        // success, and back to the old one under the reason on a refusal —
        // a field left showing a name nothing saved is the defect
        // CLAUDE.md names.
        const key = statusKey("take", sceneId);
        if (why === null) rowStatus.delete(key);
        else rowStatus.set(key, `Couldn't rename: ${why}.`);
        await render();
        return why === null;
      } catch (error) {
        // The channel itself failed — the worker gone, say. The field still
        // shows the name the author typed, so the row says it was not saved
        // and the repaint puts the stored name back; the page banner alone
        // left a name nothing saved on the card.
        reportError("renaming it", error);
        rowStatus.set(
          statusKey("take", sceneId),
          `Couldn't rename: ${error instanceof Error ? error.message : String(error)}.`,
        );
        if (lastModel !== null) paint(lastModel);
        return false;
      }
    })();
    renaming.set(sceneId, run);
    void run.finally(() => {
      if (renaming.get(sceneId) === run) renaming.delete(sceneId);
    });
  },
  renameVideo: (videoId: string, name: string): void => {
    const run = (async () => {
      const key = statusKey("video", videoId);
      let why: string | null = null;
      try {
        await platform.videos.rename(videoId, name);
      } catch (error) {
        // A refusal (another video has the name) and a channel that failed
        // both reject here with the studio's sentence; the card says it,
        // and the repaint puts the stored name back in the field.
        why = error instanceof Error ? error.message : String(error);
      }
      if (why === null) rowStatus.delete(key);
      else rowStatus.set(key, `Couldn't rename: ${why.replace(/\.$/, "")}.`);
      try {
        await render();
      } catch (error) {
        reportError("refreshing the library", error);
      }
      return why === null;
    })();
    renaming.set(videoId, run);
    void run.finally(() => {
      if (renaming.get(videoId) === run) renaming.delete(videoId);
    });
  },
  restore: (sceneId: string): void => {
    const route = platform.nav.rerun(sceneId, isAuthored(sceneId));
    // Never reached for a line: the view draws that as a sentence in place
    // of the button. Said anyway, since a Restore that did nothing would
    // look like a button that does not work.
    if (route.kind === "line") {
      console.error(
        "demoman library: Restore was pressed on a platform whose route is a line",
      );
      return;
    }
    openAfterRename(
      sceneId,
      // The platform's hrefs are relative to its pages; `location.assign`
      // resolves against this one, which is the same origin.
      new URL(route.href, platform.nav.library()).href,
      "opening Runs to restore motion",
    );
  },
  rerunLine: (sceneId, authored) => {
    const route = platform.nav.rerun(sceneId, authored);
    return route.kind === "line" ? route.text : null;
  },
  backToRecording: (sceneId: string): void => {
    void (async () => {
      let why: string | null = null;
      // A rename the same card committed reads and writes this scene too;
      // Back reading before it lands loses the name, and its put landing
      // after Back's brings `demo` back once Back has said it is gone
      // (final review I2). A rename that FAILED has already said so on the
      // row; Back still runs, and keeps that sentence beside its own.
      const renamed = await renaming.get(sceneId);
      const key = statusKey("take", sceneId);
      const renameWhy = renamed === false ? rowStatus.get(key) : undefined;
      try {
        const got = await scenes.get(sceneId);
        if (got === null) throw new Error("the video is no longer stored");
        const scene = {
          ...got.scene,
          meta: { ...got.scene.meta, renderMode: "screen" as const },
        };
        await scenes.put(scene, got.revision);
        // The write landing is not the question; the frames served are
        // (spec §5 amended 2026-09-28).
        const served = (await bundles.active(sceneId)).bundle;
        if (served?.source !== "capture") {
          why =
            served === null
              ? "The original footage could not be put back: no frames could be read for this video."
              : "There is no original footage of this video to go back to, so it keeps its re-shot frames. Videos rebuilt before original footage was kept have none.";
          console.info(
            `[demoman] library: back to the original footage — not served (${served === null ? "no bundle" : `serving ${served.source}`})`,
          );
        }
      } catch (error) {
        reportError("going back to the original footage", error);
        why = `Couldn't go back to the original footage: ${error instanceof Error ? error.message : String(error)}.`;
      }
      const said = [renameWhy, why].filter((s) => s != null).join(" ");
      if (said === "") rowStatus.delete(key);
      else rowStatus.set(key, said);
      // Fire-and-forget, so a refresh that failed has nowhere to go but
      // here: an extension page's uncaught rejection lands on the
      // chrome://extensions Errors list with no sentence for the author.
      try {
        await render();
      } catch (error) {
        reportError("refreshing the library", error);
      }
    })();
  },
  select: (videoId, how, visibleOrder, from) => {
    if (bulk?.busy === true) return;
    selection = clickSelect(selection, videoId, how, visibleOrder, from);
    bulk = undefined;
    showSelection();
  },
  selectAll: (visibleOrder) => {
    if (bulk?.busy === true) return;
    selection = selectAll(selection, visibleOrder);
    bulk = undefined;
    showSelection();
  },
  selectGroup: (ids) => {
    if (bulk?.busy === true) return;
    selection = toggleGroup(selection, ids);
    bulk = undefined;
    showSelection();
  },
  clearSelection: () => {
    if (bulk?.busy === true) return;
    selection = emptySelection();
    bulk = undefined;
    showSelection();
  },
  deleteSelected: () => {
    void deleteSelected();
  },
  repo: {
    addable: (id) => addables[id],
    adding: (id) => addingNow.has(id),
    add: (id) => void addToRepo(id),
    remove: (id) => void removeFromRepo(id),
  },
  ciSetup: (p) => ciSetupFor(p),
  remove: (sceneId: string, kind: RowKind): void => {
    // The run in flight owns the deletes; a second dialog over it would
    // race its list.
    if (bulk?.busy === true) return;
    const key = statusKey(kind, sceneId);
    void (async () => {
      try {
        // A dialog that could not open is not a No: it is said on the row,
        // where a refusal from the delete itself would be.
        let go: boolean;
        try {
          go = await askToConfirm(questionFor(sceneId, kind));
        } catch (error) {
          console.error("demoman library: asking before a delete —", error);
          rowStatus.set(
            key,
            `Not deleted: the confirmation could not open — ${
              error instanceof Error ? error.message : String(error)
            }.`,
          );
          await render();
          return;
        }
        if (!go) return;
        // Read before the delete: the repaint after it has no flow to ask.
        const flow = lastModel?.groups?.find((g) => g.video.id === sceneId);
        const kept =
          kind === "video" && flow !== undefined
            ? keptSentence(flow.video)
            : null;
        const andKept = (said: string): string =>
          kept === null ? said : `${said} ${kept}`;
        await renaming.get(sceneId);
        const r =
          kind === "video" || kind === "record"
            ? await platform.videos.remove(sceneId)
            : await scenes.remove(sceneId);
        // Three distinct outcomes, three distinct sentences — a refusal, a
        // partial delete, and a clean delete must never read alike, and a
        // partial delete in particular must never say "Deleted".
        //
        // Held rather than shown here, and said after the `render()` below:
        // the render clears the page notice as it starts.
        let pageMessage: string | null = null;
        if (!r.ok) {
          // The platform's own sentence when it sent one; otherwise the
          // reason in the author's terms, and the raw identifier last.
          const why = r.detail ?? REFUSAL_TEXT[r.error] ?? r.error;
          rowStatus.set(key, `Not deleted: ${why}.`);
        } else if (r.partly !== undefined) {
          // A video's delete that stopped part-way: said on the page, since
          // the card may be gone with the versions that went.
          rowStatus.delete(key);
          pageMessage = andKept(`Partly deleted: ${r.partly}.`);
        } else if (r.result !== undefined && !r.result.ok) {
          const failedStep = r.result.steps.find((s) => !s.ok);
          const message = `Partly deleted: ${failedStep?.step ?? "a step"} could not be removed — ${failedStep?.error ?? "unknown error"}`;
          // `deleteDemo` deletes the SCENE before its last step ("drift" —
          // see src/core/storage/delete.ts). A failure at "scene" or later
          // means the scene document is already gone, so `render()`'s next
          // `scenes.list()` will not return this row at all — a row-level
          // status here would never be seen, and the demo would appear to
          // have vanished cleanly. Surface it at PAGE level instead, the
          // same `#notice`/`fail(...)` surface a `sendMessage` failure
          // already uses.
          const sceneStep = r.result.steps.find((s) => s.step === "scene");
          if (sceneStep?.ok === true) {
            rowStatus.delete(key);
            pageMessage = message;
          } else {
            rowStatus.set(key, message);
          }
        } else {
          rowStatus.delete(key);
        }
        await render();
        if (pageMessage !== null) fail(pageMessage);
        else if (r.ok && r.note !== undefined) say(andKept(r.note), "info");
        // Clean: nothing refused, partial or noted. A toast, then gone.
        else if (r.ok && r.partly === undefined && r.result?.ok !== false) {
          showToast(
            kept === null ? DELETED[kind] : `${DELETED[kind]}. ${kept}`,
          );
        }
      } catch (error) {
        reportError("deleting it", error);
      }
    })();
  },
};

/** The ticked flows, asked about once and deleted one at a time through
 *  the flow's own route, which checks every video for an export before any
 *  goes. A flow that stays is named with its reason and stays ticked, so
 *  trying again is one press; one that is already gone counts as gone. */
async function deleteSelected(): Promise<void> {
  const groups = new Map(
    (lastModel?.groups ?? []).map((g) => [g.video.id, g.video] as const),
  );
  const ids = [...selection.ids].filter((id) => groups.has(id));
  if (ids.length === 0 || bulk?.busy === true) return;
  const videos = ids.reduce((n, id) => n + (groups.get(id)?.versions ?? 0), 0);
  const keptOf = new Map(
    ids.flatMap((id) => {
      const video = groups.get(id);
      const kept = video === undefined ? null : keptSentence(video);
      return kept === null ? [] : [[id, kept] as const];
    }),
  );
  const asked = deleteFlows(ids.length, videos);
  let go: boolean;
  try {
    go = await askToConfirm(
      keptOf.size === 0
        ? asked
        : { ...asked, body: [asked.body, ...keptOf.values()].join(" ") },
    );
  } catch (error) {
    console.error("demoman library: asking before a bulk delete —", error);
    bulk = {
      busy: false,
      said: `Not deleted: the confirmation could not open — ${
        error instanceof Error ? error.message : String(error)
      }.`,
    };
    showSelection();
    return;
  }
  if (!go) return;
  // A Back while it asked switched place and cleared the ticks: only a flow
  // still ticked goes (spec: a switch with a selection deletes nothing).
  const still = ids.filter((id) => selection.ids.has(id));
  if (still.length === 0) return;
  bulk = { busy: true, said: null };
  showSelection();
  const outcomes: BulkOutcome[] = [];
  for (const id of still) {
    const name = groups.get(id)?.name ?? id;
    try {
      const r = await platform.videos.remove(id);
      // A kept flow's recipe stays whatever went: said with the delete's
      // own note, if it has one.
      const said = [r.ok ? r.note : undefined, keptOf.get(id)].filter(
        (n) => n !== undefined,
      );
      const note = said.length === 0 ? {} : { note: said.join(" ") };
      if (r.ok && r.partly !== undefined) {
        outcomes.push({
          id,
          name,
          stayed: `only part of it went: ${r.partly}`,
          ...note,
        });
      } else if (r.ok) {
        outcomes.push({ id, name, gone: true, ...note });
      } else if (r.error === "videoNotFound") {
        outcomes.push({ id, name, gone: true });
      } else {
        outcomes.push({
          id,
          name,
          stayed: r.detail ?? REFUSAL_TEXT[r.error] ?? r.error,
        });
      }
    } catch (error) {
      outcomes.push({
        id,
        name,
        stayed: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const said = bulkSentence(outcomes);
  const stayed = new Set(
    outcomes.flatMap((o) => ("stayed" in o ? [o.id] : [])),
  );
  selection = pruneSelection(selection, stayed);
  bulk = stayed.size === 0 ? undefined : { busy: false, said: said.text };
  try {
    await render();
  } catch (error) {
    reportError("refreshing the library", error);
  }
  // A clean delete toasts and goes; a note on what it cleared or left
  // behind stays on the notice line, where it can be read and acted on.
  if (stayed.size === 0) {
    const noted = outcomes.some((o) => "gone" in o && o.note !== undefined);
    if (noted) say(said.text, said.level);
    else showToast(said.text);
  } else if (selection.ids.size === 0) {
    // Every flow that stayed lost its card (its videos went, its record
    // did not), and the bar that would name them went with the selection.
    say(said.text, said.level);
  }
}

// Back and Forward between places the rail pushed.
window.addEventListener("popstate", () => {
  place = parsePlace(location.search) ?? "all";
  tab = "all";
  query = new URLSearchParams(location.search).get("q") ?? "";
  searchSort = null;
  // A bulk delete under way keeps its lock and its ticks; it settles both
  // itself when it ends.
  if (bulk?.busy !== true) clearForSwitch();
  if (lastModel !== null) paint(lastModel);
});

// Esc clears the selection, as it closes the panels. Not while a dialog
// is open (it answers Esc itself) or a field has the key.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || selection.ids.size === 0) return;
  if (document.querySelector("dialog[open]") !== null) return;
  if (document.activeElement?.matches("input:not([type=checkbox]), textarea")) {
    return;
  }
  actions.clearSelection?.();
});

// `/` goes to the search box, unless a dialog or a field has the keys.
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  const box = document.querySelector<HTMLInputElement>("[data-search]");
  if (box === null || box.closest("[hidden]") !== null) return;
  if (document.querySelector("dialog[open]") !== null) return;
  const active = document.activeElement as HTMLElement | null;
  if (
    active?.matches("input:not([type=checkbox]), textarea, select") === true ||
    active?.isContentEditable === true
  ) {
    return;
  }
  event.preventDefault();
  box.focus();
});

// A take landed, changed or went in the studio's folder: read again. The
// extension has no folder, and its page changes only by its own actions.
// A burst of them costs one read in flight and one after it, and a change
// event raised by this page's own write is covered by that action's render.
platform.folder?.onChange(() => refresher.soon());

// A sentence the page that sent the author here still owed them — the
// editor's Delete, with the studio's note on what it left or cleared. Said
// after the first render, which clears the notice as it starts.
const carried = takeNote();
render().then(
  () => {
    // A clean delete toasts; a note on what it left behind stays to be read.
    if (carried === VIDEO_DELETED) showToast(carried);
    else if (carried !== null) say(carried, "info");
  },
  (error: unknown) => {
    // The load failure takes the notice line; the note is not dropped.
    if (carried !== null) console.info(`demoman library: ${carried}`);
    reportError("loading your flows", error);
  },
);
