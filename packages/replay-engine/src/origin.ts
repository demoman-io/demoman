import type { OriginClass } from "@demoman/scene-schema";

export type { OriginClass };

const DEV_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);
const DEV_TLDS = [".localhost", ".local", ".test"];

const PREVIEW_SUFFIXES = [
  ".vercel.app",
  ".netlify.app",
  ".pages.dev",
  ".ngrok.io",
  ".ngrok-free.app",
  ".surge.sh",
  ".onrender.com",
  // Cloud IDEs and tunnels: a build that lives as long as the terminal.
  ".app.github.dev", // Codespaces port forwards
  ".gitpod.io",
  ".trycloudflare.com",
  ".loca.lt", // localtunnel
  ".ts.net", // Tailscale Funnel / Serve
  ".replit.dev",
];
const PREVIEW_LABELS = new Set(["staging", "preview", "dev", "test"]);
const PREVIEW_PATTERNS = [
  /^deploy-preview-\d+\./, // Netlify
  /^pr-\d+\./, // generic PR deploys
  /-git-[a-z0-9-]+-[a-z0-9-]+$/, // Vercel branch deploys
];

/*
 * The gate's own preview-deploy shapes, gathered in `GATE_DEPLOY_MATCHERS`.
 * Deliberately NOT `PREVIEW_PATTERNS`, and the two lists must not be merged.
 *
 * They answer different questions with opposite fail-safe directions. The
 * badge's list breaks ties toward `preview` because a false preview costs
 * only coverage; this one is consulted by `mayWriteUnattended`, where a
 * false preview grants writes against somebody's production database. A
 * pattern that is merely harmless above is a permission down here.
 *
 * That difference is not theoretical. Two of the badge's three patterns
 * cannot match a real hostname at all — `/-git-…-…$/` is end-anchored with a
 * dot-excluding class, so it only matches a bare label with no TLD, and
 * `/^deploy-preview-\d+\./` misses Netlify's actual double-dash format. Both
 * were inert there because `PREVIEW_SUFFIXES` matched `.vercel.app` and
 * `.netlify.app` two lines earlier, so nothing ever noticed. Sharing the
 * list would have made the gate inherit both.
 *
 * Every matcher on THIS list is exercised by a test that feeds it a realistic
 * fully-qualified hostname, awkward cases included (`replay-policy.test.ts`).
 * A matcher here without one must be deleted rather than kept: a regex that
 * matches nothing passes every test that never feeds it a real host, which is
 * exactly how the two above survived — and a matcher never fed the awkward
 * real hostname (a hyphenated team slug, a project named `next-git-blog`) is
 * the same defect one step in.
 *
 * That deletion rule is about this list, not the badge's. `PREVIEW_PATTERNS`
 * keeps `/^deploy-preview-\d+\./` and `/^pr-\d+\./`, and deleting them there
 * would not be behaviour-neutral — `deploy-preview-42.acme.com` is not a
 * Netlify host but it does match, and the badge would start calling it
 * published. Up there an unexercised pattern is at worst spare coverage;
 * down here a matcher is a permission, so one nobody has fed a real hostname
 * is a permission nobody has checked.
 *
 * Platforms are omitted when their real format is not certain. An omitted
 * platform refuses, which costs an author a refused replay they can read the
 * reason for; a guessed pattern either matches nothing (the bug being fixed)
 * or matches production (the harm this gate exists to prevent).
 *
 * **Every shape here is anchored on a platform's own apex.** A team's private
 * PR-deploy convention — `pr-17.preview.acme.com`, and equally `pr-1.bank.com`
 * — is not, and it is no longer admitted. The hostname carries no evidence
 * that `pr-<n>.` means anything at that domain: it is a naming habit somebody
 * may or may not have, which is strictly weaker than the bare `myapp.vercel
 * .app` this same list already refuses. Admitting it while refusing that
 * contradicted the rule the rest of the gate follows, and `pr-1.bank.com`
 * is what the contradiction bought. A convention with no platform anchor
 * cannot be verified from a hostname, so it refuses; if a project needs its
 * own hosts admitted, that wants an explicit opt-in the author states, not a
 * pattern guessed from the URL.
 *
 * **Vercel branch aliases are not on this list, and cannot be.** The format
 * is `<project>-git-<branch>-<scope>.vercel.app`, and the project name may
 * itself contain `-git-`. `next-git-blog.vercel.app`,
 * `awesome-git-client.vercel.app` and `docs-git-book-acme.vercel.app` are
 * ordinary production hosts of projects named `next-git-blog`,
 * `awesome-git-client` and `docs-git-book-acme` — and every matcher this
 * module ever carried admitted all three. This is undecidable from the
 * hostname, not merely unimplemented: nothing in `<label>.vercel.app`
 * distinguishes a project named `next-git-blog` from project `next` on
 * branch `blog`, so no regex, and no amount of parsing, can separate them.
 * The rule directly above settles it — a token with no platform anchor is
 * not evidence — and `-git-` inside a `.vercel.app` label is exactly that: a
 * naming habit somebody may or may not have. **So every `.vercel.app` host
 * refuses, genuine branch deploys included.** That costs an author on Vercel
 * a refused unattended replay they can read the reason for; admitting one
 * costs writes against a live site, which nobody can undo. Replaying against
 * a real branch deploy wants an explicit opt-in flag naming the target the
 * author deliberately chose — the next project's to add, not a shape to be
 * guessed from a URL.
 */
// Netlify deploy previews: `deploy-preview-<pr>--<site>.netlify.app`. The
// separator before the site name is a DOUBLE DASH on the netlify.app apex,
// not a dot — that is the whole reason the badge's version matches nothing.
// Always PR-scoped, so it needs no branch-name exclusion.
// It is also start-anchored on a literal no plausible project name reaches
// past: a site would have to be called `deploy-preview-<digits>--<name>` to
// collide. That is the property the deleted Vercel matcher could not have —
// `-git-` sits in the MIDDLE of a label anyone may name, so there is no
// anchor to start from. One matcher survives because of that difference, not
// because Netlify was luckier.
const NETLIFY_DEPLOY_PREVIEW = /^deploy-preview-\d+--[a-z0-9-]+\.netlify\.app$/;

const GATE_DEPLOY_MATCHERS: ((host: string) => boolean)[] = [
  (host) => NETLIFY_DEPLOY_PREVIEW.test(host),
];

// 127/8, not just the 127.0.0.1 literal in `DEV_HOSTS`. Kept apart from
// `isPrivateIpv4` because the gate admits this range and refuses the rest of
// it — see `LOCAL_ONLY_TLDS` below for why the two cannot share a predicate.
function isLoopbackIpv4(host: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Which kind of environment a URL points at.
 *
 * Lives in this package rather than the extension because `replayPolicy` now
 * calls it: v8 §491's rule — a mutating scene may not be replayed unattended
 * against a published origin — is a policy over this answer, and the
 * headless runner cannot import an app. Its two other callers,
 * `finalize.ts` (stamping `meta.capture.originClass`) and
 * `drift/index-build.ts` (the badge checks published origins only), are
 * capture and badge concerns and import it from here; that is a known
 * naming oddity, taken over a fourth package for 102 lines.
 *
 * This folds an unparseable string into `"development"`. A policy gate must
 * NOT use it for that reason: `development` is the class the badge never
 * checks (so a fold there only costs coverage) but it is also the class that
 * permits writes, so the same fold hands a gate a permission it was never
 * asked for. Use `classifyOriginStrict` and refuse on null.
 */
export function classifyOrigin(raw: string): OriginClass {
  return classifyOriginStrict(raw) ?? "development";
}

/**
 * The classification, or null when the string is not a URL at all.
 *
 * v8 §5: the badge asks "is this demo still valid against the build the world
 * is currently seeing?", so only published origins are ever checked. Ties
 * break toward preview. A false *preview* costs badge coverage but is stated
 * to the author at capture time; a false *published* produces a wrong alert
 * later, and v8 says credibility comes from being quiet. herokuapp.com,
 * fly.dev and github.io stay published — they are real production hosts for
 * plenty of apps. (These rules moved here with the body they describe when
 * the strict variant was split out; `classifyOrigin` now delegates.)
 *
 * `classifyOrigin` folds an unparseable string into `"development"`, which is
 * the safe direction for the badge — development is the class it never checks,
 * so a fold there can only cost coverage. It is the UNSAFE direction for a
 * policy gate, where `development` is the class that permits writes. A caller
 * deciding whether a replay may write must use this and treat null as a
 * refusal; `replayPolicy` does.
 */
export function classifyOriginStrict(raw: string): OriginClass | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "file:") return "development";

  const host = url.hostname.toLowerCase();
  if (DEV_HOSTS.has(host) || isPrivateIpv4(host)) return "development";
  // Reserved TLDs are checked before the preview labels so shop.test is
  // development while test.shop.com is preview.
  if (DEV_TLDS.some((tld) => host.endsWith(tld))) return "development";

  if (PREVIEW_SUFFIXES.some((s) => host.endsWith(s))) return "preview";
  if (PREVIEW_LABELS.has(host.split(".")[0] ?? "")) return "preview";
  if (PREVIEW_PATTERNS.some((p) => p.test(host))) return "preview";

  return "published";
}

/*
 * The gate's own definition of "local", gathered in `LOCAL_ONLY_TLDS` and
 * `isLocalTarget`. Deliberately NOT `classifyOriginStrict(…) === "development"`,
 * for the same reason `GATE_DEPLOY_MATCHERS` one list up is not
 * `PREVIEW_PATTERNS`: the badge's class breaks ties toward `development`
 * because that is the class it never checks, so a fold there costs only
 * coverage — while down here `development` is the class that PERMITS WRITES,
 * so it may hold only names that cannot be a deployment at all.
 *
 * `classifyOriginStrict`'s `development` is wider than that, and the extra
 * width is precisely where intranet production lives. Both of these were
 * admitted until 2026-09-08:
 *
 *   - **RFC1918 addresses.** `10.20.30.40` and `192.168.1.50` are a real host
 *     on a real network, and a headless runner's natural home is a CI box
 *     inside a VPC — where 10/8 is the internal order system, not a scratch
 *     build. `isPrivateIpv4` therefore stays where it is, serving the
 *     classifier, and the gate consults `isLoopbackIpv4` instead.
 *   - **`.local`.** mDNS names a machine on the link (RFC 6762), but a great
 *     many Active Directory estates run `company.local` as their internal
 *     domain, and the intranet apps behind it are somebody's production.
 *
 * Both still classify `development` for the badge, which is the whole point
 * of keeping two lists. What is left here is affirmative in the same way a
 * platform apex is: the loopback set (`localhost`, 127/8, `::1`, `0.0.0.0`),
 * `file:` — there is no origin server to write to — and the two TLDs the IETF
 * reserved so they could never be a deployment. RFC 6761 requires
 * `.localhost` to resolve to loopback and says `.test` must never be
 * installed in the global DNS; `.test` is also what Valet and dnsmasq map
 * onto 127.0.0.1, which is the shape of a real developer's real dev host.
 *
 * The costs are this module's usual pair, in its usual direction. Refusing
 * `192.168.1.50` costs a developer serving to their phone off the LAN a
 * refused replay they can read the reason for, and the explicit opt-in flag
 * that a deliberately named Vercel target wants is the same answer here.
 * Admitting it costs writes against an intranet database, which nobody can
 * undo.
 */
const LOCAL_ONLY_TLDS = [".localhost", ".test"];

/**
 * Whether this target is the author's own machine.
 *
 * Narrower than the `development` class, and the comment above is the whole
 * argument for why. `replayPolicy` reads this a second time, past the
 * permission: a local target is the one admission whose recorded write URLs
 * say nothing about where the replay will actually write, because the app is
 * rebuilt from local configuration.
 */
export function isLocalTarget(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL, so there is no evidence to permit on. The silence is not a
    // swallow: `replayPolicy` reaches this case through its own
    // `classifyOriginStrict` null check and reports it under a refusal reason
    // that tells the author to check what they passed.
    return false;
  }
  if (url.protocol === "file:") return true;
  const host = url.hostname.toLowerCase();
  if (DEV_HOSTS.has(host) || isLoopbackIpv4(host)) return true;
  return LOCAL_ONLY_TLDS.some((tld) => host.endsWith(tld));
}

/**
 * Whether an unattended caller may replay a mutating scene at this target.
 *
 * NOT `classifyOrigin(url) !== "published"`. That classifier breaks ties
 * toward `preview` because its first consumer is the badge, where a false
 * preview costs only coverage. Here a false preview grants writes, so the
 * ties break the other way and only affirmative evidence permits: a local
 * target as `isLocalTarget` defines one — narrower than the `development`
 * class, see its comment — or a host shaped like an ephemeral per-deploy URL.
 *
 * v8 §491 carves out "a preview deploy", which is that shape — not merely a
 * host on a platform that also serves previews. `myapp.vercel.app` is where
 * many teams serve production, exactly as `herokuapp.com` and `fly.dev` are,
 * and those are already classified `published` on that reasoning. So
 * `PREVIEW_SUFFIXES` and `PREVIEW_LABELS` are deliberately not consulted:
 * `dev.acme.com` and `staging.bank.com` are somebody's real environments
 * with a real database behind them, and a name is not a claim about
 * disposability. Only `GATE_DEPLOY_MATCHERS` — this module's second list,
 * owned by the gate rather than shared with the badge — names a URL that
 * exists for one build, and every shape on it is anchored on the platform
 * apex that issues it. A PR-deploy convention with no platform anchor
 * (`pr-17.preview.acme.com`, `pr-1.bank.com`) cannot be verified from the
 * hostname at all, so it refuses too; a later project may add an explicit
 * opt-in for its own hosts.
 *
 * **Every `.vercel.app` host refuses, branch deploys included**, because a
 * Vercel branch alias cannot be recognised from a hostname: a project may be
 * named `next-git-blog`, so `-git-` inside the label is a naming habit, not a
 * per-deploy marker (see `GATE_DEPLOY_MATCHERS` above for the worked cases).
 * That is undecidable, not unimplemented, and the same opt-in flag is the
 * answer for a Vercel target the author names deliberately.
 *
 * **Scheme is not validated here.** This reads a hostname, so `file:` is
 * admitted on its own line in `isLocalTarget` (on the same reasoning as
 * localhost: there is no origin server to write to) while `data:` and
 * `javascript:` have no hostname at all, fall through to `published`, and are
 * refused with advice written for a production target — the right verdict,
 * reached by accident, with the wrong thing to tell the author. `ftp:` and
 * `ws:` on an admitted host are admitted for the same reason. A caller that
 * accepts a URL from outside owns validating what it will even try to open:
 * the headless runner's `--url` is where that belongs, not here.
 *
 * The cost of the narrowing is a refused replay against a genuinely
 * disposable host, which the author fixes by reading the reason. The cost of
 * the widening is writes against production, which nobody can undo.
 *
 * **What a `true` here does not establish.** This reads a URL's shape, and
 * nothing else. It says "this host is shaped like a throwaway deploy"; it
 * does not say "these writes are safe". A preview deploy is a separate
 * *frontend*, and unless the team wired up per-branch databases it talks to
 * the same backend production does — so a replay this predicate admits can
 * still POST an order into the live database. v8 §491's docs claim ("mutating
 * flows need a resettable environment — which teams with preview deploys
 * already have") does not follow from the hostname, and this predicate cannot
 * check the part that matters, because it is never shown the writes.
 * `replayPolicy` is: it holds the take's own mutation log, and it refuses a
 * non-local target whose recorded writes reached a published origin — the one
 * checkable corner of this, and still not a guarantee. Anything that reports
 * a verdict from here must not imply otherwise.
 */
export function mayWriteUnattended(raw: string): boolean {
  if (isLocalTarget(raw)) return true;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    // Not a URL at all, so there is no evidence to permit on. `replayPolicy`
    // reports this case under its own refusal reason — the author's move is
    // to check what they passed, not to find a preview deploy — so the
    // silence here is a false answer, not a swallowed one.
    return false;
  }
  return GATE_DEPLOY_MATCHERS.some((matches) => matches(host));
}
