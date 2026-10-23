import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PKG = fileURLToPath(new URL("../pkg", import.meta.url));

/** `npm pack` the built package and install the tarball into a folder
 *  outside the repo, where no workspace node_modules can stand in for a
 *  dependency it failed to declare (the hand-over's rule). */
export async function installPacked(): Promise<{
  dir: string;
  bin: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "demoman-packed-"));
  const packed = execFileSync(
    "npm",
    ["pack", PKG, "--pack-destination", dir, "--silent"],
    { encoding: "utf8" },
  );
  const tgz = packed.trim().split("\n").at(-1) as string;
  await writeFile(join(dir, "package.json"), JSON.stringify({ private: true }));
  execFileSync(
    "npm",
    ["install", join(dir, tgz), "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: dir, stdio: "pipe" },
  );
  return {
    dir,
    bin: join(dir, "node_modules", "demoman", "dist", "demoman.mjs"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export async function connect(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command,
      args,
      ...(cwd === undefined ? {} : { cwd }),
      env: { ...process.env, ...env } as Record<string, string>,
    }),
  );
  return client;
}

export const text = (r: unknown): string =>
  (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
