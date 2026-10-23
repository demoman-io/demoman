/**
 * The names the runner's two halves — node and in-page — must agree on.
 *
 * They live alone in their own module for the same reason
 * `@demoman/replay-engine` has two doors. `resolve-entry.ts` is bundled and
 * injected into somebody else's page; it imports
 * `@demoman/replay-engine/page`, which drags a DOM-only surface with it.
 * `page-agent.ts` runs in node and drives Playwright. Declaring the names in
 * either file and importing them from the other would pull that file's whole
 * module graph across the boundary.
 *
 * The alternative — writing the string twice, once on each side — is the
 * divergent double this design keeps refusing: one side installs under the
 * name and the other looks it up, so a typo in either is a page agent that
 * silently finds nothing. One definition, two importers.
 */

/**
 * Where `resolve-entry.ts` hangs its entry points in every frame's MAIN
 * world. Distinct from `REPLAY_TARGETS` (the engine's park table, which is a
 * contract with the engine and lives in the engine's constants): this one is
 * a contract between the runner's own two halves and nothing else.
 */
export const ENTRY_GLOBAL = "__demomanRunner";

/**
 * Where `mux-entry.ts` hangs its entry point in the blank page `mux.ts`
 * drives (Task 11). A second contract between the runner's own two halves,
 * same reasoning as `ENTRY_GLOBAL`: `mux.ts` runs in node, `mux-entry.ts` is
 * bundled and injected into a page, and neither may import the other's
 * module graph just to share this one string.
 */
export const MUX_ENTRY_GLOBAL = "__demomanMux";

/**
 * Where `decode-probe-entry.ts` hangs its entry point. Test-only: only
 * `mux.test.ts` and `acceptance.slow.test.ts` bundle and inject this script,
 * never any production path. It exists as its own bundle, under its own
 * global, specifically so the decode side it carries (`mediabunny`'s demux
 * — `Input`/`ALL_FORMATS`/`CanvasSink`) never reaches the ~654 KB into the
 * script `mux.ts` injects on a real replay run that living inside
 * `mux-entry.ts` used to cost (measured: 1,657,504 bytes with the probe
 * folded in, 987,225 without). One global for both tests, not two: the
 * second would be the same 654 KB bundled twice for the same `Input` open.
 */
export const DECODE_PROBE_GLOBAL = "__demomanDecodeProbe";

/**
 * Where `render-entry.ts` hangs its entry point in the blank page `render.ts`
 * drives (Task 12) — the render phase's own blank page, distinct from
 * `mux.ts`'s (a fresh `page.goto` separates the two http servers, so the two
 * globals never actually have to coexist, but a third string reused from
 * either of the above would be one more place a typo in one file silently
 * fails to break the other). Same two-importer contract as `ENTRY_GLOBAL`
 * and `MUX_ENTRY_GLOBAL`: `render.ts` runs in node, `render-entry.ts` is
 * bundled and injected into a page, and neither may import the other's
 * module graph just to share this one string.
 */
export const RENDER_ENTRY_GLOBAL = "__demomanRender";

/**
 * Where `render-probe-entry.ts` hangs its entry point. Test-only, same
 * split `mux-entry.ts`/`decode-probe-entry.ts` already made and for the
 * identical reason: `render-entry.ts` alone needs `createMp4Sink`'s ENCODE
 * side of mediabunny; a decode probe (`Input`/`ALL_FORMATS`/`CanvasSink`,
 * mediabunny's DEMUX side) folded into that same bundle would inject dead
 * weight into every real render run for a codepath only `render.slow.test.ts`
 * calls. Only that test bundles and injects this file; `render.ts`'s
 * production path never does.
 */
export const RENDER_PROBE_GLOBAL = "__demomanRenderProbe";

/**
 * There is deliberately no `BROKER_BINDING` here.
 *
 * The plan expected one — a `page.exposeBinding` the in-page resolver could
 * call to have node find a cross-origin frame and re-enter it, the way
 * `createCourierBroker` reaches a frame through the courier. It is
 * unreachable in this design, so it is not here: `createHeadlessPageAgent`
 * consumes *every* leading frame hop itself before the resolver is called,
 * and a production tree path's frame hops are all leading — the sensor's
 * `prefixTreePath` prepends them to a path that `buildTreePath` built inside
 * the owning frame, so the shape is always `#frame(a)/#frame(b)/<local>`.
 * After the walk the resolver is handed a hopless path in the frame that
 * owns the element and has no frame boundary left to cross.
 *
 * A binding no page ever calls is a mechanism that passes with and without
 * its implementation. If a caller ever hands this agent a path whose frame
 * hop is *not* leading, the resolver reports `frameUnreachable` (cross-
 * origin) or resolves through `contentDocument` (same-origin) — both honest
 * outcomes, and neither improved by a broker: `stripLeadingHop` is a no-op
 * on such a path, so the brokered frame would receive a hop naming an iframe
 * it is already inside and report `frameGone`.
 */

/**
 * Where `fingerprint-probe-entry.ts` hangs its entry point. Test-only, the
 * same way `DECODE_PROBE_GLOBAL` is: only `test/fixture.ts` bundles and
 * injects that script, and it does so additively — the probe and
 * `ENTRY_GLOBAL`'s resolver coexist on one page, because the fixture guard
 * asks both of them about the same document in the same test file.
 */
export const FINGERPRINT_PROBE_GLOBAL = "__demomanFingerprintProbe";

/** The executor's in-page entry: snapshot and intent capture
 *  (`executor/executor-entry.ts`). */
export const EXECUTOR_ENTRY_GLOBAL = "__demomanExecutor";

/** The attribute `markHere` sets on the element a sign-in step resolved, so
 *  Playwright can act on it (launch C2). Shared by the entry (in the page)
 *  and `account-signin.ts` (in node). */
export const SIGN_IN_MARK = "data-demoman-signin";

/** The page → node binding the render reports progress through. */
export const RENDER_PROGRESS_BINDING = "__demomanRenderFrame";
