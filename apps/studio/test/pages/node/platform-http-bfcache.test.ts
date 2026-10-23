import { afterEach, expect, it, vi } from "vitest";
import { createPlatform } from "../../../pages/src/platform/http";

/**
 * A studio page Chrome restores from the back/forward cache: its event
 * stream was aborted on `pagehide` and `leaving` set, so without a reload it
 * would never hear its export end ("Exporting…" for good) nor the studio
 * stop. Its own file, so the one platform made here is the only one
 * listening on this window.
 *
 * Production change that reddens it, made and watched go red: drop the
 * `pageshow` listener from `createPlatform`.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("reloads a page restored from the back/forward cache, and only that", async () => {
  vi.stubEnv("STUDIO_VERSION", "1.0.0");
  // A studio that answers the ping and holds the event stream open.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/events"
        ? new Response(new ReadableStream({ start() {} }), { status: 200 })
        : new Response(
            JSON.stringify({ version: "1.0.0", pid: 1, queued: 0 }),
            {
              status: 200,
            },
          ),
    ),
  );
  const reload = vi.fn();
  createPlatform({ reload });

  // An ordinary first show is not a restore.
  window.dispatchEvent(
    new PageTransitionEvent("pageshow", { persisted: false }),
  );
  expect(reload).not.toHaveBeenCalled();

  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(
    new PageTransitionEvent("pageshow", { persisted: true }),
  );
  expect(reload).toHaveBeenCalledTimes(1);
});
