import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import {
  ciRetry,
  slowExcludes,
  testWorkers,
} from "../../scripts/test-tier.mjs";

/**
 * One lane, and — unlike `apps/extension`'s — it deliberately does NOT alias
 * `@demoman/*` to the packages' `src`.
 *
 * The runner esbuild-bundles `@demoman/replay-engine/page` through the
 * package's `exports` map, which points at `dist`. A node side reading `src`
 * while the in-page side reads `dist` could disagree about `REPLAY_TARGETS`
 * — the one constant that must be byte-identical across that port, since one
 * side parks under it and the other looks it up. So this lane runs entirely
 * against built output, which also makes it the first thing in this repo that
 * genuinely verifies `dist`.
 *
 * `server.deps.external` matters just as much and for the same reason it does
 * in `packages/replay-engine/vitest.config.ts`: left at Vitest's default,
 * vite-node resolves every non-external module through Vite's own permissive
 * resolver, which appends extensions to extensionless relative specifiers and
 * fully interops CJS named exports — exactly the two things node's own ESM
 * loader does not do. That would let this lane pass against a `dist` real
 * node cannot load. Marking the packages' own `dist/` external forces native
 * `import()` for exactly the files this lane exists to check.
 *
 * The cost is real and is accepted: `pnpm -r test` does not build, so this
 * lane is meaningless on a stale tree. Run `pnpm test` (which is
 * `pnpm -r build && pnpm -r test`) or build first.
 *
 * Timeouts: this lane launches Chromium, replays a scene and composes video.
 * The 15s default is not survivable here, and the runner is ~5x slower than a
 * developer's Mac (`fff4505`). Per-test timeouts are set at each test with
 * the measured local number and the 5x headroom written beside them; these
 * are the floor.
 *
 * `*.bench.test.ts` is excluded here and runs under `pnpm --filter
 * @demoman/runner bench` (`vitest.bench.config.ts`). The encoder bench
 * reports a number and gates nothing, and it cost ~18s and 158 MB of
 * parked JPEGs on every CI push (measured on the 2026-09-23 run).
 *
 * `*.slow.test.ts` render video in software (4K SwiftShader exports, the
 * acceptance run). `pnpm test:fast` leaves them out and says how many;
 * `pnpm test` and CI run them (`scripts/test-tier.mjs`).
 *
 * On CI a failed test runs once more, and a pass on the retry is an
 * annotation on the run (`ciRetry`).
 */
/** Measurements, not gates: run by `bench`, never by `test`. */
export const BENCH = "test/**/*.bench.test.ts";

export default defineConfig({
  test: {
    ...testWorkers("heavy"),
    ...ciRetry(),
    name: "runner",
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      BENCH,
      ...slowExcludes(fileURLToPath(new URL(".", import.meta.url))),
    ],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    server: {
      deps: {
        external: [/\/packages\/[^/]+\/dist\//],
      },
    },
  },
});
