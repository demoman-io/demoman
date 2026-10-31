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

/** A keyDown then a keyUp of one named key. */
export async function pressKey(cdp: CdpSession, key: PressKey): Promise<void> {
  const { text, ...event } = KEY_EVENTS[key];
  await cdp.send("Input.dispatchKeyEvent", {
    type: text === undefined ? "rawKeyDown" : "keyDown",
    ...event,
    ...(text === undefined ? {} : { text }),
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
}
