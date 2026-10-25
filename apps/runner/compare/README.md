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

- `sample-app.json` — the store-assets sample app (`docs/store-assets/sample-app`), served locally: a dialog, three typed fields, a submit, a toast. Its last step scrolls to the new row's due date, which exists only after a real submit, so a submit click that does nothing stops the run (on 2026-10-13 the CLI reported such a click `complete`). The submit also deletes the table's last row (Ferro Bikes), so never target that row after it. Needs network (Google Fonts, Lucide from unpkg).
- `button-run.json` — the same sample app: five quick clicks across the page (sidebar, table header, page header, top bar, sidebar) with no navigation, for the camera's follow through a run of zooms (spec 2026-10-22). Filmed before and after on 2026-10-22 (CLI side): between the first and last click the picture stood still in 45% of frames on main, with a longest still of 1.20 s, and in 25% on `feat/camera-trails`, longest 0.40 s; every click framed `inside` on both.
- `wikipedia.json` — search, type, a navigating submit, a scroll, on the monobook skin (Vector 2022's search button is ambiguous to a script). The submit is "Go" (`searchButton`), which opens the article; `mw-searchButton` is full-text "Search" and lands on a results page with no "References". The navigating submit is where the CLI hit `stillFailed` on 2026-10-12.

Four more film third-party apps kept outside the repo, each a different kind
of page. `scripts/samples.sh setup` clones them at pinned commits into
`~/Code/demoman-samples` (`DEMOMAN_SAMPLES` moves it; about 6 GB installed);
`scripts/samples.sh start <app>` serves one, and it must be running before its
script is filmed. Rebrand anything filmed from them before it goes on the site.

- `tremor.json` — Tremor's dashboard template (MIT) on 4301: hovers across stat cards, a scroll past the charts, a navigating click to a table.
- `chatbot.json` — Vercel's chatbot template (Apache-2.0) on 4303, on its mock model against a local Postgres (`demoman_chatbot`): type, send, and wait for the whole streamed answer. `scripts/samples/chatbot.patch` routes every model to the mock (upstream asks the mock for a model it does not define, and the answer is saved empty) and slows its stream to about 2 s. Never empty the `User` table under a running browser: the guest it is signed in as goes with it and every send fails a foreign key; rotating `AUTH_SECRET` in `.env.local` recovers. On 2026-10-21 it filmed with `budgetBreach`.
- `excalidraw.json` — Excalidraw (MIT) on 4302: picks the rectangle tool, draws a rectangle with a `drag` between two spots on the canvas (`{ "text": "Drawing canvas" }`, the canvas's own fallback text), then more tool picks and the Library panel. On 2026-10-21 all four runs filmed every step `inside`, the zoom held through the drag, and nothing was lost.
- `actual.json` — Actual Budget (MIT) on 3001: Try the demo, an account's transactions, then Reports. It starts on the welcome screen only in a browser that has not opened the demo, which `film:compare`'s fresh homes are. Until 2026-10-21 snapshot listed its buttons by react-aria ids that change on every load, and its demo database (blocks keyed from -1) refused every localhost session once a run had written it back; both are fixed.

Ctrl+C mid-run leaves its temporary folders in `$TMPDIR`: the two homes (`film-compare-cli-home-*`, `film-compare-headless-home-*`). A side whose runs did not all complete keeps its home on purpose; the refusal names it.

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
