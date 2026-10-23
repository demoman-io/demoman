// apps/studio/pages/src/shell/switch.ts
//
// The shell's switch: a real checkbox as the hit target with the shell's
// `.switch-track` painted over it (assets/shell.css). Settings and the
// editor's Cursor panel both build theirs here; until 2026-10-06 each page
// had its own copy of this markup, and neither animated.
//
// Why neither animated: both pages rebuild their DOM after every change
// (`replaceChildren`), so the switch the author clicked was thrown away a
// few milliseconds into its 120ms transition, and the one that replaced it
// was born already at rest in the new position. The popup never had the
// problem, because it flips `checked` on the element it already holds.
//
// So a click is remembered here, by key, and a switch rebuilt while that
// slide is still due picks it up where the old element left off: it takes
// `data-flip` and a negative `--switch-elapsed`, and the shell's keyframes
// (which are keyed on the input's own state, so they run either way) play
// the rest. A rebuild that comes back in the OTHER state — the write was
// refused, and the page put the switch back — slides back from where the
// click sent it rather than snapping.

/** Longer than any click-to-render round trip, and far longer than the
 *  shell's 120ms slide. Past it a rebuilt switch is simply at rest: by then
 *  there is nothing left of the slide to continue. */
const FLIP_HORIZON_MS = 1000;

/** The last click on each switch, by key: the state it sent the switch to,
 *  and when. Module state because the element that was clicked does not
 *  survive the render this has to reach across. */
const flips = new Map<string, { on: boolean; at: number }>();

/** Tests only: forgets every click, so a switch a case mounts does not
 *  slide on from a click an earlier case made inside the horizon. */
export function forgetSwitchFlips(): void {
  flips.clear();
}

export interface SwitchOptions {
  /** Names this switch across rebuilds; unique within the page. */
  key: string;
  checked: boolean;
  disabled?: boolean;
  /** Set on the input: `data-*` hooks, `aria-label` for a switch that does
   *  not sit inside a `<label>`. */
  attrs?: Record<string, string>;
  /** The new state, from `click`: by the time a checkbox's click handlers
   *  run its `checked` already holds it, and jsdom's `.click()` dispatches
   *  click reliably where `change` did not reach. */
  onChange(on: boolean): void;
}

export function switchControl(options: SwitchOptions): HTMLSpanElement {
  const { key, checked } = options;
  const box = document.createElement("span");
  box.className = "switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = options.disabled ?? false;
  input.setAttribute("role", "switch");
  // Written here so a test can wait on what a render wrote rather than on
  // the native flip.
  input.setAttribute("aria-checked", checked ? "true" : "false");
  for (const [name, value] of Object.entries(options.attrs ?? {}))
    input.setAttribute(name, value);
  const track = document.createElement("span");
  track.className = "switch-track";
  track.setAttribute("aria-hidden", "true");
  box.append(input, track);

  const now = performance.now();
  const flip = flips.get(key);
  if (flip !== undefined && now - flip.at > FLIP_HORIZON_MS) flips.delete(key);
  else if (flip !== undefined) {
    // Same state: the slide the click began, continued. Other state: the
    // page refused it, so the switch slides back from now.
    const elapsed = flip.on === checked ? now - flip.at : 0;
    if (flip.on !== checked) flips.set(key, { on: checked, at: now });
    box.setAttribute("data-flip", "");
    box.style.setProperty("--switch-elapsed", `${-elapsed}ms`);
  }
  // Once the slide is done the attribute has nothing left to say, and left
  // in place it would turn the next click's transition into a snap.
  track.addEventListener("animationend", () =>
    box.removeAttribute("data-flip"),
  );

  input.addEventListener("click", () => {
    box.removeAttribute("data-flip");
    flips.set(key, { on: input.checked, at: performance.now() });
    options.onChange(input.checked);
  });
  return box;
}

/** A switch with its label (and, optionally, a line saying what it does)
 *  before it: the whole row is the `<label>`, so a click on the words
 *  flips it too. Label-left, switch-right — the order Chrome's and macOS's
 *  settings use. A switch inside a Settings site fact goes in the fact's
 *  control slot instead, bare, with an `aria-label` of its own. */
export function switchRow(
  label: string,
  hint: string | null,
  control: HTMLElement,
): HTMLLabelElement {
  const row = document.createElement("label");
  row.className = "switch-row";
  const text = document.createElement("span");
  text.className = "switch-text";
  const strong = document.createElement("strong");
  strong.textContent = label;
  text.append(strong);
  if (hint !== null) {
    const line = document.createElement("span");
    line.className = "hint";
    line.textContent = hint;
    text.append(line);
  }
  row.append(text, control);
  return row;
}
