// The only door to the hosted service. Every request but signing in needs a
// stored credential, so a signed-out machine cannot call it at all.
import {
  HOSTED_ROUTES,
  type Link,
  type LinkCreateRequest,
  type LoginPoll,
  type LoginStart,
  type Me,
  type Refused,
  type UploadCompleted,
  type UploadCreated,
} from "@demoman/hosted-protocol";
import type { Credential } from "./credential.js";

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export type Answer<T> = { ok: true; value: T } | Refused;

/** How long a request may take before it is given up: a part carries up to
 *  50 MB, so it gets far longer than a question does. A stalled request must
 *  end, or a link holds the export slot for good. */
export type Timeouts = { requestMs: number; partMs: number };
const TIMEOUTS: Timeouts = { requestMs: 30_000, partMs: 10 * 60_000 };

type Route = (typeof HOSTED_ROUTES)[keyof typeof HOSTED_ROUTES];

/** A route's method and its path with `:params` filled in. */
function routeOf(
  route: Route,
  params: Record<string, string | number> = {},
): { method: string; path: string } {
  const [method, path] = route.split(" ") as [string, string];
  return {
    method,
    path: path.replace(/:(\w+)/g, (_, k: string) =>
      encodeURIComponent(String(params[k])),
    ),
  };
}

async function call<T>(
  fetchImpl: Fetch,
  base: string,
  route: { method: string; path: string },
  init: { headers?: Record<string, string>; body?: BodyInit },
  timeoutMs: number,
): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}${route.path}`, {
      method: route.method,
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      reason: "unavailable",
      detail: timedOut
        ? `Demoman's service did not answer within ${Math.round(timeoutMs / 1000)} s (${route.method} ${route.path}).`
        : `Demoman's service could not be reached (${(error as Error).message}).`,
    };
  }
  const type = res.headers.get("Content-Type") ?? "no content type";
  let body: unknown;
  let parsed = true;
  try {
    body = await res.json();
  } catch {
    parsed = false;
  }
  const refused = body as Partial<Refused> | undefined;
  if (
    parsed &&
    typeof refused?.reason === "string" &&
    typeof refused.detail === "string" &&
    refused.ok === false
  )
    return { ok: false, reason: refused.reason, detail: refused.detail };
  if (res.ok && parsed && typeof body === "object" && body !== null)
    return { ok: true, value: body as T };
  if (res.status === 401)
    return {
      ok: false,
      reason: "signedOut",
      detail:
        "Demoman's service did not accept this sign-in; run `demoman login`.",
    };
  // A page of the site, a proxy's error: an answer that is not the service's.
  return {
    ok: false,
    reason: "unavailable",
    detail: `Demoman's service answered ${res.status} with ${parsed ? "JSON it did not expect" : `something that is not JSON (${type})`} for ${route.method} ${route.path}.`,
  };
}

const JSON_TYPE = { "Content-Type": "application/json" };

export function startLogin(
  base: string,
  fetchImpl: Fetch = fetch,
  timeouts: Timeouts = TIMEOUTS,
): Promise<Answer<LoginStart>> {
  return call(
    fetchImpl,
    base,
    routeOf(HOSTED_ROUTES.cliLoginStart),
    { headers: JSON_TYPE, body: "{}" },
    timeouts.requestMs,
  );
}

export function pollLogin(
  base: string,
  code: string,
  fetchImpl: Fetch = fetch,
  timeouts: Timeouts = TIMEOUTS,
): Promise<Answer<LoginPoll>> {
  return call(
    fetchImpl,
    base,
    routeOf(HOSTED_ROUTES.cliLoginPoll),
    { headers: JSON_TYPE, body: JSON.stringify({ code }) },
    timeouts.requestMs,
  );
}

export class HostedClient {
  private readonly timeouts: Timeouts;

  constructor(
    private readonly c: Credential,
    private readonly fetchImpl: Fetch = fetch,
    timeouts: Partial<Timeouts> = {},
  ) {
    this.timeouts = { ...TIMEOUTS, ...timeouts };
  }

  private send<T>(
    route: Route,
    params: Record<string, string | number>,
    body?: BodyInit,
    type?: string,
    timeoutMs: number = this.timeouts.requestMs,
  ): Promise<Answer<T>> {
    return call<T>(
      this.fetchImpl,
      this.c.base,
      routeOf(route, params),
      {
        headers: {
          Authorization: `Bearer ${this.c.token}`,
          ...(type === undefined ? {} : { "Content-Type": type }),
        },
        ...(body === undefined ? {} : { body }),
      },
      timeoutMs,
    );
  }

  me(): Promise<Answer<Me>> {
    return this.send(HOSTED_ROUTES.me, {});
  }
  createUpload(
    size: number,
    posterSize: number,
  ): Promise<Answer<UploadCreated>> {
    return this.send(
      HOSTED_ROUTES.uploadCreate,
      {},
      JSON.stringify({ size, posterSize }),
      "application/json",
    );
  }
  putPart(
    id: string,
    n: number,
    bytes: Uint8Array,
  ): Promise<Answer<{ ok: true; n: number }>> {
    return this.send(
      HOSTED_ROUTES.uploadPart,
      { id, n },
      bytes as Uint8Array<ArrayBuffer>,
      "application/octet-stream",
      this.timeouts.partMs,
    );
  }
  putPoster(
    id: string,
    bytes: Uint8Array,
    type: string,
  ): Promise<Answer<{ ok: true }>> {
    return this.send(
      HOSTED_ROUTES.uploadPoster,
      { id },
      bytes as Uint8Array<ArrayBuffer>,
      type,
      this.timeouts.partMs,
    );
  }
  complete(id: string): Promise<Answer<UploadCompleted>> {
    return this.send(
      HOSTED_ROUTES.uploadComplete,
      { id },
      "{}",
      "application/json",
      this.timeouts.partMs,
    );
  }
  createLink(req: LinkCreateRequest): Promise<Answer<Link>> {
    return this.send(
      HOSTED_ROUTES.linkCreate,
      {},
      JSON.stringify(req),
      "application/json",
    );
  }
  logout(): Promise<Answer<{ ok: true }>> {
    return this.send(HOSTED_ROUTES.cliLogout, {}, "{}", "application/json");
  }
}
