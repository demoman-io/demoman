import type { FrameBundle } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import {
  pacedBundle,
  SLOW,
  twoStepScene,
} from "../../../compositor/test/fixtures/beats";
import { filmQuality } from "../../src/replay/film.js";
import { DEGRADATION_WORDS } from "../../src/replay/report.js";

// Held-clock capture: a held take's source time is the designed clock, so the
// report says so, and says which stretches were real network time.

const spans = [
  { startMs: 1000, endMs: 3000, label: "POST /api/chat" },
  { startMs: 5000, endMs: 5500, label: "GET /api/list" },
];

function filmOf(bundle: FrameBundle) {
  const film = filmQuality(twoStepScene(), bundle);
  if ("unavailable" in film) throw new Error(film.unavailable);
  return film;
}

const held = (overrides: Partial<FrameBundle> = {}) =>
  pacedBundle(SLOW, {
    timing: "real",
    clock: "held",
    networkSpans: spans,
    ...overrides,
  }).bundle;

describe("filmQuality: a held take", () => {
  it("says it was held and lists its network time on the video's clock", () => {
    // Red if `filmQuality` drops the `isHeld` block.
    const film = filmOf(held());
    expect(film.pacing).toBe("held");
    expect(film.networkMs).toBe(2500);
    // No edits, so the video plays the recording straight: output ms = source ms.
    expect(film.network).toEqual(spans);
    expect(film.connectionsIgnored).toEqual([]);
  });

  it("puts network time on the video's clock when an earlier stretch is shortened", () => {
    // Red if `network` is given source ms instead of the timeline's output ms.
    const late = { startMs: 9000, endMs: 9500, label: "GET /late" };
    const film = filmQuality(
      twoStepScene(undefined, [
        { id: "g1", afterActionId: "s1", durationMs: 800 },
      ]),
      held({ networkSpans: [late] }),
    );
    if ("unavailable" in film) throw new Error(film.unavailable);
    const shown = film.network?.[0];
    // The 6 s rest between the steps plays about 800 ms, so the span moves
    // earlier by seconds; its own length is the timeline's (idle after the
    // last step is shortened), while `networkMs` stays the source sum.
    expect(late.startMs - (shown?.startMs ?? 0)).toBeGreaterThan(4000);
    expect(shown?.endMs).toBeGreaterThan(shown?.startMs ?? 0);
    expect(film.networkMs).toBe(500);
  });

  it("names a connection dropped from the count", () => {
    const film = filmOf(
      held({
        degradations: [
          {
            kind: "connectionIgnored",
            startMs: 0,
            endMs: 9000,
            note: "GET /poll",
          },
        ],
      }),
    );
    expect(film.connectionsIgnored).toEqual(["GET /poll"]);
  });

  it("keeps the old report for a take that was not held", () => {
    // Red if the held fields leak onto a real-clock take.
    const film = filmOf(held({ clock: undefined, networkSpans: undefined }));
    for (const key of [
      "pacing",
      "networkMs",
      "network",
      "connectionsIgnored",
    ]) {
      expect(film).not.toHaveProperty(key);
    }
    expect(film).toEqual(filmOf(pacedBundle(SLOW, { timing: "real" }).bundle));
  });

  it("says in words what a dropped connection means, with the cutoff it used", () => {
    expect(DEGRADATION_WORDS.connectionIgnored).toMatch(/10 seconds/);
  });
});
