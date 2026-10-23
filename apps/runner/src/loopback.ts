import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The interface the runner's own http servers bind.
 *
 * `mux.ts` and `render.ts` each start a short-lived server so the page they
 * drive can fetch bytes it could not otherwise reach — parked JPEGs of the
 * author's application, and every harvested keyframe and muxed span in the
 * store. Neither server authenticates anything: the mux answers `/f<N>` for
 * whatever it has parked, and the render answers any ref in `store.refs()`.
 * That is fine for a same-machine page and not fine for anyone else, so the
 * host is not optional and not a default worth inheriting — `listen(0, cb)`
 * with no host binds every interface, which for the length of a run puts the
 * frames on the local network at paths anyone can enumerate.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * Starts `server` on a free loopback port and returns the origin to navigate
 * the page to.
 *
 * One function rather than two lines at each call site so the bind and the
 * URL cannot drift apart: a server bound to loopback and a page pointed at
 * some other host is a run that hangs with nothing to say.
 */
export async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    // `listen` reports its failure as an `error` EVENT, never as a throw or
    // a callback argument — so a promise that only ever resolves from the
    // listening callback never settles at all when the bind fails, and both
    // callers would hang forever with nothing on any stream to say why.
    // Port 0 makes EADDRINUSE unreachable, but EACCES and EMFILE are not.
    // `once`, and removed on success: this server outlives this function,
    // and a later `error` on it must not reject a promise nobody holds.
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return `http://${LOOPBACK_HOST}:${port}/`;
}
