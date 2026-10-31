import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authoredScene,
  readonlyScene,
} from "../../../../../packages/replay-engine/test/helpers/scenes";
import {
  renderBundleBanner,
  renderFailure,
  renderHeaderIcons,
  renderNotesButton,
  renderShortcuts,
  renderStageBar,
  renderTakeNotes,
  renderTransport,
  revealNewErrors,
} from "../../../pages/entrypoints/editor/view";
import { replaySentence } from "../../../pages/src/core/replay/status";
import type { HoverReport } from "../../../pages/src/editor/hover-report";
import { hoverReportText } from "../../../pages/src/editor/hover-report";
import { runsHref, runsRouteLabel } from "../../../pages/src/shell/runs-link";

/**
 * Task 12 removed `describe("renderBeats")`,
 * `describe("renderInsertAction")` and `describe("renderHoverReport")` from
 * this file along with the renderers they covered — the last of those
 * because the inspector's own take section had become a near-verbatim
 * duplicate of it with no production caller left, and a test suite pointed
 * at the dead copy would have stayed green while the live banner
 * regressed. Every assertion in them was either ported to
 * `editor-inspector.test.ts` / `editor-timeline-view.test.ts` or retired
 * where the behaviour genuinely no longer exists; the retirements are named
 * in a comment at the top of each of those two files.
 */

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
});

// `describe("renderNotice", ...)` retired with Task 10: `renderNotice` and
// the edit-time tier notice it drew are gone (spec §2). The frozen routes
// moved to the agent door: `replay-routes.test.ts`'s `frozenRoutes` describe
// pins the route list and order, which `RunReport.refused.routes` carries.
// The export's rebuild-failure row that also drew them left the editor with
// plan 2's Task 7.

describe("renderBundleBanner", () => {
  it("names the Runs route, with this take's id, when there are no frames", () => {
    renderBundleBanner(root, {
      hasFrames: false,
      route: {
        takeId: "t1",
        authored: false,
        rerun: {
          kind: "link" as const,
          href: runsHref("t1"),
          label: runsRouteLabel(false),
        },
      },
    });
    const link = root.querySelector<HTMLAnchorElement>("a[data-runs-route]");
    expect(link?.getAttribute("href")).toBe("run.html?take=t1");
    expect(root.textContent).toContain(
      "This video has no frames — re-shoot it in Runs",
    );
    // The editor offers no rebuild, so the banner must not promise one.
    expect(root.textContent).not.toMatch(/rebuil/i);
  });

  // Final review M1. Runs refuses to re-shoot a script-made take, so the
  // banner names the route that works there. Goes red if the banner stops
  // reading `route.authored`.
  it("tells an authored take to run its script again, not to re-shoot it", () => {
    renderBundleBanner(root, {
      hasFrames: false,
      route: {
        takeId: "t1",
        authored: true,
        rerun: {
          kind: "link" as const,
          href: runsHref("t1"),
          label: runsRouteLabel(true),
        },
      },
    });
    expect(root.textContent).toBe(
      "This video has no frames — run its script again in Runs",
    );
    expect(root.querySelector("a[data-runs-route]")?.getAttribute("href")).toBe(
      "run.html?take=t1",
    );
  });

  it("is silent once any frames exist", () => {
    // Premise: the root held something, so "silent" is a banner that
    // cleared, not one that never drew.
    renderBundleBanner(root, {
      hasFrames: false,
      route: {
        takeId: "t1",
        authored: false,
        rerun: {
          kind: "link" as const,
          href: runsHref("t1"),
          label: runsRouteLabel(false),
        },
      },
    });
    expect(root.children.length).toBeGreaterThan(0);
    renderBundleBanner(root, {
      hasFrames: true,
      route: {
        takeId: "t1",
        authored: false,
        rerun: {
          kind: "link" as const,
          href: runsHref("t1"),
          label: runsRouteLabel(false),
        },
      },
    });
    expect(root.children).toHaveLength(0);
  });

  // "offers the same rebuild label from every context that invites a
  // rebuild" and "says Rebuild now, not the invitation, where the mode is
  // already demo" retired with Task 10: `renderRenderMode`, `REBUILD_LABEL`
  // and `REBUILD_NOW_LABEL` are gone (spec §2 — "Recording or Rebuild?" is
  // not asked, and `renderFailure`'s own retry button went with it, so
  // there is no second label left to compare against). The Export button
  // was the last way to start a rebuild until plan 2's Task 7 took that out
  // too; its label rules are `export-run.test.ts`'s (`exportButtonLabel`).
});

describe("renderFailure", () => {
  it("renders nothing when there is no error and no replay sentence", () => {
    renderFailure(root, {
      error: null,
      replaySentence: null,
      captureSentence: null,
    });
    expect(root.children).toHaveLength(0);
  });

  it("renders the replay sentence", () => {
    renderFailure(root, {
      error: null,
      replaySentence:
        "The re-shoot reconstructed 2 of 5 steps, then stopped: what the step waited for (an element to show or hide, or the page to load) did not happen within 10 s — check the target, or what the step before it does.",
      captureSentence: null,
    });
    expect(root.querySelector("[data-replay-failure]")).not.toBeNull();
    expect(root.textContent).toContain("2 of 5 steps");
    expect(root.querySelector("[data-action-error]")).toBeNull();
  });

  // Final review I3(a). The sentence is about a re-shoot, and says to run
  // one again; a re-shoot happens only on the run page, so the box holds the
  // way there. Goes red if the replay box stops drawing `runsRoute`.
  it("draws this take's route to Runs under the replay sentence", () => {
    renderFailure(root, {
      error: null,
      replaySentence:
        "The re-shoot reconstructed 2 of 5 steps, then stopped: what the step waited for (an element to show or hide, or the page to load) did not happen within 10 s — check the target, or what the step before it does.",
      captureSentence: null,
      runsRoute: {
        takeId: "take 1&x",
        authored: false,
        rerun: {
          kind: "link" as const,
          href: runsHref("take 1&x"),
          label: runsRouteLabel(false),
        },
      },
    });
    const link = root.querySelector<HTMLAnchorElement>(
      "[data-replay-failure] [data-replay-runs-route] a[data-runs-route]",
    );
    expect(link?.getAttribute("href")).toBe("run.html?take=take%201%26x");
    expect(link?.textContent).toBe("Re-shoot this video in Runs");
  });

  it("draws no route to Runs where there is no replay sentence", () => {
    renderFailure(root, {
      error: "could not save: quota exceeded",
      replaySentence: null,
      captureSentence: null,
      runsRoute: {
        takeId: "t1",
        authored: false,
        rerun: {
          kind: "link" as const,
          href: runsHref("t1"),
          label: runsRouteLabel(false),
        },
      },
    });
    // Premise: the box rendered something.
    expect(root.querySelector("[data-action-error]")).not.toBeNull();
    expect(root.querySelector("[data-runs-route]")).toBeNull();
  });

  // "offers no retry when the policy has withheld the sentence" and "calls
  // onRegenerate when the retry button is clicked" retired with Task 10:
  // `renderFailure`'s retry button is gone (spec §2 — the export's own
  // rebuild-failure row is the one way to start a rebuild now). Covered by
  // absence instead: `editor-main-render-mode.test.ts`'s "still says why
  // the last re-shoot stopped" asserts `replaySentence` renders in
  // `#failure` with no button beside it.

  // Fix wave, item 2. `RECOVERABLE` is what keeps a non-breakage from
  // reading as breakage, and the headline sat outside it: a cancel the
  // author chose was announced as "did not finish".
  it("does not headline a recoverable stop as a failure", () => {
    renderFailure(root, {
      error: null,
      replaySentence:
        "The re-shoot reconstructed 0 of 12 steps and stopped early: you cancelled before it started.",
      replayRecoverable: true,
      captureSentence: null,
    });
    const box = root.querySelector("[data-replay-failure]");
    expect(box?.textContent).not.toContain("did not finish");
    // A re-shoot on the run page is what writes this status since plan 2's
    // Task 7, and the editor has no rebuild to name.
    expect(box?.querySelector("strong")?.textContent).toBe(
      "The last re-shoot stopped early",
    );
  });

  it("still headlines a real breakage as one", () => {
    renderFailure(root, {
      error: null,
      replaySentence:
        "The re-shoot reconstructed 1 of 3 steps then stopped: an element this demo depends on is no longer on the page.",
      replayRecoverable: false,
      captureSentence: null,
    });
    expect(
      root.querySelector("[data-replay-failure] strong")?.textContent,
    ).toBe("The last re-shoot did not finish");
  });

  // A script run that stopped partway is stored under the same status a
  // re-shoot writes, and opens in the editor under this box. The headline,
  // the sentence and the Runs link have to say one thing. The sentence comes
  // from the real `replaySentence`, so the whole box is asserted. Goes red if
  // the headline stops reading `runsRoute.authored`.
  it("names a stopped script run as one, with no re-shoot anywhere in the box", () => {
    const status = (recoverable: boolean) => ({
      outcome: "partial" as const,
      reason: recoverable ? "pageFaulted" : "unresolvedAnchor",
      completed: 1,
      total: 3,
    });
    for (const recoverable of [true, false]) {
      const scene = authoredScene(readonlyScene());
      const sentence = replaySentence(
        status(recoverable),
        { mayReplay: true },
        scene,
      );
      // Premise: the sentence is one the author reads, not the null a
      // refusing policy would return.
      expect(sentence).not.toBeNull();
      renderFailure(root, {
        error: null,
        replaySentence: sentence,
        replayRecoverable: recoverable,
        captureSentence: null,
        runsRoute: {
          takeId: "t1",
          authored: true,
          rerun: {
            kind: "link" as const,
            href: runsHref("t1"),
            label: runsRouteLabel(true),
          },
        },
      });
      const box = root.querySelector("[data-replay-failure]");
      expect(box?.querySelector("strong")?.textContent).toBe(
        recoverable
          ? "The last script run stopped early"
          : "The last script run did not finish",
      );
      expect(box?.textContent).toContain(
        "The script run performed 1 of 3 steps",
      );
      expect(box?.textContent).toContain("Run its script again in Runs");
      expect(box?.textContent).not.toMatch(/re-shoot/i);
    }
  });

  it("keeps the re-shoot headline for a recorded take with the same status", () => {
    renderFailure(root, {
      error: null,
      replaySentence: replaySentence(
        {
          outcome: "partial",
          reason: "unresolvedAnchor",
          completed: 1,
          total: 3,
        },
        { mayReplay: true },
        readonlyScene(),
      ),
      replayRecoverable: false,
      captureSentence: null,
      runsRoute: {
        takeId: "t1",
        authored: false,
        rerun: {
          kind: "link" as const,
          href: runsHref("t1"),
          label: runsRouteLabel(false),
        },
      },
    });
    const box = root.querySelector("[data-replay-failure]");
    expect(box?.querySelector("strong")?.textContent).toBe(
      "The last re-shoot did not finish",
    );
    expect(box?.textContent).toContain(
      "The re-shoot reconstructed 1 of 3 steps",
    );
    expect(box?.textContent).toContain("Re-shoot this video in Runs");
  });

  it("renders the action error when present", () => {
    renderFailure(root, {
      error: "could not save: quota exceeded",
      replaySentence: null,
      captureSentence: null,
    });
    expect(root.querySelector("[data-action-error]")).not.toBeNull();
    expect(root.textContent).toContain("could not save: quota exceeded");
    expect(root.querySelector("[data-replay-failure]")).toBeNull();
  });

  it("renders both, replay sentence before action error, when both are present", () => {
    renderFailure(root, {
      error: "could not save: quota exceeded",
      replaySentence:
        "The re-shoot reconstructed 0 of 4 steps, then stopped: x.",
      captureSentence: null,
    });
    const failureBox = root.querySelector("[data-replay-failure]");
    const errorBox = root.querySelector("[data-action-error]");
    expect(failureBox).not.toBeNull();
    expect(errorBox).not.toBeNull();
    // Both live under `root` as siblings in DOM order — replay first.
    expect(failureBox?.compareDocumentPosition(errorBox as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("says so when the export never started", () => {
    // `background.ts` resolves `{ ok: false }` on failure, so a refused
    // `render:start` sends no progress message at all. The button goes back
    // to "Export landscape video"; without this sentence the author is left
    // with a control that declined once and said nothing.
    renderFailure(root, {
      error: null,
      replaySentence: null,
      renderError: "offscreen document could not be created",
      captureSentence: null,
    });
    expect(root.querySelector("[data-render-error]")).not.toBeNull();
    // The heading names the action the author took. "Render" is the retired
    // verb for the encode as of 2026-09-14, and this box is the one place
    // the refusal is ever spoken.
    expect(root.querySelector("[data-render-error]")?.textContent).toContain(
      "The export did not start",
    );
    expect(root.textContent).toContain("offscreen document");
    expect(root.querySelector("[data-action-error]")).toBeNull();
  });

  it("says so when the preview could not draw the frame", () => {
    // Playback's own failure. The scrubber forgives a failed draw so a
    // regeneration does not wedge it, which under play leaves a frozen canvas
    // and a clock still counting -- success and failure drawn identically.
    renderFailure(root, {
      error: null,
      replaySentence: null,
      renderError: null,
      captureSentence: null,
      previewError: "frame 00312 is missing from this bundle",
    });
    expect(root.querySelector("[data-preview-error]")).not.toBeNull();
    expect(root.textContent).toContain("frame 00312");
  });

  it("says nothing about the preview when it drew fine", () => {
    renderFailure(root, {
      error: null,
      replaySentence: null,
      renderError: null,
      captureSentence: null,
      previewError: null,
    });
    expect(root.querySelector("[data-preview-error]")).toBeNull();
  });

  it("keeps a failed render distinct from a failed edit", () => {
    // Two different things went wrong and the author is owed both: one is
    // about the export, the other about the edit before it.
    renderFailure(root, {
      error: "could not save: quota exceeded",
      replaySentence: null,
      renderError: "offscreen document could not be created",
      captureSentence: null,
    });
    expect(root.querySelector("[data-render-error]")).not.toBeNull();
    expect(root.querySelector("[data-action-error]")).not.toBeNull();
  });

  // "calls onRegenerate when the retry button is clicked" retired with
  // Task 10 — see the note above "renders the replay sentence".

  it("renders the capture sentence as its own line", () => {
    renderFailure(root, {
      error: null,
      replaySentence: null,
      captureSentence:
        "the recording of on-screen motion could not be started, so this scene has only the stills taken at each step",
    });
    expect(root.querySelector("[data-capture-note]")).not.toBeNull();
    expect(root.textContent).toContain("could not be started");
  });

  it("says nothing about the capture when it is null", () => {
    renderFailure(root, {
      error: null,
      replaySentence: null,
      captureSentence: null,
    });
    expect(root.querySelector("[data-capture-note]")).toBeNull();
  });

  // The two sentences are different facts — a replay sentence about why a
  // regeneration stopped, a capture sentence about what the take itself
  // recorded — and both can be true at once. Rendering the capture sentence
  // inside the replay box, or interpolating it into the same string, would
  // make this test pass with either sentence garbling the other; keeping
  // them in separate DOM nodes is what this actually asserts.
  it("renders the replay sentence and the capture sentence as separate lines, never concatenated", () => {
    renderFailure(root, {
      error: null,
      replaySentence:
        "The re-shoot reconstructed 0 of 4 steps, then stopped: x.",
      captureSentence:
        "the recording of on-screen motion could not be started, so this scene has only the stills taken at each step",
    });
    const replayBox = root.querySelector("[data-replay-failure]");
    const captureBox = root.querySelector("[data-capture-note]");
    expect(replayBox).not.toBeNull();
    expect(captureBox).not.toBeNull();
    expect(replayBox).not.toBe(captureBox);
    expect(replayBox?.textContent).not.toContain("could not be started");
    expect(captureBox?.textContent).not.toContain("The re-shoot reconstructed");
  });

  // The capture sentence describes the take, not a regeneration, so it must
  // speak on its own — a fresh bundle whose take nonetheless lost motion is
  // exactly this case.
  it("renders the capture sentence even when there is no replay sentence to go beside", () => {
    renderFailure(root, {
      error: null,
      replaySentence: null,
      captureSentence:
        "the motion recorded during the take could not be encoded, so this scene has only the stills taken at each step",
    });
    expect(root.querySelector("[data-replay-failure]")).toBeNull();
    expect(root.querySelector("[data-capture-note]")).not.toBeNull();
  });

  // "gives a route that cannot land its own box" retired with Task 10:
  // `renderFailure`'s `routeError` field and `[data-route-error]` box are
  // gone. A route that could not land wrote into the surface it was
  // pressed from — the export's rebuild-failure row — never in `#failure`;
  // that row and its routes left the editor with plan 2's Task 7.
});

describe("renderTransport", () => {
  const state = {
    playing: false,
    enabled: true,
    rate: 1,
    looping: false,
    authored: false,
  };

  const playButton = () =>
    root.querySelector("[data-transport-play]") as HTMLButtonElement;
  const skipButton = () =>
    root.querySelector("[data-transport-skip]") as HTMLButtonElement;
  const glyphOf = (button: HTMLElement) =>
    button.querySelector("svg")?.getAttribute("data-icon");

  // The author, 2026-10-19: Play names itself and Space in the drawn
  // tooltip; a disabled Play keeps its native title, the sentence saying
  // why (the case below). Red: leave Play's `title` in place, or drop its key.
  it("names Play, or Pause, and Space in its tooltip", () => {
    const handlers = {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    };
    const play = () =>
      root.querySelector("[data-transport-play]") as HTMLButtonElement;
    renderTransport(root, state, handlers);
    expect([play().dataset.tip, play().dataset.tipKeys]).toEqual([
      "Play",
      "Space",
    ]);
    expect(play().hasAttribute("title")).toBe(false);
    renderTransport(root, { ...state, playing: true }, handlers);
    expect(play().dataset.tip).toBe("Pause");
    renderTransport(root, { ...state, enabled: false }, handlers);
    expect(play().dataset.tip).toBeUndefined();
    expect(play().title).toMatch(/frames/i);
  });

  // The rest of the row a key also works: J, L and ⌘←, as caps, and a native
  // title once disabled. Red: put any of them back on `title` with the key in
  // parentheses, or drop its key.
  it("names J, L and Mod-Left on the rest of the row", () => {
    const handlers = {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    };
    const tips = () =>
      [
        ...root.querySelectorAll<HTMLButtonElement>(
          "[data-transport-skip], [data-transport-shuttle]",
        ),
      ].map((b) => [b.dataset.tip, b.dataset.tipKeys, b.hasAttribute("title")]);
    renderTransport(root, state, handlers);
    expect(tips()).toEqual([
      ["Jump to start", "Mod Left", false],
      ["Rewind", "J", false],
      ["Fast forward", "L", false],
    ]);
    renderTransport(root, { ...state, enabled: false }, handlers);
    expect(tips()).toEqual([
      [undefined, undefined, true],
      [undefined, undefined, true],
      [undefined, undefined, true],
    ]);
  });

  it("heads the row with a jump to the start, ahead of the rate controls", () => {
    // Order, because it is the whole of what "next to the rewind button"
    // asked for and nothing else here asserts it: the controls that move
    // the take at a RATE sit together, and the one that jumps to a fixed
    // instant sits before them.
    const handlers = {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    };
    renderTransport(root, state, handlers);
    const order = [
      ...root.querySelectorAll<HTMLElement>("[data-transport-controls] button"),
    ].map((b) =>
      b.hasAttribute("data-transport-skip")
        ? "skip"
        : b.hasAttribute("data-transport-play")
          ? "play"
          : b.hasAttribute("data-transport-repeat")
            ? "repeat"
            : `shuttle${b.dataset.transportShuttle}`,
    );
    expect(order).toEqual(["skip", "shuttle-1", "play", "shuttle1", "repeat"]);
    // It runs the handler rather than seeking on its own — `main.ts` sends
    // it through the same dispatcher \u2318\u2190 uses, so the two cannot come to
    // mean different instants.
    skipButton().click();
    expect(handlers.onSkipToStart).toHaveBeenCalledTimes(1);
    // And it is drawn, not empty: the name is on the button and the glyph
    // inside it, the same split every control in this row uses.
    expect(glyphOf(skipButton())).toBe("skipBack");
    expect(skipButton().getAttribute("aria-label")).toMatch(/start/i);
    expect(skipButton().textContent).toBe("");
  });

  it("says why the jump to start is dead rather than grumbling in silence", () => {
    const handlers = {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    };
    renderTransport(root, { ...state, enabled: false }, handlers);
    expect(skipButton().disabled).toBe(true);
    expect(skipButton().title).toMatch(/no frames yet/i);
    // Where frames come from now: the editor has no rebuild to name.
    expect(skipButton().title).toMatch(/Re-shoot it in Runs first\.$/);
    // An authored take cannot be re-shot; its route is its script. Goes red
    // if the row stops reading `state.authored`.
    renderTransport(
      root,
      { ...state, enabled: false, authored: true },
      handlers,
    );
    expect(skipButton().title).toMatch(/Run its script again in Runs first\.$/);
    expect(playButton().title).toMatch(/Run its script again in Runs first\.$/);
    expect(`${skipButton().title}${playButton().title}`).not.toMatch(
      /re-shoot/i,
    );
    renderTransport(root, { ...state, enabled: false }, handlers);
    expect(playButton().title).toMatch(/Re-shoot it in Runs first\.$/);
    // Both states, because a control that is always disabled satisfies the
    // case above without the reason meaning anything.
    renderTransport(root, state, handlers);
    expect(skipButton().disabled).toBe(false);
    expect(skipButton().title).not.toMatch(/no frames yet/i);
  });

  /* The word went when the glyph arrived (2026-09-20), so these used to
     read `textContent`. The claim is unchanged — the control has to report
     the state it is actually in — but the name now lives ONLY in
     `aria-label`, which makes asserting it more important than before, not
     less: a stuck label is invisible to everyone reading the button rather
     than looking at it. Both the name and the picture are checked, because
     either alone can go stale while the other is right. */
  it("names and draws itself Play when the demo is not playing", () => {
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    const play = playButton();
    expect(play).not.toBeNull();
    expect(play.getAttribute("aria-label")).toBe("Play");
    expect(glyphOf(play)).toBe("play");
    // No words: the control is an icon button now, and a button carrying
    // both would say the same thing twice.
    expect(play.textContent).toBe("");
    expect(play.disabled).toBe(false);
  });

  it("names and draws itself Pause once it is playing", () => {
    // A button stuck on "Play" while frames advance is the same defect in
    // miniature: the page saying one thing while doing another.
    renderTransport(
      root,
      { ...state, playing: true },
      {
        onToggle: vi.fn(),
        onShuttle: vi.fn(),
        onLooping: vi.fn(),
        onSkipToStart: vi.fn(),
      },
    );
    const play = playButton();
    expect(play.getAttribute("aria-label")).toBe("Pause");
    expect(glyphOf(play)).toBe("pause");
    expect(play.textContent).toBe("");
  });

  it("swaps the glyph back when playback stops", () => {
    // The row is redrawn every animation frame and the button is reused
    // across renders, so the swap is guarded on the glyph already showing.
    // A guard that compared the wrong thing would leave a pause icon on a
    // stopped take — the state above passes whether or not the guard works,
    // because it only ever renders once.
    renderTransport(
      root,
      { ...state, playing: true },
      {
        onToggle: vi.fn(),
        onShuttle: vi.fn(),
        onLooping: vi.fn(),
        onSkipToStart: vi.fn(),
      },
    );
    expect(glyphOf(playButton())).toBe("pause");
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    expect(glyphOf(playButton())).toBe("play");
    expect(playButton().getAttribute("aria-label")).toBe("Play");
  });

  it("shuttles backwards and forwards from the pair either side of play", () => {
    const onShuttle = vi.fn();
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle,
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    const buttons = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-transport-shuttle]"),
    ];
    // Fixture guard: two of them, or the clicks below reach nothing and the
    // call count is satisfied by an empty list.
    expect(buttons).toHaveLength(2);
    // Rewind and fast-forward, NOT skip: each press doubles the rate in one
    // direction (`Player.shuttle`), which is what those glyphs mean. Jumping
    // to head or tail is `seekEdge`, a different command.
    expect(
      buttons.map((b) => b.getAttribute("data-icon") ?? glyphOf(b)),
    ).toEqual(["rewind", "fastForward"]);
    buttons[0]?.click();
    buttons[1]?.click();
    expect(onShuttle.mock.calls).toEqual([[-1], [1]]);
    // Named, since they carry no words either.
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Rewind",
      "Fast forward",
    ]);
  });

  it("marks the button with the state its icon draws, both ways", () => {
    // The stylesheet draws the glyph off this attribute, so a Play that keeps
    // `data-playing` from the previous frame would show a pause icon beside
    // the word "Play".
    renderTransport(
      root,
      { ...state, playing: true },
      {
        onToggle: vi.fn(),
        onShuttle: vi.fn(),
        onLooping: vi.fn(),
        onSkipToStart: vi.fn(),
      },
    );
    const play = root.querySelector(
      "[data-transport-play]",
    ) as HTMLButtonElement;
    expect(play.hasAttribute("data-playing")).toBe(true);
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    expect(play.hasAttribute("data-playing")).toBe(false);
  });

  it("toggles on click", () => {
    const onToggle = vi.fn();
    renderTransport(root, state, {
      onToggle,
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    (root.querySelector("[data-transport-play]") as HTMLButtonElement).click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("disables the transport, and says why, when there are no frames", () => {
    // A live Play button over a bundle-less scene starts a clock across a
    // grey placeholder. Disabled alone reads as a broken editor, so the
    // reason is on the control itself.
    renderTransport(
      root,
      { ...state, enabled: false },
      {
        onToggle: vi.fn(),
        onShuttle: vi.fn(),
        onLooping: vi.fn(),
        onSkipToStart: vi.fn(),
      },
    );
    const play = root.querySelector(
      "[data-transport-play]",
    ) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    expect(play.title).toMatch(/frames/i);
  });

  // The other half of `renderStageBar`'s "not in the transport" claim.
  // `[data-transport-time]` takes the FIRST document-order match in the
  // real page, and `#stage-bar` (inside `<main>`, which holds `#stage`)
  // precedes `#dock` — a sibling `<section>` AFTER `<main>`, not nested
  // under it — so a clock re-added here would be invisible to every
  // browser test that reads the selector; this is the guard that would
  // actually catch it.
  it("never rebuilds the clock the transport used to carry", () => {
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    // Fixture guard: this must know the renderer actually ran, or a no-op
    // `renderTransport` would satisfy "never rebuilds the clock" by never
    // building anything at all.
    expect(
      root.querySelector("[data-transport-play]"),
      "renderTransport did not run",
    ).not.toBeNull();
    expect(root.querySelector("[data-transport-time]")).toBeNull();
  });
});

describe("renderStageBar", () => {
  const stageState = () => ({
    positionMs: 0,
    durationMs: 12_000,
    aspect: "16:9" as const,
    enabled: true,
    fullscreen: false,
    error: null,
    zoom: "fit" as const,
    authored: false,
  });
  const stageHandlers = () => ({
    onAspect: vi.fn(),
    onFullscreen: vi.fn(),
    onZoom: vi.fn(),
    onDismissError: vi.fn(),
  });

  it("draws no approximations chip or popover", () => {
    const bar = document.createElement("div");
    renderStageBar(bar, stageState(), stageHandlers());
    // Premise: the bar really was drawn, or the absence below is vacuous.
    expect(bar.querySelector("[data-transport-time]")).not.toBeNull();
    expect(bar.querySelector("[data-aspect-toggle]")).not.toBeNull();
    expect(
      bar.querySelector("[data-approximations], [data-approximations-popover]"),
    ).toBeNull();
  });

  it("counts the clock on the stage bar, not in the transport", () => {
    const bar = document.createElement("div");
    renderStageBar(
      bar,
      {
        authored: false,
        positionMs: 3_000,
        durationMs: 12_000,
        aspect: "16:9",
        enabled: true,
        fullscreen: false,
        error: null,
        zoom: "fit",
      },
      stageHandlers(),
    );
    expect(bar.querySelector("[data-transport-time]")?.textContent).toBe(
      "0:03 / 0:12",
    );
  });

  it("offers the three shapes, Auto first, checked from the state", () => {
    const bar = document.createElement("div");
    renderStageBar(bar, { ...stageState(), aspect: "auto" }, stageHandlers());
    const toggle = bar.querySelector("[data-aspect-toggle]");
    expect(toggle?.getAttribute("role")).toBe("radiogroup");
    expect(toggle?.getAttribute("aria-label")).toBe("Aspect ratio");
    const buttons = [
      ...bar.querySelectorAll<HTMLButtonElement>("[data-aspect]"),
    ];
    // Fixture guard: three labelled buttons, or the checked-state assertion
    // below passes over an empty group.
    expect(buttons.map((b) => [b.dataset.aspect, b.textContent])).toEqual([
      ["auto", "Auto"],
      ["16:9", "16:9"],
      ["9:16", "9:16"],
    ]);
    expect(buttons.map((b) => b.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(buttons[0]?.title).toBe("Auto: the export takes the source's shape");
    expect(bar.querySelector("[data-format-select]")).toBeNull();
  });

  it("reports the picked aspect once per press, across redraws", () => {
    const bar = document.createElement("div");
    const handlers = stageHandlers();
    renderStageBar(bar, stageState(), handlers);
    bar.querySelector<HTMLButtonElement>('[data-aspect="9:16"]')?.click();
    // Redrawn (the animation frame this row repaints on), then pressed
    // again: a handler assigned rather than added cannot stack.
    renderStageBar(bar, { ...stageState(), aspect: "9:16" }, handlers);
    bar.querySelector<HTMLButtonElement>('[data-aspect="16:9"]')?.click();
    bar.querySelector<HTMLButtonElement>('[data-aspect="auto"]')?.click();
    expect(vi.mocked(handlers.onAspect).mock.calls).toEqual([
      ["9:16"],
      ["16:9"],
      ["auto"],
    ]);
    expect(handlers.onAspect).toHaveBeenLastCalledWith("auto");
  });

  it("names the full-screen control from the state it is in, not the press", () => {
    const bar = document.createElement("div");
    const base = {
      positionMs: 0,
      durationMs: 12_000,
      aspect: "16:9" as const,
      enabled: true,
      error: null,
      zoom: "fit" as const,
    };
    const handlers = {
      onAspect: vi.fn(),
      onFullscreen: vi.fn(),
      onZoom: vi.fn(),
      onDismissError: vi.fn(),
    };
    renderStageBar(
      bar,
      { authored: false, ...base, fullscreen: false },
      handlers,
    );
    const button = bar.querySelector<HTMLButtonElement>(
      "[data-stage-fullscreen]",
    ) as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("Full screen");
    expect(button.firstElementChild?.getAttribute("data-icon")).toBe(
      "maximize",
    );
    // Pressing it does NOT change the label. The label follows the
    // document's own state, so a request that was refused cannot leave the
    // control claiming an outcome that never happened.
    button.click();
    expect(button.getAttribute("aria-label")).toBe("Full screen");
    renderStageBar(
      bar,
      { authored: false, ...base, fullscreen: true },
      handlers,
    );
    expect(button.getAttribute("aria-label")).toBe("Exit full screen");
    expect(button.firstElementChild?.getAttribute("data-icon")).toBe(
      "minimize",
    );
    expect(handlers.onFullscreen).toHaveBeenCalledTimes(1);
    // The same shape the aspect toggle's own "assigned, not added" test has
    // (above): a click AFTER a second render, which only an assignment
    // (never an `addEventListener`) can survive without stacking. Without
    // this the first `button.click()` above is the only click this test
    // makes, and a regression to `addEventListener` would still read as one
    // call.
    button.click();
    expect(handlers.onFullscreen).toHaveBeenCalledTimes(2);
  });

  it("shows a refusal on the well itself, since #failure is invisible while full screen", () => {
    const bar = document.createElement("div");
    // `fullscreen: true` — the document is still full screen — is exactly
    // the state an EXIT refusal leaves behind (a request refusal never
    // gets this far: the document never left `fullscreen: false`). So the
    // error this fixture carries has to be the exit branch's own wording,
    // not the entry branch's — see `main.ts`'s `toggleFullscreen`.
    const base = {
      positionMs: 0,
      durationMs: 12_000,
      aspect: "16:9" as const,
      enabled: true,
      fullscreen: true,
      zoom: "fit" as const,
    };
    const handlers = {
      onAspect: vi.fn(),
      onFullscreen: vi.fn(),
      onZoom: vi.fn(),
      onDismissError: vi.fn(),
    };
    renderStageBar(bar, { authored: false, ...base, error: null }, handlers);
    const error = bar.querySelector<HTMLElement>(
      "[data-stage-error]",
    ) as HTMLElement;
    expect(error.hidden).toBe(true);
    renderStageBar(
      bar,
      {
        authored: false,
        ...base,
        error: "The preview could not exit full screen: refused",
      },
      handlers,
    );
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(
      "The preview could not exit full screen: refused",
    );
    // Clears as well as sets — a stale refusal left behind after the state
    // actually resolves would go on claiming a problem that is over.
    renderStageBar(bar, { authored: false, ...base, error: null }, handlers);
    expect(error.hidden).toBe(true);
  });

  it("says why the zoom is unavailable rather than greying out in silence", () => {
    const bar = document.createElement("div");
    renderStageBar(
      bar,
      {
        authored: false,
        positionMs: 0,
        durationMs: 0,
        aspect: "16:9",
        enabled: false,
        fullscreen: false,
        error: null,
        zoom: "fit",
      },
      stageHandlers(),
    );
    const zoom = bar.querySelector<HTMLButtonElement>(
      "[data-stage-zoom]",
    ) as HTMLButtonElement;
    expect(zoom.disabled).toBe(true);
    expect(zoom.title).toMatch(/no frames yet/);
    expect(zoom.title).toMatch(/Re-shoot it in Runs first\.$/);
    // The same chip on an authored take. Goes red if the bar stops reading
    // `state.authored`.
    renderStageBar(
      bar,
      { ...stageState(), enabled: false, authored: true },
      stageHandlers(),
    );
    expect(zoom.title).toMatch(/Run its script again in Runs first\.$/);
    expect(zoom.title).not.toMatch(/re-shoot/i);
  });

  it("reads Fit and 100% from state, not from the last click", () => {
    const bar = document.createElement("div");
    const onZoom = vi.fn();
    const base = {
      positionMs: 0,
      durationMs: 12_000,
      aspect: "16:9" as const,
      enabled: true,
      fullscreen: false,
      error: null,
    };
    renderStageBar(
      bar,
      { authored: false, ...base, zoom: "fit" },
      { ...stageHandlers(), onAspect: vi.fn(), onFullscreen: vi.fn(), onZoom },
    );
    const zoom = bar.querySelector<HTMLButtonElement>(
      "[data-stage-zoom]",
    ) as HTMLButtonElement;
    expect(zoom.textContent).toBe("Fit");
    expect(zoom.disabled).toBe(false);
    // Pressing it does not itself change the label — same rule the
    // full-screen chip follows — a click only calls the handler; `main.ts`
    // is what decides whether the state actually moved.
    zoom.click();
    expect(zoom.textContent).toBe("Fit");
    expect(onZoom).toHaveBeenCalledTimes(1);
    renderStageBar(
      bar,
      { authored: false, ...base, zoom: "actual" },
      { ...stageHandlers(), onAspect: vi.fn(), onFullscreen: vi.fn(), onZoom },
    );
    expect(zoom.textContent).toBe("100%");
  });
});

describe("renderTransport across renders", () => {
  const state = {
    playing: false,
    enabled: true,
    rate: 1,
    looping: false,
    authored: false,
  };

  it("keeps the same button, so playing does not blur it every frame", () => {
    // This row is redrawn once per animation frame while playing. Rebuilding
    // the button there would drop focus the instant the author pressed it —
    // and take the tab order back to the top of the page sixty times a
    // second.
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    const first = root.querySelector("[data-transport-play]");
    renderTransport(
      root,
      { ...state, playing: true },
      {
        onToggle: vi.fn(),
        onShuttle: vi.fn(),
        onLooping: vi.fn(),
        onSkipToStart: vi.fn(),
      },
    );
    expect(root.querySelector("[data-transport-play]")).toBe(first);
    // And the SAME element actually took the new state. Identity alone is
    // satisfied by a row that never updated at all, which is the opposite
    // failure and just as wrong. This read `textContent` until the word was
    // replaced by a glyph on 2026-09-20.
    expect(first?.getAttribute("aria-label")).toBe("Pause");
    expect(first?.querySelector("svg")?.getAttribute("data-icon")).toBe(
      "pause",
    );
  });

  it("fires the toggle once per click after many renders", () => {
    // The other half: reusing the element must not stack a listener on every
    // redraw, or one click would toggle playback as many times as the row had
    // been drawn. A distinct closure per render, because that is what a
    // caller building its handlers inline actually passes — an identical
    // function reference would be de-duplicated by addEventListener itself
    // and this test would pass with or without the fix.
    const onToggle = vi.fn();
    for (let i = 0; i < 5; i++) {
      renderTransport(root, state, {
        onToggle: () => onToggle(),
        onShuttle: vi.fn(),
        onLooping: vi.fn(),
        onSkipToStart: vi.fn(),
      });
    }
    (root.querySelector("[data-transport-play]") as HTMLButtonElement).click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("stops offering a demo with no frames even after it once had them", () => {
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    renderTransport(
      root,
      { ...state, enabled: false },
      {
        onToggle: vi.fn(),
        onShuttle: vi.fn(),
        onLooping: vi.fn(),
        onSkipToStart: vi.fn(),
      },
    );
    const play = root.querySelector(
      "[data-transport-play]",
    ) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    expect(play.title).toMatch(/frames/i);
  });

  it("stays on the same .transport-controls across ordinary repeated renders", () => {
    // What this actually proves: the build-once guard does not needlessly
    // rebuild when nothing is missing — three ordinary renders in a row
    // never even reach the `root.append(controls)` branch a second time,
    // because `play`, `rate` and `controls` are all found on renders after
    // the first. It does NOT prove `append` is safe when the guard's three
    // checks disagree with each other (one element missing, the rest
    // present) — that is a different claim, covered separately below by
    // "keeps exactly one .transport-controls when only part of it survives
    // a render".
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    renderTransport(
      root,
      { ...state, playing: true },
      {
        onToggle: vi.fn(),
        onShuttle: vi.fn(),
        onLooping: vi.fn(),
        onSkipToStart: vi.fn(),
      },
    );
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    expect(root.querySelectorAll("[data-transport-controls]").length).toBe(1);
  });

  it("keeps exactly one .transport-controls when only part of it survives a render", () => {
    // The build-once guard (`play === null || rate === null || controls ===
    // null`) decides whether to rebuild, and `root.append`s the result — not
    // `root.replaceChildren`, which was retired specifically so a static
    // `#timeline-tools` sibling on the real `#transport` survives the
    // redraw (see the comment above that call in `view.ts`). `append` does
    // not self-heal the way `replaceChildren` did: if the DOM this guard
    // reads ever disagrees with itself — `.transport-controls` still there,
    // but one of the elements INSIDE it gone (the rate badge, say, removed
    // by something else entirely) — the guard sees a null and rebuilds,
    // appending a second `.transport-controls` beside the first rather than
    // replacing it. Both would carry the same `grid-column` and stack
    // silently: `querySelector` (first match) is what every other test in
    // this file, and the browser layout tests, read the row through, so a
    // duplicate would not otherwise surface.
    //
    // This is not synthetic: it is the literal DOM state a stray removal of
    // just the rate badge leaves behind, reproduced directly rather than by
    // weakening the guard (which a plain repeated-render test, above,
    // cannot distinguish from a correct guard — the three elements only
    // ever move in and out of the DOM together under ordinary use).
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    root.querySelector("[data-transport-rate]")?.remove();
    renderTransport(root, state, {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    });
    expect(root.querySelectorAll("[data-transport-controls]").length).toBe(1);
  });
});

/**
 * The `?` overlay's markup.
 *
 * Geometry and colour are the browser lane's (`editor-shortcuts-overlay`);
 * what only this can catch is the structure those assertions stand on — a
 * cap per key, a chord that cannot be split, and a close control with a name.
 */
/**
 * The row for a given chord, found by its KEYS rather than its words.
 *
 * The legend's copy is edited freely — it is the product's voice — and a
 * test that finds its row by a phrase goes red the next time someone
 * rewrites a line. The keys are the thing under test here anyway.
 */
const rowForChord = (root: HTMLElement, caps: string[]): HTMLElement => {
  const combo = [...root.querySelectorAll("[data-combo]")].find(
    (c) =>
      [...c.querySelectorAll("kbd")].map((k) => k.textContent).join(" ") ===
      caps.join(" "),
  );
  const row = combo?.closest("[data-shortcut-row]");
  if (row === null || row === undefined) {
    throw new Error(`no row whose keys are ${caps.join(" ")}`);
  }
  return row as HTMLElement;
};

/**
 * The editor header's controls, as icons.
 *
 * Same shape the Recordings page uses for Edit and Delete — `btn-icon`, a
 * Lucide glyph, and the name on the button rather than in it. An icon-only
 * control whose whole content is `aria-hidden` decoration reads as nothing
 * at all, so the `aria-label` is the thing being asserted here, not the
 * picture.
 */
describe("renderHeaderIcons", () => {
  const header = (): HTMLElement => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button id="undo" class="btn btn-quiet btn-icon" type="button"></button>
      <button id="redo" class="btn btn-quiet btn-icon" type="button"></button>
      <button id="delete" class="btn btn-quiet btn-icon btn-danger" type="button"></button>
      <button id="shortcuts-open" class="btn btn-quiet btn-icon" type="button"></button>
    `;
    renderHeaderIcons(root);
    return root;
  };

  it("gives each control a Lucide glyph", () => {
    const root = header();
    for (const [id, glyph] of [
      ["undo", "undo"],
      ["redo", "redo"],
      ["delete", "trash"],
      ["shortcuts-open", "circleQuestionMark"],
    ] as const) {
      const svg = root.querySelector(`#${id} svg`);
      expect({ id, icon: svg?.getAttribute("data-icon") }).toEqual({
        id,
        icon: glyph,
      });
    }
  });

  it("names every one of them, since none carries a word any more", () => {
    const root = header();
    for (const id of ["undo", "redo", "delete", "shortcuts-open"]) {
      const button = root.querySelector(`#${id}`) as HTMLElement;
      expect({ id, label: button.getAttribute("aria-label") }).toEqual({
        id,
        label: expect.stringMatching(/\w/),
      });
      // A pointer gets the same name as a reader: the drawn tooltip where
      // the control has a key (`tooltip.ts`), the native title otherwise.
      const pointerName = button.dataset.tip ?? button.title;
      expect({ id, pointerName }).toEqual({
        id,
        pointerName: button.getAttribute("aria-label"),
      });
      // And no stray text beside the glyph.
      expect(button.textContent?.trim()).toBe("");
    }
  });

  // The author, 2026-10-19: the controls a key also works teach the key in
  // their tooltip. Red: drop one from `HEADER_KEYS`.
  it("gives the keyed controls their keys, and no native title beside", () => {
    const root = header();
    const keys = Object.fromEntries(
      ["undo", "redo", "shortcuts-open", "delete"].map((id) => {
        const button = root.querySelector(`#${id}`) as HTMLElement;
        return [id, button.dataset.tipKeys ?? null];
      }),
    );
    expect(keys).toEqual({
      undo: "Mod Z",
      redo: "Shift Mod Z",
      "shortcuts-open": "?",
      delete: null,
    });
    expect(root.querySelector("#undo")?.hasAttribute("title")).toBe(false);
  });

  it("draws the glyph once however many times it runs", () => {
    // `render` is called on every edit; a control that accumulated a glyph
    // per render would stack sixteen of them in a session.
    const root = document.createElement("div");
    root.innerHTML = `<button id="undo" type="button"></button>
      <button id="redo" type="button"></button>
      <button id="delete" type="button"></button>
      <button id="shortcuts-open" type="button"></button>`;
    renderHeaderIcons(root);
    renderHeaderIcons(root);
    renderHeaderIcons(root);
    expect(root.querySelectorAll("#undo svg")).toHaveLength(1);
  });
});

describe("renderShortcuts", () => {
  // Drawn into the page so focus can be asked about; taken away after each.
  afterEach(() => document.body.replaceChildren());
  const open = (mac = true): HTMLElement => {
    const root = document.createElement("div");
    document.body.append(root);
    renderShortcuts(
      root,
      { mac, query: "", focus: true },
      { onClose: vi.fn(), onQuery: vi.fn() },
    );
    return root;
  };
  const SHIFT = "\u21e7";

  it("draws one cap per key, and keeps a chord in one group", () => {
    const root = open();
    const row = rowForChord(root, [SHIFT, "Z"]);
    const combos = row.querySelectorAll("[data-combo]");
    // One chord — ⇧ and Z together — not two alternatives.
    expect(combos).toHaveLength(1);
    const caps = combos[0]?.querySelectorAll("kbd");
    expect([...(caps ?? [])].map((c) => c.textContent)).toEqual([SHIFT, "Z"]);
  });

  it("splits alternatives into separate groups", () => {
    const root = open();
    const row = rowForChord(root, [SHIFT, "\u2190"]);
    // Two chords, each whole: ⇧← and ⇧→.
    const combos = [...row.querySelectorAll("[data-combo]")];
    expect(combos).toHaveLength(2);
    for (const combo of combos) {
      expect(combo.querySelectorAll("kbd")).toHaveLength(2);
    }
  });

  // The author, 2026-10-19: what it does on the left, its keys at the right
  // end. Red: put the keys first again.
  it("puts what a row does first, and its keys after", () => {
    const row = rowForChord(open(), [SHIFT, "Z"]);
    expect(row.firstElementChild?.textContent).toBe("Fit the whole video");
    expect(row.lastElementChild?.querySelector("[data-combo]")).not.toBeNull();
  });

  it("names the command key for the keyboard it is drawn for", () => {
    expect(open(true).textContent).toContain("\u2318");
    expect(open(true).textContent).not.toContain("Ctrl");
    expect(open(false).textContent).toContain("Ctrl");
  });

  it("says each chord out loud, since the caps carry no separator", () => {
    const row = rowForChord(open(), [SHIFT, "Z"]);
    const combo = row.querySelector("[data-combo]");
    expect(combo?.getAttribute("aria-label")).toBe("Shift plus Z");
    // ...and the caps inside it are then decoration, or a reader would say
    // the keys twice.
    for (const cap of row.querySelectorAll("kbd")) {
      expect(cap.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("writes each line for the keyboard it is drawn for", () => {
    // The redo line is the one that says something on one keyboard only.
    expect(open(true).textContent).not.toMatch(/Ctrl\+Y/);
    expect(open(false).textContent).toMatch(/Ctrl\+Y/);
  });

  describe("its search", () => {
    const type = (root: HTMLElement, text: string) => {
      const field = root.querySelector(
        "[data-shortcuts-search]",
      ) as HTMLInputElement;
      field.value = text;
      field.dispatchEvent(new Event("input"));
      return field;
    };
    const shown = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLElement>("[data-shortcut-row]")]
        .filter((r) => !r.hidden)
        .map((r) => r.firstElementChild?.textContent);

    it("opens ready to type into", () => {
      const root = open();
      expect(document.activeElement).toBe(
        root.querySelector("[data-shortcuts-search]"),
      );
    });

    // Red: drop the filter, and every row stays.
    it("keeps only the rows whose words match, and their group", () => {
      const root = open();
      // Premise: every row shows before anything is typed.
      expect(shown(root).length).toBeGreaterThan(10);
      type(root, "TRIM");
      expect(shown(root)).toEqual(["Trim start / end to playhead"]);
      const groups = [
        ...root.querySelectorAll<HTMLElement>(".shortcuts-section"),
      ].filter((g) => !g.hidden);
      expect(groups.map((g) => g.querySelector("h3")?.textContent)).toEqual([
        "Trim",
      ]);
    });

    it("keeps a whole group when its name matches", () => {
      const root = open();
      type(root, "editing");
      expect(shown(root)).toEqual([
        "Split at playhead",
        "Delete the selected piece, zoom or mask",
        "Undo",
        "Redo",
      ]);
    });

    // The list is redrawn with the inspector on every render; what was
    // typed is `main.ts`'s to keep. Red: stop reporting it, or stop drawing
    // from it.
    it("keeps what was typed across a redraw", () => {
      const root = document.createElement("div");
      document.body.append(root);
      const onQuery = vi.fn();
      renderShortcuts(
        root,
        { mac: true, query: "", focus: true },
        { onClose: vi.fn(), onQuery },
      );
      type(root, "undo");
      expect(onQuery).toHaveBeenLastCalledWith("undo");
      renderShortcuts(
        root,
        { mac: true, query: "undo", focus: false },
        { onClose: vi.fn(), onQuery },
      );
      const field = root.querySelector(
        "[data-shortcuts-search]",
      ) as HTMLInputElement;
      expect(field.value).toBe("undo");
      expect(shown(root)).toEqual(["Undo"]);
    });

    // Review 2026-10-19: a redraw rebuilt the field under the author's
    // typing, so the caret jumped to the end and an IME composition was
    // cancelled. Red: drop the already-drawn early return.
    it("leaves the field it drew, caret and all, when nothing changed", () => {
      const root = document.createElement("div");
      document.body.append(root);
      const onQuery = vi.fn();
      renderShortcuts(
        root,
        { mac: true, query: "", focus: true },
        { onClose: vi.fn(), onQuery },
      );
      type(root, "redo");
      const field = root.querySelector(
        "[data-shortcuts-search]",
      ) as HTMLInputElement;
      field.setSelectionRange(1, 1);
      // Premise: the field holds the focus and a caret mid-word.
      expect(document.activeElement).toBe(field);
      renderShortcuts(
        root,
        { mac: true, query: "redo", focus: true },
        { onClose: vi.fn(), onQuery },
      );
      expect(root.querySelector("[data-shortcuts-search]")).toBe(field);
      expect(field.selectionStart).toBe(1);
      expect(shown(root)).toEqual(["Redo"]);
      // A different query is a different list, and is drawn.
      renderShortcuts(
        root,
        { mac: true, query: "", focus: false },
        { onClose: vi.fn(), onQuery },
      );
      expect(root.querySelector("[data-shortcuts-search]")).not.toBe(field);
    });

    // A redraw that grabbed the focus would take the next key from the
    // editor — Space would type into the field. Red: focus on every draw.
    it("takes the focus only on the draw that opened it", () => {
      const elsewhere = document.createElement("button");
      document.body.append(elsewhere);
      elsewhere.focus();
      const root = document.createElement("div");
      document.body.append(root);
      renderShortcuts(
        root,
        { mac: true, query: "", focus: false },
        { onClose: vi.fn(), onQuery: vi.fn() },
      );
      expect(document.activeElement).toBe(elsewhere);
    });

    it("says so when nothing matches", () => {
      const root = open();
      const none = root.querySelector<HTMLElement>("[data-shortcuts-empty]");
      expect(none?.hidden).toBe(true);
      type(root, "zzz");
      expect(shown(root)).toEqual([]);
      expect(none?.hidden).toBe(false);
    });

    it("clears what was typed on Escape, then closes on the next", () => {
      const root = document.createElement("div");
      document.body.append(root);
      const onClose = vi.fn();
      renderShortcuts(
        root,
        { mac: true, query: "", focus: true },
        { onClose, onQuery: vi.fn() },
      );
      const field = type(root, "undo");
      const pressEscape = () =>
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      pressEscape();
      expect(field.value).toBe("");
      expect(shown(root).length).toBeGreaterThan(10);
      expect(onClose).not.toHaveBeenCalled();
      pressEscape();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * The take's warnings, in the status row.
 *
 * Ported from `editor-timeline-view.test.ts`'s `describe("the bar carries
 * the take's hover report")` when the report left the dock on 2026-09-22 —
 * see that file for what moved and the one case that was retired with the
 * mechanism it guarded.
 */
describe("renderTakeNotes", () => {
  let notes: HTMLElement;
  beforeEach(() => {
    notes = document.createElement("div");
  });

  it("draws nothing when the take has nothing wrong with it", () => {
    renderTakeNotes(notes, { notices: [], hoverReport: null });
    expect(notes.textContent).toBe("");
    expect(notes.querySelector("[data-take-notes]")).toBeNull();
  });

  // The batch that removed them left with step editing (spec 2026-10-22
  // split-tool); the sentence naming them stays, with nothing to press.
  it("names the unchanged hovers, and offers no removal", () => {
    const report: HoverReport = {
      removable: ["act-hover"],
      checked: 1,
      unchecked: 0,
      failed: false,
    };
    // Fixture guard: the sentence exists to be shown.
    expect(hoverReportText(report)).not.toBeNull();
    renderTakeNotes(notes, { notices: [], hoverReport: report });
    expect(notes.querySelector("[data-hover-report]")?.textContent).toContain(
      hoverReportText(report),
    );
    expect(notes.querySelector("button")).toBeNull();
  });

  it("carries the take's own notices, every one of them", () => {
    // Each sentence drawn, not just the first: `buildLaneModel` collects
    // one per degradation, and a card that showed only the head of the
    // list would hide exactly the takes with most wrong with them.
    const notices = [
      "Motion reclaimed to free space. Replay to restore.",
      "2 pauses could not be placed.",
    ];
    renderTakeNotes(notes, { notices, hoverReport: null });
    const drawn = [...notes.querySelectorAll("[data-take-notice]")].map(
      (n) => n.textContent,
    );
    expect(drawn).toEqual(notices);
  });

  it("clears itself once the take has nothing left to say", () => {
    // A card left behind from a previous render would describe a take that
    // has since been fixed — the shape this codebase keeps paying for.
    renderTakeNotes(notes, {
      notices: ["Motion reclaimed to free space. Replay to restore."],
      hoverReport: null,
    });
    expect(notes.querySelector("[data-take-notes]")).not.toBeNull();
    renderTakeNotes(notes, { notices: [], hoverReport: null });
    expect(notes.querySelector("[data-take-notes]")).toBeNull();
  });
});

describe("renderNotesButton", () => {
  function panel(): { button: HTMLElement; notes: HTMLElement } {
    document.body.innerHTML = `<button id="notes-open" class="hidden"></button>
      <div id="notes"><div id="banner"></div><div id="failure"></div>
      <div id="report"></div><div id="take-notes"></div></div>`;
    return {
      button: document.getElementById("notes-open") as HTMLElement,
      notes: document.getElementById("notes") as HTMLElement,
    };
  }
  const failure = (over: Record<string, unknown>) =>
    ({
      error: null,
      replaySentence: null,
      captureSentence: null,
      ...over,
    }) as never;

  it("stays hidden with nothing in the panel", () => {
    const { button, notes } = panel();
    renderNotesButton(button, notes);
    expect(button.classList.contains("hidden")).toBe(true);
    expect(button.hasAttribute("data-level")).toBe(false);
  });

  it("calls a failure an error, and counts it", () => {
    const { button, notes } = panel();
    renderFailure(
      notes.querySelector("#failure") as HTMLElement,
      failure({ replaySentence: "The re-shoot could not reach your app." }),
    );
    renderNotesButton(button, notes);
    expect(button.classList.contains("hidden")).toBe(false);
    expect(button.getAttribute("data-level")).toBe("error");
    expect(button.querySelector("[data-count]")?.textContent).toBe("1");
    expect(button.getAttribute("aria-label")).toBe(
      "1 note on this video, with an error",
    );
  });

  it("does not call the capture note an error", () => {
    const { button, notes } = panel();
    renderFailure(
      notes.querySelector("#failure") as HTMLElement,
      failure({ captureSentence: "Captured at 2x." }),
    );
    // Premise: the capture note is the one card drawn, inside #failure.
    expect(notes.querySelectorAll("#failure > .notice")).toHaveLength(1);
    expect(notes.querySelector("[data-capture-note]")).not.toBeNull();
    renderNotesButton(button, notes);
    expect(button.getAttribute("data-level")).toBe("warn");
  });
});

describe("revealNewErrors", () => {
  /** `#notes` with the popover API jsdom lacks: `showPopover` opens it,
   *  `close()` stands in for the author dismissing it. */
  function panel() {
    document.body.innerHTML = `<div id="notes"><div id="failure"></div>
      <div id="take-notes"></div></div>`;
    const notes = document.getElementById("notes") as HTMLElement;
    let open = false;
    const showPopover = vi.fn(() => {
      open = true;
    });
    notes.showPopover = showPopover;
    const matches = notes.matches.bind(notes);
    notes.matches = (selector: string) =>
      selector === ":popover-open" ? open : matches(selector);
    return {
      notes,
      showPopover,
      close: () => {
        open = false;
      },
      failure: notes.querySelector("#failure") as HTMLElement,
    };
  }
  const failure = (over: Record<string, unknown>) =>
    ({
      error: null,
      replaySentence: null,
      captureSentence: null,
      ...over,
    }) as never;

  it("opens the panel on an error, once per distinct error", () => {
    const { notes, showPopover, close, failure: box } = panel();
    let seen = revealNewErrors(notes, "");
    expect(showPopover).not.toHaveBeenCalled();

    renderFailure(box, failure({ error: "The export did not start." }));
    seen = revealNewErrors(notes, seen);
    expect(showPopover).toHaveBeenCalledTimes(1);

    // Dismissed, then repainted with the same error: left closed.
    close();
    seen = revealNewErrors(notes, seen);
    expect(showPopover).toHaveBeenCalledTimes(1);

    // A different error is news.
    renderFailure(box, failure({ error: "That edit did not go through." }));
    revealNewErrors(notes, seen);
    expect(showPopover).toHaveBeenCalledTimes(2);
  });

  it("leaves the panel shut for notes that are not errors", () => {
    const { notes, showPopover, failure: box } = panel();
    renderFailure(box, failure({ captureSentence: "Captured at 2x." }));
    renderTakeNotes(notes.querySelector("#take-notes") as HTMLElement, {
      notices: ["2 recorded pauses could not be placed."],
      hoverReport: null,
    });
    // Premise: both cards are drawn.
    expect(notes.querySelectorAll(".notice").length).toBeGreaterThanOrEqual(2);
    revealNewErrors(notes, "");
    expect(showPopover).not.toHaveBeenCalled();
  });
});
