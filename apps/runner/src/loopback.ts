import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
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

/**
 * For a loopback server that hands out files (the refresh comparison, the
 * compare measurer). A port on 127.0.0.1 answers every account on this
 * machine and, through DNS rebinding, a page that names another host. So the
 * files sit under a random path segment only the server's own page is told
 * (`prefix`), and a request whose Host is not the server's own gets a 404
 * (DEM-114).
 */
export function loopbackGuard(): {
  prefix: string;
  /** `listenOnLoopback`, remembering the Host the server answers to. */
  listen(server: Server): Promise<string>;
  /** True, with a 404 sent, when `req` named another Host. */
  refused(req: IncomingMessage, res: ServerResponse): boolean;
} {
  const prefix = `/${randomBytes(16).toString("hex")}`;
  let host: string | null = null;
  return {
    prefix,
    async listen(server) {
      const origin = await listenOnLoopback(server);
      host = new URL(origin).host;
      return origin;
    },
    refused(req, res) {
      if (host !== null && req.headers.host === host) return false;
      res.writeHead(404).end();
      return true;
    },
  };
}
