---
name: record-demo
description: Use when asked to record, shoot or make a demo video, screencast or walkthrough of a flow in a web app — a feature just built ("record a video of the feature we just built", "make a demo of checkout") or any public site ("record searching Wikipedia"). Produces an MP4 on disk through Demoman's tools. Also use when opening a pull request in a repo whose Demoman status says pullRequests "ask" or "attach".
---

# Record a demo with Demoman

Demoman's tools run a script you write in a browser window of their own on
this machine, then render the video to an MP4.

1. Call the `recipe` tool and follow it. It is the whole procedure: the
   script format with examples, how to read each report, and what every
   refusal means. Do not write a script before reading it.
2. Every run belongs to a flow (what you film; each run of it is one
   video). Before recording, find it: `flows` with `file` (an exported video
   the repo already has) or else `query`; then `run` with `flow: { id }`, or
   `flow: { new: "<name>" }` for a new one.
3. The browser is signed in only where the user ran `npx demoman signin <url>`
   or where a demo account in `.demoman/accounts.json` signs it in. On
   `signedOut`, follow the recipe's "Behind a login: demo accounts": reuse one,
   or create one on a local development database, else give the user the
   command from its detail. Only demo accounts; never ask for the user's own
   password.
4. When `export` answers `saved`, end on two lines: `summary` as it is, then
   its `links` as markdown links on one line, as the recipe's hand-back says.
