// apps/studio/pages/entrypoints/library/main.ts

import type { FrameBundle } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { createPlatform } from "#platform";
import { editedLength } from "../../src/library/length";
import type { PreviewMounter, PreviewPorts } from "../../src/library/preview";
import { createPreviewMounter } from "../../src/library/preview";
import type { LibraryFilter, LibraryModel } from "../../src/library/state";
import { buildLibraryModel, NO_FILTER } from "../../src/library/state";
import {
  type LibraryActions,
  type RowKind,
  renderLibrary,
  statusKey,
} from "../../src/library/view";
import { trackSectionNav } from "../../src/settings/section-nav";
import { takeNote } from "../../src/shell/carried-note";
import { askToConfirm, DELETE_DEMO } from "../../src/shell/confirm-dialog";
import { createRefresher } from "../../src/shell/refresher";
import { mountTopbar } from "../../src/shell/topbar";

const root = document.querySelector("#root") as HTMLElement;
const noticeEl = document.querySelector("#notice") as HTMLElement;
// The left column's jump list marks the section in view, as Settings'
// nav does (2026-10-08). Links are rebuilt on every paint, so each paint
// puts the mark back.
const jumps = trackSectionNav(root);
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

/** The model of the last pass, so a filter change can repaint without
 *  asking the background for the summary again. */
let lastModel: LibraryModel | null = null;
let filter: LibraryFilter = NO_FILTER;

/** Drops a status whose row is gone. Keyed by the kind of row it was said
 *  on (`statusKey`), so a take that became a "Couldn't read" folder leaves
 *  its card's status here and the folder's row never shows it. */
function dropStatusesWithNoRow(model: LibraryModel): void {
  const rows = new Set([
    ...model.rows.map((r) => statusKey("take", r.sceneId)),
    ...(model.unreadable ?? []).map((u) => statusKey("folder", u.folder)),
  ]);
  for (const key of rowStatus.keys()) {
    if (!rows.has(key)) rowStatus.delete(key);
  }
}

function paint(model: LibraryModel): void {
  dropStatusesWithNoRow(model);
  mounter?.dispose();
  mounter = createPreviewMounter(previewPorts);
  renderLibrary(root, model, actions, rowStatus, filter);
  jumps.mark();
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
  const studio = await platform.folder.read();
  const listed = studio.scenes;
  scenesById = new Map(listed.map((scene) => [scene.meta.id, scene]));
  const model = buildLibraryModel({
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
  paint(model);
}

/** A refusal's reason, in the author's terms — one of three distinct
 *  outcomes `demo:delete` can produce (refused / partly deleted / deleted),
 *  each of which must read differently. Every reason the background can
 *  send needs a line here: an unmapped one falls through to the raw
 *  identifier below. */
const REFUSAL_TEXT: Record<string, string> = {
  recording: "a take is recording",
  rendering: "a render is running",
  sharing: "a share is in progress",
  // A hold the background takes while a take is being replayed — since
  // 2026-09-28 only by a re-shoot on the run page: `src/run/develop.ts` is
  // the one sender of `replay:gate`, which takes it. An authored script run
  // sends no `replay:gate` and takes no hold, and the editor takes none.
  replaying: "a take is being run in Runs",
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
  const pending = renaming.get(sceneId);
  if (pending === undefined) {
    openInThisTab(url, context);
    return;
  }
  void pending.then((landed) => {
    if (landed) openInThisTab(url, context);
  });
}

/** Whether a take was made by a script, for the route that films it again. */
function isAuthored(sceneId: string): boolean {
  return scenesById.get(sceneId)?.meta.capture.mode === "authored";
}

const actions: LibraryActions = {
  filter: (next: LibraryFilter): void => {
    filter = next;
    if (lastModel === null) {
      // Unreachable as written — the pills only exist once a pass has
      // rendered — but a pill that silently did nothing would look like a
      // filter that does not work.
      console.error(
        "demoman library: a filter was picked before the page had rendered",
      );
      return;
    }
    paint(lastModel);
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
            why = "the take is no longer stored";
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
        reportError("renaming this demo", error);
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
        if (got === null) throw new Error("the take is no longer stored");
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
              ? "Your recording could not be put back: no frames could be read for this take."
              : "There is no recording of this take to go back to, so it keeps its re-shot frames. Takes rebuilt before recordings were kept have none.";
          console.info(
            `[demoman] library: back to your recording — not served (${served === null ? "no bundle" : `serving ${served.source}`})`,
          );
        }
      } catch (error) {
        reportError("going back to the recording", error);
        why = `Couldn't go back to the recording: ${error instanceof Error ? error.message : String(error)}.`;
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
  remove: (sceneId: string, kind: RowKind): void => {
    const key = statusKey(kind, sceneId);
    void (async () => {
      try {
        // A dialog that could not open is not a No: it is said on the row,
        // where a refusal from the delete itself would be.
        let go: boolean;
        try {
          go = await askToConfirm(DELETE_DEMO);
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
        await renaming.get(sceneId);
        const r = await scenes.remove(sceneId);
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
        else if (r.ok && r.note !== undefined) say(r.note, "info");
      } catch (error) {
        reportError("deleting this demo", error);
      }
    })();
  },
};

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
    if (carried !== null) say(carried, "info");
  },
  (error: unknown) => {
    // The load failure takes the notice line; the note is not dropped.
    if (carried !== null) console.info(`demoman library: ${carried}`);
    reportError("loading your demos", error);
  },
);
