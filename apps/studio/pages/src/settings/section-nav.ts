// apps/studio/pages/src/settings/section-nav.ts

/**
 * Which section the Settings nav marks as current.
 *
 * The last section whose top has crossed `line` (a fraction of the window
 * down from its top), or the first when none has. At the foot of the page
 * it is the last section outright: Diagnostics is short and last, so at the
 * bottom of the page its top still sits well below the line, and a rule
 * that only asked "whose top has crossed" never marked it (found in the
 * mockup on 2026-10-06).
 */
export function currentSection(
  sections: ReadonlyArray<{ id: string; top: number }>,
  view: { height: number; atFoot: boolean },
  line = 0.3,
): string | null {
  if (sections.length === 0) return null;
  if (view.atFoot) return sections[sections.length - 1]?.id ?? null;
  let current = sections[0]?.id ?? null;
  for (const s of sections) if (s.top <= view.height * line) current = s.id;
  return current;
}

/** How long a click holds its section current while the scroll it started
 *  is still travelling. Smooth scrolling passes over the sections between,
 *  and the nav should not flicker through them. */
const CLICK_HOLD_MS = 800;

/**
 * Keeps `[data-nav]` links' `aria-current` on the section in view. The nav
 * is rebuilt on every render, so the links are looked up afresh each time
 * and the page calls `mark()` after a render to put the mark back.
 */
export function trackSectionNav(root: HTMLElement): { mark(): void } {
  let held: string | null = null;
  let release: ReturnType<typeof setTimeout> | undefined;
  const links = () => [
    ...root.querySelectorAll<HTMLAnchorElement>("a[data-nav]"),
  ];
  const set = (id: string | null) => {
    for (const a of links())
      a.setAttribute("aria-current", String(a.dataset.nav === id));
  };
  const mark = () => {
    if (held !== null) return set(held);
    const doc = document.documentElement;
    const sections = links().flatMap((a) => {
      const id = a.dataset.nav ?? "";
      const s = document.getElementById(id);
      return s === null ? [] : [{ id, top: s.getBoundingClientRect().top }];
    });
    set(
      currentSection(sections, {
        height: window.innerHeight,
        atFoot: window.scrollY + window.innerHeight >= doc.scrollHeight - 2,
      }),
    );
  };
  root.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(
      "a[data-nav]",
    );
    if (link === null || link === undefined) return;
    held = link.dataset.nav ?? null;
    set(held);
    clearTimeout(release);
    release = setTimeout(() => {
      held = null;
      mark();
    }, CLICK_HOLD_MS);
  });
  window.addEventListener("scroll", mark, { passive: true });
  window.addEventListener("resize", mark);
  return { mark };
}
