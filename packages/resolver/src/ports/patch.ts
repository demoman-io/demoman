import type { ImagePatchMatcher } from "../types.js";

/** Default: tier 5 is skipped entirely. */
export const NO_PATCH: ImagePatchMatcher = {
  capture: async () => null,
  match: async () => [],
};
