// apps/mcp/src/instructions.ts
//
// The server's MCP instructions: a preface Claude Code delivers whole up to
// 4,096 characters (its MCP docs; 2,048 before v2.1.296, so an older client
// loses the last lines); recipe.test.ts holds it to 3,500 for headroom. The
// recipe itself is the `recipe` tool (`recipe.md`).
/** The preface (spec 2026-10-12 §1; cli-launch.md project A). The first line
 *  names the recipe on its own: Pi shows a server only its first line. (The
 *  extension executor's own preface, INSTRUCTIONS, was archived with it on
 *  2026-10-20.) */
export const INSTRUCTIONS_CLI = `Demoman records demo videos of web apps. Call recipe first and follow it: it is the whole procedure, the script format with examples, and what every report and refusal means.

This server runs them in its own browser on this machine: signed in only where the user ran \`npx demoman signin <url>\` or a demo account in .demoman/accounts.json signs it in; otherwise a sign-in page answers signedOut. In short:
1. status — executor "cli" means this server's own browser; it opens on the first snapshot, run or export.
2. snapshot(url) — the page's targets, each one a run resolves. Copy a target verbatim; never compose one. landedElsewhere true means the app redirected: if landedUrl is a sign-in page (session "signedOut", or "none"/"unchecked" on a plain one), spend no run: reuse a demo account from status.accounts, or create one when the repo runs on a local development database (recipe), else give the user the command in sessionDetail. Only demo accounts; never ask for the user's own password.
3. run(script, flow) — a flow is what you film, a video one recording of it. First find the flow: flows({ file }) from an exported file the repo has, else flows({ query }); flow is { id } or { new: name }. Answers its report or {outcome: "stillRunning", id}; then call report(id) until the outcome is none of "running", "stillRunning". Fix what is the script's to fix. Stop after three runs, done or not.
4. export(videoId) — may answer stillRunning; call report(id) until the outcome is none of "exporting", "stillRunning". On "saved", file.path is the video's absolute path (folder.path for stills; in the user's Export folder, ~/Downloads unless they chose another in the Studio's Settings, or this server's --out-dir; status.exportsTo names it). End on summary, then its links as markdown links on one line (recipe: hand back).

When the Studio tool is listed and no links.studio is in hand, offer studio({ videoId }) after a run, a window where the user can edit and export the video; never open it unasked.

Before opening a pull request, check status.pullRequests; the recipe says when to record and attach.

Every refusal carries a "reason" to branch on and a "detail" to tell the user; recipe lists them all.`;
