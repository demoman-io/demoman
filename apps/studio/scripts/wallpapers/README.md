# Built-in wallpapers

The ten files per shape in `apps/studio/pages/public/wallpapers/` are made
here, not drawn by hand (spec `2026-10-28-wallpapers-design.md`, "The built-in
set"). Regenerate them rather than editing a bitmap.

| File | What it is |
| --- | --- |
| `measure.mjs` | Measures Apple's abstract macOS wallpapers on this Mac and writes `palette.json`. |
| `palette.json` | The measured hue, saturation, lightness and contrast ranges per family, and the names of the images measured. Numbers only. |
| `recipes.json` | One entry per wallpaper id: its colours (positions inside its family's ranges), a seed, and its layers. |
| `generate.mjs` | Draws each recipe in Playwright's Chromium and writes the WebP files. |

## Regenerate

From the repo root, after `pnpm install`:

    node apps/studio/scripts/wallpapers/generate.mjs --sheet /tmp/contact-sheet.png

It prints each file's size, the 30-file total and one `swatch <id> from … to …`
line per wallpaper. Copy those swatches into `WALLPAPERS` in
`packages/scene-schema/src/wallpapers.ts` (the Solid/Gradient colours a
wallpaper hands over). `--only vivid-1,dark-2` remakes some;
`--preview <dir>` draws every shape at a 1600px long side into `<dir>`
instead, for iterating on `recipes.json` in seconds.
`apps/studio/test/node/wallpaper-files.test.ts` checks the sizes and the
budget.

To re-measure (macOS only; scratch must be outside the repo):

    node apps/studio/scripts/wallpapers/measure.mjs "$TMPDIR/apple-measure"
    pnpm exec biome format --write apps/studio/scripts/wallpapers/palette.json

## Nothing of Apple's is in the repo

`measure.mjs` converts each image to a PNG of at most 512px with `sips` in the
scratch folder you name, reads its pixels, and writes only numbers and file
names to `palette.json`. No Apple image, crop or traced shape is committed or
shipped; the shapes and composition are drawn from `recipes.json`.

Measured on 2026-10-28 on macOS 27.2: 70 images decoded, 56 kept: the
abstract and colour-field sets only (Big Sur Graphic, Chroma, Grid, hello,
Hello Metallic, iMac, Iridescence, Light Stream, Mac, Monterey Graphic,
Motion, Radial, Sonoma, Studio Color, Ventura Graphic); photos of places are
not looked at. Most were the 214×130 thumbnails macOS keeps on disk, since
the full-size pictures are downloaded on demand; the iMac, Mac, Sonoma and
Radial Sky Blue sets and Hello Metallic Yellow were full size. Each image is
filed by what it measures: dark under a median lightness of 0.25, light over
0.7, vivid between; greys and silvers (median saturation under 0.4) are no
family's. `palette.json`'s `measuredFrom` lists them.

## Why 9600

The background is drawn inside the camera transform, so it scales with the
zoom: the long side it needs is the largest export long side times the
deepest zoom.

- Largest export long side: 3840 (MP4's top tier; stills cap at
  `MAX_STILL_SIDE = 3840`).
- Deepest zoom: `CAMERA_DEFAULTS.maxScale = 2.5`.
- **3840 × 2.5 = 9600.** The masters are 4:3 (9600×7200, and 7200×9600 for
  portrait), so a cover fit of any frame from 4:3 to 21:9 is limited by the
  long side and gets the full 9600.

The effective figure is lower in two places, and the set is not sized down for
either: a 9:16 export's camera is capped at `verticalMaxScale = 1.15`, so it
needs 3840 × 1.15 = 4416 on the portrait's long side; and padding means the
recording, not the background, fills most of the frame at 3840. Both still
show the background edge to edge at the frame's corners, and an Auto frame
from a tall window can be portrait at 2.5, so portrait stays at 9600 too.

## Size

WebP quality 0.97, after a ±1-level triangular dither (below one level, so not
grain) that keeps slow gradients from stepping into 8-bit bands. At 0.92 the
encoder flattened the dither and a dark gradient showed bands 60–80px wide; at
0.98 two recipes measured 2.0–2.2 MB a master, about 42 MB for the set, over
the 40 MB budget. At 0.97 the 30 files total 20.1 MB.
