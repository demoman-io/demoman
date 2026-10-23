/**
 * Input and stills never overlap.
 *
 * Chromium converts input dispatched while `Page.captureScreenshot` is in
 * flight with the display's device scale factor instead of the emulated one,
 * so under `REPLAY_DPR` every pointer event lands at display DPR /
 * `REPLAY_DPR` of the point it was sent to — 2/3 on a Retina display, 1/3
 * headless. Measured 2026-10-13: a bare page at that scale with a screenshot
 * in flight put 39 of 40 presses and releases at exactly that point, headed
 * and headless, and none without one (or at the display's own scale). In the
 * engine a settled still is requested by the recorder whenever the page goes
 * quiet, so one could be capturing as a step's click went out: "Create
 * invoice" in the store-assets sample app landed on the backdrop in 5 of 8
 * runs, in both executors, and the runs said `complete`. `click-probe.ts`
 * catches a click that lands elsewhere; this is what stops it landing there.
 *
 * A `section` is input — a cursor path, a verb. A `capture` asked for during
 * one waits for it to end; a section that opens while a capture is in flight
 * waits for the capture. Sections do not overlap each other (the walk runs
 * them one at a time) and neither do captures (the still line does), so one
 * slot of each is the whole state.
 */
export interface InputGate {
  section<T>(input: () => Promise<T>): Promise<T>;
  capture<T>(take: () => Promise<T>): Promise<T>;
}

export function createInputGate(): InputGate {
  let capturing: Promise<void> = Promise.resolve();
  let inputOpen: Promise<void> | null = null;
  return {
    async section(input) {
      // One slot is the whole state, so a second section would take it from
      // the first, whose `finally` would then open the door mid-way through
      // the second. The walk never does this; a caller that did is a fault,
      // said here rather than left to land a click at 2/3 of its point.
      if (inputOpen !== null) {
        throw new Error(
          "input sections overlap: one was opened while another was still sending input",
        );
      }
      let end = (): void => undefined;
      inputOpen = new Promise<void>((resolve) => {
        end = resolve;
      });
      try {
        await capturing;
        return await input();
      } finally {
        inputOpen = null;
        end();
      }
    },
    async capture(take) {
      // No await between this loop's last check and `take()` starting: a
      // section opened after it finds `capturing` set and waits for it.
      while (inputOpen !== null) await inputOpen;
      const taking = take();
      capturing = taking.then(
        () => undefined,
        () => undefined,
      );
      return taking;
    },
  };
}
