// apps/studio/pages/src/platform/studio-prelude.ts
import { z } from "zod";

/**
 * Runs first in each of the studio's pages: `vite.studio.config.ts` puts
 * `import` of this module at the head of the editor's and the library's
 * entry, in the studio build only.
 *
 * The studio serves its pages under `default-src 'self'` (spec §4.1), which
 * refuses zod's `Function("")` probe for its JIT. The probe is caught, but
 * Chrome logs the refusal as a CSP violation on every page load (ruling
 * R19). Jitless skips the probe and parses the same way, a little slower.
 *
 * First, because zod reads the setting when a schema is built, and the
 * packages build theirs at module scope: set from `http.ts`, which a page
 * imports after them, it came too late (measured — the probe still ran).
 * One zod instance: the packages resolve the same `zod@4` this does.
 */
z.config({ jitless: true });
