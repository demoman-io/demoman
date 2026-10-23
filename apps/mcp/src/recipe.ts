// apps/mcp/src/recipe.ts
//
// The recipe (spec §6, plan 2), one directory up from both `src/` and
// `dist/`, so tests and the bin read the same file. (`recipe-extension.md`,
// the extension executor's, was archived with it on 2026-10-20.)
import { readFileSync } from "node:fs";

export const RECIPE_URL = new URL("../recipe.md", import.meta.url);

/** Throws when the file is missing or empty: the bin refuses to start
 *  rather than serve an agent a recipe tool that answers nothing. */
export function readRecipe(): string {
  const text = readFileSync(RECIPE_URL, "utf8");
  if (text.trim() === "") throw new Error(`${RECIPE_URL.pathname} is empty`);
  return text;
}
