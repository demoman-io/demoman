import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

// The probe measures what Demoman's own cap hides by design: each client's
// tool-call and startup timeouts, whether it shows a server's instructions,
// and where it cuts a long result (launch E spec §5). These cases check the
// probe says what its README says it says.
const SERVER = fileURLToPath(new URL("../probe/server.mjs", import.meta.url));
const open: Client[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function probe(args: string[] = []): Promise<Client> {
  const client = new Client({ name: "probe-test", version: "1.0.0" });
  open.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, ...args],
    }),
  );
  return client;
}

const textOf = (r: unknown): string =>
  ((r as { content: Array<{ text: string }> }).content[0] ?? { text: "" }).text;

describe("the client probe", () => {
  it("sleep answers after the time it was given", async () => {
    const client = await probe();
    const started = Date.now();
    const r = await client.callTool({
      name: "sleep",
      arguments: { seconds: 1 },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(textOf(r)).toBe("slept 1");
  });

  it("long_text is the size asked for, with three markers", async () => {
    const client = await probe(["--tokens", "1000"]);
    const text = textOf(
      await client.callTool({ name: "long_text", arguments: {} }),
    );
    const bytes = Buffer.byteLength(text, "utf8");
    expect(Math.abs(bytes - 4000)).toBeLessThanOrEqual(80);
    for (const m of ["PROBE-HEAD-1", "PROBE-MIDDLE-2", "PROBE-TAIL-3"]) {
      expect(text, m).toContain(m);
    }
    const middle = text.indexOf("PROBE-MIDDLE-2") / text.length;
    expect(middle).toBeGreaterThan(0.4);
    expect(middle).toBeLessThan(0.6);
    expect(text.trimEnd().endsWith("PROBE-TAIL-3")).toBe(true);
  });

  it("the instructions carry the canary", async () => {
    const client = await probe();
    expect(client.getInstructions()).toContain("PROBE-INSTR-4F7K");
  });

  it("--start-delay holds initialize", async () => {
    const started = Date.now();
    await probe(["--start-delay", "1"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });
});
