import { el } from "./dom";

/**
 * Which panel sections the author has opened or closed, for the life of
 * the page.
 *
 * Every titled block in the inspector is a `<details>`; the UA toggles
 * it, and this remembers the result so the next render — an edit, a
 * selection and back — does not re-collapse what the author opened. The
 * Steps disclosure kept one boolean for this; the rail's panels have
 * several sections, so it is a map keyed by `data-section`.
 *
 * Absence is "never toggled" and reads as the caller's default. That is
 * a state and not a fault, so there is nothing to report on a miss.
 */
export interface Sections {
  isOpen(name: string, fallback: boolean): boolean;
  set(name: string, open: boolean): void;
}

export function createSections(): Sections {
  const open = new Map<string, boolean>();
  return {
    isOpen: (name, fallback) => open.get(name) ?? fallback,
    set: (name, value) => {
      open.set(name, value);
    },
  };
}

/**
 * A `<details data-section=name>` whose summary is the heading and whose
 * `open` comes from — and is written back to — `sections`.
 *
 * `forceOpen` is for the render where something inside has just become worth
 * seeing: a share that reached its gate, an export that came back with a
 * quality warning. It opens the section over the author's stored preference
 * and does NOT overwrite it, so the next fold they make is still theirs and
 * the render after this one respects it.
 *
 * That second half is the whole reason this is a parameter rather than an
 * `open = true` at the call site. `details.open = true` fires `toggle` — a
 * task later, so a listener attached after the assignment still hears it —
 * and the listener recorded it as the author's own choice. The section was
 * then pinned open in `sections` by code, and a fold the author made on the
 * next render read as "they want it open" all over again.
 *
 * The body is returned separately: callers fill it with `replaceChildren`,
 * which would take a summary inside with it.
 */
export function section(
  name: string,
  heading: string,
  sections: Sections,
  defaultOpen: boolean,
  forceOpen = false,
): { details: HTMLDetailsElement; body: HTMLDivElement } {
  const details = el("details");
  details.setAttribute("data-section", name);
  details.open = forceOpen || sections.isOpen(name, defaultOpen);
  // The last state this code put the element in. A `toggle` that agrees with
  // it is the echo of that assignment — including the async one the line
  // above queues — and is not the author speaking; anything else is.
  let ours = details.open;
  // Stored, not re-rendered: the UA has already toggled by the time this
  // fires, and a render here would fight a mid-toggle animation.
  details.addEventListener("toggle", () => {
    if (details.open !== ours) sections.set(name, details.open);
    ours = details.open;
  });
  details.append(el("summary", undefined, heading));
  const body = el("div");
  details.append(body);
  return { details, body };
}
