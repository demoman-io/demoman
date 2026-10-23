import { describe, expect, it } from "vitest";
import { captureSentence } from "../../../pages/src/core/capture-explain";

describe("captureSentence after the split", () => {
  it("maps a capture reason to a sentence, not to its identifier", () => {
    const sentence = captureSentence({
      motion: "none",
      reason: "attachFailed",
      coveredMs: 0,
      takeMs: 12_000,
    });
    // Asserted against the fallback, not merely for a match: `reasonSentence`
    // prints an unmapped key verbatim, so `/attach/i` would pass with and
    // without the mapping. See CLAUDE.md, "Tests must be able to fail".
    expect(sentence).not.toBe("attachFailed");
    expect(sentence).toContain("no video");
  });

  it("says nothing for a genuinely static page", () => {
    expect(
      captureSentence({
        motion: "none",
        reason: null,
        coveredMs: 0,
        takeMs: 9_000,
      }),
    ).toBeNull();
  });

  it("states coverage as a fraction of the take", () => {
    expect(
      captureSentence({
        motion: "partial",
        reason: "budgetSpent",
        coveredMs: 4_000,
        takeMs: 12_000,
      }),
    ).toContain("(4s of 12s recorded)");
  });
});
describe("captureSentence", () => {
  it("says nothing when the recording was complete", () => {
    expect(
      captureSentence({
        motion: "full",
        reason: null,
        coveredMs: 9000,
        takeMs: 9000,
      }),
    ).toBeNull();
  });

  it("says nothing when the page was simply static", () => {
    expect(
      captureSentence({
        motion: "none",
        reason: null,
        coveredMs: 0,
        takeMs: 9000,
      }),
    ).toBeNull();
  });

  it("names a spent budget, with how much was kept", () => {
    const sentence = captureSentence({
      motion: "partial",
      reason: "budgetSpent",
      coveredMs: 8000,
      takeMs: 47000,
    });
    // Discriminates on the mapped copy, not on the raw identifier: a test
    // matching /budget/i would pass whether or not the mapping exists.
    expect(sentence).toContain("8s of 47s");
    expect(sentence).toContain("outran its motion budget");
  });

  it("tells the author which moments are stills when spans failed to encode", () => {
    const sentence = captureSentence({
      motion: "partial",
      reason: "spansDiscarded",
      coveredMs: 3000,
      takeMs: 12000,
    });
    // Discriminates on the mapped copy, never on the identifier: the
    // fallback prints the reason verbatim, so a test matching /discard/i
    // would pass with and without the mapping.
    expect(sentence).toContain("couldn't be encoded");
    expect(sentence).toContain("3s of 12s");
    expect(sentence).not.toContain("spansDiscarded");
  });

  it("says why spans failed to encode, after the sentence", () => {
    const sentence = captureSentence({
      motion: "partial",
      reason:
        "spansDiscarded:2 of 7 spans — NotSupportedError: unsupported configuration",
      coveredMs: 5000,
      takeMs: 12000,
    });
    // The mapped copy must survive the detail: without the key split, the
    // whole reason is unmapped and prints verbatim, identifier and all.
    expect(sentence).toBe(
      "Some motion couldn't be encoded, so those moments are stills — 2 of 7 spans — NotSupportedError: unsupported configuration (5s of 12s recorded)",
    );
  });

  it("tells the author their disk refused the take's frames", () => {
    const sentence = captureSentence({
      motion: "none",
      reason: "storageRefused",
      coveredMs: 0,
      takeMs: 9000,
    });
    // Discriminates on the mapped copy, never on the identifier: the
    // fallback prints the reason verbatim, so a test matching /storage/i
    // or /refused/i would pass with and without the mapping — the exact
    // trap that left three other tests in this codebase able to pass
    // whether or not their production code existed.
    expect(sentence).toContain("couldn't be saved");
    expect(sentence).toContain("free up space");
    expect(sentence).not.toContain("storageRefused");
  });

  it("carries what the store said after the advice", () => {
    const sentence = captureSentence({
      motion: "none",
      reason: "storageRefused:QuotaExceededError",
      coveredMs: 0,
      takeMs: 9000,
    });
    expect(sentence).toContain("couldn't be saved");
    expect(sentence).toContain("QuotaExceededError");
  });

  it("does not blame the disk for a take that could not be put together", () => {
    const sentence = captureSentence({
      motion: "none",
      reason: "bundleInvalid:cursorSamples must be in ascending order",
      coveredMs: 0,
      takeMs: 9000,
    });
    expect(sentence).toContain("couldn't be put together");
    expect(sentence).toContain("cursorSamples must be in ascending order");
    expect(sentence).not.toContain("free up space");
    expect(sentence).not.toMatch(/^bundleInvalid/);
  });

  it("reads a stored error as text, never as a browser detach reason", () => {
    // The detail after a store or bundle reason is free-form error text.
    // Looked up in the detach table, text that happens to match one of its
    // keys — or a name every plain object answers, like "constructor" —
    // printed something the error never said.
    const sentence = captureSentence({
      motion: "none",
      reason: "storageRefused:constructor",
      coveredMs: 0,
      takeMs: 9000,
    });
    expect(sentence).toContain("— constructor");
    expect(sentence).not.toContain("function");
    const matching = captureSentence({
      motion: "none",
      reason: "bundleInvalid:target_closed",
      coveredMs: 0,
      takeMs: 9000,
    });
    expect(matching).toContain("— target_closed");
    expect(matching).not.toContain("the page was replaced");
  });

  it("prints an unmapped reason verbatim rather than swallowing it", () => {
    const sentence = captureSentence({
      motion: "none",
      reason: "somethingNew",
      coveredMs: 0,
      takeMs: 1000,
    });
    expect(sentence).toContain("somethingNew");
  });

  it("says the rest of the recording is unaffected, without hedging", () => {
    const sentence = captureSentence({
      motion: "partial",
      reason: "motionIncomplete",
      coveredMs: 4000,
      takeMs: 9000,
    });
    // Discriminates on the mapped copy, never on the identifier: the
    // fallback prints the reason verbatim, so a test matching /motion/i
    // would pass with and without the mapping.
    expect(sentence).toContain("parts are stills");
    // The hedge specifically. This is the assertion that is red today.
    expect(sentence).not.toContain("usually unaffected");
    expect(sentence).not.toContain("motionIncomplete");
  });

  it("never rounds a nonzero duration down to a contradicting 0s", () => {
    const sentence = captureSentence({
      motion: "partial",
      reason: "budgetSpent",
      coveredMs: 400,
      takeMs: 400,
    });
    expect(sentence).not.toContain("0s of");
    expect(sentence).not.toContain("of 0s");
  });
});

describe("captureSentence for the reasons a take loses its debugger", () => {
  // Three reasons the harvester can now write, each of which fell through
  // to the raw-identifier fallback: "attachFailed (0s of 12s recorded)" is
  // not a sentence an author can act on.
  for (const reason of [
    "attachFailed",
    "debuggerDetached",
    "workerRestarted",
  ]) {
    it(`maps ${reason} to a sentence rather than the identifier`, () => {
      const sentence = captureSentence({
        motion: "none",
        reason,
        coveredMs: 0,
        takeMs: 12000,
      } as never);
      expect(sentence).not.toBeNull();
      expect(sentence).not.toContain(reason);
      expect(sentence).toMatch(/video|recording|stills|frames/i);
    });
  }
});

describe("a detach carries Chrome's own reason", () => {
  it("says which detach Chrome reported, instead of guessing at the infobar", () => {
    const sentence = captureSentence({
      motion: "partial",
      reason: "debuggerDetached:replaced_with_devtools",
      coveredMs: 2_000,
      takeMs: 12_000,
    });
    // The whole point: this take was NOT the author pressing Cancel, and the
    // old fixed sentence said it probably was. Both halves are asserted —
    // the base sentence still arrives, and the reason is named — so neither
    // a lost mapping nor a lost detail passes.
    expect(sentence).toContain("Recording stopped partway through");
    expect(sentence).toContain("DevTools");
    expect(sentence).not.toContain("most likely");
  });

  it("prints an unfamiliar detach reason verbatim rather than dropping it", () => {
    // `CAPTURE_REASON_TEXT`'s own rule, applied one level down: curt beats
    // mysterious, and a reason Chrome adds later must still reach the author.
    const sentence = captureSentence({
      motion: "partial",
      reason: "debuggerDetached:some_future_reason",
      coveredMs: 2_000,
      takeMs: 12_000,
    });
    expect(sentence).toContain("Recording stopped partway through");
    expect(sentence).toContain("some_future_reason");
  });

  it("still maps a bare detach with no reason attached", () => {
    const sentence = captureSentence({
      motion: "partial",
      reason: "debuggerDetached",
      coveredMs: 2_000,
      takeMs: 12_000,
    });
    expect(sentence).not.toBe("debuggerDetached");
    expect(sentence).toContain("Recording stopped partway through");
  });
});

it("says nothing for a status whose reason field is missing entirely", () => {
  // Rows come out of IndexedDB by cast, not by parse, so a take stored
  // before `reason` existed arrives with the field absent — `undefined`,
  // which is not the `null` the type promises. The old lookup was total and
  // survived it; splitting the reason on ":" was not, and threw a TypeError
  // out of the editor's render, taking the timeline with it.
  const sentence = captureSentence({
    motion: "none",
    coveredMs: 0,
    takeMs: 9_000,
  } as unknown as Parameters<typeof captureSentence>[0]);
  expect(sentence).toBeNull();
});

it("does not claim the tab was closed when the target merely went away", () => {
  // `target_closed` is the browser saying the TARGET it had is gone. A tab
  // close is one cause; a navigation that swaps the renderer process, a
  // discard, or a prerender activation are others, and on a real site those
  // are the common ones. Measured 2026-09-26: a take on search.brave.com
  // detached with `target_closed` two seconds in and went on recording
  // actions for another fourteen — which a closed tab cannot do.
  const sentence = captureSentence({
    motion: "partial",
    reason: "debuggerDetached:target_closed",
    coveredMs: 2_000,
    takeMs: 16_000,
  });
  expect(sentence).toContain("Recording stopped partway through");
  // Both causes named, neither asserted.
  expect(sentence).toContain("the page was replaced");
  expect(sentence).not.toMatch(/\bthe tab was closed\b/);
});

it("says a recovered outage left a hole, not that the frames stopped", () => {
  // The distinction the re-attach created: the frames resume, so the
  // detached sentence's "the frames stop at that point" is false here, and
  // the coverage figure beside it is what says how much is missing.
  const sentence = captureSentence({
    motion: "partial",
    reason: "debuggerRecovered:target_closed",
    coveredMs: 14_000,
    takeMs: 16_000,
  });
  expect(sentence).not.toMatch(/stopped/i);
  expect(sentence).toContain("A stretch in the middle is missing");
  expect(sentence).toContain("14s of 16s recorded");
});

it("distinguishes a session it could not get back from one it never fought for", () => {
  const lost = captureSentence({
    motion: "partial",
    reason: "debuggerLost:target_closed",
    coveredMs: 1_000,
    takeMs: 14_000,
  });
  expect(lost).toContain("couldn't restart");
  expect(lost).toContain("the page was replaced");
});
