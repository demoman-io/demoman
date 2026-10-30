// apps/studio/pages/src/shell/icons.ts

/** The extension's glyphs: Lucide outlines (MIT), 24-unit, stroked in the
 *  current colour. Decorative wherever they appear — every one sits
 *  beside words, or inside a control whose `aria-label` carries the name —
 *  so each is hidden from the accessibility tree. Lived in
 *  `library/view.ts` until 2026-09-14, when the popup needed one too. */
const GLYPHS = {
  /** Edit a take. Lucide `clapperboard`, not a pencil: a pencil says
   *  "edit this text or field", and a take is a video. It replaced
   *  `scissors` on 2026-09-22 — scissors reads as cut or trim, one edit
   *  among many, where the clapperboard says "work on this take". */
  clapperboard: [
    "m12.296 3.464 3.02 3.956",
    "M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z",
    "M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    "m6.18 5.276 3.1 3.899",
  ],
  /** The Recordings page, on the popup's button, the nav tab and the
   *  empty library. Lucide `monitor-play` (v1.52.0), its screen's rect
   *  written as a path. It replaced `video` on 2026-10-06: the camera says
   *  "record", and this is where recordings are watched and kept. */
  monitorPlay: [
    "M15.033 9.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56V7.648a.645.645 0 0 1 .967-.56z",
    "M12 17v4",
    "M8 21h8",
    "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
  ],
  /** The popup's device picker: what Record films (2026-10-11). Lucide
   *  `monitor`, `smartphone` and `tablet`, their rects and lines written as
   *  paths: `monitor` is `monitorPlay`'s screen without the play mark. */
  monitor: [
    "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M8 21h8",
    "M12 17v4",
  ],
  smartphone: [
    "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
    "M12 18h.01",
  ],
  tablet: [
    "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
    "M12 18h.01",
  ],
  /** Recording a video, on the consent card's list of what an agent may
   *  do. Lucide `video`. */
  video: [
    "m22 8-6 4 6 4V8Z",
    "M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
  ],
  /** The Settings gear, on the popup's foot and the nav tab. */
  settings: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  ],
  trash: [
    "M3 6h18",
    "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  ],
  file: [
    "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z",
    "M14 2v6h6",
  ],
  cloud: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"],
  restore: [
    "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
    "M3 3v5h5",
    "M12 7v5l4 2",
  ],
  image: [
    "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    "M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
  ],
  /** Export: the download arrow — the file leaves the editor. */
  download: [
    "M12 15V3",
    "m7 10 5 5 5-5",
    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
  ],
  /** Put one thing in another's place: the confirm dialog's Replace.
   *  Lucide `refresh-cw`. Not `repeat`, which is the transport's loop
   *  toggle and would say "again" rather than "instead". */
  refresh: [
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ],
  /** Dismiss. The close control on the shortcuts overlay. */
  close: ["M18 6 6 18", "m6 6 12 12"],
  /** Add a mask, on the Mask lane's header. Lucide `plus`. */
  plus: ["M5 12h14", "M12 5v14"],
  /** Leave the editor for the Recordings page. Lucide `chevron-left`: a
   *  bare chevron, not `arrow-left`. The arrow is the browser's own Back —
   *  the one that walks history — and this control does not walk history,
   *  it goes to one named page whether or not there is anything behind it.
   *  Drawing the browser's glyph for a different promise is the confusion
   *  worth avoiding. */
  chevronLeft: ["m15 18-6-6 6-6"],
  /** The split button's caret. Lucide `chevron-down`. */
  chevronDown: ["m6 9 6 6 6-6"],
  /** The consent cards' code check. Lucide `shield-check` (v0.577.0). */
  shieldCheck: [
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "m9 12 2 2 4-4",
  ],
  /** The split button's selected item. Lucide `check`. */
  check: ["M20 6 9 17l-5-5"],
  /** Step back through the edit history. Lucide `undo-2`. */
  undo: [
    "M9 14 4 9l5-5",
    "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11",
  ],
  /** Step forward again. Lucide `redo-2`, the mirror of `undo`. */
  redo: [
    "m15 14 5-5-5-5",
    "M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13",
  ],
  /** The transport's four. Lucide `play`, `pause`, `rewind`,
   *  `fast-forward` — the set every NLE draws, so the pair either side of
   *  play reads as shuttle (a rate that doubles per press) rather than as
   *  skip-to-edge, which is a different command on Home/End. Outlines like
   *  the rest of this table: `icon()` strokes and never fills, so a
   *  triangle written closed still draws as a triangle outline. */
  play: ["M6 3 20 12 6 21Z"],
  pause: [
    "M7 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
    "M15 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
  ],
  /** Jump to the start of the trimmed take. Lucide `skip-back`, filled to
   *  match the four transport glyphs beside it: a bar the playhead stops
   *  against and a triangle running back into it. */
  skipBack: ["M6 5h2v14H6Z", "M21 19l-11-7 11-7Z"],
  rewind: ["M11 19 2 12l9-7Z", "M22 19l-9-7 9-7Z"],
  fastForward: ["M13 19l9-7-9-7Z", "M2 19l9-7-9-7Z"],
  /** Repeat, on the transport's loop toggle. Lucide `repeat`, and stroked
   *  rather than filled like the four above it: it reports a MODE the
   *  transport is in, not a direction it is moving, and the solid triangles
   *  beside it are what say "this one moves the take". */
  repeat: [
    "m17 2 4 4-4 4",
    "M3 11v-1a4 4 0 0 1 4-4h14",
    "m7 22-4-4 4-4",
    "M21 13v1a4 4 0 0 1-4 4H3",
  ],
  /**
   * The keyboard-commands overlay. Lucide `keyboard`.
   *
   * Its outline is a `rect` in Lucide's own source; written as a path here
   * because `icon()` emits paths only, and a second element type would be a
   * new shape for every glyph after it to think about.
   */
  /** The shortcuts overlay's own control. Lucide `circle-question-mark`.
   *  It replaced a `keyboard` glyph on 2026-09-21: the overlay is reached by
   *  pressing `?`, the button is labelled with that key, and a question mark
   *  is the sign every app uses for "what can I press here" — a miniature
   *  keyboard drawn at 20px read as an unidentifiable grid of dots.
   *
   *  Lucide draws the ring as `<circle cx="12" cy="12" r="10">`; this table
   *  is paths only (`icon()` appends nothing else), so it is written as the
   *  two-arc form `settings` already uses for their circles. */
  circleQuestionMark: [
    "M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0z",
    "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3",
    "M12 17h.01",
  ],
  /** The editor's notes button. Lucide `circle-alert`, its circle written
   *  as the two-arc path `circleQuestionMark` uses and its two lines as
   *  paths, for the reason given there. */
  circleAlert: [
    "M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0z",
    "M12 8v4",
    "M12 16h.01",
  ],
  /** Lucide `mouse-pointer-2`, the bare arrow: the Cursor panel, which
   *  styles the arrow the video paints, and Settings' Replay. */
  mousePointer2: [
    "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z",
  ],
  /** The "Allow an agent?" page: the agent asking (Lucide `bot`, its rect
   *  written as a path), and "open any site you're signed into" (Lucide
   *  `globe`, its circle written as a path). */
  bot: [
    "M12 8V4H8",
    "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
    "M2 14h2",
    "M20 14h2",
    "M15 13v2",
    "M9 13v2",
  ],
  globe: [
    "M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0z",
    "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
    "M2 12h20",
  ],
  /** The Clip lane's step icons beside the two pointers below: Lucide
   *  `type`, `move-vertical`, `hourglass` (the author, 2026-10-19). */
  type: ["M12 4v16", "M4 7V4h16v3", "M9 20h6"],
  moveVertical: ["M12 2v20", "m8 18 4 4 4-4", "m8 6 4-4 4 4"],
  /** A drag step on the Clip lane (2026-10-21). Lucide `hand-grab`,
   *  copied from lucide-react 0.577.0's own icon node, not drawn by hand. */
  handGrab: [
    "M18 11.5V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4",
    "M14 10V8a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2",
    "M10 9.9V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v5",
    "M6 14a2 2 0 0 0-2-2a2 2 0 0 0-2 2",
    "M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8 2 2 0 1 1 4 0",
  ],
  hourglass: [
    "M5 22h14",
    "M5 2h14",
    "M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22",
    "M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2",
  ],
  /** Lucide `mouse-pointer-click`, the arrow clicking: the Selection panel,
   *  for the thing the author clicked on the timeline, and the approve
   *  page's "click and type" grants. Named for Lucide rather than for a
   *  panel since 2026-10-19, when Cursor and Selection swapped glyphs and
   *  a `cursor` glyph would have drawn Selection. */
  mousePointerClick: [
    "M14 4.1 12 6",
    "m5.1 8-2.9-.8",
    "m6 12-1.9 2",
    "M7.2 2.2 8 5.1",
    "M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z",
  ],
  /** The timeline's three track headers, each drawn in its lane's hue.
   *  Lucide `film`, `zoom-in` and `eye-off`, copied from lucide 0.577; the
   *  rect and circle of the first two written as paths for the reason
   *  `circleQuestionMark` gives. Film rather than `video` for the Clip
   *  track: `video` is the camera — a take on the Recordings page — and
   *  the track holds the strip of footage the take became. Eye-off for
   *  Mask because a mask hides what it covers. */
  film: [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M7 3v18",
    "M3 7.5h4",
    "M3 12h18",
    "M3 16.5h4",
    "M17 3v18",
    "M17 7.5h4",
    "M17 16.5h4",
  ],
  zoomIn: [
    "M19 11a8 8 0 1 1-16 0 8 8 0 1 1 16 0z",
    "M21 21 16.65 16.65",
    "M11 8v6",
    "M8 11h6",
  ],
  eyeOff: [
    "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
    "M14.084 14.158a3 3 0 0 1-4.242-4.242",
    "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
    "m2 2 20 20",
  ],
  /** The timeline's view tools on the transport row, copied from lucide
   *  0.577. `zoomOut` pairs with `zoomIn` above at the slider's two ends;
   *  Lucide `magnet` is snapping, the sign every editor uses for it; and
   *  `move-horizontal` is Fit, the take spread across the full width. */
  zoomOut: [
    "M19 11a8 8 0 1 1-16 0 8 8 0 1 1 16 0z",
    "M21 21 16.65 16.65",
    "M8 11h6",
  ],
  magnet: [
    "m12 15 4 4",
    "M2.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.029-6.029a1 1 0 1 1 3 3l-6.029 6.029a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.365-6.367A1 1 0 0 0 8.716 4.282z",
    "m5 8 4 4",
  ],
  moveHorizontal: ["m18 8 4 4-4 4", "M2 12h20", "m6 8-4 4 4 4"],
  /** The timeline's Split (2026-10-22). Lucide `scissors` (v0.460.0), its
   *  two circles in the two-arc form the table uses. */
  scissors: [
    "M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
    "M8.12 8.12 12 12",
    "M20 4 8.12 15.88",
    "M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
    "M14.8 14.8 20 20",
  ],
  /** Full screen, on the stage bar. Lucide `maximize`. */
  maximize: [
    "M8 3H5a2 2 0 0 0-2 2v3",
    "M21 8V5a2 2 0 0 0-2-2h-3",
    "M3 16v3a2 2 0 0 0 2 2h3",
    "M16 21h3a2 2 0 0 0 2-2v-3",
  ],
  /** Leaving it. Lucide `minimize` — the same four corners turned inward. */
  minimize: [
    "M8 3v3a2 2 0 0 1-2 2H3",
    "M21 8h-3a2 2 0 0 1-2-2V3",
    "M3 16h3a2 2 0 0 1 2 2v3",
    "M16 21v-3a2 2 0 0 1 2-2h3",
  ],
  /** A Settings site's Production icon: the live server. Lucide `server`,
   *  its two racks written as paths. */
  server: [
    "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
    "M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z",
    "M6 6h.01",
    "M6 18h.01",
  ],
  /** A Settings site's Analytics rules icon. Lucide `chart-column`. */
  chartColumn: ["M3 3v16a2 2 0 0 0 2 2h16", "M18 17V9", "M13 17V5", "M8 17v-3"],
  /** A closed fold — a Settings site, a Recordings day — turned a quarter
   *  to say open. Lucide `chevron-right`. */
  chevronRight: ["m9 18 6-6-6-6"],
  /** The Brand kit in the Settings nav. Lucide `palette`, its four dots
   *  written as zero-length round-capped strokes. */
  palette: [
    "M13.5 6.5h.01",
    "M17.5 10.5h.01",
    "M8.5 7.5h.01",
    "M6.5 12.5h.01",
    "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z",
  ],
  /** Diagnostics in the Settings nav. Lucide `activity`. */
  activity: [
    "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
  ],
  /** The default brand kit, on its tile in Settings. Lucide `star`; the
   *  default's is filled by the page's CSS, the rest are outlines. */
  star: [
    "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
  ],
  /** Upload or replace a logo. Lucide `upload`. */
  upload: [
    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
    "m17 8-5-5-5 5",
    "M12 3v12",
  ],
  /** Duplicate a brand kit. Lucide `copy`, its rect written as a path. */
  copy: [
    "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z",
    "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
  ],
} as const;

export type GlyphName = keyof typeof GLYPHS;

const SVG = "http://www.w3.org/2000/svg";

/**
 * The glyphs that are drawn SOLID rather than as outlines.
 *
 * The transport's four, and a property of those glyphs rather than of the
 * row they sit in: every media player draws play, pause and the shuttle
 * pair filled, and a hollow play triangle at 20px reads as an arrow
 * pointing somewhere rather than as a play button.
 *
 * Filled *and* still stroked, which is why `icon` sets fill without
 * clearing the stroke: the round joins the rest of this table uses are
 * what keep the triangle's tip from drawing as a needle. Every path here
 * closes, or a fill would leak across the shape's open side.
 */
const FILLED = new Set<GlyphName>([
  "play",
  "pause",
  "rewind",
  "fastForward",
  "skipBack",
]);

export function icon(name: GlyphName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", FILLED.has(name) ? "currentColor" : "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-icon", name);
  for (const d of GLYPHS[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
