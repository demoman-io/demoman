// Types for the vitest configs that import test-tier.mjs: the extension's
// typecheck includes its own vitest.config.ts.
export function testTier(
  env?: Record<string, string | undefined>,
): "fast" | "full";
export function slowExcludes(
  pkgDir: string,
  env?: Record<string, string | undefined>,
  say?: (line: string) => void,
): string[];
export function testWorkers(
  weight: "heavy" | "light",
  env?: Record<string, string | undefined>,
): { minWorkers?: number; maxWorkers?: number };
