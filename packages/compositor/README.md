# @demoman/compositor

Turns a scene document plus a bundle of harvested frames into a deliverable:
a landscape MP4, a vertical cut, a GIF, or stills. It is the last stage of
the pipeline and the one a viewer actually judges.

Nothing in `src/**` touches `chrome.*`, `browser.*`, or `apps/` — the
boundary test enforces it. The package runs in the extension's offscreen
document today and in a desktop app later, unchanged.

## Two rules that are easy to get wrong

**SP5 owes this package `anchorRects` and `cursorSamples`.** They are not
optional decoration. Without `anchorRects` the camera falls back to
capture-time rects that the replayed page may have moved, so the zoom frames
the wrong thing. Without `cursorSamples` the compositor synthesizes a cursor
from its own plan — correct for a mutating scene that never replayed, but a
`source: "replay"` bundle that omits them is a broken seam, and
`validateBundle` rejects it for exactly that reason.

**A deliverable is never produced by capturing a preview surface.** Every
output frame is composed offline from `outputTimeMs`, never from wall clock,
and muxed at constant fps. SP1 built both and the difference was the whole
finding: the realtime-assembled sample was visibly janky from the *assembly
path*, not from the harvest. `MediaRecorder` and anything else that records a
live surface is banned from the deliverable path. SP7's scrubbing preview
calls `renderFrame()` — the same renderer pointed at a canvas — but what the
user downloads comes from `renderScene()`.

## The three stages

```
scene document ──▶ planScene()   ──▶ RenderPlan       (no frames needed)
     + bundle  ──▶ resolvePlan() ──▶ ResolvedPlan     (pure, still no pixels)
                ─▶ renderScene() ──▶ bytes            (canvas, encoder)
```

**`planScene(scene)` is frameless on purpose.** Cursor paths, camera intent,
cosmetic bindings and the retiming policy are all derivable from the document
alone. That is what lets SP5 consume `plan.cursorSegments` to drive a replay
*before* a single frame exists — the inversion contract: the compositor plans
the path, replay dispatches it, replay hands the samples back, and the
compositor draws the cursor from what was actually sent. It is also what let
this package be built against fixtures instead of serializing behind SP5.

**`resolvePlan(plan, bundle, scene, hints)`** is the bundle-dependent stage.
Still pure, still canvas-free, but it now knows where elements really were
(`bundle.anchorRects` wins over the scene's capture-time rects) and where the
source was moving. It solves the camera curve over *output* time and builds
the timeline.

**`renderScene({ plan, bundle, scene, target, ports })`** is the streaming
loop. One canvas, reused. The loop owns frame fetching: it pulls exactly one
source frame, hands `renderFrame` a one-shot source that returns the frame
already in hand, and lets it go before the next iteration. Encoded chunks
leave immediately. Nothing accumulates, because MV3 memory limits are a named
platform risk and a crashed render is a broken promise where a slower one is
only slower.

It returns `{ bytes, detailViolations }`. `renderStills` returns
`{ files, detailViolations }`. **Print the violations.** They are the camera
zoom that had to be cut back because the source frames could not back it;
silently upscaling to hit a resolution number is the shortcut a
side-by-side comparison punishes.

**`renderStills` takes each default still from its action's keyframe, not
from its marker.** A still is the one output with no motion to preserve, and
keyframes carry the deliverable's resolution while motion spans are upscaled
transients — so a marker that lands inside a motion span is pulled to the
keyframe tagged with the same `actionId`. Caller-supplied `outputTimesMs` are
honoured exactly; a caller asking for its own times is asking for frames, not
for beats. The substitution moves the *output* time, so the frame, camera,
cursor and cosmetics all move together.

Note that the still therefore shows the action's *settled* state — the frame
the harvest tagged for that action — which for a click whose result covers
its own target is the outcome rather than the pointer-on-target instant.

**Known condition: the motion stream can arrive at 1× CSS resolution.**
Screencast frames track the physical compositor surface and ignore emulated
DPR, so a DPR-3 scene captured on a 1× display (or headless, as the harvested
fixture is) yields 3840×2400 keyframes beside a 1280×800 motion stream — a
1.62× upscale into the 4K landscape frame before the camera moves at all.
The clamp cannot fix it — it never cuts below 1.0 — but since 2026-09-21
`detailViolations` does report it: a violation whose `grantedScale` equals its
`requestedScale` is an upscale with no zoom cut, and `sourceWidth /
neededWidth` is the sampling the deliverable got. How much upscaling a real
render does is a property of the replay host's display. See the design doc's
frame-bundle section.

### Retiming

Dead air plays back at its recorded duration, verbatim — the min/max idle
clamp (`RETIMING_DEFAULTS.minIdleMs`/`maxIdleMs`) was removed on 2026-09-08:
it invented a duration the take never had, squeezing a six-second pause down
to 0.4s and stretching a 50ms one up to 120ms. In-app motion always played at
rate 1.0 and still does. Motion is found three ways, cheapest first: a
harvested `motionSpan`, a `keyframeOnly` degradation (SP5 reporting motion it
could not keep), and keyframe diffing, which lives in the render layer
because it needs pixels.

**Pacing.** How long the stretch between two steps plays for is carried on
`SceneDocument.edits.gaps` and resolved by `planScene` into `RenderPlan.paces`
— one `PlannedPace` per adjacent action pair. It is a union, not a number
with a label:

- `{ origin: "authored", idleTargetMs }` — the author set a gap. The number
  is the IDLE duration only: motion between the pair always plays at rate 1.0
  and is *added* to it, so `setGap(…, 0)` cuts the dead air and leaves a
  dropdown animation intact.
- `{ origin: "recorded", recordedSpanMs }` — nobody edited it, so the pair
  plays for as long as the take recorded. The whole interval, motion
  included, because `planScene` is the frameless stage and `action.timestamp`
  cannot tell a page settling apart from an author sitting still.

`paces` is `PlannedPace[] | null`, and the two must not collapse: `[]` means
"computed, and this take has no pairs", `null` means "this plan was built
without a scene, so pacing is unknown" — `buildTimeline` accepts hand-built
plans and must not render one at replay speed as though that were the
recorded pace.

`buildTimeline` consumes `paces` in two places, and each is gated to one
bundle mode so an authored gap is never applied twice:

| | Recording (`source: "capture"`) | Rebuild (`source: "replay"`) |
| --- | --- | --- |
| Where the pause lives | already in the bundle, as elapsed source time | nowhere — replay raced |
| What runs | `idleOutputFor` sets the pair's idle segments' output duration | `paceInstants` inserts a `"pace"` segment |
| Authored gap | idle plays for `idleTargetMs` | freeze of `max(0, idleTargetMs − replayIdle)` |
| Recorded pace | no-op; the bundle already holds it | freeze of `max(0, recordedSpanMs − elapsed)` |

Both sides measure against **idle**, never the whole marker span
(`idleTargetMsFor` is the one place the union becomes a number). That is what
makes render mode a toggle over provenance rather than over length: the same
scene renders to the same `outputDurationMs` through either bundle, up to
whatever the app's own response time did differently between the two runs.
`packages/compositor/test/node/timeline.test.ts`'s "one pacing policy, two
render modes" asserts it.

A `"pace"` segment is structurally a `"hold"` — `srcStartMs === srcEndMs`,
output advancing over a frozen source instant — and kept distinct so the
editor can tell a reconstructed pause from an authored freeze. It lands at
the END of the stretch, on the next marker, so whatever the page did while
responding plays at 1x before the freeze begins. Never negative: if replay
ran slower than the author, nothing is inserted and nothing is compressed
either (v8 §4 — compression is a cut on dead air, never a speed-up through
motion).

A pace whose two markers the bundle does not carry is counted in
`Timeline.unplacedPaces` rather than dropped. A rebuild that stopped early is
the common cause and not the only one, so the count names the condition and
leaves the cause to its caller; `Degradation.kind` carries `"pacingUnplaced"`
as the shared word for it, and the extension's Capture lane is what says so
to an author. Dropping one silently would be a video shorter than the take
with nothing to tell it apart from a take that was simply short — the exact
defect this feature exists to remove.

## The `FrameBundle` contract

`src/bundle.ts` is SP6's input and SP5's output obligation. All coordinates
are CSS pixels in the emulated viewport, so the bundle is DPR-independent;
each frame records the pixels that actually arrived.

| Field | What it is | Notes |
| --- | --- | --- |
| `keyframes` | full-resolution PNG stills, ascending | honour emulated DPR; at least one required |
| `motionSpans` | encoded/streamed stretches of real in-app motion | routinely *smaller* than `viewport × dpr` — the screencast is capped at the physical compositor surface, and the compositor upscales |
| `cursorSamples` | what replay actually dispatched, ascending | **required when `source: "replay"`** |
| `anchorRects` | where each action's anchor really was, per action | **SP5 must produce these** |
| `markers` | the source time of each action's beat | drives the click pulse, the camera lead-in, and the default still times |
| `degradations` | spans replay could not keep faithfully | `keyframeOnly` is read as motion, never as dead air |

A keyframe should land *exactly* on a motion span's end. Frames are served by
"newest keyframe at or before this time", so a gap between a span's end and
the next keyframe is served by the last keyframe *before* the span — the
deliverable flashes back to the pre-action page and then forward again.

## The five ports

Everything platform-shaped is an interface in `src/ports/types.ts`, which is
what keeps `src/**` free of extension APIs.

| Port | Production | In tests |
| --- | --- | --- |
| `FrameSource` | `createImageFrameSource` (stills), `createVideoFrameSource` (encoded spans) | procedural canvases |
| `Surface` | `createOffscreenSurface` | same |
| `VideoSink` | `createMp4Sink` (mediabunny, H.264) | `createRecordingVideoSink` |
| `GifSink` | `createGifSink` (gifenc) | `createRecordingGifSink` |
| `ImageSink` | `createPngSink` | `createCollectingImageSink` |

The compositor does not care whether a frame was a hi-res keyframe, an
upscaled motion frame, or a rectangle drawn on a canvas — which is exactly
what let SP6 develop ahead of SP5.

## Testing: two fixture tiers

A fixture belongs in the browser lane iff its assertion depends on layout,
pixels, or a real encoder.

- `test/node/**` — geometry, timing, the camera solver, bundle validation,
  plan determinism, the package boundary.
- `test/browser/**` — Chromium, via `@vitest/browser`: rasterization, the
  encode → mux → demux → decode roundtrip, GIF encode, the surface-capped
  upscale path.

**Procedural fixtures** (`test/fixtures/`) are checked in, tiny and
deterministic: frames drawn programmatically with known motion spans, anchor
rects and dead air. They back every unit test. They prove correctness and
they cannot prove anything else — coloured rectangles look fine no matter how
bad the shadow, the easing or the cursor are.

**Harvested fixtures** are generated on demand into `.fixtures/`, which is
git-ignored. `scripts/fixture-app.html` is a real-looking app with real text
at real sizes; the harvest drives it with Playwright and CDP and writes a
bundle with DPR-3 keyframes, a surface-capped JPEG motion span with real
timing jitter, dispatched cursor samples and measured anchor rects.

```bash
pnpm --filter @demoman/compositor harvest         # → packages/compositor/.fixtures/
pnpm --filter @demoman/compositor render:fixture  # → packages/compositor/.fixtures/out/
```

The render script bundles `scripts/render-entry.ts` with esbuild and runs it
in headless Chromium, because the renderer needs `OffscreenCanvas` and
WebCodecs and Node has neither — the same arrangement as the extension's
offscreen document. It prints every detail clamp.

`scripts/fixture-scene.ts` carries the anchor rects the page actually lays
out. They are load-bearing: `planScene` is frameless, so the planned cursor
path has nothing else to aim at, and the harvest dispatches that path into
the live page. The harvest re-measures every anchor and fails if the page has
drifted away from them.

**A green suite is not the quality gate.** The suite cannot see whether the
zoom eases or snaps, whether the cursor arrives before the click pulse,
whether the shadow seats the frame or leaves it floating like a sticker,
whether the motion span plays at natural speed, or whether a dead-air cut is
clean. A human plays `.fixtures/out/landscape.mp4` beside a reference
recording and judges. Scripts live in `scripts/`, which the boundary test
does not scan — it walks `src/` only — and they run under `tsx` in Node, so
they may use `node:fs`.

## Limitations

- **Overlay substitution typography.** Text replacements drawn over the frame
  approximate the page's own type. Replay-path substitution is the faithful
  one; a replacement with no `targetAnchorId` has no rect to draw into and is
  skipped by the overlay renderer entirely.
- **One H.264 generation on motion spans.** A harvested span is already
  encoded; recomposing it means decode → compose → re-encode.
- **No audio.** Nothing in the pipeline carries or muxes an audio track.
- **No App Store preview output.** Out of scope for Part I.
- **Solid and gradient backgrounds only.** The presented background is
  `branding.background`, painted as stored (schema v6): a solid colour or a
  two-stop linear gradient at a CSS angle. Image backgrounds are not yet
  supported.
- **The frame shadow's scale is an approximation under `cover`.**
  `drawFrameChrome` sizes both shadow passes from `frameRect.height / 800`,
  which reads the frame's height as if it still corresponded to an 800 px
  viewport. That holds under `contain`, where the frame carries the capture's
  aspect. Under `cover` it does not: `VERTICAL_1080` gives a 1747.2 px frame,
  so the wide pass blurs ~131 px at an 86 px margin and is largely clipped by
  the canvas edge. The contact pass still seats the frame and the rendered
  vertical does not float, so this is cosmetic — but the heuristic is
  approximate rather than principled, and a target whose padding and aspect
  diverge further would expose it. The principled version would scale off the
  padded margin, which is what the shadow actually has room to occupy.
