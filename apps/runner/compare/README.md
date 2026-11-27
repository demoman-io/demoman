# film:compare

`pnpm film:compare [--script <file>…] [--sides cli,headless]` films each script
through `demoman-mcp --headed` (the CLI's visible window) and through
`demoman-mcp` headless (the server's default), twice each, on Chrome for
Testing, and writes `film-compare/<date>/<script>/`: `cli.mp4`, `headless.mp4`
(each side's first run), `compare.html` (open it), and `numbers.json`. It is
manual: it needs a display and network.

The headless side stands in for this Mac's menu-bar display (or
`DEMOMAN_DISPLAY`), so its motion films at the display's scale. `--sides`
takes the two sides in either order; they are always filmed, shown and tabled
visible first. Until 2026-10-20 the extension was a third side, behind a
private-port build on 47399; it was archived that day (tag
`archive/extension`), and `--sides extension,…` is refused by name.

- `sample-app.json` — the store-assets sample app (`internal/docs/store-assets/sample-app`, from the private repo), served locally: a dialog, three typed fields, a submit, a toast. Its last step scrolls to the new row's due date, which exists only after a real submit, so a submit click that does nothing stops the run (on 2026-10-13 the CLI reported such a click `complete`). The submit also deletes the table's last row (Ferro Bikes), so never target that row after it. Needs network (Google Fonts, Lucide from unpkg).
- `button-run.json` — the same sample app: five quick clicks across the page (sidebar, table header, page header, top bar, sidebar) with no navigation, for the camera's follow through a run of zooms (spec 2026-10-22). Filmed before and after on 2026-10-22 (CLI side): between the first and last click the picture stood still in 45% of frames on main, with a longest still of 1.20 s, and in 25% on `feat/camera-trails`, longest 0.40 s; every click framed `inside` on both.
- `video-as-code.json` — the same sample app: the script's `trim` and per-click `zoom` (spec 2026-11-01 video-as-code). The start keeps 300 ms before the first click and the end 400 ms after the last zoom-out; Customers has `zoom: false`, Export `zoom: { scale: 1.4 }`, Status and Reports the camera's own. The go/no-go: the video opens just before the Customers click with no zoom on it, Export holds 1.4x, and it ends on the whole page. The run report's `opening` line says where the cut opening went.
- `same-document.json` — the same-document go/no-go, against `apps/runner/test/fixtures/same-document-app.html` served on 8130 (`python3 -m http.server 8130 --bind 127.0.0.1 --directory apps/runner/test/fixtures`): a search that writes `?q=` with `replaceState`, a row that opens its detail with `pushState`, a pause, and Reply in the detail. Before the fix it stopped at the row ("Stopped after step 2 of 4", label "script step 3", `pageWentElsewhere`). Recorded 2026-11-07 through the branch's own `demoman mcp`: `Complete: the video matches every step the script asked for.`, exported 2560×1758, 60 fps, 9.35 s; the video shows the typing, the row opening and Reply. The same script with a missing button appended stops "at script step 6 of 6", its label "script step 6".
- Input-coverage go/no-go (keydown, native select, new tab, confirm dialog), each against a page in `apps/runner/test/fixtures` served on 8130, the same server as `same-document.json`. Each script's last step targets something that exists only if the input really worked, so a gap stops the run instead of completing; a plain `pnpm film:compare` includes them, and the ones whose issue is fixed now complete (`confirm-dialog.json`). Recorded on the Mac on 2026-11-19 under held capture (0.9.8, `recording.clock: "held"`) against these pages; each issue carries the report lines. An earlier run on 2026-11-11 (0.9.4) stopped at the same steps, the keydown page then in an earlier form:
  - `keydown-field.json`: types "North" into a field that counts `input` and `keydown` apart and reveals a suggestion only on a printable keydown. Stopped at step 5 (`unresolvedAnchor`); the page read `input events: 5`, `keydown events: 1`, `keys seen: Ctrl+?`. That one key is the Ctrl+A `type` then sent to select the field first (`walk.ts`; since the input fixes it calls the field's own `select()` and sends no key); no character fires a keydown. An earlier version of the page counted any keydown and passed for that reason.
  - `native-select-click.json` and `native-select-keys.json`: a native `<select>` whose Continue button appears only once the value is Team. Clicking the select then the option stopped at the option (`unresolvedAnchor`, though `candidates: 1`: the option was found and has no box). Clicking it then ArrowDown, Enter stopped at Continue: both presses reported nothing wrong and the value stayed Free. The still shows no open list either way. That keyboard result is the Mac's: `press` sends ArrowDown as `moveDown` there only (`packages/replay-engine/src/keys.ts`), and Chrome on Linux may step a closed select to the next option on ArrowDown, so the keys script may complete on Linux with the gap still open.
  - `new-tab.json`: a `target=_blank` link, then a button on the page it opens. Stopped at the button (`unresolvedAnchor`); the run stayed on the first tab and the report says nothing of a tab having opened.
  - `confirm-dialog.json`: a button that calls `confirm()`; OK reveals Undo, Cancel reveals "Project kept". Fixed 2026-11-21: the run answers the dialog OK (or as the click's `dialog` says), the report's `dialogs` lists it with its step, and the script now completes. Before, it stopped at Undo with the end page reading `confirm() answered false`: the dialog was dismissed in silence, in neither the report nor the video.
- `inputs.json` — `apps/runner/test/fixtures/inputs-app.html` on 8130: `Mod+K` and Escape (each a keycap pill at the bottom centre), a double-click on row 2 (two ripples and a ×2 tag; the row turns into a rename field), a right-click on row 4 (a small mouse with its right button lit, no ripple; the page's own menu opens), a right-click on `#plain`, which has no menu of its own (the same mouse, and no Chrome menu in a visible window), a click on row 1, a click in the field, and a Shift-click on row 3 (a "⇧ + click" pill; rows 1–3 selected). `executor-inputs-picture.slow.test.ts` records this same file and reads each mark off the decoded export; filming it is how the author judges the marks' look.
- `wikipedia.json` — search, type, a navigating submit, a scroll, on the monobook skin (Vector 2022's search button is ambiguous to a script). The submit is "Go" (`searchButton`), which opens the article; `mw-searchButton` is full-text "Search" and lands on a results page with no "References". The navigating submit is where the CLI hit `stillFailed` on 2026-10-12.

Five more scripts film four third-party apps kept outside the repo, each a different kind
of page. `scripts/samples.sh setup` clones them at pinned commits into
`~/Code/demoman-samples` (`DEMOMAN_SAMPLES` moves it; about 6 GB installed);
`scripts/samples.sh start <app>` serves one, and it must be running before its
script is filmed. Rebrand anything filmed from them before it goes on the site.

- `tremor.json` — Tremor's dashboard template (MIT) on 4301: hovers across stat cards, a scroll past the charts, a navigating click to a table.
- `tremor-filter.json` — the same template's Details table on 4301 (`scripts/samples.sh start tremor`): the Status filter's popover, its select, Live, Apply, then the first row's actions menu and Edit. The popover, the option and the menu exist only after their clicks, so every target came from a `snapshot` or a `probe`, none composed. Filmed 2026-10-27: `complete`, 7 steps, every click framed `inside`.
- `chatbot.json` — Vercel's chatbot template (Apache-2.0) on 4303, on its mock model against a local Postgres (`demoman_chatbot`): type, send, and wait for the whole streamed answer. `scripts/samples/chatbot.patch` routes every model to the mock (upstream asks the mock for a model it does not define, and the answer is saved empty) and slows its stream to about 2 s. Never empty the `User` table under a running browser: the guest it is signed in as goes with it and every send fails a foreign key; rotating `AUTH_SECRET` in `.env.local` recovers. On 2026-10-21 it filmed with `budgetBreach`.
- `excalidraw.json` — Excalidraw (MIT) on 4302: picks the rectangle tool, draws a rectangle with a `drag` between two spots on the canvas (`{ "text": "Drawing canvas" }`, the canvas's own fallback text), then more tool picks and the Library panel. On 2026-10-21 all four runs filmed every step `inside`, the zoom held through the drag, and nothing was lost.
- `actual.json` — Actual Budget (MIT) on 3001: Try the demo, an account's transactions, then Reports. It starts on the welcome screen only in a browser that has not opened the demo, which `film:compare`'s fresh homes are. Until 2026-10-21 snapshot listed its buttons by react-aria ids that change on every load, and its demo database (blocks keyed from -1) refused every localhost session once a run had written it back; both are fixed.

Ctrl+C mid-run leaves its temporary folders in `$TMPDIR`: the two homes (`film-compare-cli-home-*`, `film-compare-headless-home-*`). A side whose runs did not all complete keeps its home on purpose; the refusal names it.

## House-app trial

`house-trial.sh <app checkout> <rounds> [flow…]` runs a house app's refresh
trial on this machine with the repo's own build, so a refresh fix is measured
before it is released, not after. It records a local baseline, then
refreshes `<rounds>` times against it with nothing changed; the last line
counts the unchanged verdicts, and every one should be. `DEMOMAN` picks the
build to run, and `COLD=1` wipes the app's build caches before each refresh.

A Mac is fast enough to hide a race CI's runner loses. The settled-after-a-route-change race read 15 of 15
unchanged here, warm or cold, until the ticket page's modules were slowed to
CI's pace: a local, never-pushed vite plugin in helpdesk's `nuxt.config.ts`
that holds each `/_nuxt/…/pages/` module 1.5 s. Then every round took the
empty reader, and with the fix every round showed the ticket.

## Held clock on a house app

`held-clock.sh <app checkout> <out dir> [flow…]` records each kept flow
held twice and once in real time (`DEMOMAN_HELD_CLOCK=0`) with this
checkout's runner (`pnpm -r build` first), exports every recording to
`<out dir>/{held-1,held-2,real}/<flow>.mp4`, and prints per flow the held
frame count, step frames, picture-change frames, network stretches, record
time and video length, and whether the two held runs match outside the
stretches. The app must already be serving (`pnpm dev` in it); its
`reset` (app.json, or `RESET="pnpm reset"` for Nylon) runs before each
recording. Each recording is a refresh's own run in a throwaway home:
nothing in the checkout is written. `node held-clock.mjs trial --app …
--out … [--rounds 3]` is a refresh trial the same way (a baseline, then
rounds judged by refresh's own `sameScreens`), for checkouts where
`house-trial.sh`'s local commit is not wanted. `held-risks.sh <out dir>`
runs it on one small page per risk of the held-clock spec (`<video>`, the
app's smooth scroll, a cross-origin iframe, WebGL, a phone). `held-push.sh <out dir>`
does the same for a page per push channel (an EventSource, one that goes
quiet, a long poll, a fetch stream that never ends) beside a page with none. Measured
2026-11-15 in the held-clock spec's "Measured: held capture as built".

## Camera motion

`camera-motion.mjs --video <mp4> [--from <s>] [--to <s>]` reads a video's
pixels and prints each frame's pan (px at 2560 wide, `dx` and `dy`) and
whether it repeats the frame before, then `reversals x:` and `reversals y:`
(the pan changing direction at 8 px a frame or more) and `repeats:` (a frame
identical to the one before, between two that changed). With `--repo <root>
--take <id> --out <mp4>` it first exports that take with `<root>`'s built
runner, from a copy in a throwaway home, so one take compares across two
checkouts. The pan is read from row and column profiles, so a pan on both
axes at once, or one past a tenth of the frame per frame, reads roughly:
check a surprising number against the frames. On 2026-11-22 the Sublime
board's drag read `reversals x: 3 [1.08, 3.23, 7.80]` on main and
`reversals x: 2 [1.08, 3.23]` with the fix; the repeats at the drop are the
held clock's 30 fps page.

`--plan --repo <root> --take <id>` reads the camera from the take's plan
instead of its pixels, so nothing the page draws moves it (its centres are unclamped, as planned, not as drawn at a canvas edge): `plan reversals
x:` and `y:` (at 0.5 CSS px a frame), `plan fastest:`, and `plan push-ins:`,
each push-in's length and landing (a drag right after another step read
517 ms of 1300 until 2026-11-23, when it was given the room a click gets). Run it with two
checkouts' `--repo` to compare a camera change. On the 16 saved takes with a
zoomed drag (2026-11-23), the drag-camera fix lowered reversals on 7 and raised
them on none.

`record-cost.mjs --repo <root> --script <file> --out <mp4> [--project <app>]`
records a script with `<root>`'s built runner in a throwaway home (signed in
by the project's demo account), exports it, and prints `outcome:` and `cost:
run <s> s, take <MB> MB on disk`. `--home <dir>` records into `<dir>`, keeps
it and prints `take: <id>`, so `DEMOMAN_HOME=<dir> camera-motion.mjs --plan`
can read the take. `sublime-drag.json` is the site's Sublime
take (`demoman-io/sublime` on 4402, `pnpm reset` before each run, size
pinned at 1710×1107, the site take's). On 2026-11-23, through the project's
`.demoman/config.json` `recordingFrameRate`, it recorded in about
15 s (14.9–21.8) and 9.0 MB at 30, and in about 24 s (23.5–31.4) and 8.4 MB
at 60, where the export's repeated frames went from 11–16 to 1. (A first
trial that edited the clock's constant by hand halved its holds and waits too,
and read 29.6 s and 14–15 MB.)

## Export cost

Three scripts for where an export's time goes, all headless, all against a
built runner (`pnpm -r build`). Every run and export also logs one
`timing …` line (`apps/runner/src/stage-times.ts`) naming its stages.

- `export-variants.mjs --repo <root> --script <file> [--sample <index.html>]`
  films a script once and exports the take under scene variants (no camera
  blur, no padding, solid background, no zooms, no blur and no padding),
  printing each render's seconds. On 2026-10-25, `button-run.json`
  (684 frames, 1920x1500 at 60 fps) rendered in 72 s as filmed, 31 s with no
  camera blur, 41 s with no padding (the frame's two shadows) and 16 s with
  neither, the same within 2.5 s on a second take.
  On a runner without a GPU, `.github/workflows/export-variants.yml` runs
  it on the public fixture app (`fixture-clicks.json`).
- `gpu-args.mjs --repo <root> --script <file> --sample <index.html> [--rounds 2] [--sets all|"<name>;<name>"]`
  records one take and exports it once per set of Chrome launch flags,
  printing each render's seconds and the WebGL renderer that came up. On
  2026-11-03, runners without a GPU rendered the fixture take in 185–198 s
  under every set, `--disable-gpu` included; a Colab T4 rendered it in 22.5 s
  with ANGLE on Vulkan against ~420 s without. `.github/workflows/gpu-args.yml`
  runs it on GitHub runners; `gpu-args.sh` sets up a bare Linux notebook
  (Colab or Kaggle, free T4) and runs it there.
- `export-profile.mjs --repo <root> --script <file> [--out <trace.json>]`
  exports under a V8 CPU-profiler trace and prints self time per function on
  the render page. GPU work is charged to whatever waits on it first: on
  2026-10-25, 85% landed in mediabunny's `VideoSample` (`new
  VideoFrame(canvas)`) and 14% in `paintCameraBlur`.
- `render-cost-probe.mjs [--headed] [--as-executor]` prints `chrome://gpu`'s
  feature lines for the executor's Chromium and times synthetic frames
  through draw, `new VideoFrame(canvas)` and a live encoder. Its 6–7 ms a
  frame did not reproduce the real compositor's cost, and `chrome://gpu`'s
  "Hardware accelerated" is not evidence: it says the same with and without
  the GPU in use.

What the cost was (2026-10-25): headless Chromium drew the export's canvas
on the renderer's CPU. A trace of the export (`export-profile.mjs` with the
`disabled-by-default-skia` and `blink` categories) showed
`OffscreenCanvasRenderingContext2D::FinalizeFrame` taking 77.9 s of a 78.3 s
render on the renderer's main thread, `SkCanvas::drawPath` (the shadows)
running there, and the canvas on a `Canvas2DBitmapProvider` surface.
Launched with `--enable-gpu` (`HEADLESS_GPU_ARGS` in `src/launch.ts`) the
same take rendered in 5.3 s against 70.5 s, and a sample-app take with a
stand-in display in 9.6 s against 174.7 s. The GPU also offers headless a
hardware encoder, which sized files differently, so the render page pins the
software one (`render-entry.ts`'s `softwareEncoded`): one take then rendered
in 5.7 s against 92.6 s at 12,243,149 against 12,307,207 bytes. Linux has no
entry in `HEADLESS_GPU_ARGS` yet; this script, run there with and without
one, is the measurement that adds it.

## `pnpm agent:study`

Runs a model as an agent against the five briefs in `compare/briefs/` (one per sample app: Nylon, Tremor, Chatbot, Actual, Excalidraw), through this repo's own `apps/mcp/dist`, then has opus judge each export's last frame against the brief's `endState`.

    pnpm agent:study --model haiku [--brief tremor]… [--pass 0]

- Start the apps first: `scripts/samples.sh start tremor|chatbot|actual|excalidraw`, one terminal each. Nylon is served by the command itself. An app that does not answer is named and skipped in `summary.md`.
- It costs real tokens: one agent session of tens of minutes per brief, plus one opus judge call. By hand only, never CI. It needs the `claude` CLI on the PATH, ffmpeg and ffprobe.
- It never uses `bypassPermissions`: the agent gets `mcp__demoman__*` and `ToolSearch`, nothing else.
- Output, gitignored: `agent-study/<date>/<model>-<pass>/<brief>/{transcript.jsonl,final.png,judge.json}` and `summary.md` beside them (App, Judge, Runs, Probes, Length, Agent's claim, Judge's reason). "unjudged" means the judge could not be read or there was no export; the reason says which.

## Settle cost

`node apps/runner/compare/settle-cost.mjs --demoman "<command>" [--out <json>] <appDir>...`
runs `<command> refresh` (never `--deliver`) in a throwaway `git worktree` of
each app, so nothing is left in the app's checkout, and prints each flow's
`timing run … walk N s`. It also copies out each take's bundle while the flow
runs (refresh deletes its throwaway home) and keeps the page screens' PNG
sizes, so `pageScreens[*].waitedMs` and `unsettled` come with the times. It
copies an app's ignored `.env.local` and `.demoman/secrets.env` into the
worktree, on this machine only. Run it once per build, with `--demoman
demoman` or `node <checkout>/apps/cli/pkg/dist/demoman.mjs` (install that
bundle's dependencies first, as `internal/tools/dev-demoman.sh` does), and
compare each flow's first walk. A flow that Refresh films again after a
problem has more than one walk line; the first is the comparable one. Measured
on 2026-11-10 for the step settle (`STEP_QUIET_MS`, spec 2026-11-10
refresh-settled-screens, decision 7): helpdesk, nylon, sublime and the chatbot
sample, ten flows, two runs per build per flow.

## Pacing fit

`beat-fit.mjs <takes-dir>` measures what today's pacing does on the author's own scripted Mac takes (door `mcp`, repo root under this home, real-time bundle, no `scene.pacing`): per marker pair, the idle before and after the cursor's last journey, as medians and quartiles. It set `BASE_REST_MS` and `OPENING_REST_MS` on 2026-11-13. `pacing-pairs.mjs --repo <checkout> --out <dir> [--sample <index.html>] <script>...` records and exports each script headless with that checkout's built runner and prints one JSON line each; run it on `main` and on a branch into different `--out` folders for old/new videos. `pacing-fixture.json` (outside `scripts/`, which `film:compare` fills only for `{sample}`) runs against `pacing-fixture.html` (`{fixture}`): a typed field then a click, two zoomed clicks close together, a click below the fold, a closing pause.

`corner-click.json` runs against `corner-click-fixture.html` (`{fixture}`) through `pacing-pairs.mjs`: one unzoomed click on a button pinned to the page's bottom-right corner. The go/no-go for the pointer drawn over the window's edge: in the export the arrow hangs past the window onto the background, uncut. Until 2026-11-22 the compositor clipped the pointer to the window. Recorded that day: `complete`, 2560×1758, 60 fps, 4.5 s.

`pacing-pairs.mjs` stands in for `DEMOMAN_DISPLAY` as the CLI does (1440x900@2 unless set), so a held take records at the scale a user's would. Each line also carries `recording` (what the run did: held, or real time and why), `target`, `detail` (the export's `detailViolations`: every zoom the render cut to the frames' detail), `stillWidths`, and the bundle's `spans` and `stills` in source ms. Set `DEMOMAN_HELD_CLOCK=0` for the real-time side.

## Held sweep

`held-sweep.json` runs against `held-sweep-fixture.html` (`{fixture}/held-sweep-fixture.html`): grey stripes sliding on every frame, three zoomed clicks, and a pure green box shown for 40 ms after the first. Record it with `pacing-pairs.mjs`, then `held-sweep-read.mjs <mp4>...` decodes each export and prints its `freezes` (each run of 200 ms or more with no change between frames, which on this page the video added) and `greenMs` (where the 40 ms box shows; empty means it was lost). Measured 2026-11-19 (lane A): real time froze 9 times (200–1383 ms) and lost the box; held froze only at the opening (617 ms, the unfilmed load and settle) and showed the box on its one frame, the same on two runs. On both fixtures every held 1.8x zoom was granted 1.35x at the default export, against 1.8x for real time's 3x stills. After the opening fix (a held take's time starts at its opening still) held froze nowhere and ran 8.7 s against 9.3 s, the same on two runs.

`held-wait-pan.json` runs against `held-wait-pan-fixture.html`: a zoomed click on Load hides Next, and a timer shows it 3 s later in page time, which the walk's designed clock does not count (as it does not count a load). Then a zoomed click on Next, across the page. Record it with `pacing-pairs.mjs`, and read Next's `arrives` in its `zooms` beside the two clicks' `markers`. Measured 2026-11-20 (lane A): held, the clicks were 4971 ms apart in the video, the walk recorded `pan`, and the export stayed zoomed on Load through the wait.
