# Brand assets

The canonical mark and lockups. This directory belongs to no app, which is
the point: the code is FSL and the docs and the site are all rights
reserved, and when one of them leaves for its own repo the brand has to be
somewhere none of them owns.

| File | What it is |
| --- | --- |
| `logomark.svg` | the mark: the bare figure, filled `currentColor`, on a square, as demoman.io's header draws it. Copied into the Studio (below) |
| `icon.svg` | the same figure, asking for 32px where nothing sizes it. Copied into the Studio (below) |
| `banner_light.svg`, `banner_dark.svg` | the README's header: the figure alone, centred on a wide banner, dark for GitHub's light theme and light for its dark one |
| `logo.svg` | the app tile: the white figure on the near-black `#0a0a0a`, with a hairline ring. demoman.io's icon at 512 |
| `lockup_light.svg`, `lockup_dark.svg` | the tile beside the wordmark, a 4:1 banner, for a place that wants the name beside the mark. The README does not use them (below). Copied into the Studio (below) |
| `wordmark.svg` | "Demoman" in Outfit 600 as outlines, filled `currentColor`: demoman.io's header wordmark, for places that cannot load the font. Written by the author's `internal/tools/make-wordmark.py`, which reads the site's copy of Outfit. Set into the docs' logos (below) |

Every file but `wordmark.svg` is written by the author's
`internal/site/scripts/icons.mjs`, from the same figure that draws
demoman.io's icons, so the README, the site and this folder cannot drift
apart. `node internal/site/scripts/icons.mjs --svgs` rewrites the SVGs alone,
without Chrome.

## The mark is the figure, used sparingly

demoman.io shows the figure twice, once in the header and once in the
footer, and the wordmark once, beside the header's figure. The README keeps
the figure alone at the top, and the name once, as its heading. The play-button head
on its own, the old 16px favicon, is not a mark any more.

## The marks have copies, deliberately

Each consumer holds its own copy so it can be extracted without reaching
across the workspace for an asset:

| Copy | Why it exists |
| --- | --- |
| `apps/studio/pages/public/images/logomark.svg`, `icon.svg`, `lockup_light.svg`, `lockup_dark.svg` | served inside the Studio's pages. The page bars still name them, but the Studio draws its own inline figure and hides them (`studio.css`, `.logomark`) |
| `apps/docs/logo/light.svg`, `logo/dark.svg` | the docs site's logos at demoman.io/docs: demoman.io's header lockup, `logomark.svg`'s figure (cropped to `258 120 96 302`, 28px tall) 14px from `wordmark.svg` (as Outfit 600 at 19px), filled `#0a0a0a` for light mode and `#f4f4f5` for dark |

Copies drift. Two tests hold them to this directory, each on the side that
owns the copy, so each one keeps working after a split:

- `apps/studio/test/pages/node/brand-copies.test.ts` — every studio copy
- `apps/cli/test/docs.test.ts` — the docs logos

**After re-running `icons.mjs`**, copy the four studio files over
(`brand-copies.test.ts` goes red until they match). After re-running
`make-wordmark.py`, re-run `icons.mjs` (the lockups set the wordmark) and
rebuild the two docs logos from the figure and the wordmark with their fills
(`docs.test.ts` goes red until they match). The Studio's favicon
(`pages/public/icon/32.png`, served as `/favicon.ico`) is a byte copy of the
site's 32px tab icon, which `icons.mjs` writes and
`internal/site/test/product-docs.test.mjs` holds.

## demoman.io: the figure beside the wordmark

Since 2026-10-25 demoman.io's header sets the figure from `logomark.svg`
inline, 28px tall, 14px left of the Outfit wordmark as live text (19px,
600), with no tile; the wordmark folds away as the page scrolls. (From
2026-10-19 to then the two sat apart, the figure at the bar's centre.) The
site copies no lockup or mark file; the docs' logos are this lockup as SVG.

Its icons (`favicon.ico`, the touch and PWA icons) and `og.png` are drawn
in the same look by `internal/site/scripts/icons.mjs`: the white figure on the
near-black `#0a0a0a`, on a rounded tile with a hairline ring, the whole
figure at every size. They replaced the author's D tile of 2026-10-11 on
2026-10-19. demoman.io/docs takes the same icon: its favicon is a byte copy
of the site's `icon-512.png` (the script makes it), held by
`internal/site/test/product-docs.test.mjs`.

If the figure's geometry changes here, change the site's inline copies by
hand (`internal/site/public/` `index.html`, `privacy.html`, and the page in
`src/worker.js`) and the paths at the top of `internal/site/scripts/icons.mjs`,
then re-run it.
