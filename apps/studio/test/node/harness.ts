import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { createLibrary } from "@demoman/runner/studio";
import { STUDIO_HEADER, type StudioEvent } from "@demoman/studio-protocol";
import { createEventHub, type EventHub } from "../../src/events.js";
import { createPageServer } from "../../src/pages.js";
import { createRoutes } from "../../src/routes.js";
import {
  createStudioServer,
  type Handler,
  type StudioHandlers,
  type StudioServer,
} from "../../src/server.js";
import { createThumbs, type MakeThumb } from "../../src/thumbs.js";
import { type HomeFeeds, type WatchFn, watchHome } from "../../src/watch.js";

export interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: Buffer;
  text: string;
  json(): unknown;
}

/** Task 7's two handlers, stubbed: they are not this task's. */
export const stubWindow: Handler = async () => ({ status: 200, json: {} });
export const stubExportStart: Handler = async () => ({ status: 200, json: {} });

export interface Harness {
  studio: StudioServer;
  hub: EventHub;
  /** Every event the hub was asked to send, in order: counted here rather
   *  than off the stream, so a count made after a settle is not racing the
   *  socket. */
  sent: StudioEvent[];
  feeds: HomeFeeds;
  logs: string[];
  revealed: string[];
  pagesDir: string;
  call(
    path: string,
    o?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Buffer;
    },
  ): Promise<Answer>;
  /** An open `GET /api/events`; `waitFor` resolves when the text so far
   *  passes `test`, and rejects naming what arrived if it has not within
   *  `ms` (5 s unless given). */
  stream(): Promise<{
    text(): string;
    waitFor(test: (text: string) => boolean, ms?: number): Promise<string>;
    close(): void;
  }>;
  close(): Promise<void>;
}

const LIBRARY_HTML =
  '<!doctype html>\n<html lang="en">\n<head><title>Library</title></head><body>library</body></html>\n';
const EDITOR_HTML =
  '<!doctype html>\n<html lang="en">\n<head><title>Editor</title></head><body>editor</body></html>\n';

const SETTINGS_HTML =
  '<!doctype html>\n<html lang="en">\n<head><title>Settings</title></head><body>settings</body></html>\n';

/** A pages dir shaped like the studio build: three pages and an asset. */
export async function writePages(dir: string): Promise<void> {
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "library.html"), LIBRARY_HTML);
  await writeFile(join(dir, "editor.html"), EDITOR_HTML);
  await writeFile(join(dir, "settings.html"), SETTINGS_HTML);
  await writeFile(join(dir, "assets", "main.js"), "console.log(1);\n");
}

export async function startStudio(
  home: string,
  o: {
    revealFails?: string;
    make?: MakeThumb;
    watch?: WatchFn;
    settleMs?: number;
    onSettled?: (feed: "takes" | "kits") => void;
  } = {},
): Promise<Harness> {
  const logs: string[] = [];
  const revealed: string[] = [];
  const log = (line: string) => logs.push(line);
  const sent: StudioEvent[] = [];
  const realHub = createEventHub({ log });
  const hub: EventHub = {
    ...realHub,
    send(e) {
      sent.push(e);
      realHub.send(e);
    },
  };
  const pagesDir = join(home, "pages");
  await writePages(pagesDir);
  const library = createLibrary(home);
  await mkdir(join(home, "takes"), { recursive: true });
  const feeds = await watchHome({
    home,
    events: hub,
    log,
    ...(o.watch === undefined ? {} : { watch: o.watch }),
    ...(o.onSettled === undefined ? {} : { onSettled: o.onSettled }),
    // Short, so a test waits for the feed and not for the production delay.
    settleMs: o.settleMs ?? 40,
  });
  const handlers: StudioHandlers = {
    ...createRoutes({
      home,
      library,
      events: hub,
      log,
      version: "0.0.0-test",
      queued: () => 0,
      feeds,
      thumbs: createThumbs({
        library,
        ...(o.make === undefined ? {} : { make: o.make }),
      }),
      reveal: async (path) => {
        if (o.revealFails !== undefined) throw new Error(o.revealFails);
        revealed.push(path);
      },
    }),
    window: stubWindow,
    exportStart: stubExportStart,
  };
  const studio = await createStudioServer({
    handlers,
    pages: createPageServer({ dir: pagesDir }),
  });

  const headers = (extra: Record<string, string> = {}) => ({
    Host: `127.0.0.1:${studio.port}`,
    Cookie: `studio=${studio.token}`,
    [STUDIO_HEADER]: "1",
    ...extra,
  });

  const call: Harness["call"] = (path, c = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: studio.port,
          path,
          method: c.method ?? "GET",
          headers: headers(c.headers),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const bytes = Buffer.concat(chunks);
            const text = bytes.toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              bytes,
              text,
              json: () => JSON.parse(text) as unknown,
            });
          });
        },
      );
      req.on("error", reject);
      if (c.body !== undefined) req.write(c.body);
      req.end();
    });

  const stream: Harness["stream"] = () =>
    new Promise((resolve, reject) => {
      let text = "";
      const waiters = new Set<() => void>();
      const req = request(
        {
          host: "127.0.0.1",
          port: studio.port,
          path: "/api/events",
          headers: headers(),
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`events answered ${res.statusCode}`));
            return;
          }
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
            for (const w of waiters) w();
          });
          resolve({
            text: () => text,
            waitFor: (test, ms = 5_000) =>
              new Promise((ok, fail) => {
                const check = () => {
                  if (test(text)) {
                    waiters.delete(check);
                    clearTimeout(timer);
                    ok(text);
                  }
                };
                const timer = setTimeout(() => {
                  waiters.delete(check);
                  fail(
                    new Error(
                      `the stream never matched in ${ms} ms; it held:\n${text}`,
                    ),
                  );
                }, ms);
                waiters.add(check);
                check();
              }),
            close: () => req.destroy(),
          });
        },
      );
      req.on("error", (e) => {
        // A destroy() from close() is the test ending the stream.
        if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
      });
      req.end();
    });

  return {
    studio,
    hub,
    sent,
    feeds,
    logs,
    revealed,
    pagesDir,
    call,
    stream,
    close: async () => {
      feeds.close();
      hub.close();
      await studio.close();
    },
  };
}
