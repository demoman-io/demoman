// The only door to the hosted service. Every request but signing in needs a
// stored credential, so a signed-out machine cannot call it at all.
import type {
  Link,
  LinkChangeRequest,
  LinkCreateRequest,
  LoginPoll,
  LoginStart,
  Me,
  Refused,
  UploadCompleted,
  UploadCreated,
} from "@demoman/hosted-protocol";
import type { Credential } from "./credential.js";

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export type Answer<T> = { ok: true; value: T } | Refused;

async function call<T>(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (error) {
    return {
      ok: false,
      reason: "unavailable",
      detail: `Demoman's service could not be reached (${(error as Error).message}).`,
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const refused = body as Partial<Refused> | undefined;
  if (res.ok && !(refused?.ok === false)) return { ok: true, value: body as T };
  if (typeof refused?.reason === "string" && typeof refused.detail === "string")
    return { ok: false, reason: refused.reason, detail: refused.detail };
  if (res.status === 401)
    return {
      ok: false,
      reason: "signedOut",
      detail:
        "Demoman's service did not accept this sign-in; run `demoman login`.",
    };
  return {
    ok: false,
    reason: "unavailable",
    detail: `Demoman's service answered ${res.status} ${res.statusText} without saying why.`,
  };
}

export function startLogin(
  base: string,
  fetchImpl: Fetch = fetch,
): Promise<Answer<LoginStart>> {
  return call(fetchImpl, `${base}/api/hosted/cli/login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

export function pollLogin(
  base: string,
  code: string,
  fetchImpl: Fetch = fetch,
): Promise<Answer<LoginPoll>> {
  return call(fetchImpl, `${base}/api/hosted/cli/login/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

export class HostedClient {
  constructor(
    private readonly c: Credential,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private send<T>(
    method: string,
    path: string,
    body?: BodyInit,
    type?: string,
  ): Promise<Answer<T>> {
    return call<T>(this.fetchImpl, `${this.c.base}/api/hosted${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.c.token}`,
        ...(type === undefined ? {} : { "Content-Type": type }),
      },
      ...(body === undefined ? {} : { body }),
    });
  }

  me(): Promise<Answer<Me>> {
    return this.send("GET", "/me");
  }
  createUpload(
    size: number,
    posterSize: number,
  ): Promise<Answer<UploadCreated>> {
    return this.send(
      "POST",
      "/uploads",
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
      "PUT",
      `/uploads/${id}/parts/${n}`,
      bytes as Uint8Array<ArrayBuffer>,
      "application/octet-stream",
    );
  }
  putPoster(
    id: string,
    bytes: Uint8Array,
    type: string,
  ): Promise<Answer<{ ok: true }>> {
    return this.send(
      "PUT",
      `/uploads/${id}/poster`,
      bytes as Uint8Array<ArrayBuffer>,
      type,
    );
  }
  complete(id: string): Promise<Answer<UploadCompleted>> {
    return this.send(
      "POST",
      `/uploads/${id}/complete`,
      "{}",
      "application/json",
    );
  }
  createLink(req: LinkCreateRequest): Promise<Answer<Link>> {
    return this.send("POST", "/links", JSON.stringify(req), "application/json");
  }
  changeLink(id: string, req: LinkChangeRequest): Promise<Answer<Link>> {
    return this.send(
      "PATCH",
      `/links/${id}`,
      JSON.stringify(req),
      "application/json",
    );
  }
  logout(): Promise<Answer<{ ok: true }>> {
    return this.send("POST", "/cli/logout", "{}", "application/json");
  }
}
