import { createHash } from "node:crypto";
import { EXPIRED_LINE, SECURITY_HEADERS } from "./guard.js";

/**
 * The page a browser gets when its session cookie is missing or wrong (403).
 * With no session, the guarded assets (`shell.css`, the fonts) cannot load,
 * so the page carries its own style and nothing else. That one inline
 * `<style>` is allowed by its sha256 in a `style-src` added to this response's
 * CSP alone; every other response keeps `SECURITY_HEADERS` exactly.
 *
 * The look is the studio's (spec 2026-10-19): dark only, the site's
 * near-black ground and ink, Geist and Geist Mono by name (installed ones
 * only; the files are behind the cookie, as guard.test.ts holds), centred
 * on one quiet line.
 */
const STYLE = `
:root{color-scheme:dark;--ground:#0a0a0a;--ink:#f4f4f5;--ink-muted:#a1a1aa}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background-color:var(--ground);color:var(--ink-muted);font:400 14px/1.5 "Geist",ui-sans-serif,system-ui,sans-serif;letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
p{margin:0;max-width:40rem;text-align:center}
code{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;color:var(--ink)}
`;

const styleHash = `'sha256-${createHash("sha256").update(STYLE).digest("base64")}'`;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The document: the expired line, its backtick span drawn as `<code>`. */
export const EXPIRED_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demoman Studio</title><style>${STYLE}</style><p>${escapeHtml(EXPIRED_LINE).replace(/`([^`]*)`/g, "<code>$1</code>")}</p>`;

/** The page's CSP: the spec's, plus permission for the one style above. */
export const EXPIRED_CSP = `${SECURITY_HEADERS["Content-Security-Policy"]}; style-src ${styleHash}`;
