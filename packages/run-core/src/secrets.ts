// Ordered: the specific shapes run before the generic base64/hex sweeps, so a
// JWT is reported as a JWT-shaped match rather than shredded into three runs.
const SPECIFIC_SHAPES: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // JWT
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe-style
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/g,
];
const SWEEPS: RegExp[] = [
  /\b[A-Fa-f0-9]{32,}\b/g, // bare hex run
  /\b[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g, // bare base64 run
];
const PATTERNS: RegExp[] = [...SPECIFIC_SHAPES, ...SWEEPS];

/**
 * Console text is a Part-II-feeding side-channel nobody reads as prose, so
 * this errs hard toward redaction: redacting a sha256 in a log line costs
 * nothing, missing one secret costs everything.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, "<redacted>");
  return out;
}

/**
 * Whether text carries one of the vendor-shaped secrets -- and only those.
 * Typed text IS prose the author meant to be seen, so the sweeps that are
 * right for a console line would redact an order number or a long word
 * here; the price of a miss is bounded by `isCredentialField`, which still
 * redacts by the field's markup first.
 *
 * `search`, not `test`: these are /g regexes, and `test` on one of those
 * resumes from where the previous call stopped.
 */
export function looksLikeSecret(text: string): boolean {
  return SPECIFIC_SHAPES.some((pattern) => text.search(pattern) !== -1);
}
