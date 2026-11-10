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

/** Lower, upper, digit; anything else (a separator, `=`, `%`) is skipped. */
function charClass(c: string): string | null {
  if (c >= "a" && c <= "z") return "l";
  if (c >= "A" && c <= "Z") return "u";
  if (c >= "0" && c <= "9") return "d";
  return null;
}

/**
 * A random token: `-` and `_` break the runs `scrubSecrets` sweeps for, so a
 * base64url reset or invite token passes it whole (DEM-130). Told from a
 * slug by how often it switches between lower case, upper case and digits:
 * random base64url switches on about 2 characters in 3 and hex on about 1
 * in 2, while `2024_United_States_presidential_election` switches 4 times
 * in 40. At least one switch per 3 characters (per 4 with no upper case,
 * for hex and base36) over 20+ characters. Measured on 20,000 random tokens
 * each, survivors were 1.4% of 22-character base64url (16 bytes), 0.07% of
 * 43-character (32 bytes) and 3% of 20-character hex.
 */
function looksLikeToken(segment: string): boolean {
  if (!/^[\w.~+%=-]{20,}$/.test(segment) || UUID.test(segment)) return false;
  const classes = [...segment].map(charClass).filter((c) => c !== null);
  let switches = 0;
  for (let i = 1; i < classes.length; i++) {
    if (classes[i] !== classes[i - 1]) switches++;
  }
  return switches * (/[A-Z]/.test(segment) ? 3 : 4) >= segment.length;
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
 * secret scrub would touch, or that `looksLikeToken` reads as random, is
 * replaced whole. The route around it stays, which is what classification
 * and the badge read. A UUID survives, and so does a slug or a date.
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
