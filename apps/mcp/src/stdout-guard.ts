// apps/mcp/src/stdout-guard.ts
//
// stdout is the MCP channel: every line on it must be JSON-RPC. Code this
// server loads but does not own writes `console.info` lines meant for a
// person — `@demoman/run-core`'s snapshot ("demoman snapshot: … did not
// load"), `@demoman/replay-engine`'s walk — and under node `console.log`,
// `info` and `debug` go to stdout, where an MCP host reads them as a broken
// message (final review 2026-10-12, Important 1). Those packages are shared
// with the extension, whose console levels mean something on
// chrome://extensions, so the line is moved here, at the process boundary,
// and not there.
//
// A module of its own, imported FIRST by index.ts: ESM evaluates a module's
// static imports in order before its body, so a redirect written in
// index.ts's body would run after every other import had already loaded.
import { Console } from "node:console";

const toStderr = new Console({
  stdout: process.stderr,
  stderr: process.stderr,
});
console.log = toStderr.log.bind(toStderr);
console.info = toStderr.info.bind(toStderr);
console.debug = toStderr.debug.bind(toStderr);
