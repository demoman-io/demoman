import { describe, expect, it, vi } from "vitest";
import {
  createOcclusionGuard,
  HEARTBEAT_STALL_MS,
  OCCLUSION_TIMEOUT_MS,
} from "../../src/index.js";
import { createCdpFake } from "../helpers/cdp-fake";

/**
 * The heartbeat guard. Its predecessor trusted `document.visibilityState`,
 * which convicts on hearsay: real Chrome marks a covered window hidden even
 * while the lifecycle override keeps it painting (SP1 measured ~56fps on a
 * minimized window), and four real runs died `occlusionTimeout` on that
 * label alone. The guard now pauses only on the absence of evidence of
 * painting — a rAF-driven beat over the binding channel — so a page that is
 * "hidden" but demonstrably still being driven replays on.
 */

function guardWith() {
  const cdp = createCdpFake();
  let now = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const beat = () =>
    cdp.emit("Runtime.bindingCalled", {
      name: "__demomanHeartbeat",
      payload: String(now),
    });
  return { cdp, clock, beat, advance: (ms: number) => (now += ms) };
}

describe("createOcclusionGuard", () => {
  it("installs a rAF heartbeat that survives a navigation", async () => {
    const { cdp, clock } = guardWith();
    const guard = createOcclusionGuard({ cdp, clock });
    await guard.install();

    const methods = cdp.calls.map((c) => c.method);
    expect(methods).toContain("Runtime.addBinding");
    // On new document, not once: a replay that navigates must not lose the
    // only thing telling it the page is still painting.
    const injected = cdp.calls.find(
      (c) => c.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(injected).toBeDefined();
    // The mechanism is the claim: rAF only runs when Chrome is driving
    // frames, so a beat IS evidence of painting — a timer would keep
    // beating on a genuinely frozen page.
    expect(String(injected?.params.source)).toContain("requestAnimationFrame");
    expect(String(injected?.params.source)).toContain("__demomanHeartbeat");
  });

  it("lets replay through while the page is beating", async () => {
    const { cdp, clock, beat } = guardWith();
    const guard = createOcclusionGuard({ cdp, clock });
    await guard.install();
    beat();
    expect(await guard.ensureVisible()).toBe(true);
    expect(guard.pauses()).toBe(0);
  });

  it("extends a fresh page a grace period rather than an instant pause", async () => {
    // Between install and the navigated document's first rAF there are no
    // beats to have heard. A guard that convicted here would pause every
    // run at its first check.
    const { cdp, clock } = guardWith();
    const guard = createOcclusionGuard({ cdp, clock });
    await guard.install();
    expect(await guard.ensureVisible()).toBe(true);
    expect(guard.pauses()).toBe(0);
  });

  // The discriminating case, and the production change that reddens it is
  // the old design itself: a visibility-based guard reads silence as
  // "visible" and sails past a page that stopped painting entirely.
  it("pauses when the heartbeat stalls and resumes on the next beat", async () => {
    const { cdp, clock, beat, advance } = guardWith();
    const onPause = vi.fn();
    const onResume = vi.fn();
    const guard = createOcclusionGuard({ cdp, clock, onPause, onResume });
    await guard.install();

    beat();
    advance(HEARTBEAT_STALL_MS + 100);
    const pending = guard.ensureVisible();
    advance(400);
    beat();

    expect(await pending).toBe(true);
    expect(guard.pauses()).toBe(1);
    expect(guard.pausedMs()).toBeGreaterThan(0);
    expect(onPause).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledOnce();
  });

  // Review 2026-10-03 #6: the page stopped painting at its last beat, up to
  // HEARTBEAT_STALL_MS before the check that noticed — and a real-time film
  // has to remove that stretch too.
  it("says the pause began at the last beat, not at the check", async () => {
    const { cdp, clock, beat, advance } = guardWith();
    const guard = createOcclusionGuard({ cdp, clock });
    await guard.install();
    expect(guard.stalledSince()).toBeNull();

    advance(500);
    beat();
    const lastBeat = clock.now();
    advance(HEARTBEAT_STALL_MS + 100);
    const checkedAt = clock.now();
    const pending = guard.ensureVisible();
    advance(400);
    beat();
    expect(await pending).toBe(true);
    expect(guard.stalledSince()).toBe(lastBeat);
    expect(checkedAt - lastBeat).toBeGreaterThan(HEARTBEAT_STALL_MS);
  });

  it("gives up rather than waiting forever on a page that never paints again", async () => {
    const { cdp, clock, beat, advance } = guardWith();
    const guard = createOcclusionGuard({ cdp, clock });
    await guard.install();

    beat();
    advance(HEARTBEAT_STALL_MS + 100);
    const started = clock.now();
    expect(await guard.ensureVisible()).toBe(false);
    expect(clock.now() - started).toBeGreaterThanOrEqual(OCCLUSION_TIMEOUT_MS);
  });
});
