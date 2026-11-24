import type { Modifier, PressKey } from "@demoman/scene-schema";

import type { CdpSession } from "./types.js";

type KeyEvent = {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
};

/** What CDP needs to press each named key. `text` is what the key types:
 *  Enter submits a form only when its keyDown carries a carriage return. */
export const KEY_EVENTS: Record<PressKey, KeyEvent> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
};

const NAVIGATION: Record<string, number> = {
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

/** US punctuation: [unshifted, shifted, code, VK_OEM]. */
const PUNCTUATION: readonly [string, string, string, number][] = [
  [";", ":", "Semicolon", 186],
  ["=", "+", "Equal", 187],
  [",", "<", "Comma", 188],
  ["-", "_", "Minus", 189],
  [".", ">", "Period", 190],
  ["/", "?", "Slash", 191],
  ["`", "~", "Backquote", 192],
  ["[", "{", "BracketLeft", 219],
  ["\\", "|", "Backslash", 220],
  ["]", "}", "BracketRight", 221],
  ["'", '"', "Quote", 222],
];
/** Index = the digit key the character sits on. */
const SHIFTED_DIGITS = ")!@#$%^&*(";

/** The key event for a key as a take stores it (`parseKeyCombo`'s key). */
export function keyEventOf(key: string, shift: boolean): KeyEvent {
  const named = (KEY_EVENTS as Partial<Record<string, KeyEvent>>)[key];
  if (named !== undefined) return named;
  const nav = NAVIGATION[key];
  if (nav !== undefined) return { key, code: key, windowsVirtualKeyCode: nav };
  const fn = /^F([1-9]|1[0-2])$/.exec(key);
  if (fn) return { key, code: key, windowsVirtualKeyCode: 111 + Number(fn[1]) };
  if (/^[A-Za-z]$/.test(key)) {
    const printed = shift ? key.toUpperCase() : key.toLowerCase();
    return {
      key: printed,
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      text: printed,
    };
  }
  if (/^[0-9]$/.test(key))
    return {
      key,
      code: `Digit${key}`,
      windowsVirtualKeyCode: key.charCodeAt(0),
      text: key,
    };
  const digit = key.length === 1 ? SHIFTED_DIGITS.indexOf(key) : -1;
  if (digit !== -1)
    return {
      key,
      code: `Digit${digit}`,
      windowsVirtualKeyCode: 48 + digit,
      text: key,
    };
  for (const [plain, shifted, code, vk] of PUNCTUATION)
    if (key === plain || key === shifted)
      return { key, code, windowsVirtualKeyCode: vk, text: key };
  throw new Error(`keyEventOf: no key event for "${key}"`);
}

/** Playwright 1.62.1 `macEditingCommands`, minus its `insert…` commands (the
 *  key's text inserts) and the trailing `:`. Keyed as Playwright keys it:
 *  the held `Shift`, `Control`, `Alt`, `Meta`, then the code, joined by `+`. */
const MAC_COMMANDS: Record<string, string | string[]> = {
  Backspace: "deleteBackward",
  Escape: "cancelOperation",
  ArrowUp: "moveUp",
  ArrowDown: "moveDown",
  ArrowLeft: "moveLeft",
  ArrowRight: "moveRight",
  F5: "complete",
  Delete: "deleteForward",
  Home: "scrollToBeginningOfDocument",
  End: "scrollToEndOfDocument",
  PageUp: "scrollPageUp",
  PageDown: "scrollPageDown",
  "Shift+Backspace": "deleteBackward",
  "Shift+Escape": "cancelOperation",
  "Shift+ArrowUp": "moveUpAndModifySelection",
  "Shift+ArrowDown": "moveDownAndModifySelection",
  "Shift+ArrowLeft": "moveLeftAndModifySelection",
  "Shift+ArrowRight": "moveRightAndModifySelection",
  "Shift+F5": "complete",
  "Shift+Delete": "deleteForward",
  "Shift+Home": "moveToBeginningOfDocumentAndModifySelection",
  "Shift+End": "moveToEndOfDocumentAndModifySelection",
  "Shift+PageUp": "pageUpAndModifySelection",
  "Shift+PageDown": "pageDownAndModifySelection",
  "Shift+Numpad5": "delete",
  "Control+Tab": "selectNextKeyView",
  "Control+KeyA": "moveToBeginningOfParagraph",
  "Control+KeyB": "moveBackward",
  "Control+KeyD": "deleteForward",
  "Control+KeyE": "moveToEndOfParagraph",
  "Control+KeyF": "moveForward",
  "Control+KeyH": "deleteBackward",
  "Control+KeyK": "deleteToEndOfParagraph",
  "Control+KeyL": "centerSelectionInVisibleArea",
  "Control+KeyN": "moveDown",
  "Control+KeyO": "moveBackward",
  "Control+KeyP": "moveUp",
  "Control+KeyT": "transpose",
  "Control+KeyV": "pageDown",
  "Control+KeyY": "yank",
  "Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter",
  "Control+ArrowUp": "scrollPageUp",
  "Control+ArrowDown": "scrollPageDown",
  "Control+ArrowLeft": "moveToLeftEndOfLine",
  "Control+ArrowRight": "moveToRightEndOfLine",
  "Shift+Control+Tab": "selectPreviousKeyView",
  "Shift+Control+KeyA": "moveToBeginningOfParagraphAndModifySelection",
  "Shift+Control+KeyB": "moveBackwardAndModifySelection",
  "Shift+Control+KeyE": "moveToEndOfParagraphAndModifySelection",
  "Shift+Control+KeyF": "moveForwardAndModifySelection",
  "Shift+Control+KeyN": "moveDownAndModifySelection",
  "Shift+Control+KeyP": "moveUpAndModifySelection",
  "Shift+Control+KeyV": "pageDownAndModifySelection",
  "Shift+Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter",
  "Shift+Control+ArrowUp": "scrollPageUp",
  "Shift+Control+ArrowDown": "scrollPageDown",
  "Shift+Control+ArrowLeft": "moveToLeftEndOfLineAndModifySelection",
  "Shift+Control+ArrowRight": "moveToRightEndOfLineAndModifySelection",
  "Alt+Backspace": "deleteWordBackward",
  "Alt+Escape": "complete",
  "Alt+ArrowUp": ["moveBackward", "moveToBeginningOfParagraph"],
  "Alt+ArrowDown": ["moveForward", "moveToEndOfParagraph"],
  "Alt+ArrowLeft": "moveWordLeft",
  "Alt+ArrowRight": "moveWordRight",
  "Alt+Delete": "deleteWordForward",
  "Alt+PageUp": "pageUp",
  "Alt+PageDown": "pageDown",
  "Shift+Alt+Backspace": "deleteWordBackward",
  "Shift+Alt+Escape": "complete",
  "Shift+Alt+ArrowUp": "moveParagraphBackwardAndModifySelection",
  "Shift+Alt+ArrowDown": "moveParagraphForwardAndModifySelection",
  "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection",
  "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection",
  "Shift+Alt+Delete": "deleteWordForward",
  "Shift+Alt+PageUp": "pageUp",
  "Shift+Alt+PageDown": "pageDown",
  "Control+Alt+KeyB": "moveWordBackward",
  "Control+Alt+KeyF": "moveWordForward",
  "Control+Alt+Backspace": "deleteWordBackward",
  "Shift+Control+Alt+KeyB": "moveWordBackwardAndModifySelection",
  "Shift+Control+Alt+KeyF": "moveWordForwardAndModifySelection",
  "Shift+Control+Alt+Backspace": "deleteWordBackward",
  "Meta+NumpadSubtract": "cancel",
  "Meta+Backspace": "deleteToBeginningOfLine",
  "Meta+ArrowUp": "moveToBeginningOfDocument",
  "Meta+ArrowDown": "moveToEndOfDocument",
  "Meta+ArrowLeft": "moveToLeftEndOfLine",
  "Meta+ArrowRight": "moveToRightEndOfLine",
  "Shift+Meta+NumpadSubtract": "cancel",
  "Shift+Meta+Backspace": "deleteToBeginningOfLine",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection",
  "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection",
  "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection",
  "Meta+KeyA": "selectAll",
  "Meta+KeyC": "copy",
  "Meta+KeyX": "cut",
  "Meta+KeyV": "paste",
  "Meta+KeyZ": "undo",
  "Shift+Meta+KeyZ": "redo",
};

const PLAYWRIGHT_NAME: Record<Modifier, string> = {
  Shift: "Shift",
  Ctrl: "Control",
  Alt: "Alt",
  Mod: "Meta",
};
/** Playwright's order for a lookup key. */
const LOOKUP_ORDER: readonly Modifier[] = ["Shift", "Ctrl", "Alt", "Mod"];

/** The editor commands macOS runs for a key with these modifiers. A synthetic
 *  key event skips the native binding that would name them, so they go on the
 *  event, on every host: a take's keys mean the same whichever machine plays
 *  them. Plural because Playwright has two-command entries (Alt+ArrowUp). */
export function macCommands(
  modifiers: readonly Modifier[],
  code: string,
): string[] | undefined {
  const held = LOOKUP_ORDER.filter((m) => modifiers.includes(m)).map(
    (m) => PLAYWRIGHT_NAME[m],
  );
  const found = MAC_COMMANDS[[...held, code].join("+")];
  return found === undefined ? undefined : [found].flat();
}

const MODIFIER_KEYS: Record<
  Modifier,
  { key: string; code: string; vk: number; bit: number }
> = {
  Mod: { key: "Meta", code: "MetaLeft", vk: 91, bit: 4 },
  Shift: { key: "Shift", code: "ShiftLeft", vk: 16, bit: 8 },
  Ctrl: { key: "Control", code: "ControlLeft", vk: 17, bit: 2 },
  Alt: { key: "Alt", code: "AltLeft", vk: 18, bit: 1 },
};

const maskOf = (modifiers: readonly Modifier[]): number =>
  modifiers.reduce((mask, m) => mask | MODIFIER_KEYS[m].bit, 0);

function modifierEvent(
  type: "rawKeyDown" | "keyUp",
  m: Modifier,
  mask: number,
) {
  const { key, code, vk } = MODIFIER_KEYS[m];
  return { type, key, code, windowsVirtualKeyCode: vk, modifiers: mask };
}

/** Press the modifiers down, in order; the returned function lifts them in
 *  reverse. */
export async function holdModifiers(
  cdp: CdpSession,
  modifiers: readonly Modifier[],
): Promise<() => Promise<void>> {
  let mask = 0;
  for (const m of modifiers) {
    mask |= MODIFIER_KEYS[m].bit;
    await cdp.send(
      "Input.dispatchKeyEvent",
      modifierEvent("rawKeyDown", m, mask),
    );
  }
  return async () => {
    for (const m of [...modifiers].reverse()) {
      mask &= ~MODIFIER_KEYS[m].bit;
      await cdp.send("Input.dispatchKeyEvent", modifierEvent("keyUp", m, mask));
    }
  };
}

/** The modifiers down, the key down and up, the modifiers up. */
export async function pressCombo(
  cdp: CdpSession,
  modifiers: readonly Modifier[],
  key: string,
): Promise<void> {
  const release = await holdModifiers(cdp, modifiers);
  const { text, ...event } = keyEventOf(key, modifiers.includes("Shift"));
  const mask = maskOf(modifiers);
  // A chord is not typing: only no modifier, or Shift alone, prints.
  const typed = mask === 0 || mask === 8 ? text : undefined;
  const commands = macCommands(modifiers, event.code);
  await cdp.send("Input.dispatchKeyEvent", {
    type: typed === undefined ? "rawKeyDown" : "keyDown",
    ...event,
    modifiers: mask,
    ...(typed === undefined ? {} : { text: typed }),
    ...(commands === undefined ? {} : { commands }),
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...event,
    modifiers: mask,
  });
  await release();
}
