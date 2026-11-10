// apps/mcp/src/home.ts
//
// Where Demoman keeps its files.
import { homedir } from "node:os";
import { join } from "node:path";

export function demomanHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DEMOMAN_HOME;
  return override !== undefined && override !== ""
    ? override
    : join(homedir(), ".demoman");
}
