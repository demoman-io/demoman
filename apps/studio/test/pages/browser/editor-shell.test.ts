import { LANDSCAPE_1440P, planScene, resolvePlan } from "@demoman/compositor";
import { page, userEvent } from "@vitest/browser/context";
import { afterAll, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
// The page's own markup and rules — the shell it links comes in through
// the helper — and the real renderers, so the surfaces measured are the
// ones the editor paints.
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import { renderInspector } from "../../../pages/entrypoints/editor/inspector";
import {
  renderExportDoor,
  renderRail,
} from "../../../pages/entrypoints/editor/rail";
import { renderTakeInfo } from "../../../pages/entrypoints/editor/take-info";
import {
  renderTimeline,
  renderTimelineTools,
} from "../../../pages/entrypoints/editor/timeline-view";
import {
  renderBranding,
  renderExport,
  renderFailure,
  renderHeaderIcons,
  renderStageBar,
  renderTransport,
} from "../../../pages/entrypoints/editor/view";
import { buildLaneModel } from "../../../pages/src/editor/lanes";
import { createSections } from "../../../pages/src/editor/sections";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import { fitAll } from "../../../pages/src/editor/viewport";
import { runsHref, runsRouteLabel } from "../../../pages/src/shell/runs-link";
import {
  contrast,
  ink,
  length,
  mountShell,
  node,
  over,
  parse,
  radius,
  surface,
  token,
} from "../helpers/shell-css";

/**
 * The editor's painted surface, in both themes.
 *
 * Restyled 2026-09-14 to close the polish run: the editor links the shell
 * stylesheet the popup, Recordings and Settings pages share, and keeps
 * inline only what is the editor's own — the stage well, the lane beds
 * and hues. The header is the site's lockup, every button the shell's
 * quiet control, Play and Export its lime primary, the status row its
 * notices, and the panel beside the 48px rail is sectioned with headings
 * and fields on the Settings page's pattern. Each of those is a claim
 * about what the page paints, so this mounts the shipped stylesheets and
 * the real renderers' output and reads computed style back.
 *
 * Retargeted 2026-09-14 (Task 10) onto the rail: one panel is drawn per
 * rail entry, so `mount` draws the Export entry into `#inspector` and the
 * Background entry beside it, and the four output checkboxes it used to
 * measure are one Export button now.
 */

const css = /<style>([\s\S]*?)<\/style>/.exec(shell)?.[1] ?? "";
const bodyHtml = (/<body>([\s\S]*?)<\/body>/.exec(shell)?.[1] ?? "").replace(
  /<script[\s\S]*?<\/script>/g,
  "",
);
if (!css.includes("#stage") || !bodyHtml.includes('id="timeline"')) {
  throw new Error("editor/index.html no longer carries the editor's shell");
}

/** Every handler a renderer asks for, answered with a spy. */
const handlers = () => new Proxy({}, { get: () => vi.fn() }) as never;

function mount(
  scheme: "light" | "dark",
  order: "source" | "build" = "source",
  selected = false,
) {
  mountShell(scheme, css, order);
  document.body.innerHTML = bodyHtml;
  // The header's glyphs, which the page fills in at boot. Mounted here
  // because the buttons ship EMPTY in `index.html` — without this the
  // shape and size assertions below measure bare boxes and say nothing
  // about what is drawn in them.
  renderHeaderIcons();

  const scene = readonlyScene();
  const bundle = proceduralBundle();
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const view = buildTimelineView({ scene, bundle, resolved });
  const model = buildLaneModel({
    scene,
    view,
    bundle,
    resolved,
    hoverReport: null,
  });
  const second = scene.actions[1];
  if (second === undefined) throw new Error("fixture scene has one action");
  const selection = selected
    ? ({ kind: "tick", actionId: second.id } as const)
    : null;
  const timelineState = {
    viewport: fitAll(model.durationMs),
    selection,
    positionMs: 2_000,
    refusal: null,
    snapping: true,
  };
  renderTimeline(node("#timeline"), model, timelineState, handlers());
  // `Snap` and `Fit` moved to `#transport` (`renderTimelineTools`);
  // `.fit`'s own check below reads the markup this mounts, so it has to be
  // drawn here too, not just `renderTimeline`'s lanes.
  renderTimelineTools(
    node("#timeline-tools"),
    model,
    timelineState,
    handlers(),
  );
  renderTransport(
    node("#transport"),
    { authored: false, playing: false, enabled: true, rate: 1, looping: false },
    handlers(),
  );
  const inspector = node("#inspector");
  // One state, read by both: the rail presses the entry whose panel the
  // inspector draws. A pair that disagreed here would let the rail test
  // pass against a panel nobody is looking at.
  const rail = selected ? ("selection" as const) : ("export" as const);
  const props = {
    selection,
    view,
    model,
    scene,
    hoverReport: null,
    viewport: scene.meta.capture.viewport,
    rail,
    sections: createSections(),
    attachedToCuts: [],
  };
  renderInspector(inspector, props, handlers());
  renderRail(
    node("#rail"),
    { rail, panelOpen: true, hasSelection: selected },
    handlers(),
  );
  renderExportDoor(
    node("#export-open") as HTMLButtonElement,
    { rail, panelOpen: true },
    handlers(),
  );
  if (!selected) {
    renderExport(
      node("[data-panel-export]"),
      {
        // One real output, so Share holds a real `.beat` row and Take info
        // (drawn below) a history row — a label beside a Download button,
        // the shape the layout test measures. With `outputs: []` there is
        // no row on the page to measure and the rule could go missing
        // unseen.
        outputs: [
          {
            kind: "stored" as const,
            output: {
              ref: "r1",
              name: "landscape.mp4",
              byteLength: 1024,
              contentType: "video/mp4",
              detailViolations: [],
              renderedAt: "2026-08-25T00:00:00.000Z",
            },
          },
        ],
        fileType: "mp4",
        aspect: "16:9",
        target: LANDSCAPE_1440P,
        recording: { width: 1280, height: 800 },
        durationMs: 24_000,
        run: { phase: "idle" },
        save: null,
        readiness: { kind: "exact" },
        runsRoute: {
          takeId: "t1",
          authored: false,
          rerun: {
            kind: "link",
            href: runsHref("t1"),
            label: runsRouteLabel(false),
          },
        },
        currentDigest: "d-now",
        sections: createSections(),
        beatAt: () => null,
        hasReclaimedMotion: true,
      },
      handlers(),
    );
    // Take info, in its real popover: the history row and the Re-film link
    // the cases below measure (both under the Export button until
    // 2026-10-19).
    const stored = {
      kind: "stored" as const,
      output: {
        ref: "r1",
        name: "landscape.mp4",
        byteLength: 1024,
        contentType: "video/mp4",
        detailViolations: [],
        renderedAt: "2026-08-25T00:00:00.000Z",
      },
    };
    const route = {
      takeId: "t1",
      authored: false,
      rerun: {
        kind: "link" as const,
        href: runsHref("t1"),
        label: runsRouteLabel(false),
      },
    };
    renderTakeInfo(
      node("#take-info"),
      {
        recordedAt: "2026-08-25T00:00:00.000Z",
        site: "https://northwind.example/checkout",
        durationMs: 24_000,
        steps: 3,
        recording: { width: 1280, height: 800 },
        target: LANDSCAPE_1440P,
        aspect: "16:9",
        takeId: "t1",
        rerun: route.rerun,
        revealError: null,
        history: {
          outputs: [stored],
          currentDigest: "d-now",
          showAll: false,
          warningsOpen: new Set(),
          reportContext: { beatAt: () => null, runsRoute: route },
        },
      },
      {
        onDownload: () => undefined,
        onReveal: () => undefined,
        onShowAll: () => undefined,
        onWarnings: () => undefined,
        onCopy: () => Promise.resolve(),
      },
    );
    // Branding is the Background entry's panel as of 2026-09-14, and one
    // inspector render draws one entry — so the Export panel `#inspector`
    // holds cannot also hold it. The Background entry is drawn into a
    // second `<aside>`: of the two shapes Task 10 offered this is the
    // simpler one, because `#inspector` stays the Export panel for every
    // assertion in the file (a render-branding-then-re-render-Export pass
    // would leave the panel's own `sections` toggled twice and the export
    // button re-created under whatever ran last). An `<aside>` rather than
    // a bare `<div>` so the panel sits on the same card tone and ring the
    // real one does, and `renderInspector` wraps it in `.inspector` either
    // way, which is what the panel rules are scoped to.
    const background = document.createElement("aside");
    background.setAttribute("data-background-mount", "");
    document.body.append(background);
    renderInspector(background, { ...props, rail: "background" }, handlers());
    renderBranding(
      node("[data-panel-branding]"),
      {
        branding: scene.branding,
        logoThumb: null,
        logoPlacement: null,
        formatTitle: "Landscape video",
        logoNotes: [],
        wallpaper: {
          thumbUrl: (id: string) => `/wallpapers/${id}-thumb.webp`,
          custom: null,
          loadError: null,
        },
      },
      handlers(),
    );
  }
  renderFailure(node("#failure"), {
    error: null,
    replaySentence: "The re-shoot could not reach your app.",
    // Non-null (unlike the fixtures above 2026-09-24): this box is the
    // status row's stand-in for a plain, non-error `.notice` — the render-
    // mode notice `renderNotice` used to draw was the only other one, and
    // it retired with Task 10. `[data-capture-note]` is deliberately absent
    // from index.html's `#notes .notice[data-…]` error list, so it keeps
    // the base tone "tones the status row…" below contrasts against.
    captureSentence: "It recorded five hover checks without incident.",
    // The re-shoot box holds the way to Runs (final review I3).
    runsRoute: {
      takeId: "t1",
      authored: false,
      rerun: {
        kind: "link",
        href: runsHref("t1"),
        label: runsRouteLabel(false),
      },
    },
  });
  return { surface, ink, radius };
}

afterAll(async () => {
  await page.viewport(414, 896);
});

describe("the editor page's stylesheet", () => {
  it("links the shell and declares only the editor's own tokens inline", () => {
    expect(shell).toContain('href="../../assets/shell.css"');
    // The tokens the shell owns must not have a second, drifting copy here.
    // The production change that reddens this: a parallel `--shell` or
    // `--card` re-declared in the editor's own sheet.
    for (const owned of [
      "--shell:",
      "--card:",
      "--ink:",
      "--panel:",
      "--hairline:",
    ]) {
      expect(css, owned).not.toContain(owned);
    }
    // And the editor's own are still here — the well and the lane hues
    // have no home in the shell.
    for (const own of ["--stage-bed:", "--track:", "--lane-clip:"]) {
      expect(css, own).toContain(own);
    }
    // Nor a bare `button` or field rule: the quiet button and the field
    // are the shell's, and the editor's renderers carry its classes.
    expect(css).not.toMatch(/\n\s*button \{/);
    expect(css).not.toMatch(/\n\s*select,/);
  });
});

describe.each(["light", "dark"] as const)("the editor shell, %s", (scheme) => {
  it("wears the site's lockup and faces", async () => {
    mount(scheme);
    const manrope = await document.fonts.load('500 13px "Manrope"');
    const outfit = await document.fonts.load('500 16px "Outfit"');
    expect(manrope.map((f) => f.status)).toEqual(["loaded"]);
    expect(outfit.map((f) => f.status)).toEqual(["loaded"]);
    expect(getComputedStyle(node("body")).fontFamily).toMatch(/Manrope/);
    // No lockup on THIS page since 2026-09-21: the editor is the one page
    // reached from another of ours, so the slot carries the way back
    // instead. The popup, Recordings and Settings still wear it, and
    // `settings-shell.test.ts` still compares it across them.
    expect(node("header #back")).not.toBeNull();
    expect(document.querySelector("header #brand")).toBeNull();
    expect(document.querySelector("#wordmark")).toBeNull();
  });

  // In the UI's own face with tabular digits since 2026-10-08, the way the
  // ruler's labels are set; it was `--font-mono` until then.
  it("sets the player's clock in the page's face, with tabular digits", async () => {
    mount(scheme);
    // Both of `main.ts`'s roots, as it draws them: the toolbar's copy is
    // the clock the author reads outside full screen, and it goes to its
    // own root, `#toolbar-clock`, the toolbar grid's first column.
    for (const [root, clockRoot] of [
      ["#stage-bar", "#stage-bar"],
      ["#stage-tools", "#toolbar-clock"],
    ] as const) {
      renderStageBar(
        node(root),
        {
          authored: false,
          positionMs: 2_000,
          durationMs: 12_000,
          aspect: "16:9",
          enabled: true,
          fullscreen: false,
          error: null,
          zoom: "fit",
        },
        handlers(),
        node(clockRoot),
      );
    }
    const clock = node("#toolbar-clock [data-transport-time]");
    // Fixture guard: an empty clock has nothing for a face to set, and a
    // hidden one is not what the author reads.
    expect(clock.textContent).toBe("0:02 / 0:12");
    expect(clock.checkVisibility(), "the toolbar's clock is hidden").toBe(true);
    // Loaded, not merely named: a @font-face whose file `public/fonts`
    // does not ship resolves with no faces, and the computed stack below
    // would still read "Manrope" over a fallback.
    const face = await document.fonts.load("400 12px Manrope");
    expect(face.map((f) => f.status)).toEqual(["loaded"]);
    // Both copies: the full-screen bar's clock is styled by its own rule.
    for (const copy of [clock, node("#stage-bar [data-transport-time]")]) {
      const style = getComputedStyle(copy);
      expect(style.fontFamily).toMatch(/^Manrope\b/);
      // Tabular, or the readout changes width as it counts.
      expect(style.fontVariantNumeric).toBe("tabular-nums");
    }
  });

  /* The stage bed is the page's ground since 2026-10-07, and every card
     floats on it. Until then the ground was `--shell`, with the stage a
     darker well painted into it; the spec's "the stage is a well darker
     than the page" has no two surfaces left to compare, so it becomes
     this: the ground IS the bed, and each card clears 1.15:1 against it. */
  it("paints the stage bed as the page's ground and floats every card on it", () => {
    mount(scheme);
    const ground = surface("body");
    expect(parse(getComputedStyle(node("body")).backgroundColor)[3]).toBe(1);
    expect(ground).toEqual(token("--stage-bed"));
    // The stage is not a card any more: it paints nothing, so the picture
    // sits on the ground itself. Alpha, not luminance — a transparent
    // black would read as "darker than anything" and pass a luminance check
    // whether or not anything painted.
    expect(parse(getComputedStyle(node("#stage")).backgroundColor)[3]).toBe(0);
    // Nor a corner: the old well's radius went with its fill.
    expect(getComputedStyle(node("#stage")).borderTopLeftRadius).toBe("0px");
    for (const card of [
      "#dock",
      "#inspector",
      "#rail",
      "header .head-take",
      "header .actions",
    ]) {
      expect(surface("body", card), card).toEqual(token("--card"));
      expect(
        contrast(surface("body", card), ground),
        `${card} against the ground in ${scheme}`,
      ).toBeGreaterThanOrEqual(1.15);
      expect(getComputedStyle(node(card)).boxShadow, `${card} floats`).not.toBe(
        "none",
      );
    }
  });

  /* The ground is dotted since 2026-10-08: a 1px dot every `--dot-pitch`,
     phased so one runs down the middle of the page's outer `--seam` inset.
     Asked of the picture — the computed `background-image` would read the
     same whether the dot painted, painted elsewhere, or painted the colour
     of the ground. */
  it("dots the ground, with a dot in the middle of the outer inset", async () => {
    mount(scheme);
    const bed = token("--stage-bed");
    const dot = over(token("--ground-dot"), bed);
    // Positive control: the dot colour really differs from the ground, or
    // "a dot is painted here" and "nothing is" would read the same.
    const apart = Math.max(
      ...[0, 1, 2].map((i) => Math.abs((dot[i] ?? 0) - (bed[i] ?? 0))),
    );
    expect(
      apart,
      `the dot is the ground's colour in ${scheme}`,
    ).toBeGreaterThan(8);
    const seam = length("--seam");
    const pitch = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--dot-pitch",
      ),
    );
    // Fixture guard: the top-left corner of the inset is ground, not a
    // card, or the pixels below sample a card.
    const head = node("header .head-take").getBoundingClientRect();
    expect(head.left).toBeGreaterThanOrEqual(seam);
    expect(head.top).toBeGreaterThanOrEqual(seam);

    const { base64 } = await page.screenshot({
      path: `__screenshots__/editor-ground-dots-${scheme}.png`,
      base64: true,
    });
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(image, 0, 0);
    const scale = image.width / window.innerWidth;
    const at = (x: number, y: number): number[] => [
      ...context.getImageData(
        Math.floor(x * scale),
        Math.floor(y * scale),
        1,
        1,
      ).data,
    ];
    const near = (got: number[], want: readonly number[]) =>
      [0, 1, 2].every((i) => Math.abs((got[i] ?? 0) - (want[i] ?? 0)) <= 3);
    const centre = seam / 2;
    const onDot = at(centre, centre);
    const between = at(centre + pitch / 2, centre);
    expect(
      near(onDot, dot),
      `at the inset's centre ${centre}px: ${onDot} against a dot of ${dot.map(Math.round)} in ${scheme}`,
    ).toBe(true);
    expect(
      near(between, bed),
      `half a pitch along: ${between} against the ground ${bed.map(Math.round)} in ${scheme}`,
    ).toBe(true);
    // And the next dot along, a pitch away.
    expect(near(at(centre + pitch, centre), dot)).toBe(true);
  });

  /* Delete goes red under the pointer, the way the Recordings page's own
   * delete does.
   *
   * Hovered for real and read off the painted result, not matched against
   * the stylesheet: the bug this exists to catch was never a missing rule.
   * The shell has said `.btn-icon.btn-danger:hover { background:
   * --error-soft; color: --error }` all along and `#delete` has carried
   * `btn-danger` all along, and the background still never painted, because
   * the editor's own unlayered `header .actions .btn` outranks anything in
   * `@layer shell` regardless of specificity. A test that asked the CSSOM
   * whether the rule EXISTS would have been green throughout.
   *
   * Both halves are asserted, and the resting state with them: `color`
   * came through even while broken — the rule that was winning sets no
   * colour to compete with — so a check on the glyph alone would have
   * passed against the half-applied state this fixes. */
  it(`turns the delete button red under the pointer in ${scheme}`, async () => {
    mount(scheme);
    const del = node("#delete");
    // At rest it is a quiet icon on the take's card: transparent, so the
    // card shows through. The control this case rests on: without it, "red
    // on hover" is satisfied by a button that is red all the time.
    const rest = surface("body", "header .head-take", "#delete");
    expect(rest).toEqual(surface("body", "header .head-take"));
    expect(parse(getComputedStyle(del).color)).toEqual(token("--ink-muted"));

    await userEvent.hover(del);
    expect(
      surface("body", "header .head-take", "#delete"),
      `the delete button kept its grey fill under the pointer in ${scheme}`,
    ).toEqual(
      over(token("--error-soft"), surface("body", "header .head-take")),
    );
    expect(
      parse(getComputedStyle(del).color),
      `the delete glyph did not redden in ${scheme}`,
    ).toEqual(token("--error"));

    // Onto another control rather than `unhover`, which parks the pointer
    // at the body's centre — that is the stage here, but naming a target
    // keeps this from depending on what happens to be mid-page.
    await userEvent.hover(node("#back"));
    expect(
      surface("body", "header .head-take", "#delete"),
      `the delete button stayed red after the pointer left in ${scheme}`,
    ).toEqual(rest);
  });

  /* The surfaces are NEUTRAL grey, which is the half of the 2026-09-22
   * retone that no contrast check can see.
   *
   * The pair before it was #101013 / #1d1d21 — three points of blue on
   * each, enough to read as cool against the lime and violet the lanes
   * carry. Every ratio in this file is computed from luminance, and
   * luminance is unchanged by shifting a channel and compensating, so a
   * tint creeping back would pass all of them.
   *
   * Light is exempt and stated so rather than skipped: its ground is
   * #eef0f4, deliberately a cool paper tone, and only the dark palette was
   * retoned. */
  it(`keeps the ground and the cards free of a colour cast in ${scheme}`, () => {
    mount(scheme);
    if (scheme === "light") {
      // The positive control for the exemption: light really is tinted, so
      // "dark is neutral" is a fact about dark rather than about the
      // assertion being trivially true everywhere.
      const [r, , b] = token("--shell");
      expect(b).toBeGreaterThan(r);
      return;
    }
    for (const name of ["--shell", "--card"] as const) {
      const [r, g, b] = token(name);
      expect(
        Math.max(r, g, b) - Math.min(r, g, b),
        `${name} is ${JSON.stringify(token(name))} — a colour cast, not a grey`,
      ).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The header row has no surface of its own: since 2026-10-07 it holds
   * two floating cards — the take's (`.head-take`) and the actions'
   * (`.actions`) — each `--card`, and the shell's ground shows between
   * them. It carried `--card` itself until 2026-09-21, which made the
   * chrome one container wrapping the stage; and from then until the
   * refresh it was a bare row of controls on the ground, with no card at
   * all. The surface is the cards' now, so the row stays the ground.
   *
   * Asserted as "composites to the shell", not "is transparent": a header
   * painted `--shell` explicitly would read identically and is equally
   * correct, and a test that demanded `rgba(0,0,0,0)` would reject it.
   */
  it("gives the header's row no surface, and its two cards the card's", () => {
    mount(scheme);
    expect(surface("body", "header")).toEqual(surface("body"));
    expect(surface("body", "header .head-take")).toEqual(token("--card"));
    expect(surface("body", "header .actions")).toEqual(token("--card"));
  });

  it("gives every button the shell's quiet control, and Play and Export its primary", async () => {
    const { surface, ink, radius } = mount(scheme);
    // A quiet button on a card in the Export panel: the failed save's
    // "Download again", on the same `notice notice-error` card the export's
    // rebuild-failure row used to carry "Export as previewed" on (that row
    // left with the rebuild, plan 2's Task 7). `mount()`'s own fixture saves
    // nothing, so it is redrawn here. Before that, this loop checked
    // `renderNotice`'s `[data-route="regenerate"]` and `renderFailure`'s
    // retry button, both retired by Task 10 (spec §2), and the chip's
    // popover route, retired with the popover (plan 2, Task 6).
    renderExport(
      node("[data-panel-export]"),
      {
        outputs: [],
        fileType: "mp4",
        aspect: "16:9",
        target: LANDSCAPE_1440P,
        recording: { width: 1280, height: 800 },
        durationMs: 24_000,
        run: { phase: "idle" },
        save: {
          kind: "failed",
          error: "the disk is full",
          refs: ["r1"],
          saved: 0,
          total: 1,
        },
        readiness: { kind: "exact" },
        runsRoute: {
          takeId: "t1",
          authored: false,
          rerun: {
            kind: "link",
            href: runsHref("t1"),
            label: runsRouteLabel(false),
          },
        },
        currentDigest: "d-now",
        sections: createSections(),
        beatAt: () => null,
        hasReclaimedMotion: false,
      },
      handlers(),
    );
    // Each button over the surface it actually sits on — the timeline
    // panel, the notice card — not over the body, or the contrast measured
    // is one no button shows. The header's quiet icons are not in this list:
    // they sit on the take's and the actions' cards and rest transparent,
    // so the loop after this one asserts them against that shape.
    // The fourth column is the SHAPE. The transport's controls are discs
    // while every other quiet button on the page keeps the shell's
    // `--radius`. Written per-entry rather than as an exemption: a blanket
    // "not --radius" would pass against a disc that had quietly stopped
    // being round, and rounding the whole page's buttons by accident is
    // exactly what this loop exists to catch.
    const quiet: [
      string,
      string[],
      string,
      "card" | "pill" | "disc",
      string?,
    ][] = [
      // Snap and Fit on the transport row: glyph-only discs since
      // 2026-09-22, when the row's words went. `+ Mask` is not here: it
      // moved to the Mask lane's header (22px, transparent at rest) and has
      // its own check after this loop.
      [".snap", ["#dock"], "--control", "disc"],
      [".fit", ["#dock"], "--control", "disc"],
      [
        "[data-save-outcome] [data-save-again]",
        ["[data-save-outcome]"],
        "--control",
        "card",
      ],
    ];
    for (const [button, stack, restTok, shape, inkTok] of quiet) {
      const ground = surface("body", ...stack);
      const seen = surface("body", ...stack, button);
      // The control tone IS the button now: flat since 2026-09-20, this
      // assertion is the only thing left that says the button has an edge,
      // so it carries the weight the border check used to share.
      expect(seen, button).toEqual(over(token(restTok), ground));
      // And the identity above is not enough on its own: it says which
      // token painted, not whether the result separates from what it sits
      // on — composition FOLLOWS the ground wherever it moves, so a button
      // whose ground quietly lost its own edge would still satisfy the
      // equality above while nearly vanishing. Measured floor from the
      // 2026-09-21 regression: light went 1.239:1 -> 1.086:1 against the
      // 1.1 this asks for.
      expect(
        contrast(seen, ground),
        `${button} is ${contrast(seen, ground).toFixed(3)}:1 against its ${stack.join(" ")} in ${scheme}`,
      ).toBeGreaterThan(1.1);
      if (shape === "disc") {
        // A circle on the row's 32px, with the shell's 16px glyph.
        const box = node(button).getBoundingClientRect();
        expect([box.width, box.height], `${button} size`).toEqual([32, 32]);
        expect(radius(button), button).toBeGreaterThanOrEqual(box.height / 2);
        const glyph = node(`${button} svg`).getBoundingClientRect();
        expect(glyph.width, `${button} glyph`).toBe(16);
      } else if (shape === "pill") {
        // Round-ended, not merely rounded: `border-radius: 999px` is
        // clamped by the browser to half the SHORT side, so the used value
        // reads back as half the height rather than 999 — and asserting
        // "at least half" is what tells a pill from a 6px corner, where
        // asserting the literal 999 would pass on a box of any shape.
        const box = node(button).getBoundingClientRect();
        expect(box.height, button).toBeGreaterThan(0);
        expect(radius(button), button).toBeGreaterThanOrEqual(box.height / 2);
        // And it is a PILL rather than a circle: wider than it is tall,
        // because it carries a word.
        expect(box.width, button).toBeGreaterThan(box.height);
      } else {
        expect(radius(button), button).toBe(length("--radius"));
      }
      expect(
        Number.parseFloat(getComputedStyle(node(button)).borderTopWidth),
      ).toBe(0);
      // Ink, whatever the container's own colour: a button inside a red
      // failure card is a control, not part of the error text.
      expect(ink(button), button).toEqual(token(inkTok ?? "--ink"));
      // The shell's own classes, so a change to `.btn-quiet` in shell.css
      // reaches the editor rather than a restated copy here.
      expect(node(button).classList.contains("btn"), button).toBe(true);
      expect(node(button).classList.contains("btn-quiet"), button).toBe(true);
    }
    // `+ Mask`, on the Mask lane's header. Not a 32px disc like the row
    // above: a 22px quiet square that paints nothing at rest, in the lane's
    // own glyph colour, and takes the shell's `--control` under the pointer.
    // The size and the 14px glyph are asserted because `.lane-head svg`
    // (the header's 26px glyph disc) reaches an svg inside this button, and
    // a rule that stopped overriding it would draw a second disc.
    {
      const add = '[data-lane="mask"] [data-add-mask]';
      const ground = surface("body", "#dock");
      const box = node(add).getBoundingClientRect();
      expect([box.width, box.height], `${add} size in ${scheme}`).toEqual([
        22, 22,
      ]);
      const glyph = node(`${add} svg`).getBoundingClientRect();
      expect([glyph.width, glyph.height], `${add} glyph in ${scheme}`).toEqual([
        14, 14,
      ]);
      expect(
        getComputedStyle(node(`${add} svg`)).backgroundColor,
        `${add}'s glyph still wears the lane header's disc in ${scheme}`,
      ).toBe("rgba(0, 0, 0, 0)");
      expect(
        getComputedStyle(node(add)).backgroundColor,
        `${add} paints a fill at rest in ${scheme}`,
      ).toBe("rgba(0, 0, 0, 0)");
      expect(ink(add), add).toEqual(token("--lane-mask-glyph"));
      expect(
        contrast(ink(add), ground),
        `${add}'s glyph on the dock in ${scheme}`,
      ).toBeGreaterThanOrEqual(3);
      expect(node(add).classList.contains("btn-quiet"), add).toBe(true);
      await userEvent.hover(node(add));
      expect(
        getComputedStyle(node(add)).backgroundColor,
        `${add} paints nothing under the pointer in ${scheme}`,
      ).not.toBe("rgba(0, 0, 0, 0)");
    }
    // The header's quiet icons, on their cards. At rest they paint nothing
    // — the card shows through — and under the pointer they take the shell's
    // `--control`, which has to clear 1.1:1 against that card or the hover
    // says nothing. Both cards are asserted: the take's holds Back and
    // Delete, the actions' hold Undo, Redo and Shortcuts.
    for (const [button, card] of [
      ["#back", "header .head-take"],
      ["#delete", "header .head-take"],
      ["#undo", "header .actions"],
      ["#redo", "header .actions"],
      ["#shortcuts-open", "header .actions"],
    ] as const) {
      const ground = surface("body", card);
      expect(
        surface("body", card, button),
        `${button} paints a fill at rest in ${scheme}`,
      ).toEqual(ground);
      expect(ink(button), button).toEqual(token("--ink-muted"));
      expect(
        contrast(ink(button), ground),
        `${button}'s glyph on its card in ${scheme}`,
      ).toBeGreaterThanOrEqual(4.5);
      const glyph = node(`${button} svg`).getBoundingClientRect();
      expect([glyph.width, glyph.height], `${button} glyph`).toEqual([18, 18]);
      const box = node(button).getBoundingClientRect();
      expect([box.width, box.height], `${button} size`).toEqual([32, 32]);
      expect(radius(button), button).toBe(length("--radius"));
      expect(node(button).classList.contains("btn-quiet"), button).toBe(true);
      // Delete's hover is red, not the shell's control tone: its own case
      // above holds that, so only the grey ones are hovered here.
      if (button === "#delete") continue;
      await userEvent.hover(node(button));
      const lit = surface("body", card, button);
      expect(
        lit,
        `${button} took the shell's quiet control under the pointer in ${scheme}`,
      ).toEqual(over(token("--control"), ground));
      expect(
        contrast(lit, ground),
        `${button}'s hover pill on its card in ${scheme}`,
      ).toBeGreaterThan(1.1);
    }
    // Export alone since 2026-09-20. Play was the editor's second primary
    // until the transport became neutral glyphs floating under the picture
    // — a filled lime control there read as part of the frame. Export is
    // still the one thing on this page worth a primary, and narrowing the
    // list is the assertion that says so: a second primary creeping back
    // anywhere makes "the one" untrue without failing anything else.
    // `#export-open` is the header's door to the same panel and is lime
    // too: two primaries, the button and the panel's own.
    for (const primary of ["[data-export-start]", "#export-open"]) {
      expect(surface("body", primary), primary).toEqual(token("--primary"));
      expect(
        contrast(ink(primary), surface("body", primary)),
      ).toBeGreaterThanOrEqual(4.5);
      expect(node(primary).classList.contains("btn-primary"), primary).toBe(
        true,
      );
    }
    // And Play is NOT one of them any more. Asserted, not merely dropped
    // from the list above: a play button that quietly kept `btn-primary`
    // would satisfy every other check on this page.
    //
    // It sits on an ink disc: `--secondary`, the shell's own primary-button
    // ink, bigger than its neighbours and round. Not the brand colour, which
    // the transport keeps for the controls that report a state.
    const play = node("[data-transport-play]");
    expect(play.classList.contains("btn-primary")).toBe(false);
    expect(play.classList.contains("transport-button")).toBe(true);
    // Through the stack it actually sits in — the dock, then the body. A
    // composite that skipped `#dock` would be measuring the button over a
    // ground it never sits on.
    expect(surface("body", "#dock", "[data-transport-play]")).toEqual(
      over(token("--secondary"), surface("body", "#dock")),
    );
    expect(ink("[data-transport-play]")).toEqual(token("--secondary-ink"));
  });

  it("tones the status row as the shell's notices, a failure leading with red", () => {
    const { surface, ink, radius } = mount(scheme);
    const note = "#failure [data-capture-note]";
    // Body ink, not the shell's muted note: a notice in the status row is
    // the page speaking, not a footnote inside a card.
    expect(ink(note)).toEqual(token("--ink"));
    expect(ink(`${note} strong`)).toEqual(token("--ink"));
    expect(radius(note)).toBe(length("--radius-card"));
    const failure = "#failure [data-replay-failure]";
    const tone = surface("body", failure);
    expect(tone[0]).toBeGreaterThan(tone[1]);
    expect(contrast(ink(failure), tone)).toBeGreaterThanOrEqual(4.5);
    // The rule at the left is the colour of what the card is.
    expect(parse(getComputedStyle(node(failure)).borderLeftColor)).toEqual(
      token("--error"),
    );
    // The route to Runs under the sentence (final review I3) reads on the
    // card's tone in both schemes, not only in the one it was looked at in.
    const route = `${failure} a[data-runs-route]`;
    expect(node(route).textContent).toBe("Re-shoot this take in Runs");
    expect(contrast(ink(route), tone)).toBeGreaterThanOrEqual(4.5);
    // A note inside the inspector keeps body ink too.
    expect(ink("[data-reclaimed-motion-notice]")).toEqual(token("--ink"));
  });

  it("titles a panel in Outfit at 16/700", () => {
    mount(scheme);
    const title = node("[data-export-panel] > h2");
    const style = getComputedStyle(title);
    expect(style.fontFamily).toMatch(/^"?Outfit"?,/);
    expect(style.fontSize).toBe("16px");
    expect(style.fontWeight).toBe("700");
  });

  // The Runs route is Take info's Re-film row since 2026-10-19 (it was a
  // line under the Export button).
  it("draws the Runs route as a quiet link", () => {
    mount(scheme);
    node("#take-info").showPopover();
    const link = node("#take-info a[data-runs-route]");
    expect(getComputedStyle(link).textDecorationLine).toBe("none");
    expect(ink("#take-info a[data-runs-route]")).toEqual(token("--ink-muted"));
    // (Its second half, the Export panel's disclosure chevron, sampled the
    // Share section — the panel's last disclosure, cut 2026-10-20.)
  });

  it("heads the Export panel and lays out its export button", () => {
    mount(scheme);
    const headings = [...document.querySelectorAll("#inspector h2")].map((h) =>
      h.textContent?.trim(),
    );
    // One panel per rail entry since 2026-09-14: the Export entry's panel
    // has one heading, and Render and Branding are not in it.
    expect(headings).toEqual(["Export"]);
    // The heading is the heaviest text in its panel.
    expect(
      Number.parseInt(getComputedStyle(node("#inspector h2")).fontWeight, 10),
    ).toBeGreaterThanOrEqual(600);
    // And the largest: 16px since 2026-10-07, Outfit at the floating cards'
    // title weight. (It was 20px to match the Settings page's headings,
    // which keep theirs; "titles a panel in Outfit at 16/700" above holds
    // the face.) 16px still tops the 13px summary and body beneath it.
    expect(getComputedStyle(node("#inspector h2")).fontSize).toBe("16px");
    // (The panel's disclosures — Source, then Share — are gone: Source with
    // Task 10, Share with the archive on 2026-10-20.)
    expect(
      document.querySelector("[data-panel-export] details[data-section]"),
    ).toBeNull();
    // One export button, named for the format the stage is on — the four
    // output checkboxes went with the format switch. It is laid out as the
    // shell's control rather than as a bare inline button.
    const start = node("[data-export-start]");
    // In an actions row since 2026-09-22, where a flex item computes to
    // `flex`; either way it is the shell's control, not a bare inline box.
    expect(getComputedStyle(start).display).toMatch(/^(inline-)?flex$/);
    expect(start.textContent).toMatch(/^Export /);
    // An exported output is a label beside a Download button. Unstyled, the
    // two were inline boxes touching — the file size ran into the word
    // "Download" with nothing between them. In Take info's history since
    // 2026-10-19.
    node("#take-info").showPopover();
    const beat = node("#take-info .beat");
    expect(getComputedStyle(beat).display).toBe("flex");
    expect(Number.parseFloat(getComputedStyle(beat).columnGap)).toBeGreaterThan(
      0,
    );
    // Fixture guard: the row measured is the output row, not some other
    // `.beat` that happens to be first.
    expect(beat.querySelector("[data-download]")).not.toBeNull();
  });

  it("lays the Background panel out as style, colour, padding, then logo", () => {
    mount(scheme);
    const panel = node("[data-panel-branding]");
    const headings = [
      ...panel.querySelectorAll<HTMLElement>(".control-label"),
    ].map((h) => h.textContent);
    // The fixture scene is a gradient with no logo: Style, the two stops,
    // the angle, Padding, then Logo — every one a row label
    // (inspector-rhythm.test).
    expect(headings).toEqual([
      "Style",
      "From",
      "To",
      "Angle",
      "Padding",
      "Logo",
    ]);
    expect(panel.querySelectorAll("[data-colour-field]").length).toBe(2);
    // A pasted hex reads as code: the text box is monospaced.
    expect(getComputedStyle(node("[data-colour-text]")).fontFamily).toMatch(
      /mono|Menlo/i,
    );
    // The error line takes no space until there is an error to show.
    expect(getComputedStyle(node("[data-colour-error]")).display).toBe("none");
  });

  /**
   * The row-label treatment the Cursor panel took on 2026-09-21, carried to
   * the two panels beside it: Background's control labels and Export's
   * output rows. `editor-cursor-panel.test.ts` holds the Cursor half, where
   * the same invariant is asked of a slider, a switch and a heading.
   *
   * Asserted against the tokens the rule is written in — `--row-label` and
   * `--ink` — rather than against 14px and a hex, so moving the token moves
   * this with it instead of pinning a literal the rule no longer uses.
   *
   * The weight line passes today without the rule: a `<label>` and a
   * `<span>` inherit weight anyway. It is here to keep that true — the
   * treatment is "reads like the text it sits in", and the `<strong>` in a
   * switch row is the standing proof that this markup does not always get
   * that for free.
   */
  it("reads Background's row labels as the inspector's own", () => {
    mount(scheme);
    const branding = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-panel-branding] .control-label",
      ),
    ];
    // The fixture's premise: Branding's six control labels; a selector that
    // stopped matching would leave the loop below asserting nothing at all.
    // (Export's output rows were the Share section's, cut 2026-10-20.)
    expect(branding.map((n) => n.textContent?.trim())).toEqual([
      "Style",
      "From",
      "To",
      "Angle",
      "Padding",
      "Logo",
    ]);
    const size = length("--row-label");
    for (const label of branding) {
      const what = label.textContent?.trim() ?? "";
      const painted = getComputedStyle(label);
      const around = getComputedStyle(label.parentElement as HTMLElement);
      expect(Number.parseFloat(painted.fontSize), `"${what}" size`).toBe(size);
      expect(parse(painted.color), `"${what}" ink`).toEqual(token("--ink"));
      expect(painted.fontWeight, `"${what}" weight vs its surroundings`).toBe(
        around.fontWeight,
      );
    }
  });

  // "hides the Source disclosure when a refused render leaves its box
  // empty" retired with Task 10: the Source disclosure it tested (and the
  // `data-panel-mode` mount point inside it) no longer exist at all — spec
  // §2 asks nothing about where the frames came from, so there is no
  // render-mode banner whose emptiness a disclosure could hide. Covered by
  // absence instead: `editor-main-render-mode.test.ts`'s "offers no rebuild
  // button outside the Export panel" asserts no `[data-panel-mode]` exists.

  /* The rail is a card again since 2026-10-07, in its own track beside
     the panel, so its entries sit on a known surface rather than on
     footage. The pressed entry is told apart the way every other quiet
     control on a card is — a fill a step off the card — and carries the
     brand colour on its glyph; the others rest transparent in muted ink.

     It floated on the picture from 2026-09-21, with a fixed dark scrim
     and a fixed lime, and this case measured the entries over a bright, a
     mid and a dark frame. Those premises went with the footage. */
  it("presses the open rail entry apart from the others on the rail's card", () => {
    mount(scheme);
    renderRail(
      node("#rail"),
      { rail: "background", panelOpen: true, hasSelection: false },
      { onPick: vi.fn() },
    );
    const on = node('#rail [data-rail="background"]');
    const off = node('#rail [data-rail="cursor"]');
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(
      contrast(
        surface("body", "#rail", '#rail [data-rail="background"]'),
        surface("body", "#rail"),
      ),
    ).toBeGreaterThanOrEqual(1.1);
    expect(ink('#rail [data-rail="background"]')).toEqual(token("--accent"));
    expect(ink('#rail [data-rail="cursor"]')).toEqual(token("--ink-muted"));
    expect(off.getAttribute("aria-pressed")).toBe("false");
    // "The others rest transparent": the resting entry paints no fill, so
    // the card shows through it.
    expect(
      parse(getComputedStyle(off).backgroundColor)[3],
      `the resting rail entry paints a fill in ${scheme}`,
    ).toBe(0);
  });

  /* The pressed entry stays pressed under the pointer. The quiet hover
     rule is `:not(:disabled):hover` — one pseudo-class more than the
     pressed rule's attribute — so without its own exclusion it painted the
     open entry as a plain hovered control, in plain ink, and the one entry
     an author points at to close a panel stopped saying it was open.
     Hovered for real: which rule wins is a cascade question, and the
     painted result is the only answer that counts. */
  it(`keeps the open rail entry pressed under the pointer in ${scheme}`, async () => {
    mount(scheme);
    renderRail(
      node("#rail"),
      { rail: "background", panelOpen: true, hasSelection: false },
      { onPick: vi.fn() },
    );
    const on = '#rail [data-rail="background"]';
    const off = '#rail [data-rail="cursor"]';
    const card = surface("body", "#rail");
    const pressed = surface("body", "#rail", on);
    expect(pressed, "the open entry is not pressed at rest").toEqual(
      over(token("--control-hover"), card),
    );
    // The positive control: the pointer really reaches the rail, and a
    // resting entry under it takes the hover's fill and ink.
    await userEvent.hover(node(off));
    expect(
      surface("body", "#rail", off),
      `a resting entry did not take the hover in ${scheme}`,
    ).toEqual(over(token("--control"), card));
    expect(ink(off)).toEqual(token("--ink"));

    await userEvent.hover(node(on));
    expect(
      surface("body", "#rail", on),
      `the open entry lost its pressed fill under the pointer in ${scheme}`,
    ).toEqual(pressed);
    expect(
      ink(on),
      `the open entry lost its accent ink under the pointer in ${scheme}`,
    ).toEqual(token("--accent"));
    // Off the rail again, so the pointer does not rest on it for whatever
    // runs next.
    await userEvent.hover(node("#back"));
  });

  it("styles the step panel's fields the same way", () => {
    const { radius } = mount(scheme, "source", true);
    const gap = "[data-gap]";
    // Same field shape as the Share picker above: no ring, control tone.
    expect(Number.parseFloat(getComputedStyle(node(gap)).borderTopWidth)).toBe(
      0,
    );
    expect(radius(gap)).toBe(length("--radius"));
    expect(
      Number.parseInt(
        getComputedStyle(node("[data-step-panel] h2")).fontWeight,
        10,
      ),
    ).toBeGreaterThanOrEqual(600);
  });
});

describe("the sheets' order", () => {
  // The build moves the shell's <link> after the page's inline <style>;
  // the shell sits in a cascade layer so both orders paint the same. The
  // properties asserted are ones the shell's own rules CONTEST on these
  // elements — the shell's `.notice` is `--radius` on the control tone where
  // the page's is `--radius-card` on the card, its `.btn` is 12.5px — so a
  // shell that lost its layer
  // goes red here in build order (measured 2026-09-14) rather than passing
  // on properties nothing else sets.
  it.each(["source", "build"] as const)(
    "paints the editor the same in %s order",
    (order) => {
      const { surface, radius } = mount("light", order);
      // Contested since 2026-10-07: the shell's `body` paints `--shell` and
      // the page's paints the stage bed over it. (Both said `--shell` before,
      // so this line could not tell the orders apart until now.)
      expect(surface("body")).toEqual(token("--stage-bed"));
      // `#notice .notice` (`renderNotice`'s own box) retired with Task 10;
      // `[data-capture-note]` is `mount()`'s own plain (non-error) `.notice`
      // now — see its own docblock.
      expect(surface("body", "#failure [data-capture-note]")).toEqual(
        token("--card"),
      );
      expect(radius("#failure [data-capture-note]")).toBe(
        length("--radius-card"),
      );
      // Was `.snap`'s 13px font against the shell's 12.5px `.btn`, until
      // the tool row lost its words on 2026-09-22. A magnifier's width is
      // the same kind of probe: the page sets 28px, the shell's `.btn-icon`
      // 32px.
      expect(getComputedStyle(node('[data-zoom-step="in"]')).width).toBe(
        "28px",
      );
      // Was the play button's 999px pill until the transport went neutral,
      // and 48px until the editor refresh shrank it. Same probe, different value:
      // the page sets 36px on this control and the shell's `.btn-icon`
      // sets 32px, so the value read here says which sheet won — which is
      // the whole point of running this in both orders.
      expect(getComputedStyle(node("[data-transport-play]")).width).toBe(
        "36px",
      );
    },
  );
});
