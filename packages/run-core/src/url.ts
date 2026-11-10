import { scrubSecrets } from "./secrets.js";

/**
 * Must equal `@demoman/scene-schema`'s `URL_SCRUB_PLACEHOLDER`, which
 * `scriptFromTake` reads to tell a scrubbed origin from a real one. Not
 * imported from there: this module reaches the page code the runner injects
 * into every page, and a value import from the schema package pulls zod in
 * with it — measured 2026-09-28 on the extension's old `sensor.js`, 45 KB ->
 * 122 KB. Kept equal by hand; no test compares the two.
 */
const PLACEHOLDER = "redacted";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A base64url token: `-` and `_` break the runs `scrubSecrets` sweeps for,
 * so a reset or invite token passes it whole (DEM-130). 20+ URL-safe
 * characters with a digit and both cases; a slug is one case, a word has no
 * digit.
 */
function looksLikeToken(segment: string): boolean {
  return (
    /^[A-Za-z0-9_-]{20,}$/.test(segment) &&
    /\d/.test(segment) &&
    /[a-z]/.test(segment) &&
    /[A-Z]/.test(segment) &&
    !UUID.test(segment)
  );
}

/**
 * v8's credential rule reaches URLs: a session token in a query parameter is
 * a credential on disk. Classification (mutation vs analytics) needs origin
 * and path only, and SP8's badge matches on origin and path, so nothing
 * downstream loses information. Keys survive because "which parameters were
 * present" is signal; values never are.
 *
 * The path gets the same rule one segment at a time: a reset link, a magic
 * link or an invite carries its token as a segment, and a segment the
 * secret scrub would touch is replaced whole. The route around it stays,
 * which is what classification and the badge read. So is a segment shaped
 * like a URL-safe token (`looksLikeToken`). An ordinary id survives: a UUID
 * is exempt, and a date's dashes break every run the sweeps look for.
 */
export function scrubUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return PLACEHOLDER;
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.pathname = url.pathname
    .split("/")
    .map((segment) =>
      looksLikeToken(segment) || scrubSecrets(segment) !== segment
        ? PLACEHOLDER
        : segment,
    )
    .join("/");
  // set() collapses a repeated key to one entry, which is what we want: two
  // placeholder values would imply we knew they differed.
  for (const key of Array.from(new Set(url.searchParams.keys()))) {
    url.searchParams.set(key, PLACEHOLDER);
  }
  // searchParams percent-encodes on write; the placeholder is deliberately
  // chosen from the unreserved set so the result stays readable.
  return url.toString();
}
