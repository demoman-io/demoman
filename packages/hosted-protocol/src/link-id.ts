const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LENGTH = 22; // 62^22 is about 2^131

/** A link's id: 22 base62 characters, unguessable. */
export function newLinkId(): string {
  const out: string[] = [];
  while (out.length < LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const b of bytes) {
      // 248 = 4 * 62: rejecting the rest keeps every character equally likely.
      if (b < 248 && out.length < LENGTH) out.push(ALPHABET[b % 62] as string);
    }
  }
  return out.join("");
}

export function isLinkId(s: string): boolean {
  return /^[0-9A-Za-z]{22}$/.test(s);
}
