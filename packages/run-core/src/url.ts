import { scrubSecrets } from "./secrets.js";

/**
 * Must equal `@demoman/scene-schema`'s `URL_SCRUB_PLACEHOLDER`, which
 * `scriptFromTake` reads to tell a scrubbed origin from a real one. Not
 * imported from there: this module reaches the sensor content script, and a
 * value import from the schema package pulls zod in with it — measured
 * 2026-09-28, `sensor.js` 45 KB -> 122 KB, injected into every page. Held
 * equal by `url.test.ts` instead.
 */
const PLACEHOLDER = "redacted";

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
 * which is what classification and the badge read. An ordinary id survives
 * -- a UUID's dashes and a date's break every run the sweeps look for.
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
      scrubSecrets(segment) === segment ? segment : PLACEHOLDER,
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
