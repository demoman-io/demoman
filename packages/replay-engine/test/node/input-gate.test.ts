import { describe, expect, it } from "vitest";
import { createInputGate } from "../../src/input-gate";

/** A promise and the hand that settles it. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every queued continuation run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the input gate: input and stills never overlap", () => {
  it("holds a capture asked for during input until the input ends", async () => {
    const gate = createInputGate();
    const input = deferred();
    const log: string[] = [];
    const section = gate.section(async () => {
      log.push("input starts");
      await input.promise;
      log.push("input ends");
    });
    await settle();
    const capture = gate.capture(async () => {
      log.push("capture starts");
    });
    await settle();
    // The premise: the capture was asked for while the input was open.
    expect(log).toEqual(["input starts"]);
    input.resolve();
    await Promise.all([section, capture]);
    expect(log).toEqual(["input starts", "input ends", "capture starts"]);
  });

  it("holds input that opens during a capture until the capture ends", async () => {
    const gate = createInputGate();
    const shot = deferred<string>();
    const log: string[] = [];
    const capture = gate.capture(async () => {
      log.push("capture starts");
      const bytes = await shot.promise;
      log.push("capture ends");
      return bytes;
    });
    await settle();
    const section = gate.section(async () => {
      log.push("input starts");
    });
    await settle();
    expect(log).toEqual(["capture starts"]);
    shot.resolve("jpeg");
    expect(await capture).toBe("jpeg");
    await section;
    expect(log).toEqual(["capture starts", "capture ends", "input starts"]);
  });

  // A screenshot the page refused must not hold every later step forever,
  // and the capture's own caller still hears the refusal.
  it("lets input through after a capture that failed, and passes the failure on", async () => {
    const gate = createInputGate();
    const shot = deferred<string>();
    const capture = gate.capture(() => shot.promise);
    const section = gate.section(async () => "typed");
    shot.reject(new Error("screenshot refused"));
    await expect(capture).rejects.toThrow("screenshot refused");
    expect(await section).toBe("typed");
  });

  // Likewise input that threw: the capture waiting on it goes ahead.
  it("lets a capture through after input that threw, and passes the throw on", async () => {
    const gate = createInputGate();
    const input = deferred();
    const section = gate.section(() => input.promise);
    await settle();
    const capture = gate.capture(async () => "jpeg");
    input.reject(new Error("debugger detached"));
    await expect(section).rejects.toThrow("debugger detached");
    expect(await capture).toBe("jpeg");
  });

  it("does not hold anything when nothing else is in flight", async () => {
    const gate = createInputGate();
    expect(await gate.section(async () => 1)).toBe(1);
    expect(await gate.capture(async () => 2)).toBe(2);
    expect(await gate.section(async () => 3)).toBe(3);
  });
});

describe("the input gate's one slot", () => {
  // Second review, Minor 4. Red if a second section is let in: it would take
  // the slot, and the first one's `finally` would open the door to captures
  // while the second was still sending input.
  it("refuses a section that opens while another is open", async () => {
    const gate = createInputGate();
    const first = deferred();
    const running = gate.section(() => first.promise);
    await expect(gate.section(async () => "second")).rejects.toThrow(
      /input sections overlap/,
    );
    first.resolve();
    await running;
    // And the slot is free again afterwards.
    expect(await gate.section(async () => "third")).toBe("third");
  });
});
