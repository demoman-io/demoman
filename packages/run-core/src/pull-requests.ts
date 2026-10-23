// The pull-request video setting's values (launch F2): the user's
// `settings.json` and a repo's `.demoman/config.json` hold one, `status`
// reports it, and the studio's Settings page offers them. One list, so the
// runner's reads, the studio's checks and the page's choices cannot drift.

/** `off`: only when asked; `ask`: offer first; `attach`: film and attach. */
export const PULL_REQUESTS_VALUES = ["off", "ask", "attach"] as const;
export type PullRequestsValue = (typeof PULL_REQUESTS_VALUES)[number];

/** Each value's name wherever a person picks it: the Studio's Settings and
 *  setup's menu. */
export const PULL_REQUESTS_LABELS: Record<PullRequestsValue, string> = {
  off: "Off",
  ask: "Ask",
  attach: "Attach",
};

/** With nothing set in the repo or the user's settings: offer first (the
 *  author, 2026-10-22; `off` until then). */
export const PULL_REQUESTS_DEFAULT: PullRequestsValue = "ask";

export const isPullRequestsValue = (v: unknown): v is PullRequestsValue =>
  typeof v === "string" &&
  (PULL_REQUESTS_VALUES as readonly string[]).includes(v);
