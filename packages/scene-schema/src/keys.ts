import { z } from "zod";

/** The keys a `press` could always name: no modifiers, no free text. */
export const PRESS_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
] as const;
export type PressKey = (typeof PRESS_KEYS)[number];

/**
 * Apple's display order, used for storage, display and `formatKeyCombo`
 * alike, so one combo has one spelling. `Mod` is ⌘ on every take: a take is
 * filmed as a Mac whatever machine records it.
 */
export const MODIFIERS = ["Ctrl", "Alt", "Shift", "Mod"] as const;
export type Modifier = (typeof MODIFIERS)[number];
export const ModifierSchema = z.enum(MODIFIERS);

/** The named keys; any one printable ASCII character is a key too. */
export const KEY_NAMES: readonly string[] = [
  ...PRESS_KEYS,
  "Home",
  "End",
  "PageUp",
  "PageDown",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];

/** Whether `s` is a key as a take stores it: a name, or one printable character. */
export const isKeyName = (s: string): boolean =>
  KEY_NAMES.includes(s) || /^[!-~]$/.test(s);

const isModifier = (s: string): s is Modifier =>
  (MODIFIERS as readonly string[]).includes(s);

type Fail = { ok: false; message: string };

/** Names to a set, or the sentence for the first that is not a modifier or is repeated. */
function modifierSet(
  names: string[],
  whole: string,
  notModifier: (name: string) => string,
): { ok: true; modifiers: Modifier[] } | Fail {
  const seen = new Set<string>();
  for (const name of names) {
    if (!isModifier(name)) return { ok: false, message: notModifier(name) };
    if (seen.has(name))
      return { ok: false, message: `"${name}" is named twice in "${whole}"` };
    seen.add(name);
  }
  return { ok: true, modifiers: MODIFIERS.filter((m) => seen.has(m)) };
}

/**
 * Parse `"Mod+Shift+K"`: modifiers in any order (each once), then one key.
 * Modifier names are case-sensitive; a letter key is stored uppercase. A key
 * of `+` is written `"+"` or `"Mod++"`. The press step keeps its text and the
 * engine parses it again here, so the door and the run read it alike.
 */
export function parseKeyCombo(
  text: string,
): { ok: true; modifiers: Modifier[]; key: string } | Fail {
  let names: string[];
  let rawKey: string;
  if (text === "+") {
    names = [];
    rawKey = "+";
  } else if (text.endsWith("++")) {
    names = text.slice(0, -2).split("+");
    rawKey = "+";
  } else {
    names = text.split("+");
    rawKey = names.pop() as string;
  }
  if (isModifier(rawKey)) {
    return {
      ok: false,
      message: `"${text}" names no key: end it with one, like "${text}+K"`,
    };
  }
  if (names.includes("")) {
    return {
      ok: false,
      message: `"${text}" has an empty name beside a "+": write each name once, like "Mod+Shift+K", or "Mod++" for the + key`,
    };
  }
  const mods = modifierSet(
    names,
    text,
    (n) =>
      `"${n}" is not a modifier: write Mod (⌘ on every take), Shift, Alt or Ctrl`,
  );
  if (!mods.ok) return mods;
  const key = /^[a-z]$/.test(rawKey) ? rawKey.toUpperCase() : rawKey;
  if (!isKeyName(key)) {
    return {
      ok: false,
      message: `"${text}" names no key Demoman can press: Enter, Tab, Escape, Backspace, Delete, Space, an arrow, Home, End, PageUp, PageDown, F1–F12, or one character`,
    };
  }
  return { ok: true, modifiers: mods.modifiers, key };
}

/** Parse a click's `holding`: modifiers only, joined by `+`. */
export function parseHolding(
  text: string,
): { ok: true; modifiers: Modifier[] } | Fail {
  const mods = modifierSet(
    text.split("+"),
    text,
    () => 'holding takes modifiers only, like "Shift" or "Mod+Shift"',
  );
  if (!mods.ok) return mods;
  if (mods.modifiers.includes("Ctrl")) {
    return {
      ok: false,
      message:
        'holding Ctrl is a right-click on a Mac and a plain click elsewhere; write button: "right"',
    };
  }
  return mods;
}

/** `Shift+Mod+K`, in `MODIFIERS` order; the modifiers alone without a key. */
export function formatKeyCombo(
  modifiers: readonly Modifier[],
  key?: string,
): string {
  const ordered = MODIFIERS.filter((m) => modifiers.includes(m));
  return (key === undefined ? ordered : [...ordered, key]).join("+");
}
