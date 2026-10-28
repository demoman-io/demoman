// Slow tier: renders the take's stills through a real browser.
// `pnpm test:fast` skips it; `pnpm test` and CI run it.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exists, ownHarness, RUN_MS } from "./wallpaper-own-harness.js";

// A stills export of the fixture take: measured about 1 s locally
// (2026-10-28); 120 s leaves CI's ~5x and more.
const EXPORT_MS = 120_000;

const { h, run, scriptOn, kitOn } = ownHarness();

describe("a default kit's missing image, at export", () => {
  it(
    "the take films on the kit's ref, and its export says it was left out, naming it",
    async () => {
      const gone = join(h.scratch, "kit-gone.png");
      expect(await exists(gone)).toBe(false);
      await kitOn(gone);
      const { value, takeId, background } = await run(scriptOn(), "kit-x");
      expect(value.outcome, JSON.stringify(value)).toBe("complete");
      expect(background).toEqual({ kind: "image", ref: gone });
      const exported = await h.executor.request("export", {
        takeId,
        fileType: "stills",
        callId: "kit-x-export",
      });
      if (!exported.ok) throw new Error(JSON.stringify(exported));
      const answer = exported.value as {
        outcome: string;
        warnings?: { wallpaperWarning?: { kind: string; sentence: string } };
      };
      expect(answer.outcome, JSON.stringify(answer)).toBe("saved");
      expect(answer.warnings?.wallpaperWarning?.kind).toBe("leftOut");
      expect(answer.warnings?.wallpaperWarning?.sentence).toContain(gone);
    },
    RUN_MS + EXPORT_MS,
  );
});
