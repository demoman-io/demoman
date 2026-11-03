import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "@demoman/runner/studio";
import {
  pathFor,
  ROUTES,
  type RouteId,
  STUDIO_HEADER,
} from "@demoman/studio-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEventHub } from "../../src/events.js";
import { createExportQueue } from "../../src/queue.js";
import { buildHandlers } from "../../src/serve.js";
import {
  createStudioServer,
  type Handler,
  type StudioHandlers,
} from "../../src/server.js";

// Spec §8: every route in studio-protocol's table has exactly one handler.
// The table is serve.ts's `buildHandlers`, the one runServe serves (R5).

const ids = Object.keys(ROUTES) as RouteId[];
const SAMPLE: Record<string, string> = { id: "take-1", ref: "kf:take-1:0" };

let home: string;
let composed: Record<string, unknown>;
const opens: unknown[] = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "studio-contract-"));
  const library = createLibrary(home);
  const events = createEventHub({ log: () => {} });
  composed = buildHandlers({
    home,
    library,
    events,
    feeds: {
      unwatched: () => ({ takes: null, kits: null }),
      kitsWritten: async () => {},
      close: () => {},
    },
    log: () => {},
    version: "0",
    queue: createExportQueue({
      library,
      events,
      run: () => Promise.reject(new Error("no export runs in this test")),
      log: () => {},
    }),
    window: {
      open: async (target) => {
        opens.push(target);
        return { ok: true, path: "/" };
      },
    },
  });
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("the route contract", () => {
  it("covers the whole table (premise)", () => {
    // 22 since 2026-10-19 (themeGet and themePut left with the light
    // theme); 24 since 2026-10-24, with videoRename and videoDelete; 26
    // since 2026-10-28, with wallpaperPut and wallpaper; 28 since
    // 2026-10-31, with libraryViewGet and libraryViewPut.
    expect(ids.length).toBe(28);
  });

  it("every RouteId has a handler in the composed table, and nothing else does", () => {
    // Red: delete the `logo` handler from createRoutes, or `window` from
    // buildHandlers.
    const missing = ids.filter((id) => typeof composed[id] !== "function");
    expect(missing, `routes with no handler: ${missing.join(", ")}`).toEqual(
      [],
    );
    const extra = Object.keys(composed).filter(
      (k) => !(ids as string[]).includes(k),
    );
    expect(extra, `handlers with no route: ${extra.join(", ")}`).toEqual([]);
  });

  it("the router sends each route's sample path to that route's handler", async () => {
    // Stubs keyed by the composed table, so a route it lacks has no stub
    // either and its request fails rather than reaching another handler.
    const hits: string[] = [];
    const stubs = Object.fromEntries(
      Object.keys(composed).map((id): [string, Handler] => [
        id,
        async () => {
          hits.push(id);
          return { status: 200, json: { id } };
        },
      ]),
    ) as StudioHandlers;
    const studio = await createStudioServer({
      handlers: stubs,
      pages: {
        async serve(_req, res) {
          res.writeHead(200);
          res.end();
        },
      },
    });
    try {
      for (const id of ids) {
        const wanted = (ROUTES[id].path.match(/:\w+/g) ?? []).map((p) =>
          p.slice(1),
        );
        const path = pathFor(
          id,
          Object.fromEntries(wanted.map((n) => [n, SAMPLE[n] as string])),
        );
        const answer = await new Promise<{ status: number; text: string }>(
          (resolve, reject) => {
            const req = request(
              {
                host: "127.0.0.1",
                port: studio.port,
                path,
                method: ROUTES[id].method,
                headers: {
                  Host: `127.0.0.1:${studio.port}`,
                  Cookie: `studio=${studio.token}`,
                  [STUDIO_HEADER]: "1",
                },
              },
              (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (c: string) => {
                  text += c;
                });
                res.on("end", () =>
                  resolve({ status: res.statusCode ?? 0, text }),
                );
              },
            );
            req.on("error", reject);
            req.end();
          },
        );
        expect(answer, `${ROUTES[id].method} ${path}`).toEqual({
          status: 200,
          text: JSON.stringify({ id }),
        });
      }
      expect(hits).toEqual(ids);
    } finally {
      await studio.close();
    }
  });

  // The page's half of the contract: every `request("<id>"` literal in
  // apps/studio/pages/src/platform/http.ts names a RouteId in ROUTES, and the
  // page reaches every route but `window` (openStudio's, never a page's).
  // Red: rename a literal there to one ROUTES lacks ("scenesPut"), or drop
  // a member's request.
  it("every RouteId http.ts names exists in ROUTES", () => {
    const source = readFileSync(
      new URL("../../pages/src/platform/http.ts", import.meta.url),
      "utf8",
    );
    const named = [...source.matchAll(/\brequest\(\s*"([^"]+)"/g)].map(
      (m) => m[1] as string,
    );
    // Premise: the pattern finds the calls at all.
    expect(named.length).toBeGreaterThan(15);
    const unknown = named.filter((id) => !(ids as string[]).includes(id));
    expect(unknown, `not in ROUTES: ${unknown.join(", ")}`).toEqual([]);
    expect([...new Set(named)].sort()).toEqual(
      ids.filter((id) => id !== "window").sort(),
    );
  });
});

describe("the window route (openStudio's hop to the window)", () => {
  const post = (body: unknown) =>
    (composed.window as Handler)({
      method: "POST",
      params: {},
      query: new URLSearchParams(),
      headers: {},
      body: async () => Buffer.from(JSON.stringify(body)),
      raw: undefined as never,
    });

  it("passes a posted project to window.open", async () => {
    opens.length = 0;
    const answer = await post({ project: "k" });
    // Red: drop `project` from the target buildHandlers.window builds.
    expect(answer).toEqual({ status: 200, json: { path: "/" } });
    expect(opens).toEqual([{ project: "k" }]);
  });

  // Red: send `project` as posted in serve.ts's window handler.
  it("sends a project asked for by an aliased key to the key it resolves to", async () => {
    opens.length = 0;
    const aliases = join(home, "videos", ".aliases.json");
    await mkdir(join(home, "videos"), { recursive: true });
    await writeFile(
      aliases,
      JSON.stringify({
        "github.com/a/r": "github.com/b/r",
        "github.com/b/r": "github.com/c/r",
      }),
    );
    try {
      const answer = await post({ project: "github.com/a/r" });
      expect(answer).toEqual({ status: 200, json: { path: "/" } });
      expect(opens).toEqual([{ project: "github.com/c/r" }]);
    } finally {
      await rm(aliases, { force: true });
    }
  });

  it("refuses a project that is not a string, opening nothing", async () => {
    opens.length = 0;
    const answer = await post({ project: 42 });
    // Red: delete the project type check.
    expect(answer).toMatchObject({
      status: 400,
      json: {
        reason: "windowDidNotOpen",
        detail: "No window was opened: project is not a string.",
      },
    });
    expect(opens).toEqual([]);
  });
});
