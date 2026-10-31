# Recording a demo with Demoman

You write a DemoScript. Demoman runs it in a browser of its own on
this machine and saves the take on disk; `export` renders that take to an
MP4. Every tool answers JSON. A refusal is an error result carrying
`reason`, a stable identifier to branch on, and `detail`, a sentence for the
user; section 7 lists every reason.

## 1. Preflight

1. Call `status`. It answers `executor` (`"cli"`), `version`,
   `browserInstalled`, `browserRunning`, `runnerVersion`, `runPage` (the
   latest run's report or its progress, or null), `sessions`, `accounts`,
   `secretsFile`, `expiry` and `update`.
   `sessions` is `[{site, savedAt, refreshedAt, signInUrl}]`; it and
   `display` can be `{unreadable}`: tell the user why. `accounts` and
   `secretsFile` are the demo accounts below.
2. The browser is signed in only where the user ran `npx demoman signin <url>`;
   `status`'s `sessions` lists those sites. A demo account records best. A page
   that sends this browser to its sign-in page answers `signedOut` (section
   7) with the exact command in `detail`: give the user that command and
   spend no run until they say they have run it, unless a demo account can
   sign in (below). Only demo accounts: never ask for the
   user's own password, or type it. A sign-in or sign-up demo is not
   signing in: when the user asks for one and gives demo values, start
   the script at that form's page and type them; a password field's text is
   hidden on disk and in reports.
3. Takes are saved under `<DEMOMAN_HOME, default ~/.demoman>/takes/<id>/`.
   No telemetry.

### Behind a login: demo accounts

`status.accounts` is one of:

- `{file: null, searchedFrom}`: no `.demoman/accounts.json` was found from
  `searchedFrom` upward (`status` reads from the folder this server was
  started in and takes no `project`). Create one (below), or pass `project` on `snapshot`/`run`.
- `{file, invalid, field}`: the file exists and cannot be used; `invalid` is
  why and `field` where. Fix it; every snapshot and run from that project
  answers `accountsInvalid` until then.
- `{file, sites}`: each site is `{origin, default, accounts}`, each account
  `{name, about, session}` with `session` `"saved"`, `"none"` or
  `"changed"` (saved before the account's `checkUrl` or `signIn` was
  edited). Both are fine: Demoman signs in.
  `sessionsUnreadable`, when present: the saved sessions could not be read; tell the user.

`status.sessions` lists an account's saved session with an `account` (and
its `origin`) beside `site`; an entry without one is the site's manual
session from `npx demoman signin <url>`.

`status.secretsFile` is `null` (no usable accounts file), `{path, absent:
true}` (no secrets file: only `DEMOMAN_SECRET_*` can supply values),
`{path, git: "ignored"}` (git ignores it: safe), `{path, git: "notGit"}`
(not in git, so unchecked: tell the user), or `{path, refused}` (unreadable; `refused` is why,
as `secretsFileNotIgnored` or `secretsFileInvalid` will be). Never a value.

A page behind a login answers `signedOut` and `status` shows no account for
its site. Then, in this order:

1. **Reuse first.** Read each account's `about` and pick the one that fits
   the demo. Name it in the script's `account`, or leave it out for the
   site's `default`.
2. **The app's repo is open and runs against a local development database:**
   create a demo account and the data the demo needs, with a seed script
   committed in the app and safe to run twice (`priv/repo/demo_seeds.exs`,
   `db/seeds/demo.rb`). Generate a random password of 20 or more characters.
   Write `DEMOMAN_SECRET_<NAME>=…` and
   `DEMOMAN_SECRET_<NAME>_ORIGIN=<the site's origin>` to
   `.demoman/secrets.env`, and add it to `.gitignore` if missing. Add the
   account to `accounts.json`. Tell the user in one line; `snapshot` again.
3. **Two-factor or a magic link in the way:** add a dev-only "sign in as"
   route, reachable only in development, and make the account's `signIn` one
   `goto` to it. Phoenix:
   `if Mix.env() == :dev, do: get "/dev/sign-in-as/:email", DevController, :sign_in`; Rails: the same under `Rails.env.development?`.
   It starts a session only.
4. **The database is not clearly local** (a remote `DATABASE_URL`, staging,
   production): create nothing. Ask the user, or give them
   `npx demoman signin <url>`, which signs in by hand in a window: it is the
   way for a real account, single sign-on and two-factor.

The file, with one account:

```jsonc
{
  "accountsVersion": 1,
  "sites": {
    "http://localhost:4000": {
      "default": "seller",
      "accounts": {
        "seller": {
          "about": "Sonny BBQ: a seller with 6 custom requests and no orders needing action",
          "checkUrl": "/admin/dashboard",
          "signIn": [
            { "do": "goto", "url": "/users/log-in" },
            { "do": "type", "into": { "role": "textbox", "name": "Email" }, "text": "seller@demo.test" },
            { "do": "type", "into": { "stableId": "user_password" }, "text": "{secret:SELLER_PASSWORD}" },
            { "do": "click", "on": { "role": "button", "name": "Log in" } }
          ]
        }
      }
    }
  }
}
```

- Sites are keyed by origin. An account name is lower-case letters,
  digits, `-` and `_`, at most 64: `seller`. `signIn` uses the script's steps and targets
  (`type` names its field with `into`; copy targets from a `snapshot` of the
  login page) plus `goto`, which must be the first step. `checkUrl` is
  required: a page behind the login, a path on the origin, that a browser
  signed in to nothing cannot open (it redirects to sign-in, or shows a
  password form) and that shows no password field once signed in. Demoman
  opens it signed out first and treats where it lands as the sign-in page. `about` names who the account is and what data
  it has.
- `{secret:NAME}` goes in a `signIn` step's `text`, `NAME` being
  `[A-Z0-9_]+`, not ending in `_ORIGIN`. Demoman reads
  `DEMOMAN_SECRET_NAME` from the environment, else `.demoman/secrets.env`
  (only when git ignores it). A value
  is at least 8 characters, typed only with `DEMOMAN_SECRET_NAME_ORIGIN`
  beside it, naming the account's site. In the environment the user sets
  both and you never change them; in `secrets.env` you write both.
  A `{secret:…}` in a demo script is refused (`invalidScript`).
  Environment secrets serve only the accounts.json of the repo Demoman was
  started in; one reached through `project` reads only its own
  `.demoman/secrets.env`.
- A script names its account: `"account": "seller"`. `snapshot` takes `account` too. Both take `project`,
  an absolute path, to use another checkout's `.demoman/`.

```json
{
  "name": "Seller dashboard",
  "target": "http://localhost:4000/admin/dashboard",
  "account": "seller",
  "steps": [
    { "do": "waitForLoad" },
    { "do": "hover", "on": { "text": "Custom requests" } }
  ]
}
```

- Demoman signs in by itself: when the account has no saved session, and
  once more when a call lands on a sign-in page; `signedIn`
  (`{account, steps, ms}`) says it did. A second failure answers
  `signInFailed`. A session that lapses mid-run keeps no take; Demoman has
  signed in again: just run again.

## 2. Look at the page

`snapshot(url)` opens `url` in Demoman's browser and lists the page's
targets, leaving the page open. Each entry is
`{ target, kind, text, value, rect, shown, inFirstViewport }`. Every `target` resolves in a run to exactly that element.

- **Copy a `target` into a step verbatim. Never compose one**, and never
  translate a name from another tool's accessibility tree: Demoman's roles
  are not Chrome's.
- `landedElsewhere: true` - the app redirected, often to its sign-in page;
  `landedUrl` says where. If it is a sign-in page, this browser is not
  signed in there: see `session` below and spend no run. If it is
  not a sign-in page (a trailing slash, `https`, a locale prefix), use
  `landedUrl` as the script's `target`; this snapshot stands.
  `landedElsewhere: null` means the page's address could not be read: not an
  all-clear.
- `session` - `"saved"`: a session is saved for this site; `"none"`: none
  is (normal for a public page); `"signedOut"`: the page is a sign-in page,
  and `sessionDetail` holds the command to give the user (spend no run, or
  set up a demo account: section 1);
  `"unchecked"`: `sessionDetail` says why. A sign-in page with only "Continue with Google" may
  not answer `signedOut`: a plainly sign-in `landedUrl` with
  `"none"` or `"unchecked"` means the same. Tell the user to run
  `npx demoman signin <the page to record>` and spend no run. On
  `"unchecked"` otherwise, carry on only if `landedUrl` is not a sign-in
  page.
- `settled: false` - the page was still loading; `settleNote` says what was
  outstanding. Snapshot again before concluding something is absent.
- `rect` is in page coordinates; `inFirstViewport`: in view before any
  scroll. `rect: null`: no box yet (a closed FAQ answer), still a valid
  `waitFor … until: "visible"` target after the step that opens it.
  `shown: false`: transparent, hidden or a sliver now; `waitFor` waits.
- `size` is `{ width, height, from, error }`: the size the page was laid out
  at, which a run records too. `from` is `screen` (this machine's screen),
  or `device`. `from: "window"` with an `error`: Demoman could not read the
  screen and listed the browser's smaller layout; tell the user the `error`.
- `positional: true`: the target is a `treePath` (shared or no name); snapshot
  again after the page changes. `value`: a field's text, never a password's.
  `unresolvable`: no target reaches it. `notExamined` above 0: pass `contains`
  (name, text, stableId, kind, value); with it, narrow. `containsNote`: no match.
- Iframe and shadow-root elements are not listed.
- A snapshot sees only the page as it loads: hidden content already in the
  page is listed; content a click creates (a menu, dialog, search
  results, a new row) is not. To list it, `probe` your script
  with its steps cut off after the step that opens it, and copy targets from
  that answer. A probe acts on the app for real, every time: "Add item" adds
  one per probe and again in the run, so a target listed as unique can be
  ambiguous by then; a delete deletes; in the Studio an edit saves into the
  take. Prefer demo data. `stopped` means a step did not play: fix it as a
  run's stop with that reason says, and probe again.

### Recording a phone demo

1. Call `snapshot` with `device` (`"phone"` or `"tablet"`), and
   copy targets from that answer only: a phone shows a different page, and a
   desktop target is often not on it.
2. `run` a script that names the same `device`.
3. Leave `look.canvas` at `auto`, which comes out portrait, or name `9:16`.
4. No `hover` steps: tap instead.

## 3. Get a script

### A new script (usually: a feature just built)

1. `snapshot` the page the flow starts on.
2. Write each step with a `target` copied from that snapshot.
3. A step that reveals hidden content (a FAQ answer, a panel) names its
   targets from the same snapshot, then a `waitFor … until: "visible"`. A step that navigates: snapshot the new page's URL and put a `waitForLoad` after it; the step after that waits up to 10 s for its own target, so it needs no `waitFor`. Content a click creates: section 2.
4. `snapshot`'s `kits` lists the user's brand kits by name, the default
   marked. Use a name from it in `look.kit` only when the user asked for a
   look.
   `{ "ok": false, "reason": … }`: the kits could not be read; say so, name none.

### From a take made earlier

`derive(takeId)` answers `{ report, script }`: the take's steps as a script
to change and run again.

- `report.outcome: "derived"` - `script` is a draft, with `holes[]` and
  `notes[]`. Fill every hole; the run refuses the draft with
  `unfilledHoles` until you do, `field` naming the path (`steps.2.text`).

  | Hole `reason` | What to do |
  | --- | --- |
  | `scrubbedTarget` | `step` is null: the hole is the start URL. Demoman strips query values and secret-looking path segments from a take; `recorded` shows `redacted` in their place. Set `target` to the real start URL - ask the user if unsure. |
  | `redacted` | Add `"text"` with a **demo** value, never a real credential. |
  | `unnameable`, `ambiguousAtCapture`, `brokenAtCapture` | Add the target, copied from a `snapshot` of that page. |
  | `buttonNotScriptable` | Delete `"button"` only if a left click is acceptable - it is a different action. Otherwise tell the user the step cannot be scripted. |
  | `hostField` | Deleting `"host"` makes the step **replace the whole rich-text editor's contents** on the live app. Ask the user first. |

  `notes[]` lists steps the take cut or trimmed; they are kept. A
  `landingOffscreen` note names a scroll that will centre its element. **Keep each step's `recorded`, each
  scroll's `landing`, and the script's `recordedFrom`**: they are how the
  report compares the new run with the take. A step you add has no
  `recorded`.
  `report.skeleton` is what the merge with the take's saved script said:
  `noSkeleton` or `skeletonUnreadable` (the original's pauses were not
  kept), `stepDropped`, `actionAdded` (kept in place), `verbChanged` (the
  draft takes the verb in `scene.json` - check that step before running).
- `takeNotFound` - no take has that id; call `takes`.
- `unreadable` - a stored take cannot be read; report its `reason`.
- `threw` - report its `error`.

**Re-recording an edited take.** `run({ video: { id } })` with no `script`
records the video's current version again from its saved script and current
`scene.json` (steps, name, look, pauses, added steps), as a new version and a
run toward the three. Refused with `unfilledHoles` when the take did not keep
a value: `derive`, fill, `run`. `invalidScript` (`field` `steps.<i>.do`): a
verb was changed by hand: `derive`, check it, `run` the draft.

A video kept current in the repo (.demoman/videos) is rewritten by each run into it: commit that file with the change. To keep one current, run `npx demoman keep <video> --to <path>` in the repo.

## 4. Run and read

0. Name the video first: every run adds a version to one. If the repo
   has an exported file of it, `videos({ file:
   <absolute path> })`. Else `videos({ query: "<what the flow shows>" })`;
   `videos()` lists the repo's. Then `run({ script, video:
   { id } })` adds a version; `video: { new: "<name>" }` starts one.
   `possibleDuplicate` lists `matches`: use one's `id`, or repeat with
   `confirmedNew: true` for a different flow. `nameTaken` names the
   `holder`: use its `id` or another name. The report's `videoVersion`
   says what was made.
1. `run(script, video)`. It answers the run's report, or
   `{ "outcome": "stillRunning", "id": … }` after about 50 s; then call
   `report(id)` until the outcome is neither `running` nor `stillRunning`.
2. The report's `outcome`:
   - `refusedBeforeRun` - the door refused before opening anything; `reason`
     and `field` name what to fix (section 7).
   - `refused` - the replay policy refused; `refused.routes` names the
     user's move. Tell the user; do not work around it.
   - `stopped` - `stopped.at` names the step and `stopped.sentence` says why.
     A `steps[i].pageUrl` on a sign-in page means the app sent this browser
     to sign in mid-run: tell the user; do not rewrite targets.
     (A run that stopped short on the site's recorded sign-in page is relabelled
     `signedOut` (section 7); its detail ends "The run itself stopped at script
     step N: ...".)
   - `complete` - read `verdict`: `verdict.kind` is `"matches"` or
     `"diverged"`, and `verdict.diverged[]` lists each step the video does not
     show the way the script asked. `matches` with every
     `steps[i].candidates` at 1 means the steps are right.
   - In any outcome, a step whose `textHidden` is set typed into a credential
     field (`"credentialField"`, or `"credentialUnchecked"` if the page could
     not say): its text is kept nowhere. Re-recording or deriving that take
     asks for a demo value. `landing.startedElsewhere` names where the start URL went; `landing.unchecked`: the page could not be checked for a
     sign-in page. `notStored` with `what: "session"` means the saved
     session could not be refreshed: name it to the user.
   - `threw` - a fault in the run; report its `error`.
   - Then read `frames.degradations` and `frames.storageRefused`. These are
     about the video, not the script (`surfaceMismatch`: the browser handed
     back frames of the wrong size; `dragPictureMissing`: a native drag's item
     jumps). `notDragged`: a drag changed nothing; `verdict.diverged` lists
     it. Name them to the user; spend no run. `clickUnconfirmed` is about a step: a click
     could not be confirmed to have reached its target, and
     `frames.unconfirmedClicks` names each such step and says why; check in
     the video that the step did what it should before saying so.
   - A re-recording's report carries `rerecord`: `from` (the take), `notes`
     (as `report.skeleton` above, `stepDropped` with `why` `actionGone` or
     `neverPerformed`; `migrated`: a `sentence`) and `notCarried` (each `removed`, `split`,
     mask, hold, gap or trim the old take had and the new one lacks, and
     each zoom the editor aimed or ended by hand, `zoom`; every other zoom
     the new take makes again from its own clicks). Name every
     one to the user; a mask not carried may show what the old video hid.
3. **Read the video.** The report carries `video` and `recording`. Read
   `video.summary` first (a count per label: `inside`, `atEdge`, `cutOff`,
   `outOfFrame`, `strayArrival`, `detour`, `longStill`), then
   `video.steps[i].framing.label`, and `video.journeys[j].arrival` /
   `video.journeys[j].detour` for the cursor.
   - **Which script step a video step is:** `video.steps` lists the take's
     actions, and a `pause` makes no action. Find the report's `steps[k]`
     whose `actionId` equals `video.steps[i].actionId`; `steps[k].index` is
     its 0-based position in your script.
   - `video` may be `{ "unavailable": … }` (`refused`, `noTake`, `noFrames`,
     `checkFailed` with `error`): not a clean bill; say so, do not retry. Likewise
     `video.steps[i].unknown` and `video.noCursor: true`.
   - `recording` is `{ "unavailable": … }` or
     `{ recordingTakeId, steps[], notInRecording[] }`, comparing the run with
     the take a derived script came from. `unavailable` is again an answer.

   | Finding | Whose | The move |
   | --- | --- | --- |
   | `cutOff`, `outOfFrame` | the script | add a `scrollTo` on that element before the step |
   | `atEdge` | the script, if a run remains | as above; otherwise leave it |
   | `longStill` beyond what a `pause` asked for | Demoman | leave it; do not rewrite steps |
   | stray arrival, `detour` | Demoman | leave it |
   | drift from the earlier take | the app | report it |

   A finding that is Demoman's earns no run and is not passed on (the
   user can change it in the Studio). A step's
   `roomMs` is Demoman's own pacing, not a stall.
4. Tighten a step whose `candidates` is above 1 or whose `strategy` is weaker
   than the target you named.

**Stop after three runs**, done or not, then export: every run drives the
user's real app. A take zooms on every click and starts from `look.kit`, else the
user's default brand kit; a derived draft keeps its take's branding. The report's `look.branding` says where it came from: `script`,
`kit` (you named it; `look.kit.name` says which), `defaultKit`, or
`defaults`. A non-null `look.brandKitError` (default kit unreadable),
`look.wallpaperError` (its image) or `size.error` goes into your hand-back;
`size` is the recorded size (section 2).

## 5. Export and hand back

1. `export(takeId)` with the accepted run's `provenance.takeId`. It answers
   the export report, or `stillRunning` with an `id`; then call `report(id)`
   until the outcome is none of `exporting`, `stillRunning`.
   `fileType` picks the file: `mp4` (the default), `gif` (plays inline in
   a GitHub PR or issue), or `stills` (a PNG per step, in a folder); only
   if asked. An MP4 follows Settings
   (unset: ~1 MB/s); `quality: "full"` is largest.
   `export({ takeId, maxMB: 9.5 })` fits GitHub's 10 MB drag-in, or says
   it could not (the summary says what it cost).
   A GIF is made as wide as the recording backs and fits 10 MB, up to twice
   its usual width; `warnings.gifSize` says how wide, its size, and which
   wider widths were refused; a GIF over 10 MB at its narrowest says so: offer the MP4.
   Stills take `stills: { width, zoom }`, both optional. A
   still is by default the whole window, up to 2560 px wide (no wider than the recording). `width` is px (320-3840) or `"native"`, the recording's own size; `zoom` is `"none"` or `"step"`, which frames each step as the video zooms on it, all the way in. Pass
   them only when asked.
2. `saved` - the file is at `file.path`, absolute: in `~/Downloads`, or the
   folder the server was started with `--out-dir`. For `stills`, `fileType`
   is `stills` and the answer carries `folder: { path, files }` instead of
   `file`: give the user `folder.path`; `warnings.unplacedStills` lists steps
   that got no still. `summary` is one
   sentence: what was saved and anything the user asked for that the file
   lacks (a logo, motion, a still, an edit). `warnings` holds more:
   Demoman's calls (`zooms`, `detailViolations`, a size cap's `steps`,
   a GIF's widths, `targetCheck`). They are not the user's to act on: do not pass them on. None is the script's.
   Except `wallpaperWarning.sentence` (wallpaper left out: plain
   gradient; or will look soft): quote it.
   `warnings.editedSinceRecorded` lists steps whose `scene.json` no longer
   matches the frames; the summary names the re-recording
   (`run({ video: { id } })`, or `derive` then `run` when a verb changed).
   Re-record only on request. `warnings.untagged`: the file has no video
   tag (`error` says why); not the user's to act on.
   `links` holds the export's one-click actions, each present
   only where it works: `studio`, `file` (the file itself) and `copy` (the
   file to the clipboard; none for stills). `linksError`, set instead, says
   why there are none: tell the user in one line.
   Every export report carries a `summary` (`stillRunning`, this server's
   own answer, does not).
3. `renderFailed` - export **once** more; never re-run the script for an
   export failure. `saveFailed` - its `error` names the folder and the
   system's reason (a folder that cannot be written): tell the user;
   exporting again will not help until fixed. A stills export that
   stopped partway carries `partial: { folder, written, notWritten }`; the
   stills in `written` are whole PNGs.
4. `pathUnknown`, `refusedBeforeExport` or `threw` - report it, quoting
   `detail` or `error`. Do not retry.
5. The export does not count toward the three runs.

### Pull requests

Before opening a PR, read `status.pullRequests` (`project` for
another checkout): `attach`, `ask`, `off`, or `{ unreadable, file }`,
which is not `off`: tell the user. `off`: only when asked. If the diff
changes what a user sees, record that one flow (only the change),
push and open the PR, then `attach({ takeId, into: "description" })`, or
`"comment"` on a PR that is not yours. The video carries its own line; write no other. On `line.notWritten`,
tell the user the video lacks it, quoting why. A later `gh pr edit --body` drops the video. `ask`: offer once; on a no, nothing to see or a failed run (say why),
the PR says nothing of it. `attach`: with no video, the PR description gets
one line, `No demo: <why>`, and so does the user.
`attach` caps at 9.5 MB; `maxMB` sets another. On `stillRunning`, `report(id)`
until the outcome is not `attaching` or `stillRunning`. On `busy`,
`report(id)` on the export in flight, then `attach` again. On `ghMissing`,
`ghOutdated`, `ghSignedOut`, `notGitHub` or `copyFailed`, call
`export({ takeId, maxMB: 9.5 })` and give the user its `file.path` to drag
into the PR, saying why. On `uploadRefused`, do as its `detail` says. On `partial` or `unconfirmed`, do not
post again; tell the user to check the PR. Other reasons: section 7. An unsaved export answers as `export` does.

Hand back, on `saved`, two lines and nothing else: the `summary` as it is,
then the `links` as markdown links on one line, in this order, only
those present: `[Open in Studio](links.studio) · [<file name>](links.file) · [Copy video](links.copy)`
(`Copy GIF` for a GIF). Add one line only for `look.brandKitError`,
`look.wallpaperError`, `size.error`, `linksError`, or something you could not fix. Any other
outcome: quote its `error` or `detail`.

When the `studio` tool is listed and there is no `links.studio`, **offer**
it; never open it unasked. `studio({ takeId })`
opens a window to edit and export the take.
`{ outcome: "opened", takeId?, note? }`: say it is open;
quote `note` if set. Studio exports go to `~/Downloads`.

## 6. The format

```json
{
  "name": "Checkout with a coupon",
  "target": "https://app.example.com/cart",
  "steps": [
    { "do": "waitForLoad" },
    { "do": "scrollTo", "on": { "treePath": "body:1/main:1/section:2/div:1" }, "landing": { "top": 280 } },
    { "do": "click", "on": { "role": "button", "name": "Apply coupon" } },
    { "do": "waitFor", "on": { "role": "textbox", "name": "Coupon code" }, "until": "visible" },
    { "do": "type", "into": { "role": "textbox", "name": "Coupon code" }, "text": "SPRING25" },
    { "do": "click", "on": { "text": "Apply" } },
    { "do": "pause", "ms": 800 },
    { "do": "click", "on": { "stableId": "checkout-btn" } }
  ]
}
```

```json
{"name": "Move a card", "target": "https://app.example.com/board",
 "steps": [{ "do": "drag", "from": { "on": { "text": "Card A" } }, "to": { "on": { "text": "Done" } } }]}
```

```json
{"name": "Search", "target": "https://app.example.com/",
 "steps": [
   { "do": "type", "into": { "role": "searchbox", "name": "Search" }, "text": "invoices" },
   { "do": "press", "key": "Enter" }
 ]}
```

- `name` is required; a step's verb is `do`. Leave `scriptVersion` out: Demoman sets it. A derived draft also carries `recorded` on steps and `recordedFrom` on the script: keep them.
- **Targets** name exactly one strategy: `{ "stableId" }`, `{ "role", "name" }`,
  `{ "text" }` or `{ "treePath" }`. Two in one target is refused. Copy them
  from `snapshot` or a derived draft. A `treePath` is a position in the
  page: it breaks when the structure changes, and the run stops there.
- **Verbs:** `click` (optional `at: { x, y }`, a spot in the box, 0–1, as drag's; absent is the centre), `type` (replaces the field's contents), `hover`,
  `scrollTo`, `waitFor` (`until`: `visible` | `hidden`; visible means it can
  be seen, so an element at `opacity: 0` or `visibility: hidden` is hidden),
  `waitForLoad`, `pause` (`ms`), `press` (`key`: `Enter` | `Tab` | `Escape` |
  `Backspace` | `Delete` | `ArrowUp` | `ArrowDown` | `ArrowLeft` | `ArrowRight` |
  `Space`; names no element, goes to whatever holds focus), and `drag` (`from: { on, at? }`, `to`
  the same or `{ "by": { x, y } }` px; `at` is a spot in the box, 0–1). An unknown key is refused and named.
- `scrollTo` takes an optional `landing: { "top": <px> }`, the viewport y of
  the element's top edge when the scroll stops. Absent means centred.
- `viewport` absent means the size the user chose: the screen's, which
  `snapshot` measured `inFirstViewport` against. Leave `viewport` out unless the user asked.
- `device` is `"phone"` or `"tablet"`: the page is recorded as a phone (393x852)
  or a tablet (820x1180), with touch and an iOS user agent. Name a device or a
  `viewport`, not both. A device has no hover, so a `hover` step under one is
  refused. `look` takes `branding` or `kit`, plus `cursor`, `canvas` and
  `motion`; absent means the user's default brand kit. `kit` names one of
  `snapshot`'s `kits` (any case); not both a kit and a branding. An unknown key in `look` is refused and named. A
  `branding` is the whole of one: `background`, `logo` (or `null`) and
  `padding`, the margin as a fraction of the frame's shorter side (0 to
  0.2; left out is 0.12); a missing `background` or `logo` is refused.
  A `background` may be `{ "kind": "wallpaper", "id" }` (`muted-1` to
  `muted-4`, `vivid-1` to `vivid-6`, `light-1`, `light-2`, `dark-1`, `dark-2`;
  another id is refused, naming them) or `{ "kind": "image", "ref": "<path>" }`, a file, absolute or
  relative to the Demoman home; copied into the take. Either takes
  `"blur"`, 0-1 (default 0, sharp).
  A `canvas` is `{ "aspect": "auto" | "16:9" | "9:16" }`; `auto`, the
  default, is the recording's own shape plus an even margin.
  A `motion` is how the camera moves, `{ "smoothness": 0-1, "blur": 0-1, "follow": true | false }`; a derived draft carries the take's own, so keep it.
- Refused at the door: a script whose every step is a `pause`; a `target`
  that is not `http(s)`; a `click` with a `button`.
- No branching, loops or assertions. Add `pause` only where a viewer must read.

## 7. Every reason

`probe` can answer any reason `snapshot` can, and `run`'s `refusedBeforeRun` ones.

| Reason | Where | What it means, and the move |
| --- | --- | --- |
| `browserMissing` | `snapshot`, `run` (`refusedBeforeRun`), `studio` | Demoman's browser or its libraries are missing; `detail` gives the command. Ask the user to run it, then call again. |
| `unsupportedPlatform` | `snapshot`, `run`, `export` | This machine cannot record (arm64 Linux, or another OS); quote `detail` to the user. |
| `sessionUnreadable` | `snapshot`, `run` (`refusedBeforeRun`) | A saved session file or folder could not be read, or others can read it; `detail` names the fix. Tell the user. |
| `sessionNotLoaded` | `snapshot`, `run` (`refusedBeforeRun`) | The browser refused the saved sessions; `detail` says why. Tell the user to run `npx demoman signin` again for that site. |
| `signInFailed` | `snapshot`, `run` (`refusedBeforeRun`) | Demoman signed in as the account and the page still showed a sign-in page, or a step could not run; `detail` says where. It tried once. Fix the account's steps or the secret, or tell the user; do not run again unchanged. |
| `secretMissing` | `snapshot`, `run` (`refusedBeforeRun`) | A `{secret:NAME}` has no `DEMOMAN_SECRET_NAME` and no line in `.demoman/secrets.env`; `detail` names both. Through `project` the environment is not used. Write one (section 1), or ask the user. |
| `secretTooShort` | `snapshot`, `run` (`refusedBeforeRun`) | The secret `NAME` is under 8 characters. Generate a longer one and write it again. |
| `secretUnbound` | `snapshot`, `run` (`refusedBeforeRun`) | `DEMOMAN_SECRET_NAME` has no `DEMOMAN_SECRET_NAME_ORIGIN` beside it, or one that is not an origin; `detail` names the line and the site. Nothing was typed. Add it to `secrets.env` for an account you made; else tell the user. |
| `secretOffOrigin` | `snapshot`, `run` (`refusedBeforeRun`) | A secret was about to be typed off its site: a sign-in step's page is not the site's origin, or the secret's `_ORIGIN` names another site; `detail` names both. Nothing was typed. Check the account's site and `goto`, then tell the user. |
| `secretsFileNotIgnored` | `snapshot`, `run` (`refusedBeforeRun`) | Git does not ignore `.demoman/secrets.env`, so Demoman did not read it. Add `.demoman/secrets.env` to `.gitignore` (`detail` says the line), or take the file out of git if tracked. |
| `secretsFileInvalid` | `snapshot`, `run` (`refusedBeforeRun`) | A line of `.demoman/secrets.env` is not `DEMOMAN_SECRET_NAME=value`, a comment or blank; `detail` gives the line number. Fix it. |
| `accountsInvalid` | `snapshot`, `run` (`refusedBeforeRun`) | `.demoman/accounts.json` is malformed or breaks a rule; `detail` names the field and the rule. Fix the file. |
| `unknownAccount` | `snapshot`, `run` (`refusedBeforeRun`) | The script names an account the site does not have, or names none and the site has no `default`; `detail` lists the site's accounts. Name one, or add it (section 1). |
| `invalidProject` | `snapshot`, `run` (`refusedBeforeRun`), `attach` | `project` is not an absolute path to a folder. Pass one, or leave it out. |
| `ghMissing`, `ghOutdated`, `ghSignedOut` | `attach` (`refusedBeforeAttach`) | `gh` is missing, too old or signed out; `detail` gives the fix. Hand the user the file (section 5). |
| `notGitHub`, `prNotFound`, `prUnreadable` | `attach` (`refusedBeforeAttach`) | Not a GitHub remote; no such PR; the PR could not be read. Nothing was posted: quote `detail` to the user. |
| `invalidAttach` | `attach` (`refusedBeforeAttach`) | The call is malformed; `detail` says how. Fix it. |
| `uploadRefused` | `attach` (`notAttached`) | GitHub refused the video. Retry as the Pull requests text says. |
| `partial` | `attach` (`notAttached`) | `gh` failed but the video is on the PR; do not post again. |
| `unconfirmed` | `attach` (`notAttached`) | Unknown what landed. Do not post again; tell the user to look at the PR. |
| `copyFailed` | `attach` (`notAttached`) | The video could not be copied; nothing was posted. Hand the user the capped export's file. |
| `windowDidNotOpen` | `snapshot`; `run` (`refusedBeforeRun`); `studio` | The window would not open; try once more. |
| `studioDidNotStart` | `studio` | The Studio did not start; `detail` quotes the end of `~/.demoman/studio.log`. Tell the user, quoting it. |
| `alreadyRunning` | `snapshot`, `probe`, `run`, `derive` | A run, probe, snapshot or export is in progress. Call `report(id)` on it; try again when it settles. |
| `busy` | `export` (`refusedBeforeExport`) | A run, probe or snapshot is in progress. Call `report(id)` on it first. |
| `browserSilent` | `status`, `takes`, `derive`, `report` | The browser did not answer within about 50 s. Call `status` once; if again, tell the user. From `report`, the run may still be going: call `report(id)` again. |
| `libraryUnreadable` | `takes`, `studio` | The library could not be read; report it. |
| `libraryUnwritable` | `run` (in `notStored`) | Not a `reason`: the report has a `notStored` entry `{ "what": "take", "error": … }` and a null `provenance.takeId`. Nothing was saved; quote the `error`. |
| `unknownRun` | `report` | This demoman-mcp never issued that id (ids do not survive a server restart). |
| `noReport` | `report` | No report for that id: this server keeps only its latest; `detail` says which. Do not run again. |
| `notAnObject` | `run` | The script is not a JSON object. |
| `invalidScript` | `run` | The schema refused the script; `field` names where. |
| `unfilledHoles` | `run` | A derived draft still has holes (section 3); also a re-record of a take that did not keep a value. |
| `videoRequired` | `run` (`refusedBeforeRun`) | No `video` was given. Find one (section 4), or pass `{ new }`. |
| `possibleDuplicate`, `nameTaken` | `run` (`refusedBeforeRun`) | A similar video exists (`matches`) or the name is taken (`holder`). Section 4. |
| `videoNotFound` | `run` (`refusedBeforeRun`) | No video has that `id`; call `videos`. |
| `videoUnreadable`, `videoUnwritable` | `run` (`refusedBeforeRun`), `videos` | The video records could not be read or written; quote `detail`. Nothing was recorded. |
| `noTag`, `unknownVideo`, `fileNotFound` | `videos` | The file has no Demoman tag; its video is not in this library; no file there. Use `query` instead. |
| `invalidArgs` | `videos` | `file` with `query`, or not an absolute path. |
| `versionExpired` | `export` (`refusedBeforeExport`) | The take's frames expired: `run({ video: { id } })`, then export. |
| `failed` | `status` (`expiry`) | Not a refusal: `expiry` is the last cleanup. Say nothing unless it is `{ failed }` or `{ unreadable }`: quote it. |
| `nothingToRerecord` | `run` (`refusedBeforeRun`) | The take has no step left that acts; tell the user. |
| `unknownKit` | `run` (`refusedBeforeRun`) | `look.kit` names no kit, or an unreadable one; `detail` lists the kits. Fix it from `snapshot`'s `kits`, or ask the user. |
| `kitsUnreadable` | `run` (`refusedBeforeRun`) | The kits file would not read, so `look.kit` went unchecked. Quote `detail`; keep the name. |
| `wallpaperUnreadable` | `run` (`refusedBeforeRun`) | The image would not open. Quote `detail`; fix or drop `look.branding`/`look.kit`. |
| `invalidDevice` | `snapshot` | `device` is no phone or tablet Demoman has; `detail` lists them. |
| `deviceFailed` | `snapshot`, `run` | The browser would not emulate the device; nothing was listed or recorded. Tell the user `detail`; do not run again. |
| `nonHttpTarget` | `run`, `snapshot` | The target or url is not `http(s)`, or its host contains `*`. |
| `invalidFileType` | `export` (`refusedBeforeExport`) | Not answered here: the schema takes only `mp4`, `gif`, `stills`. |
| `invalidStillsOptions` | `export` (`refusedBeforeExport`) | `stills` was given for an MP4 or GIF, or breaks section 5's width or zoom; `detail` says which. Fix the call. |
| `invalidQuality`, `invalidMaxMB` | `export` (`refusedBeforeExport`), `attach` | Through these tools, only `quality` or `maxMB` given for a GIF or stills; the schema rejects a bad value first. |
| `noTakeId`, `noFrames` | `export` (`refusedBeforeExport`) | No take id; the take has no frames to render. |
| `takeNotFound`, `takeUnreadable` | `export` (`refusedBeforeExport`), `run` re-record (`refusedBeforeRun`), `studio` (`takeNotFound`: call `takes`) | No such take; it could not be read (or, for `run`, built into a script). |
| `unresolvedAnchor`, `anchorNotRendered`, `waitTimeout` | `run` (`stopped.reason`) | The target was not there in the 10 s a step waits, or a `waitFor`/`waitForLoad` timed out. Check it against a `snapshot` and the step before; `scrollTo` first in a long list. |
| `ambiguousAnchor` | `run` (`stopped.reason`) | Several elements matched; name the target more exactly. |
| `anchorFrameMismatch`, `anchorUnreachable`, `occlusionTimeout` | `run` (`stopped.reason`) | `anchorFrameMismatch`: its frame changed; pick another target. The others are not the script (unmeasurable, or window covered): run again once. |
| `pageWentElsewhere`, `unperformableStep` | `run` (`stopped.reason`) | The app left the page unasked (sign-in expired, or a missing `waitForLoad`); or the step asks for what a run cannot do. |
| `dragEndOutOfView`, `dragNoDistance` | `run` (`stopped.reason`) | A drag's end was off screen (a drag cannot scroll), or on its start. Fix the script. |
| `clickNotDelivered` | `run` (`stopped.reason`) | The browser put a click elsewhere than where it was sent; `stopped.detail` says where. Not the script's fault: run again (it counts); tell the user if it repeats. |
| `signedOut` | `run` (`stopped.reason`) | The app sent this browser to its sign-in page. Nothing was kept, and it is not a script fault. Give the user the command in `stopped.detail`; run again only after they ran it. As an account there is no command: the detail says whether Demoman signed in again; repeat only if it says so. |
| `windowClosed` | `run` (`stopped.reason`) | `--headed` only: the window was closed mid-run; the script is fine. Ask the user to leave it open; run once more. In an export it answers `renderFailed`; export again. |
| `pageDidNotLoad` | `snapshot`, `probe` stop | The url did not load. Ask whether the app runs at that address; spend no run. |
| `pageSilent` | `snapshot` | The page never answered. Call once more; if again, the page blocked Demoman's script; tell the user. |
| `pageFaulted` | `snapshot` | The page's own code threw; quote `detail`. |
| `snapshotThrew` | `snapshot` | A fault in the snapshot; quote `detail`. |
| `probeThrew` | `probe` | A fault in the probe; quote `detail`. |
| `portFailure` | `probe` | The browser gave way; not the script's fault. Probe once more; quote `detail` if it repeats. |
