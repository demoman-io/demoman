// apps/mcp/src/session-links.ts
//
// The links a saved export ends on (author, 2026-10-20): Open in studio,
// the file itself and Copy video, one click each in the agent's closing
// message. The file is a plain file:// link, which the terminal hands to
// macOS with no browser (2026-10-23). The other two need this process to
// act, and Claude Code makes only http, https and file links clickable, so
// this server answers them on 127.0.0.1 while the session lives. Their tab
// closes itself when the action worked, and stays to say why when it did not.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import type { StudioToolAnswer } from "./tools.js";

/** What a saved export's answer carries as `links`: the file, and each
 *  action this server can take on it. */
export interface SessionLinks {
  studio?: string;
  /** file:// to the video, GIF or stills folder. */
  file: string;
  copy?: string;
}

/** A saved export, as the links need it: `isFile` false is a stills folder,
 *  which has no Copy. */
export interface SavedExport {
  takeId: string;
  path: string;
  isFile: boolean;
}

export type LinksFor = (
  saved: SavedExport,
) => Promise<SessionLinks | { error: string }>;

export interface SessionLinkDeps {
  /** Absent: `demoman-mcp`, which lists no studio tool, gives no studio link. */
  studio?: (args: { takeId: string }) => Promise<StudioToolAnswer>;
  copy?: (path: string) => Promise<void>;
  /** The pasteboard is macOS's: elsewhere no Copy. */
  platform?: NodeJS.Platform;
  log: (line: string) => void;
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error === null) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || error.message));
    });
  });

/**
 * The file itself on the pasteboard, as Finder's Copy puts it, so it pastes
 * into Slack, Mail or a Finder window. Read back after the write: a process
 * macOS keeps out of ~/Downloads gets `true` from writeObjects and an empty
 * pasteboard (measured in the 2026-10-20 spike), which must not read as
 * copied.
 */
export async function copyFileToClipboard(path: string): Promise<void> {
  const said = await run("osascript", [
    "-e",
    'use framework "AppKit"',
    "-e",
    "on run argv",
    "-e",
    "set pb to current application's NSPasteboard's generalPasteboard()",
    "-e",
    "pb's clearContents()",
    "-e",
    "pb's writeObjects:{current application's NSURL's fileURLWithPath:(item 1 of argv)}",
    "-e",
    'if (pb\'s stringForType:"public.file-url") is missing value then return "empty"',
    "-e",
    'return "copied"',
    "-e",
    "end run",
    path,
  ]);
  if (said !== "copied") {
    throw new Error(
      "macOS left the clipboard empty — the terminal Demoman runs in may not be allowed to read this folder (System Settings → Privacy & Security → Files and Folders)",
    );
  }
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );

// A tab a terminal opened has one history entry, which browsers let a
// script close; where one refuses, the sentence stays readable.
const CLOSE = "<script>window.close()</script>";

const page = (text: string, close: boolean) => `<!doctype html>
<meta charset="utf-8"><title>Demoman</title>
<meta name="color-scheme" content="light dark">
<body style="font:15px/1.5 system-ui,sans-serif;margin:40px">
<p>${escapeHtml(text)}</p>${close ? CLOSE : ""}`;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nameOf = (path: string) => path.split("/").pop() ?? path;

/**
 * One server per demoman-mcp, listening on first use. Each saved export
 * gets one unguessable token, and a link is `/<action>/<token>`: a page
 * elsewhere cannot guess one, and no link names a path.
 */
export function createSessionLinks(deps: SessionLinkDeps): {
  linksFor: LinksFor;
  close: () => void;
} {
  const copy = deps.copy ?? copyFileToClipboard;
  const mac = (deps.platform ?? process.platform) === "darwin";
  const exports = new Map<string, SavedExport>();
  let server: Server | null = null;
  let listening: Promise<number> | null = null;

  const act = async (action: string, saved: SavedExport): Promise<string> => {
    switch (action) {
      case "studio": {
        if (deps.studio === undefined) throw new Error("no studio here");
        const answer = await deps.studio({ takeId: saved.takeId });
        if ("reason" in answer) throw new Error(answer.detail);
        return answer.note === undefined
          ? "Opened in the studio."
          : `Opened in the studio. ${answer.note}`;
      }
      case "copy":
        await copy(saved.path);
        return `Copied ${nameOf(saved.path)}.`;
      default:
        throw new Error(`no such action: ${action}`);
    }
  };

  const listen = (): Promise<number> => {
    listening ??= new Promise<number>((resolve, reject) => {
      const s = createServer((req, res) => {
        const [, action = "", token = ""] = (req.url ?? "").split("/");
        const saved = exports.get(token);
        const reply = (status: number, text: string) => {
          res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
          res.end(page(text, status === 200));
        };
        if (req.method !== "GET" || saved === undefined) {
          reply(404, "This is not a link this Demoman session made.");
          return;
        }
        act(action, saved).then(
          (said) => reply(200, said),
          (error) => {
            deps.log(`a ${action} link failed: ${messageOf(error)}`);
            reply(500, `That did not work: ${messageOf(error)}`);
          },
        );
      });
      s.once("error", (error) => {
        listening = null;
        reject(error);
      });
      s.listen(0, "127.0.0.1", () => {
        server = s;
        // The links must not keep demoman-mcp alive after its host leaves.
        s.unref();
        resolve((s.address() as { port: number }).port);
      });
    });
    return listening;
  };

  return {
    linksFor: async (saved) => {
      let port: number;
      try {
        port = await listen();
      } catch (error) {
        return {
          error: `the links could not be served on 127.0.0.1: ${messageOf(error)}`,
        };
      }
      const token = randomBytes(18).toString("base64url");
      exports.set(token, saved);
      const at = (action: string) =>
        `http://127.0.0.1:${port}/${action}/${token}`;
      return {
        ...(deps.studio === undefined ? {} : { studio: at("studio") }),
        file: pathToFileURL(saved.path).href,
        ...(mac && saved.isFile ? { copy: at("copy") } : {}),
      };
    },
    close: () => {
      server?.close();
    },
  };
}
