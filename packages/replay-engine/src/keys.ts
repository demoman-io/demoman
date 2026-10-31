import type { PressKey } from "@demoman/scene-schema";

import type { CdpSession } from "./types.js";

/** What CDP needs to press each named key. `text` is what the key types:
 *  Enter submits a form only when its keyDown carries a carriage return. */
export const KEY_EVENTS: Record<
  PressKey,
  { key: string; code: string; windowsVirtualKeyCode: number; text?: string }
> = {
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

/** The editor command Chromium on macOS runs for each key, from
 *  Playwright's `macEditingCommands` (its `insert…` ones dropped, as it drops
 *  them: the key's text inserts). A synthetic key event skips the native
 *  key binding that would name it, so Playwright sends it on the event. */
const MAC_COMMANDS: Partial<Record<PressKey, string>> = {
  Backspace: "deleteBackward",
  Delete: "deleteForward",
  Escape: "cancelOperation",
  ArrowUp: "moveUp",
  ArrowDown: "moveDown",
  ArrowLeft: "moveLeft",
  ArrowRight: "moveRight",
};

/** Whether the browser runs on macOS: it is launched on this machine, which
 *  is how Playwright decides it too. */
const MAC_HOST =
  (globalThis as { process?: { platform?: string } }).process?.platform ===
  "darwin";

/** A keyDown then a keyUp of one named key. */
export async function pressKey(
  cdp: CdpSession,
  key: PressKey,
  mac = MAC_HOST,
): Promise<void> {
  const { text, ...event } = KEY_EVENTS[key];
  const command = mac ? MAC_COMMANDS[key] : undefined;
  await cdp.send("Input.dispatchKeyEvent", {
    type: text === undefined ? "rawKeyDown" : "keyDown",
    ...event,
    ...(text === undefined ? {} : { text }),
    ...(command === undefined ? {} : { commands: [command] }),
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
}
