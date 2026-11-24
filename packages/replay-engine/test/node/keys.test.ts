import type { Modifier } from "@demoman/scene-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  holdModifiers,
  keyEventOf,
  macCommands,
  pressCombo,
} from "../../src/keys.js";
import type { CdpSession } from "../../src/types.js";

function recorder() {
  const calls: Record<string, unknown>[] = [];
  const cdp = {
    send: async (_method: string, params?: Record<string, unknown>) => {
      calls.push(params ?? {});
      return {};
    },
  } as unknown as CdpSession;
  return { calls, cdp };
}

/** Every key event a press sends. */
async function sent(
  modifiers: Modifier[],
  key: string,
): Promise<Record<string, unknown>[]> {
  const { calls, cdp } = recorder();
  await pressCombo(cdp, modifiers, key);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("pressCombo", () => {
  it("Mod+Shift+K goes down modifier by modifier, presses K with no text, and lifts in reverse", async () => {
    const calls = await sent(["Mod", "Shift"], "K");
    expect(calls).toEqual([
      {
        type: "rawKeyDown",
        key: "Meta",
        code: "MetaLeft",
        windowsVirtualKeyCode: 91,
        modifiers: 4,
      },
      {
        type: "rawKeyDown",
        key: "Shift",
        code: "ShiftLeft",
        windowsVirtualKeyCode: 16,
        modifiers: 12,
      },
      {
        type: "rawKeyDown",
        key: "K",
        code: "KeyK",
        windowsVirtualKeyCode: 75,
        modifiers: 12,
      },
      {
        type: "keyUp",
        key: "K",
        code: "KeyK",
        windowsVirtualKeyCode: 75,
        modifiers: 12,
      },
      {
        type: "keyUp",
        key: "Shift",
        code: "ShiftLeft",
        windowsVirtualKeyCode: 16,
        modifiers: 4,
      },
      {
        type: "keyUp",
        key: "Meta",
        code: "MetaLeft",
        windowsVirtualKeyCode: 91,
        modifiers: 0,
      },
    ]);
  });

  it.each([
    ["A", "selectAll"],
    ["Z", "undo"],
  ])("Mod+%s carries [%s] on its keyDown only", async (key, command) => {
    const calls = await sent(["Mod"], key);
    const down = calls.find(
      (c) => c.code === `Key${key}` && c.type !== "keyUp",
    );
    const up = calls.find((c) => c.code === `Key${key}` && c.type === "keyUp");
    expect(down?.commands).toEqual([command]);
    expect(up && "commands" in up).toBe(false);
  });

  it("Enter carries no command and types a carriage return, on any host", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const [down] = await sent([], "Enter");
    expect(down?.text).toBe("\r");
    expect(down && "commands" in down).toBe(false);
  });

  it("ArrowDown carries moveDown on a linux host", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const [down] = await sent([], "ArrowDown");
    expect(down?.commands).toEqual(["moveDown"]);
  });

  it("? presses Slash, 191, typing ?, with no modifiers", async () => {
    const [down] = await sent([], "?");
    expect(down).toMatchObject({
      type: "keyDown",
      key: "?",
      code: "Slash",
      windowsVirtualKeyCode: 191,
      text: "?",
      modifiers: 0,
    });
  });

  it("Shift+K types K", async () => {
    const calls = await sent(["Shift"], "K");
    const down = calls.find((c) => c.code === "KeyK");
    expect(down).toMatchObject({ key: "K", text: "K", modifiers: 8 });
  });

  it("an unshifted letter is lowercase", () => {
    expect(keyEventOf("K", false)).toMatchObject({ key: "k", text: "k" });
  });
});

describe("a dispatch that throws", () => {
  it("still lifts the modifiers pressCombo put down", async () => {
    const calls: Record<string, unknown>[] = [];
    const cdp = {
      send: async (_method: string, params?: Record<string, unknown>) => {
        calls.push(params ?? {});
        // The modifiers' own events go through; the key's does not.
        if (params?.code === "KeyK") throw new Error("session gone");
        return {};
      },
    } as unknown as CdpSession;
    await expect(pressCombo(cdp, ["Mod", "Shift"], "K")).rejects.toThrow(
      "session gone",
    );
    // Premise: both modifiers went down before the throw.
    expect(
      calls.filter((c) => c.type === "rawKeyDown").map((c) => c.key),
    ).toEqual(["Meta", "Shift", "K"]);
    expect(calls.filter((c) => c.type === "keyUp").map((c) => c.key)).toEqual([
      "Shift",
      "Meta",
    ]);
  });
});

describe("keyEventOf", () => {
  it.each([
    ["5", "Digit5", 53],
    ["%", "Digit5", 53],
    [";", "Semicolon", 186],
    ["+", "Equal", 187],
    ["~", "Backquote", 192],
    ['"', "Quote", 222],
    ["F1", "F1", 112],
    ["F12", "F12", 123],
    ["Home", "Home", 36],
    ["PageDown", "PageDown", 34],
  ])("%s is %s, VK %i", (key, code, vk) => {
    expect(keyEventOf(key, false)).toMatchObject({
      code,
      windowsVirtualKeyCode: vk,
    });
  });
});

describe("macCommands", () => {
  it("has no command for a key whose text does the work", () => {
    expect(macCommands([], "Enter")).toBeUndefined();
  });
  it("keys on Shift, Control, Alt, Meta whatever order they were named", () => {
    expect(macCommands(["Mod", "Shift"], "KeyZ")).toEqual(["redo"]);
    expect(macCommands(["Shift", "Ctrl"], "ArrowLeft")).toEqual([
      "moveToLeftEndOfLineAndModifySelection",
    ]);
  });
  it("carries a two-command entry whole", () => {
    expect(macCommands(["Alt"], "ArrowUp")).toEqual([
      "moveBackward",
      "moveToBeginningOfParagraph",
    ]);
  });
});

describe("holdModifiers", () => {
  it("presses down in order and lifts in reverse with the mask shrinking", async () => {
    const { calls, cdp } = recorder();
    const release = await holdModifiers(cdp, ["Ctrl", "Alt"]);
    expect(calls.map((c) => [c.type, c.key, c.modifiers])).toEqual([
      ["rawKeyDown", "Control", 2],
      ["rawKeyDown", "Alt", 3],
    ]);
    await release();
    expect(calls.slice(2).map((c) => [c.type, c.key, c.modifiers])).toEqual([
      ["keyUp", "Alt", 2],
      ["keyUp", "Control", 0],
    ]);
  });
});
