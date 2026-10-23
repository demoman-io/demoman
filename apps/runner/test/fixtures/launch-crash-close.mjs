// Not a vitest test: a standalone Node script, spawned as a real child
// process by test/launch-process-exit.test.ts. It has to run as its own OS
// process because the property under test — "the node process exits on its
// own once there is no more work queued" — cannot be observed from inside
// the same process that's asserting it.
//
// Deliberately no `process.exit()` anywhere in this file: that is the whole
// point. If launch()/close() leave any handle registered with the event
// loop, this script hangs forever instead of exiting with code 0, and the
// spawning test's bounded wait is what turns that into a visible failure
// rather than a silent hang.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../../dist/launch.js";

const LARGE = new Uint8Array(
  readFileSync(join(import.meta.dirname, "frame-large.jpg")),
);
function b64() {
  return Buffer.from(LARGE).toString("base64");
}

const launched = await launch();

// Task 6's measured crash boundary (a page.evaluate call carrying ~70+
// large frames' base64 kills the whole browser), reproduced directly rather
// than through the mux path so this fixture has no dependency on the
// encoder or the store.
const frames = Array.from({ length: 80 }, () => b64());
try {
  await launched.page.evaluate((list) => list.length, frames);
  console.log("DID_NOT_CRASH");
} catch {
  // Expected — this is the crash under test, not a bug in this fixture.
}

await launched.close();
console.log("CRASHED_AND_CLOSED_OK");
