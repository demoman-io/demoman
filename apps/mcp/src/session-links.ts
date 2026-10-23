// apps/mcp/src/session-links.ts
//
// The links a saved export ends on (author, 2026-10-20): Open in studio,
// Reveal in Finder and Copy video, one click each in the agent's closing
// message. Terminals open http links only (Ghostty 1.3.1 dropped a
// `demoman://` scheme in the spike), so this server answers them on
// 127.0.0.1 while the session lives, and the tab a click leaves says what
// happened or why it did not.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { StudioToolAnswer } from "./tools.js";

/** What a saved export's answer carries as `links`: each action this
 *  server can take on that file. */
export interface SessionLinks {
  studio?: string;
  reveal?: string;
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
  reveal?: (path: string) => Promise<void>;
  copy?: (path: string) => Promise<void>;
  /** Finder and the pasteboard are macOS's: elsewhere only the studio link. */
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

/** `open -R`, which shows the file selected in a Finder window. */
export async function revealInFinder(path: string): Promise<void> {
  await run("open", ["-R", path]);
}

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

const page = (text: string) => `<!doctype html>
<meta charset="utf-8"><title>Demoman</title>
<meta name="color-scheme" content="light dark">
<body style="font:15px/1.5 system-ui,sans-serif;margin:40px">
<p>${escapeHtml(text)}</p>`;

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
  const reveal = deps.reveal ?? revealInFinder;
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
      case "reveal":
        await reveal(saved.path);
        return `Revealed ${nameOf(saved.path)} in Finder.`;
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
          res.end(page(text));
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
        ...(mac ? { reveal: at("reveal") } : {}),
        ...(mac && saved.isFile ? { copy: at("copy") } : {}),
      };
    },
    close: () => {
      server?.close();
    },
  };
}
