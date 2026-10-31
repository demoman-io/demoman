import { describe, expect, it } from "vitest";
import { pressKey } from "../../src/keys.js";
import type { CdpSession } from "../../src/types.js";

/** Every key event a press sends. */
async function sent(
  key: Parameters<typeof pressKey>[1],
  mac: boolean,
): Promise<Record<string, unknown>[]> {
  const calls: Record<string, unknown>[] = [];
  const cdp = {
    send: async (_method: string, params?: Record<string, unknown>) => {
      calls.push(params ?? {});
      return {};
    },
  } as unknown as CdpSession;
  await pressKey(cdp, key, mac);
  return calls;
}

describe("pressKey's editor commands", () => {
  // Playwright's table (`macEditingCommands`), the same strings it sends:
  // on macOS a synthetic key event edits a field only with its command.
  it.each([
    ["Backspace", "deleteBackward"],
    ["Delete", "deleteForward"],
    ["ArrowLeft", "moveLeft"],
    ["ArrowRight", "moveRight"],
    ["ArrowUp", "moveUp"],
    ["ArrowDown", "moveDown"],
    ["Escape", "cancelOperation"],
  ] as const)("%s carries %s on macOS, on its keyDown only", async (key, command) => {
    const [down, up] = await sent(key, true);
    expect(down?.commands).toEqual([command]);
    expect(up?.type).toBe("keyUp");
    expect(up && "commands" in up).toBe(false);
  });

  it("Enter, Tab and Space carry none on macOS: their text does the work", async () => {
    for (const key of ["Enter", "Tab", "Space"] as const) {
      const [down] = await sent(key, true);
      expect(down && "commands" in down, key).toBe(false);
    }
  });

  it("no key carries a command off macOS", async () => {
    const [down] = await sent("Backspace", false);
    expect(down?.type).toBe("rawKeyDown");
    expect(down && "commands" in down).toBe(false);
  });
});
