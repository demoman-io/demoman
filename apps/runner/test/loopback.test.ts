import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { LOOPBACK_HOST, listenOnLoopback } from "../src/loopback.js";

/**
 * The one choke point both of the runner's http servers go through.
 *
 * Whole-branch review, round 2's findings 1 and 2: `mux.ts` and `render.ts`
 * each called `server.listen(0, resolve)` with no host, which binds `::` /
 * `0.0.0.0`. For the length of a run that put every parked screencast frame
 * of the author's application (`/f0`, `/f1`, … — enumerable, unauthenticated)
 * and every harvested keyframe and muxed span in the store on the local
 * network. Nothing failed, nothing was slower, and nothing said a word: the
 * only observable difference between the two binds is the one this file
 * asserts on.
 *
 * To see it fail: drop `LOOPBACK_HOST` from `listenOnLoopback`'s own
 * `server.listen` call. `address.address` comes back `::` and the first
 * expectation goes red naming it.
 */
describe("listenOnLoopback", () => {
  it("binds the loopback interface, never every interface", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
    onTestFinished(() => {
      server.close();
    });

    const origin = await listenOnLoopback(server);
    const address = server.address() as AddressInfo;
    expect(address.address, JSON.stringify(address)).toBe(LOOPBACK_HOST);

    // The origin and the bind are the same host, by construction — a server
    // on loopback and a page pointed anywhere else is a run that hangs with
    // nothing to say, which is why they come from one function.
    expect(origin).toBe(`http://${LOOPBACK_HOST}:${address.port}/`);

    // And it really serves there: an assertion about `address()` alone would
    // still pass against a server that never came up.
    const response = await fetch(origin);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("rejects when the bind fails, rather than never settling", async () => {
    // `listen` reports a failed bind as an `error` EVENT — it does not
    // throw, and it does not pass an error to its callback. A promise wired
    // only to the listening callback therefore never settles: the caller
    // hangs forever with nothing on any stream to say why, which is the
    // worst outcome this codebase's opening rule names. Port 0 makes
    // EADDRINUSE unreachable here, but EACCES and EMFILE are not.
    //
    // A stand-in rather than a real failing bind, because there is no
    // portable way to make `listen(0, "127.0.0.1")` fail on demand — and
    // the event, not the cause, is the thing under test. `EventEmitter`
    // already provides the `once`/`off` pair `listenOnLoopback` uses.
    const fake = new EventEmitter() as unknown as Server;
    (fake as unknown as { listen: () => void }).listen = () => {
      setTimeout(
        () => fake.emit("error", new Error("EACCES: permission denied")),
        0,
      );
    };

    // Revert the `once("error")` wiring in `listenOnLoopback` and this does
    // not fail with a message — it hangs until the timeout below, which is
    // exactly the difference the fix is about.
    await expect(listenOnLoopback(fake)).rejects.toThrow(/EACCES/);
  }, 5_000);
});
