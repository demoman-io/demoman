import type { BrowserContext } from "playwright";

let held = 0;
/** How long `lagCdp` has held commands in this process, in all. */
export const heldByLagMs = (): number => held;

type LaggedProto = {
  send: ((...args: unknown[]) => Promise<unknown>) & { lagged?: boolean };
  lagMs?: number;
};

let wrapped: LaggedProto | null = null;
/** Changes the lag `lagCdp` set, mid-run: a machine that falls behind once
 *  a page is under way. */
export function relagCdp(ms: number): void {
  if (wrapped === null) throw new Error("relagCdp before lagCdp");
  wrapped.lagMs = ms;
}

/**
 * Holds every CDP command `ms` ms: a slow machine on this machine, whose
 * stills and lookups take longer. Page-CPU throttling does not reach them.
 *
 * `CDPSession`'s prototype is the process's, shared by every browser it
 * launches, so the wrapper goes on once and reads the current `ms` from the
 * prototype: a later call (0 included) changes it for every session, and a
 * test that slows one recording must call this with 0 afterwards.
 */
export async function lagCdp(
  context: BrowserContext,
  ms: number,
): Promise<void> {
  const proto = Object.getPrototypeOf(
    await context.newCDPSession(
      context.pages()[0] ?? (await context.newPage()),
    ),
  ) as LaggedProto;
  proto.lagMs = ms;
  wrapped = proto;
  if (proto.send.lagged === true) return;
  const send = proto.send;
  proto.send = async function (this: unknown, ...args: unknown[]) {
    const lag = proto.lagMs ?? 0;
    if (lag > 0) {
      await new Promise((r) => setTimeout(r, lag));
      held += lag;
    }
    return send.apply(this, args);
  };
  proto.send.lagged = true;
}
