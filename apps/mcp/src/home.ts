// apps/mcp/src/home.ts
//
// Where Demoman keeps its files. Its own module so the CLI path (serve-cli)
// needs nothing from key.ts, which is the extension bridge's.
import { homedir } from "node:os";
import { join } from "node:path";

export function demomanHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DEMOMAN_HOME;
  return override !== undefined && override !== ""
    ? override
    : join(homedir(), ".demoman");
}
