// SP6 compositor. In: frames + event log. Out: MP4, vertical cut, GIF, stills.
// Recorded per render in meta.toolchain.compositorVersion.
//
// Must equal package.json's `version` — boundary.test.ts reads that file and
// compares. This constant sat at 1.0.0 through 54 commits of renderer
// changes, so nothing stamped on a scene said which renderer made it. 1.1.0
// marks the 2026-09-06 audit: one composition shared with the editor
// preview, unavailable spans and empty outputs reported, gif timing fixed.
export const COMPOSITOR_VERSION = "1.1.0";
