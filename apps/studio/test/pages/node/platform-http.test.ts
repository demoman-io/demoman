import type { ExportAnswer } from "@demoman/run-core";
import type { StudioEvent } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { goneText } from "../../../pages/src/platform/gone";
import {
  createPlatform,
  KITS_BUSY,
  StudioError,
} from "../../../pages/src/platform/http";
import type { ExportEvent } from "../../../pages/src/platform/types";

/**
 * The studio's side of `#platform` against a faked server: `fetch` answers
 * per route, and `/api/events` is a stream the test writes SSE frames into
 * (ruling R10: `fetch`, not `EventSource`, which cannot send the studio
 * header).
 *
 * Production changes that redden these, each made and watched go red:
 * - `request` treating a 409 as ok: the changedElsewhere case resolves.
 * - `request` not awaiting the version check for a write: the skew case
 *   sees a PUT.
 * - `follow` showing the stopped line on the first stream error rather than
 *   the second: the one-error control finds it.
 * - `kits.update` without its retry loop: the two-409s case rejects.
 */

const VERSION = "9.9.9-test";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  credentials: string | undefined;
}

type Route = (call: Call) => Response | Promise<Response> | undefined;

const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** A faked studio: routes tried in order, the ping and the event stream
 *  answered unless a test says otherwise. */
function fakeStudio() {
  const calls: Call[] = [];
  const routes: Route[] = [];
  let streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  /** How each successive `GET /api/events` answers: a stream by default. */
  const eventAnswers: Array<"stream" | "reject"> = [];
  let version = VERSION;
  const encoder = new TextEncoder();

  const fetchStub = vi.fn(
    async (input: string, init: RequestInit = {}): Promise<Response> => {
      const call: Call = {
        method: init.method ?? "GET",
        url: input,
        headers: { ...(init.headers as Record<string, string>) },
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
        credentials: init.credentials,
      };
      calls.push(call);
      if (call.url === "/api/events") {
        if ((eventAnswers.shift() ?? "stream") === "reject") {
          throw new TypeError("Failed to fetch");
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
            controller.enqueue(encoder.encode(": connected\n\n"));
            init.signal?.addEventListener("abort", () => {
              try {
                controller.error(new DOMException("aborted", "AbortError"));
              } catch {
                // Already closed: nothing to abort.
              }
            });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      for (const route of routes) {
        const answer = await route(call);
        if (answer !== undefined) return answer;
      }
      if (call.url === "/api/ping") {
        return json(200, { version, pid: 1, queued: 0 });
      }
      return json(404, {
        reason: "routeNotFound",
        detail: `no fake for ${call.method} ${call.url}`,
      });
    },
  );

  return {
    calls,
    fetch: fetchStub,
    route(fn: Route) {
      routes.push(fn);
    },
    setVersion(v: string) {
      version = v;
    },
    eventAnswers,
    /** One SSE frame to every open stream, as the server's `frameOf`. */
    send(e: StudioEvent) {
      const text = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
      for (const c of streams) c.enqueue(encoder.encode(text));
    },
    /** Ends every open stream, as a server that went away. */
    endStreams() {
      for (const c of streams) c.close();
      streams = [];
    },
    openStreams: () => streams.length,
  };
}

let studio: ReturnType<typeof fakeStudio>;

beforeEach(() => {
  document.body.innerHTML = `<main id="page">the editor</main>`;
  studio = fakeStudio();
  vi.stubGlobal("fetch", studio.fetch);
  vi.stubEnv("STUDIO_VERSION", VERSION);
});

afterEach(() => {
  // Every platform made here stops following its stream.
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const gone = () =>
  document.querySelector<HTMLElement>("[data-studio-gone]")?.dataset
    .studioGone ?? null;

describe("the Export quality setting", () => {
  it("reads the Studio's answer, with its sentence when it could not use the file", async () => {
    const platform = createPlatform();
    let answered: Record<string, unknown> = {
      exportQuality: "share",
      unreadable: "x is not JSON",
    };
    studio.route((c) =>
      c.url === "/api/settings/export-quality" && c.method === "GET"
        ? json(200, answered)
        : undefined,
    );
    expect(await platform.exportQuality?.read()).toEqual({
      quality: "share",
      unreadable: "x is not JSON",
    });
    answered = { exportQuality: "full" };
    expect(await platform.exportQuality?.read()).toEqual({ quality: "full" });
  });

  it("writes { exportQuality } and returns the replaced sentence, if any", async () => {
    const platform = createPlatform();
    let sent: unknown;
    studio.route((c) => {
      if (c.url !== "/api/settings/export-quality" || c.method !== "PUT") {
        return undefined;
      }
      sent = c.body;
      return json(200, { exportQuality: "full", replaced: "it was replaced" });
    });
    expect(await platform.exportQuality?.write("full")).toEqual({
      replaced: "it was replaced",
    });
    expect(sent).toEqual({ exportQuality: "full" });
  });
});

describe("wallpapers", () => {
  // The upload's resize needs a real canvas: `fit-wallpaper.test.ts`
  // (run-core's browser lane) covers it. Here, what `load` answers.
  it("load answers the served bytes, and a refusal as its sentence rather than an empty image", async () => {
    const platform = createPlatform();
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
    studio.route((c) =>
      c.url === "/api/wallpaper?ref=assets%2Fa.webp"
        ? new Response(webp, { headers: { "Content-Type": "image/webp" } })
        : c.url.startsWith("/api/wallpaper?")
          ? json(422, {
              reason: "wallpaperRefused",
              detail: "/h/assets/b.webp could not be read (ENOENT)",
            })
          : undefined,
    );
    const got = await platform.wallpapers.load("assets/a.webp");
    if (!got.ok) throw new Error(got.error);
    expect(new Uint8Array(await got.blob.arrayBuffer())).toEqual(webp);
    expect(await platform.wallpapers.load("assets/b.webp")).toEqual({
      ok: false,
      error: "/h/assets/b.webp could not be read (ENOENT)",
    });
  });
});

describe("every request", () => {
  it("carries the Studio header and the session cookie", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/takes"
        ? json(200, { scenes: [], videos: [], videoOf: {} })
        : undefined,
    );
    expect(await platform.scenes.list()).toEqual([]);
    const call = studio.calls.find((c) => c.url === "/api/takes");
    expect(call?.headers["X-Demoman-Studio"]).toBe("1");
    expect(call?.credentials).toBe("same-origin");
    // The event stream too (R10).
    const events = studio.calls.find((c) => c.url === "/api/events");
    expect(events?.headers["X-Demoman-Studio"]).toBe("1");
  });

  it("turns a refusal into its detail, with the reason on the error", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/takes"
        ? json(500, {
            reason: "libraryUnreadable",
            detail: "Could not read the library.",
          })
        : undefined,
    );
    const error = await platform.scenes.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudioError);
    expect((error as StudioError).message).toBe("Could not read the library.");
    expect((error as StudioError).reason).toBe("libraryUnreadable");
    // Not a session failure: the page stays.
    expect(gone()).toBeNull();
  });
});

describe("scenes", () => {
  it("rejects a save another window got to first with the Studio's sentence", async () => {
    const platform = createPlatform();
    const scene = readonlyScene();
    studio.route((c) =>
      c.method === "PUT"
        ? json(409, {
            reason: "changedElsewhere",
            detail:
              "This take changed in another window. Reopen it to keep editing.",
          })
        : undefined,
    );
    const error = await platform.scenes
      .put(scene, "r-1")
      .then(() => "resolved")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudioError);
    expect((error as StudioError).message).toBe(
      "This take changed in another window. Reopen it to keep editing.",
    );
    expect((error as StudioError).reason).toBe("changedElsewhere");
    // Premise: the PUT went, with the revision as If-Match.
    const put = studio.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(`/api/takes/${scene.meta.id}/scene`);
    expect(put?.headers["If-Match"]).toBe("r-1");
  });

  it("answers the new revision for a save that landed", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.method === "PUT" ? json(200, { revision: "r-2" }) : undefined,
    );
    expect(await platform.scenes.put(readonlyScene(), "r-1")).toEqual({
      revision: "r-2",
    });
  });

  it("reads a take that is not stored as null, and any other refusal as a rejection", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/takes/gone/scene"
        ? json(404, { reason: "takeNotFound", detail: "No take gone." })
        : c.url === "/api/takes/bad/scene"
          ? json(500, { reason: "libraryUnreadable", detail: "Unreadable." })
          : undefined,
    );
    expect(await platform.scenes.get("gone")).toBeNull();
    await expect(platform.scenes.get("bad")).rejects.toThrow("Unreadable.");
  });

  it("says who holds a take a delete was refused for, and the note of one that went", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.method === "DELETE" && c.url === "/api/takes/busy"
        ? json(409, {
            reason: "takeBusy",
            detail: "This take is being exported by an agent.",
          })
        : c.method === "DELETE"
          ? json(200, {
              note: "Cleared a stale export lock left by process 7.",
            })
          : undefined,
    );
    expect(await platform.scenes.remove("busy")).toEqual({
      ok: false,
      error: "takeBusy",
      // The library adds its own full stop ("Not deleted: <detail>.").
      detail: "This take is being exported by an agent",
    });
    expect(await platform.scenes.remove("t1")).toEqual({
      ok: true,
      note: "Cleared a stale export lock left by process 7.",
    });
  });
});

describe("the version check", () => {
  it("sends no edit from a page built for another studio, and says so", async () => {
    studio.setVersion("0.0.1-older");
    const platform = createPlatform();
    const error = await platform.scenes
      .put(readonlyScene(), "r-1")
      .then(() => "resolved")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudioError);
    expect((error as StudioError).reason).toBe("versionSkew");
    expect(studio.calls.filter((c) => c.method !== "GET")).toEqual([]);
    // Premise: the ping went, and was what told it.
    expect(studio.calls.some((c) => c.url === "/api/ping")).toBe(true);
    expect(gone()).toBe("updated");
    expect(document.body.textContent).toContain(goneText("updated"));
  });

  it("sends the edit when the versions agree (the control)", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.method === "PUT" ? json(200, { revision: "r-2" }) : undefined,
    );
    await platform.scenes.put(readonlyScene(), "r-1");
    expect(studio.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(gone()).toBeNull();
  });
});

describe("a lost studio", () => {
  it("covers the page with the stopped line after two event-stream failures", async () => {
    studio.eventAnswers.push("reject", "reject");
    createPlatform();
    await vi.waitFor(() => {
      if (gone() === null) throw new Error("no line yet");
    });
    expect(gone()).toBe("stopped");
    expect(document.body.textContent).toContain(goneText("stopped"));
    expect(document.querySelector("code")?.textContent).toBe(
      "npx demoman studio",
    );
    // The page's own elements are covered, not removed: inert under a line
    // the stylesheet lays over them, no inline style (ruling R20).
    const page = document.getElementById("page");
    expect(page?.inert).toBe(true);
    expect(page?.getAttribute("style")).toBeNull();
    const box = document.querySelector("[data-studio-gone]");
    expect(box?.classList.contains("gone")).toBe(true);
    expect(box?.getAttribute("style")).toBeNull();
    expect(document.body.textContent).not.toContain("`");
    expect(
      studio.calls.filter((c) => c.url === "/api/events"),
      "tried twice",
    ).toHaveLength(2);
  });

  it("reconnects after one failure and shows nothing (the control)", async () => {
    studio.eventAnswers.push("reject");
    createPlatform();
    await vi.waitFor(() => {
      if (studio.openStreams() === 0) throw new Error("not reconnected yet");
    });
    expect(
      studio.calls.filter((c) => c.url === "/api/events"),
      "the failed try and the reconnect",
    ).toHaveLength(2);
    expect(gone()).toBeNull();
  });

  it("covers the page when a request finds no server", async () => {
    const platform = createPlatform();
    studio.route((c) => {
      if (c.url === "/api/takes") throw new TypeError("Failed to fetch");
      return undefined;
    });
    await expect(platform.scenes.list()).rejects.toBeInstanceOf(StudioError);
    expect(gone()).toBe("stopped");
  });

  it("says the server is stopping when it says so", async () => {
    createPlatform();
    await vi.waitFor(() => {
      if (studio.openStreams() === 0) throw new Error("no stream yet");
    });
    studio.send({ type: "server:stopping" });
    await vi.waitFor(() => {
      if (gone() === null) throw new Error("no line yet");
    });
    expect(gone()).toBe("stopped");
  });
});

describe("an expired session", () => {
  it("covers the page with the expired line on the guard's 403", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/takes"
        ? json(403, { reason: "tokenWrong", detail: "The session is wrong." })
        : undefined,
    );
    await expect(platform.scenes.list()).rejects.toThrow(
      "The session is wrong.",
    );
    expect(gone()).toBe("expired");
    expect(document.body.textContent).toContain(goneText("expired"));
  });

  it("leaves the page for a route's own 403 (a reveal of an unlisted path)", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/reveal"
        ? json(403, {
            reason: "revealRefused",
            detail: "/x is not an export any take lists, so it is not shown.",
          })
        : undefined,
    );
    await expect(
      platform.files.reveal({ kind: "path", path: "/x" }),
    ).rejects.toThrow("is not an export any take lists");
    expect(gone()).toBeNull();
  });
});

describe("brand kits", () => {
  /** A kits file that changes under each PUT `conflicts` times. */
  function kitsServer(conflicts: number) {
    let revision = 0;
    let stored: { kits: unknown[]; default: string | null } = {
      kits: [],
      default: null,
    };
    let left = conflicts;
    const puts: string[] = [];
    studio.route((c) => {
      if (c.url !== "/api/kits") return undefined;
      if (c.method === "GET") {
        return json(200, { stored, revision: `k${revision}` });
      }
      puts.push(c.headers["If-Match"] ?? "none");
      if (left > 0) {
        left -= 1;
        // Another window wrote meanwhile.
        revision += 1;
        return json(409, {
          reason: "changedElsewhere",
          detail: "The kits changed in another window.",
        });
      }
      if (c.headers["If-Match"] !== `k${revision}`) {
        return json(409, { reason: "changedElsewhere", detail: "stale" });
      }
      stored = c.body as typeof stored;
      revision += 1;
      return json(200, { revision: `k${revision}` });
    });
    return { puts, stored: () => stored };
  }

  const addKit = (cur: {
    kits: { id: string; name: string; branding: unknown }[];
    defaultId: string | null;
  }) => ({
    kits: [...cur.kits, { id: "kit-1", name: "Mine", branding: {} }],
    defaultId: "kit-1",
  });

  it("re-reads and re-applies a change refused twice, and lands it on the third try", async () => {
    const server = kitsServer(2);
    const platform = createPlatform();
    expect(await platform.kits.update(addKit as never)).toBeNull();
    expect(server.puts, "each try sent the revision it had read").toEqual([
      "k0",
      "k1",
      "k2",
    ]);
    expect(server.stored()).toEqual({
      kits: [{ id: "kit-1", name: "Mine", branding: {} }],
      default: "kit-1",
    });
  });

  it("refuses kitsBusy after three refused tries, and tries no fourth", async () => {
    const server = kitsServer(4);
    const platform = createPlatform();
    const error = await platform.kits
      .update(addKit as never)
      .then(() => "resolved")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudioError);
    expect((error as StudioError).reason).toBe("kitsBusy");
    expect((error as StudioError).message).toBe(KITS_BUSY);
    expect(server.puts).toHaveLength(3);
  });

  it("reads a kits file the Studio could not judge as unreadable, with its reason", async () => {
    studio.route((c) =>
      c.url === "/api/kits"
        ? json(200, {
            invalid: { reason: "kits.json is not valid JSON" },
            revision: "k9",
          })
        : undefined,
    );
    const platform = createPlatform();
    expect(await platform.kits.read()).toEqual({
      state: "invalid",
      reason: "kits.json is not valid JSON",
    });
    // And an update refuses rather than writing over it.
    expect(await platform.kits.update(addKit as never)).toMatch(
      /could not be read \(kits\.json is not valid JSON\)/,
    );
    expect(studio.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });
});

describe("exports", () => {
  const saved = (
    over: Partial<Extract<ExportAnswer, { outcome: "saved" }>>,
  ): ExportAnswer =>
    ({
      outcome: "saved",
      takeId: "t1",
      aspect: "16:9",
      width: 1920,
      height: 1080,
      fps: 30,
      warnings: { logo: null, unavailableSpans: [], detailViolations: [] },
      fileType: "mp4",
      file: {
        path: "/Users/me/Downloads/demo.mp4",
        byteLength: 2048,
        downloadId: null,
      },
      summary: "Saved demo.mp4.",
      ...over,
    }) as ExportAnswer;

  it("posts only the file type and the revision", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/takes/t1/exports"
        ? json(200, { jobId: "j1", position: 0 })
        : undefined,
    );
    await platform.exports.start("t1", {
      fileType: "gif",
      aspect: "9:16",
      revision: "r-5",
    });
    const post = studio.calls.find((c) => c.url === "/api/takes/t1/exports");
    expect(post?.body).toEqual({ fileType: "gif", revision: "r-5" });
  });

  it("holds the queue's first event until the POST names the job, then reports this page's job alone", async () => {
    const platform = createPlatform();
    const events: ExportEvent[] = [];
    platform.exports.onEvent((e) => events.push(e));
    await vi.waitFor(() => {
      if (studio.openStreams() === 0) throw new Error("no stream yet");
    });
    let answer: (r: Response) => void = () => undefined;
    studio.route((c) =>
      c.url === "/api/takes/t1/exports"
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : undefined,
    );
    const started = platform.exports.start("t1", {
      fileType: "mp4",
      aspect: "16:9",
      revision: "r-1",
    });
    await vi.waitFor(() => {
      if (!studio.calls.some((c) => c.url === "/api/takes/t1/exports"))
        throw new Error("not posted yet");
    });
    // The queue speaks before the POST answers.
    studio.send({
      type: "export",
      takeId: "t1",
      jobId: "j1",
      phase: "queued",
      position: 1,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([]);
    answer(json(200, { jobId: "j1", position: 1 }));
    await started;
    expect(events).toEqual([{ kind: "queued", jobId: "j1", position: 1 }]);

    // Another window's job moves nothing here but the list.
    studio.send({
      type: "export",
      takeId: "t1",
      jobId: "other",
      phase: "saved",
      report: saved({}),
    });
    studio.send({
      type: "export",
      takeId: "t1",
      jobId: "j1",
      phase: "saved",
      report: saved({}),
    });
    await vi.waitFor(() => {
      if (!events.some((e) => e.kind === "saved")) throw new Error("not yet");
    });
    expect(events.slice(1)).toEqual([
      { kind: "outputsChanged" },
      {
        kind: "saved",
        jobId: "j1",
        save: {
          kind: "saved",
          names: ["demo.mp4"],
          byteLength: 2048,
          reveal: { kind: "path", path: "/Users/me/Downloads/demo.mp4" },
          summary: "Saved demo.mp4.",
          outputRefs: [],
        },
        summary: "Saved demo.mp4.",
      },
      { kind: "outputsChanged" },
    ]);
  });

  it("reports a stills folder by its folder, its stills and their summed size", async () => {
    const platform = createPlatform();
    const events: ExportEvent[] = [];
    platform.exports.onEvent((e) => events.push(e));
    studio.route((c) =>
      c.url === "/api/takes/t1/exports"
        ? json(200, { jobId: "j2", position: 0 })
        : undefined,
    );
    await vi.waitFor(() => {
      if (studio.openStreams() === 0) throw new Error("no stream yet");
    });
    await platform.exports.start("t1", {
      fileType: "stills",
      aspect: "16:9",
      revision: "r-1",
    });
    studio.send({
      type: "export",
      takeId: "t1",
      jobId: "j2",
      phase: "saved",
      report: {
        ...saved({}),
        fileType: "stills",
        folder: {
          path: "/Users/me/Downloads/demo stills",
          files: [
            { name: "01.png", byteLength: 100 },
            { name: "02.png", byteLength: 250 },
          ],
        },
        summary: "Saved 2 stills.",
      } as unknown as ExportAnswer,
    });
    await vi.waitFor(() => {
      if (!events.some((e) => e.kind === "saved")) throw new Error("not yet");
    });
    expect(events.find((e) => e.kind === "saved")).toMatchObject({
      save: {
        names: ["01.png", "02.png"],
        byteLength: 350,
        reveal: { kind: "path", path: "/Users/me/Downloads/demo stills" },
      },
    });
  });

  it("ends this page's job on a failure with the queue's sentence", async () => {
    const platform = createPlatform();
    const events: ExportEvent[] = [];
    platform.exports.onEvent((e) => events.push(e));
    studio.route((c) =>
      c.url === "/api/takes/t1/exports"
        ? json(200, { jobId: "j3", position: 0 })
        : undefined,
    );
    await vi.waitFor(() => {
      if (studio.openStreams() === 0) throw new Error("no stream yet");
    });
    await platform.exports.start("t1", {
      fileType: "mp4",
      aspect: "16:9",
      revision: "r-1",
    });
    studio.send({
      type: "export",
      takeId: "t1",
      jobId: "j3",
      phase: "failed",
      reason: "takeNotFound",
      detail: "Not exported: the take was deleted before its turn came.",
    });
    await vi.waitFor(() => {
      if (!events.some((e) => e.kind === "failed")) throw new Error("not yet");
    });
    expect(events).toEqual([
      {
        kind: "failed",
        jobId: "j3",
        detail: "Not exported: the take was deleted before its turn came.",
      },
      { kind: "outputsChanged" },
    ]);
  });
});

describe("frames, outputs, nav", () => {
  it("loads a frame from the take whose bundle named it", async () => {
    const platform = createPlatform();
    const bundle = {
      keyframes: [{ ref: "kf:t1:0" }],
      motionSpans: [{ ref: "span:t1:0" }],
    };
    studio.route((c) =>
      c.url === "/api/takes/t1/bundle"
        ? json(200, { bundle, replay: null, capture: null })
        : c.url === `/api/takes/t1/frames/${encodeURIComponent("span:t1:0")}`
          ? new Response(new Uint8Array([1, 2, 3]))
          : undefined,
    );
    await expect(platform.bundles.load("span:t1:0")).rejects.toThrow(
      /no take this page has read/,
    );
    await platform.bundles.active("t1");
    expect(await platform.bundles.load("span:t1:0")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("lists outputs.json's rows newest first, gone files included", async () => {
    const platform = createPlatform();
    const row = (path: string, renderedAt: string, exists: boolean) => ({
      path,
      fileType: "mp4",
      aspect: "16:9",
      byteLength: 10,
      renderedAt,
      sceneDigest: "d",
      report: { summary: `made ${path}` },
      exists,
    });
    studio.route((c) =>
      c.url === "/api/takes/t1/outputs"
        ? json(200, {
            outputs: [
              row("/a/old.mp4", "2026-10-16T01:00:00.000Z", false),
              row("/a/new.mp4", "2026-10-16T02:00:00.000Z", true),
            ],
          })
        : undefined,
    );
    const rows = await platform.outputs.list("t1");
    expect(
      rows.map((r) => (r.kind === "file" ? [r.name, r.exists] : r)),
    ).toEqual([
      ["new.mp4", true],
      ["old.mp4", false],
    ]);
    // A record that is not a saved export has no frame to say.
    expect(rows[0]).toMatchObject({
      detail: null,
      renderedAt: "2026-10-16T02:00:00.000Z",
      path: "/a/new.mp4",
    });
  });

  // The author, 2026-10-19: a row says its frame, not the sentence that
  // restates its path and size. Red: put `summary` back on the row. Its
  // caveats ride on it as clauses, for the row's warnings chip (review
  // 2026-10-19: without them a reload left nothing saying the file has no
  // logo). Red: drop `caveats` from `outputRowOf`.
  it("says a saved export's frame and its caveats, not its sentence", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/takes/t1/outputs"
        ? json(200, {
            outputs: [
              {
                path: "/a/demo.mp4",
                fileType: "mp4",
                aspect: "16:9",
                byteLength: 10,
                renderedAt: "2026-10-16T02:00:00.000Z",
                sceneDigest: "d",
                exists: true,
                report: {
                  outcome: "saved",
                  takeId: "t1",
                  aspect: "16:9",
                  width: 1920,
                  height: 1318,
                  fps: 30,
                  fileType: "mp4",
                  file: {
                    path: "/a/demo.mp4",
                    byteLength: 10,
                    downloadId: null,
                  },
                  warnings: {
                    logo: "decode failed",
                    unavailableSpans: [],
                    detailViolations: [],
                  },
                  summary: "Saved /a/demo.mp4 (1920×1318, 30 fps), but …",
                },
              },
            ],
          })
        : undefined,
    );
    const [row] = await platform.outputs.list("t1");
    expect(row).toMatchObject({
      detail: "1920×1318 · 30 fps",
      caveats: ["the logo is missing (decode failed)"],
    });
    expect(JSON.stringify(row)).not.toContain("Saved /a/demo.mp4");
  });

  // A record an older studio wrote, its warnings not in the shape this
  // build reads: the row says they could not be read, never reads as clean.
  // Red: let `caveatsOf` answer [] when `exportCaveats` throws.
  it("says a record's warnings could not be read rather than none", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/takes/t1/outputs"
        ? json(200, {
            outputs: [
              {
                path: "/a/demo.mp4",
                fileType: "mp4",
                aspect: "16:9",
                byteLength: 10,
                renderedAt: "2026-10-16T02:00:00.000Z",
                sceneDigest: "d",
                exists: true,
                report: {
                  outcome: "saved",
                  takeId: "t1",
                  aspect: "16:9",
                  width: 1920,
                  height: 1318,
                  fps: 30,
                  fileType: "mp4",
                  file: {
                    path: "/a/demo.mp4",
                    byteLength: 10,
                    downloadId: null,
                  },
                  summary: "Saved /a/demo.mp4.",
                },
              },
            ],
          })
        : undefined,
    );
    const [row] = await platform.outputs.list("t1");
    const caveats = row?.kind === "file" ? row.caveats : null;
    expect(caveats, JSON.stringify(row)).toHaveLength(1);
    expect(caveats?.[0]).toMatch(/^its warnings could not be read: /);
  });

  it("names the Studio's pages and the re-film line", () => {
    const platform = createPlatform();
    expect(platform.nav.editor("t 1")).toBe("/editor.html?scene=t%201");
    expect(platform.nav.library()).toBe("/");
    expect(platform.nav.kits?.()).toBe("/settings.html");
    // A take not read yet, or in no video: no call can name it.
    expect(platform.nav.rerun("t1", false)).toEqual({
      kind: "line",
      text: "Ask your agent to re-record this take.",
    });
  });

  it("names the take's video in the re-record line once the take was read", async () => {
    // Red: build the line from the take id — `run({ takeId })`, which the
    // runner refuses (videoRequired).
    const platform = createPlatform();
    const VIDEO = "0b5d2a6e-1c3f-4e8a-9b7d-2f4c6a8e0b1d";
    studio.route((c) =>
      c.url === "/api/takes/t1/scene"
        ? json(200, {
            scene: readonlyScene(),
            revision: "r-1",
            notes: [],
            videoId: VIDEO,
          })
        : undefined,
    );
    await platform.scenes.get("t1");
    expect(platform.nav.rerun("t1", false)).toEqual({
      kind: "line",
      text: `Ask your agent to re-record this take — \`run({ video: { id: "${VIDEO}" } })\``,
    });
  });

  it("says why the take's video could not be read where the re-record line goes", async () => {
    // Red (second review 6): drop videoError on the floor — the editor
    // reads "Ask your agent to re-record this take." as if it were in no
    // video.
    const platform = createPlatform();
    const why = "/h/takes/t1/video.json is not JSON (Unexpected token)";
    studio.route((c) =>
      c.url === "/api/takes/t1/scene"
        ? json(200, {
            scene: readonlyScene(),
            revision: "r-1",
            notes: [],
            videoId: null,
            videoError: why,
          })
        : undefined,
    );
    await platform.scenes.get("t1");
    expect(platform.nav.rerun("t1", false)).toEqual({
      kind: "line",
      text: `Couldn't read which video this take is in: ${why}`,
    });
  });

  it("reads a video delete that stopped part-way as partly deleted, never as deleted", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.method === "DELETE"
        ? json(200, { note: null, partly: "only 1 of its 3 recordings went" })
        : undefined,
    );
    expect(await platform.videos.remove("v")).toEqual({
      ok: true,
      partly: "only 1 of its 3 recordings went",
    });
  });

  it("goes where the server sends the window", async () => {
    const platform = createPlatform();
    const went: string[] = [];
    platform.nav.onOpen?.((path) => went.push(path));
    await vi.waitFor(() => {
      if (studio.openStreams() === 0) throw new Error("no stream yet");
    });
    studio.send({ type: "open", path: "/editor.html?scene=t2" });
    await vi.waitFor(() => {
      if (went.length === 0) throw new Error("not yet");
    });
    expect(went).toEqual(["/editor.html?scene=t2"]);
  });
});

describe("the take folder and the kit feed", () => {
  /** Waits for the event stream to be open, then sends. */
  async function sendWhenOpen(e: StudioEvent): Promise<void> {
    await vi.waitFor(() => {
      if (studio.openStreams() === 0) throw new Error("no stream yet");
    });
    studio.send(e);
  }

  it("folder.read answers sizes, unreadable and unwatched as the Studio sent them", async () => {
    const platform = createPlatform();
    const scene = readonlyScene();
    const sent = {
      videos: [],
      videoOf: {},
      scenes: [scene],
      sizes: { [scene.meta.id]: 2048, "half-made": 12 },
      unreadable: [
        { folder: "half-made", reason: "scene.json is not JSON", kind: "take" },
      ],
      unwatched: "the watcher stopped: ENOSPC",
    };
    studio.route((c) => (c.url === "/api/takes" ? json(200, sent) : undefined));
    const got = await platform.folder?.read();
    // Premise: the member exists on this side, and the fixture carries a
    // value in each field the assertion compares.
    expect(got).toBeDefined();
    expect(Object.keys(sent.sizes).length).toBe(2);
    expect(sent.unreadable.length).toBe(1);
    expect(got).toEqual(sent);
    // The same answer feeds scenes.list.
    expect((await platform.scenes.list()).map((s) => s.meta.id)).toEqual([
      scene.meta.id,
    ]);
  });

  it("a takes event and a takes watchFailed each call onChange once; a kits watchFailed does not", async () => {
    const platform = createPlatform();
    let takes = 0;
    let kits = 0;
    platform.folder?.onChange(() => {
      takes += 1;
    });
    platform.kits.onChange?.(() => {
      kits += 1;
    });
    await sendWhenOpen({ type: "takes" });
    await vi.waitFor(() => {
      if (takes !== 1) throw new Error(`takes=${takes} kits=${kits}`);
    });
    studio.send({ type: "watchFailed", feed: "takes", detail: "gone" });
    await vi.waitFor(() => {
      if (takes !== 2) throw new Error(`takes=${takes} kits=${kits}`);
    });
    studio.send({ type: "watchFailed", feed: "kits", detail: "gone" });
    // The kits listener is the proof the event was handled: the takes
    // listener has had every chance to hear it by then.
    await vi.waitFor(() => {
      if (kits !== 1) throw new Error(`takes=${takes} kits=${kits}`);
    });
    expect({ takes, kits }).toEqual({ takes: 2, kits: 1 });
  });

  it("kits.unwatched is null before any read and the Studio's sentence after", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/kits"
        ? json(200, {
            stored: { kits: [], default: null },
            revision: "k0",
            unwatched: "the kits watcher stopped: EMFILE",
          })
        : undefined,
    );
    expect(platform.kits.unwatched?.()).toBeNull();
    await platform.kits.read();
    expect(platform.kits.unwatched?.()).toBe(
      "the kits watcher stopped: EMFILE",
    );
  });

  it("folder.thumb asks for the thumb of the take whose bundle named the ref", async () => {
    const platform = createPlatform();
    const bitmap = { width: 3, height: 2 } as unknown as ImageBitmap;
    const made: Blob[] = [];
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => {
        made.push(blob);
        return bitmap;
      }),
    );
    studio.route((c) =>
      c.url === "/api/takes/t1/bundle"
        ? json(200, {
            bundle: { keyframes: [{ ref: "kf:t1:0" }], motionSpans: [] },
            replay: null,
            capture: null,
          })
        : c.url === `/api/takes/t1/thumbs/${encodeURIComponent("kf:t1:0")}`
          ? new Response(new Uint8Array([0xff, 0xd8]), {
              headers: { "Content-Type": "image/jpeg" },
            })
          : undefined,
    );
    // A ref no bundle named: rejects, naming it, and asks nothing.
    await expect(platform.folder?.thumb("kf:t9:0")).rejects.toThrow(/kf:t9:0/);
    expect(studio.calls.some((c) => c.url.includes("/thumbs/"))).toBe(false);
    await platform.bundles.active("t1");
    expect(await platform.folder?.thumb("kf:t1:0")).toBe(bitmap);
    expect(
      studio.calls.filter((c) => c.url.includes("/thumbs/")).map((c) => c.url),
    ).toEqual([`/api/takes/t1/thumbs/${encodeURIComponent("kf:t1:0")}`]);
    expect(made).toHaveLength(1);
  });

  it("folder.thumb rejects with the Studio's detail when the preview could not be made", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/takes/t1/bundle"
        ? json(200, {
            bundle: { keyframes: [{ ref: "kf:t1:0" }], motionSpans: [] },
            replay: null,
            capture: null,
          })
        : c.url.includes("/thumbs/")
          ? json(500, {
              reason: "thumbFailed",
              detail: "Couldn't make a preview of kf:t1:0: sips said no.",
            })
          : undefined,
    );
    await platform.bundles.active("t1");
    await expect(platform.folder?.thumb("kf:t1:0")).rejects.toThrow(
      "Couldn't make a preview of kf:t1:0: sips said no.",
    );
  });

  it("kits.reset answers the backup path", async () => {
    const platform = createPlatform();
    studio.route((c) =>
      c.url === "/api/kits/reset" && c.method === "POST"
        ? json(200, { backup: "/Users/a/.demoman/kits.json.bak" })
        : undefined,
    );
    expect(await platform.kits.reset()).toEqual({
      backup: "/Users/a/.demoman/kits.json.bak",
    });
  });

  it("names the Studio's empty-library hint", () => {
    expect(createPlatform().nav.firstTakeHint()).toBe(
      "Ask your agent for a demo video. Each take shows up here, grouped by the day you made it.",
    );
  });
});
