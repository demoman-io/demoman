import { rectFromQuad } from "./geometry.js";
import type { CdpSession, Rect } from "./types.js";

/**
 * Did the click the engine just dispatched arrive where it was sent?
 *
 * Found on 2026-10-13, in both executors: Chromium sometimes delivered a
 * click at exactly 2/3 of the point it was sent to — the display's device
 * pixel ratio (2) over the emulated one (`REPLAY_DPR`, 3). Sometimes only the
 * release moved (pressed on the button, released on the backdrop: the browser
 * fires `click` on their common ancestor and the button never activates);
 * sometimes the press too, and the whole click landed on whatever was at 2/3
 * of the point — in the store-assets sample app a backdrop whose own click
 * handler closed the form. Either way the step did not happen, and the run
 * reported `complete` with a verdict of `matches`. The cause was input sent
 * while a still was being captured, and `input-gate.ts` now keeps the two
 * apart; this check stays as the guard, because a run that says it clicked
 * must know that it did.
 *
 * So this asks the page. Before the press, a listener goes on the target's
 * own window (capture phase, trusted events only) and keeps the first
 * pointerdown and pointerup it sees, and the target is measured in two
 * spaces at one moment — by CDP in the space the engine dispatches in, and by
 * the page in its own client coordinates. Those two rects map the point the
 * engine sends to the point the page should see it at, which keeps the check
 * right inside an iframe (offset client coordinates) and on a scaled frame.
 * After the release, both events are read back and compared with that point.
 *
 * What the page's own code does on the press — open a menu over the target,
 * move the target away — does not trip this: the events are judged by where
 * they arrived, not by what was under them by then.
 */
export const CLICK_PROBE_MARKER = "__demomanClickProbe";

/**
 * The binding the probe's listeners report each event through as it
 * arrives (`createClickSightings`). The read after the release is what
 * judges a click; this is what is left when the read cannot be had.
 *
 * Measured 2026-10-13: after a click that submits a form to a slow page,
 * the read did not answer until the new page committed — seconds — and then
 * failed, its page gone, so every navigating click to a slow page was
 * reported `clickUnconfirmed`. A binding call reaches the engine as an event
 * the moment the listener runs, before any navigation the click starts.
 */
export const CLICK_SIGHTING_BINDING = "__demomanClickSeen";

/** Further than this from where it was sent, in the pixels the engine
 *  dispatches in, an event arrived somewhere else. Two absorbs the rounding of
 *  mapping a point between the two spaces; the defect moved a click by a third
 *  of its coordinates, tens to hundreds of pixels. */
export const CLICK_DRIFT_PX = 2;

/** Further apart than this, in CDP's pixels, the target's two CDP boxes say it
 *  moved while it was being measured (`placeClickProbe`). */
export const CLICK_MEASURE_SLACK_PX = 0.5;

/** How many brackets `placeClickProbe` takes before it calls a target moving.
 *  Measured 2026-10-13 in Chromium, a click sent 0-150 ms into a 300 ms hover
 *  transition: one bracket caught the motion on 18 of 100 clicks (a
 *  `transform: scale` transition) and 12 of 100 (a `width` one), each an
 *  unconfirmed click on a page that did nothing wrong. Each bracket is about
 *  a millisecond and catches a frame boundary independently, so five leave
 *  that at about 2 in 10,000. */
export const CLICK_MEASURE_TRIES = 5;

/** Installed with `this` = the target element, and optionally the probe's
 *  token: given one, each event is also reported through
 *  `CLICK_SIGHTING_BINDING` when the page has it. Answers an object whose
 *  `read()` removes the listeners and says what they saw. */
export const CLICK_PROBE_INSTALL = `function(token){
  const ${CLICK_PROBE_MARKER} = true;
  const doc = this.ownerDocument;
  const view = doc && doc.defaultView;
  if (!view) return null;
  const rect = () => {
    const box = this.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  };
  let own = rect();
  const viewport = { width: view.innerWidth, height: view.innerHeight };
  const seen = { down: null, up: null, cancelled: false };
  const point = (e) => ({ x: e.clientX, y: e.clientY });
  const binding = view[${JSON.stringify(CLICK_SIGHTING_BINDING)}];
  const report = typeof token === "string" && typeof binding === "function"
    ? () => { try { binding(JSON.stringify({ token, own, viewport, ...seen })); } catch (_) {} }
    : () => undefined;
  const onDown = (e) => { if (e.isTrusted && seen.down === null) { seen.down = point(e); report(); } };
  const onUp = (e) => { if (e.isTrusted && seen.up === null) { seen.up = point(e); report(); } };
  // A native drag ends in a drop, not a pointerup: it is the release.
  const onDrop = (e) => { if (e.isTrusted && seen.up === null) { seen.up = point(e); report(); } };
  const onCancel = (e) => { if (e.isTrusted) { seen.cancelled = true; report(); } };
  view.addEventListener("pointerdown", onDown, true);
  view.addEventListener("pointerup", onUp, true);
  view.addEventListener("pointercancel", onCancel, true);
  view.addEventListener("drop", onDrop, true);
  const target = this;
  return {
    measure() { own = rect(); },
    read() {
      view.removeEventListener("pointerdown", onDown, true);
      view.removeEventListener("pointerup", onUp, true);
      view.removeEventListener("pointercancel", onCancel, true);
      view.removeEventListener("drop", onDrop, true);
      const root = target.getRootNode();
      const active = root && root.activeElement;
      // A label passes its click to its control, so a type aimed at the
      // label lands in the control: that is the field, focused.
      const control = target.control;
      return {
        own,
        viewport,
        down: seen.down,
        up: seen.up,
        cancelled: seen.cancelled,
        focused: !!active && (active === target || target.contains(active) || (!!control && active === control)),
      };
    },
  };
}`;

const CLICK_PROBE_READ = `function(){ const ${CLICK_PROBE_MARKER} = true; return this.read(); }`;
const CLICK_PROBE_MEASURE = `function(){ const ${CLICK_PROBE_MARKER} = true; this.measure(); }`;

interface Point {
  x: number;
  y: number;
}

/**
 * Said in the walk's note when a `type`'s click could not be confirmed and
 * focus went somewhere other than its field. Not the browser's fault the way
 * a misdelivered click is: the target may not be the field at all (a button
 * that opens one), so the report moves the agent differently
 * (`clickNotDeliveredDetail`), and finds this case by these words.
 */
export const TYPE_FIELD_UNFOCUSED = "its field did not hold focus";

/** What the page's listeners saw, as `read()` answers it. */
export interface ClickSeen {
  /** The target's client rect when the probe was placed, in the page's own
   *  coordinates — the frame's, inside an iframe. */
  own: Rect;
  /** The target's window's viewport, in the same coordinates: a click sent
   *  outside it reaches nothing on the page. */
  viewport: { width: number; height: number };
  down: Point | null;
  up: Point | null;
  cancelled: boolean;
  /** Whether the target (or something inside it, or the control a label
   *  target names) held focus afterwards. */
  focused: boolean;
}

/**
 * - `delivered`: the press and the release both arrived where they were sent.
 * - `misdelivered`: one of them arrived somewhere else, so the page saw no
 *   click on the target.
 * - `unconfirmed`: the page could not say — the probe could not be placed or
 *   read (the click navigated away, most often), the target could not be
 *   measured or was moving, an event was never seen, or the browser cancelled
 *   the pointer. Not evidence of a miss, and not of a hit either; `why` says
 *   which, so the caller can report it rather than count it as either.
 */
export type ClickVerdict =
  | { kind: "delivered"; seen: ClickSeen }
  | { kind: "misdelivered"; seen: ClickSeen; why: string }
  /** `seen` whenever the page answered: what a `type` is judged by — whether
   *  its field holds focus — does not depend on the events being seen. */
  | { kind: "unconfirmed"; why: string; seen?: ClickSeen };

const at = (p: Point): string => `(${Math.round(p.x)}, ${Math.round(p.y)})`;

/**
 * Where a point the engine dispatched should arrive in the page: `sent` is
 * in the space `box` was measured in (CDP's), and the answer is in the space
 * of `own` (the page's client coordinates), with the scale between the two —
 * page pixels per dispatched pixel. A zero-sized rect has no scale to read,
 * so it maps by offset alone.
 */
export function pagePointOf(
  sent: Point,
  box: Rect,
  own: Rect,
): Point & { scale: Point } {
  const sx = box.width > 0 && own.width > 0 ? own.width / box.width : 1;
  const sy = box.height > 0 && own.height > 0 ? own.height / box.height : 1;
  return {
    x: own.x + (sent.x - box.x) * sx,
    y: own.y + (sent.y - box.y) * sy,
    scale: { x: sx, y: sy },
  };
}

/**
 * The verdict on what the page saw against `expected`, where the click was
 * sent in the page's coordinates, with `scale` page pixels per dispatched one
 * — so the tolerance is a count of dispatched pixels on a scaled page too.
 * Pure, so every branch has a test.
 *
 * Only an event that ARRIVED somewhere else is evidence of a miss. One that
 * was never seen is not: a page whose own earlier window listener calls
 * `stopImmediatePropagation` on it hides it from the probe, and a
 * deterministic stop blamed on the browser would follow every run on that
 * page. So a missing event reads `unconfirmed`, unless the one that did
 * arrive landed elsewhere — and both shapes measured on 2026-10-13 had an
 * event far from where it was sent.
 */
export function clickVerdict(
  seen: ClickSeen,
  expected: Point,
  scale: Point = { x: 1, y: 1 },
): ClickVerdict {
  return judge(
    seen,
    expected,
    expected,
    scale,
    `sent to ${at(expected)}`,
    null,
  );
}

/**
 * A drag's verdict: the press judged against where it pressed, the release
 * against where it let go, by `clickVerdict`'s rules. A drag's release is
 * meant to land far from its press, which `clickVerdict` would call a miss.
 */
export function dragVerdict(
  seen: ClickSeen,
  start: Point,
  end: Point,
  scale: Point = { x: 1, y: 1 },
  touch = false,
): ClickVerdict {
  return judge(
    seen,
    start,
    end,
    scale,
    `sent from ${at(start)} to ${at(end)}`,
    touch ? "touch" : "mouse",
  );
}

function judge(
  seen: ClickSeen,
  press: Point,
  release: Point,
  scale: Point,
  sent: string,
  /** A drag, and by what: a native mouse drag cancels its pointer as it
   *  begins and then drops, so a release seen after a cancel is that drag,
   *  not a cancelled one. A touch has no native drag. */
  dragging: "mouse" | "touch" | null,
): ClickVerdict {
  // A touch the browser cancelled is one it took as its own pan or zoom,
  // whatever the drop target would have done: the fix is the gesture or the
  // page's `touch-action`, not the end.
  if (dragging === "touch" && seen.cancelled) {
    return {
      kind: "unconfirmed",
      why: "the browser cancelled the touch, taking it as its own scroll or zoom (the page's touch-action), so the page never saw the drag",
      seen,
    };
  }
  // A native drag that began and found no drop target: Chrome cancels the
  // pointer at dragstart and, with nothing accepting the drop, fires none.
  if (dragging === "mouse" && seen.cancelled && seen.up === null) {
    return {
      kind: "unconfirmed",
      why: "the drag began, and nothing at its end accepted the drop",
      seen,
    };
  }
  if (seen.cancelled && !(dragging === "mouse" && seen.up !== null)) {
    return {
      kind: "unconfirmed",
      why: "the browser cancelled the pointer, so no click was dispatched to check",
      seen,
    };
  }
  // Sent outside the page's viewport: whatever arrives there — the events
  // land on the document itself — no element was clicked. Found 2026-10-13
  // when an app's script failed to load and its sheet never slid in: its
  // fields sat past the viewport's right edge, the engine clicked them there,
  // the events arrived exactly where they were sent, and that read as
  // delivered.
  const outside = (p: Point): boolean =>
    p.x < 0 ||
    p.y < 0 ||
    p.x > seen.viewport.width ||
    p.y > seen.viewport.height;
  if (outside(press) || outside(release)) {
    return {
      kind: "misdelivered",
      seen,
      why: `${sent}, outside the page's ${Math.round(seen.viewport.width)}x${Math.round(seen.viewport.height)} viewport — the target is off screen — so it reached nothing`,
    };
  }
  const { down, up } = seen;
  if (down === null && up === null) {
    return {
      kind: "unconfirmed",
      why: "neither the press nor the release reached the target's page",
      seen,
    };
  }
  const far = (p: Point, expected: Point): boolean =>
    Math.abs(p.x - expected.x) / scale.x > CLICK_DRIFT_PX ||
    Math.abs(p.y - expected.y) / scale.y > CLICK_DRIFT_PX;
  const arrival = (p: Point | null): string =>
    p === null ? "was never seen" : `arrived at ${at(p)}`;
  const said = `${sent}, the press ${arrival(down)} and the release ${arrival(up)}`;
  if (
    (down !== null && far(down, press)) ||
    (up !== null && far(up, release))
  ) {
    return { kind: "misdelivered", seen, why: said };
  }
  if (down === null || up === null) {
    return {
      kind: "unconfirmed",
      why: `${said} — the page's own code may have kept it from the check`,
      seen,
    };
  }
  return { kind: "delivered", seen };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A placed probe and the target's rect in CDP's space at that moment, or
 *  why it could not be placed. `token` names its reports to
 *  `ClickSightings`; null when it was placed without one. */
export type ClickProbe =
  | {
      probeId: string;
      token: string | null;
      box: Rect | null;
      unmeasured: string | null;
    }
  | { unplaced: string };

/**
 * What every probe's listeners reported through `CLICK_SIGHTING_BINDING`,
 * by token — the last report each sent, which holds everything it had seen
 * by then.
 */
export interface ClickSightings {
  /** Asks the browser for the binding. Never throws: a page without it
   *  leaves the probe's read as the only word, and `unavailable` says why. */
  install(): Promise<void>;
  of(token: string): ClickSeen | null;
  /** Why no reports can come, or null. */
  unavailable(): string | null;
  stop(): Promise<void>;
}

export function createClickSightings(cdp: CdpSession): ClickSightings {
  const seen = new Map<string, ClickSeen>();
  let why: string | null = "the binding was never asked for";
  const off = cdp.on("Runtime.bindingCalled", (params) => {
    if (params.name !== CLICK_SIGHTING_BINDING) return;
    let report: unknown;
    try {
      report = JSON.parse(String(params.payload));
    } catch {
      return;
    }
    const r = report as Partial<ClickSeen & { token: unknown }> | null;
    // Exactly what a read answers, focus aside: it went with the page.
    const sighting = {
      own: r?.own,
      viewport: r?.viewport,
      down: r?.down,
      up: r?.up,
      cancelled: r?.cancelled,
      focused: false,
    };
    if (typeof r?.token === "string" && isSeen(sighting)) {
      seen.set(r.token, sighting);
    }
  });
  return {
    async install() {
      try {
        await cdp.send("Runtime.addBinding", { name: CLICK_SIGHTING_BINDING });
        why = null;
      } catch (error) {
        why = `the page could not be given a way to report clicks (${messageOf(error)})`;
      }
    },
    of: (token) => seen.get(token) ?? null,
    unavailable: () => why,
    async stop() {
      off();
      // Best effort: it only stops reports nobody is listening for now.
      await cdp
        .send("Runtime.removeBinding", { name: CLICK_SIGHTING_BINDING })
        .catch(() => undefined);
    },
  };
}

/** The target's border box in CDP's space, or why it has none. */
async function boxOf(
  cdp: CdpSession,
  objectId: string,
): Promise<Rect | string> {
  try {
    const model = (await cdp.send("DOM.getBoxModel", { objectId })).model as
      | { border?: number[] }
      | undefined;
    return model?.border === undefined
      ? "it has no box"
      : rectFromQuad(model.border);
  } catch (error) {
    return messageOf(error);
  }
}

const moved = (a: Rect, b: Rect): boolean =>
  Math.abs(a.x - b.x) > CLICK_MEASURE_SLACK_PX ||
  Math.abs(a.y - b.y) > CLICK_MEASURE_SLACK_PX ||
  Math.abs(a.width - b.width) > CLICK_MEASURE_SLACK_PX ||
  Math.abs(a.height - b.height) > CLICK_MEASURE_SLACK_PX;

/**
 * Place the listeners on the target's window and measure the target in
 * CDP's space. Never throws, because a click must not fail for want of a
 * check on it; the caller reports the reason instead.
 *
 * The page measures itself as the listeners go on, and CDP measures the
 * target either side of that: two boxes that agree mean the page's rect is
 * of the same moment, so the mapping between the two spaces is the frame's
 * and not the difference between two frames of an animation. A target that
 * moved in between (a panel still sliding, a layout that keeps reflowing)
 * is bracketed again, the page measuring itself anew each time, and only a
 * target that moved through `CLICK_MEASURE_TRIES` brackets leaves the click
 * unjudged rather than misjudged. A hover transition still running as the
 * cursor arrives is the everyday case, a `transform` one included: the
 * bracket trips when a frame lands inside it (measured, see the constant).
 * Not every motion: one that comes back to where it started within a
 * bracket, about a millisecond, passes it with the page's rect from mid-way,
 * and the click would read as a miss. Layout motion that fast on a control a
 * step means to click is not something a page has been seen to do.
 */
export async function placeClickProbe(
  cdp: CdpSession,
  objectId: string,
  token: string | null = null,
): Promise<ClickProbe> {
  let before = await boxOf(cdp, objectId);
  let probeId: string;
  try {
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: CLICK_PROBE_INSTALL,
      arguments: token === null ? [] : [{ value: token }],
      returnByValue: false,
    });
    const result = reply.result as { objectId?: unknown } | undefined;
    if (typeof result?.objectId !== "string") {
      return {
        unplaced:
          "the target has no window to listen on (it is not in a document)",
      };
    }
    probeId = result.objectId;
  } catch (error) {
    return { unplaced: messageOf(error) };
  }
  let after = await boxOf(cdp, objectId);
  for (
    let tries = 1;
    tries < CLICK_MEASURE_TRIES &&
    typeof before !== "string" &&
    typeof after !== "string" &&
    moved(before, after);
    tries++
  ) {
    before = await boxOf(cdp, objectId);
    try {
      await cdp.send("Runtime.callFunctionOn", {
        objectId: probeId,
        functionDeclaration: CLICK_PROBE_MEASURE,
      });
    } catch (error) {
      return {
        probeId,
        token,
        box: null,
        unmeasured: `the target was moving as it was measured, and could not be measured again (${messageOf(error)})`,
      };
    }
    after = await boxOf(cdp, objectId);
  }
  if (typeof before === "string")
    return { probeId, token, box: null, unmeasured: before };
  if (typeof after === "string")
    return { probeId, token, box: null, unmeasured: after };
  if (moved(before, after)) {
    return {
      probeId,
      token,
      box: null,
      unmeasured: "the target was moving as it was measured",
    };
  }
  return { probeId, token, box: after, unmeasured: null };
}

/**
 * Take the listeners down without judging anything: the click never went
 * out (its dispatch threw), and a probe left on the page would keep a
 * listener on the author's own tab and a handle on the target. Best effort —
 * the dispatch's own failure is what the caller reports.
 */
export async function discardClickProbe(
  cdp: CdpSession,
  probe: ClickProbe,
): Promise<void> {
  if ("unplaced" in probe) return;
  await readClickProbe(cdp, probe, { x: 0, y: 0 });
}

/** Read the probe back and judge it against `sent`, the point the engine
 *  dispatched both events at. Never throws, for the same reason. A read the
 *  page went away from is answered by what its listeners reported through
 *  `sightings` as the events arrived, when they did. */
export async function readClickProbe(
  cdp: CdpSession,
  probe: ClickProbe,
  sent: Point,
  sightings: ClickSightings | null = null,
  /** A drag's release point and whether it was a touch; absent for a
   *  click, whose release is `sent`. */
  drag: { releasedAt: Point; touch: boolean } | null = null,
): Promise<ClickVerdict> {
  if ("unplaced" in probe) {
    return {
      kind: "unconfirmed",
      why: `the click could not be checked: ${probe.unplaced}`,
    };
  }
  let value: unknown;
  try {
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: probe.probeId,
      functionDeclaration: CLICK_PROBE_READ,
      returnByValue: true,
    });
    value = (reply.result as { value?: unknown } | undefined)?.value;
  } catch (error) {
    const reported =
      probe.token === null ? null : (sightings?.of(probe.token) ?? null);
    if (reported === null) {
      const none = sightings?.unavailable() ?? null;
      return {
        kind: "unconfirmed",
        why: `the page went away before the click could be checked (${messageOf(error)})${none === null ? "" : `, and ${none}`}`,
      };
    }
    // The page went away — most often the click navigated it — but its
    // listeners said what arrived before it did. Focus went with the page,
    // so a `type` judged on this is judged as unfocused.
    value = reported;
  }
  // The probe's handle, let go. Its only failure is a page that went away
  // after the read answered, which leaves nothing holding anything.
  await cdp
    .send("Runtime.releaseObject", { objectId: probe.probeId })
    .catch(() => undefined);
  if (!isSeen(value)) {
    return {
      kind: "unconfirmed",
      why: "the click check answered with nothing this could read",
    };
  }
  // Judged after the read, so the listeners are down whatever the verdict.
  if (probe.box === null) {
    return {
      kind: "unconfirmed",
      why: `the target could not be measured as the click was sent (${probe.unmeasured}), so where it arrived could not be judged`,
      seen: value,
    };
  }
  const expected = pagePointOf(sent, probe.box, value.own);
  if (drag !== null) {
    const end = pagePointOf(drag.releasedAt, probe.box, value.own);
    return dragVerdict(value, expected, end, expected.scale, drag.touch);
  }
  return clickVerdict(value, expected, expected.scale);
}

function isPoint(v: unknown): v is Point {
  const p = v as { x?: unknown; y?: unknown } | null | undefined;
  return typeof p?.x === "number" && typeof p?.y === "number";
}

function isRect(v: unknown): v is Rect {
  const r = v as { width?: unknown; height?: unknown } | null | undefined;
  return (
    isPoint(v) && typeof r?.width === "number" && typeof r?.height === "number"
  );
}

function isSeen(v: unknown): v is ClickSeen {
  const s = v as Partial<ClickSeen> | undefined;
  return (
    typeof s === "object" &&
    s !== null &&
    isRect(s.own) &&
    typeof s.viewport?.width === "number" &&
    typeof s.viewport?.height === "number" &&
    (s.down === null || isPoint(s.down)) &&
    (s.up === null || isPoint(s.up)) &&
    typeof s.cancelled === "boolean" &&
    typeof s.focused === "boolean"
  );
}
