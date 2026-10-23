import { failure, type Outcome, RUN_TOOL_CAP_MS } from "@demoman/agent-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_ANNOTATIONS } from "../src/annotations";
import { INSTRUCTIONS_CLI } from "../src/instructions";
import type { Link } from "../src/local-link";
import type { LinksFor } from "../src/session-links";
import {
  progressReading,
  registerTools,
  type StudioToolAnswer,
} from "../src/tools";
import type { UpdateAnswer } from "../src/update-check";

afterEach(() => {
  vi.useRealTimers();
});

type Handler = (
  args: Record<string, unknown>,
  progress: (v: unknown) => void,
) => Promise<Outcome>;

/** What every request carries: this file's client names itself (below). */
const AGENT = { name: "test", title: "Test Agent" };

async function connect(
  handlers: Partial<Record<string, Handler>>,
  capMs = 200,
  clientInfo: { name: string; title?: string; version: string } = {
    ...AGENT,
    version: "1.0.0",
  },
  updateCheck?: () => Promise<UpdateAnswer>,
  studio?: (args: { takeId?: string }) => Promise<StudioToolAnswer>,
  links?: LinksFor,
) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const link: Link = {
    connected: () => ({ browser: "TestBrowser 1" }),
    request: async (op, args, onProgress) => {
      calls.push({ op, args });
      const h = handlers[op];
      if (h === undefined)
        return { ok: false, reason: "noHandler", detail: op };
      return h(args, (v) => onProgress?.(v));
    },
  };
  const server = new McpServer(
    { name: "demoman", version: "0.1.0" },
    { instructions: INSTRUCTIONS_CLI },
  );
  let n = 0;
  registerTools(server, link, {
    recipe: "RECIPE TEXT",
    version: "0.1.0",
    ...(updateCheck === undefined ? {} : { updateCheck }),
    ...(studio === undefined ? {} : { studio }),
    ...(links === undefined ? {} : { links }),
    capMs,
    newId: () => `id-${++n}`,
  });
  const client = new Client(clientInfo);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  // Tap what the server put on the wire: the client drops a progress
  // notification whose handler is gone, so onprogress cannot show a late one.
  const progressOnWire: number[] = [];
  const deliver = b.onmessage;
  b.onmessage = (message, extra) => {
    const m = message as { method?: string; params?: { progress?: number } };
    if (m.method === "notifications/progress") {
      progressOnWire.push(m.params?.progress ?? -1);
    }
    deliver?.(message, extra);
  };
  return { client, calls, progressOnWire };
}

const textOf = (result: unknown): unknown => {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]
    ?.text;
  if (text === undefined) {
    throw new Error(`tool result carried no text: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text);
};

describe("the links on a saved export", () => {
  const asked: unknown[] = [];
  const links: LinksFor = async (saved) => {
    asked.push(saved);
    return saved.path === "/D/refused.mp4"
      ? { error: "the links could not be served" }
      : { reveal: "http://127.0.0.1:1/reveal/tok" };
  };
  const exportOf = (value: Record<string, unknown>) =>
    connect(
      { export: async () => ({ ok: true, value }) },
      200,
      undefined,
      undefined,
      undefined,
      links,
    );

  // Red if a saved export answers without its links, or for the wrong file.
  it("carries links for the file it saved, and none on a failure", async () => {
    asked.length = 0;
    const { client } = await exportOf({
      outcome: "saved",
      takeId: "t1",
      file: { path: "/D/a.mp4" },
      summary: "Saved /D/a.mp4.",
    });
    const result = await client.callTool({
      name: "export",
      arguments: { takeId: "t1" },
    });
    expect(textOf(result)).toMatchObject({
      outcome: "saved",
      links: { reveal: "http://127.0.0.1:1/reveal/tok" },
    });
    expect(asked).toEqual([{ takeId: "t1", path: "/D/a.mp4", isFile: true }]);

    const failed = await exportOf({
      outcome: "renderFailed",
      takeId: "t1",
      error: "boom",
    });
    const answer = textOf(
      await failed.client.callTool({
        name: "export",
        arguments: { takeId: "t1" },
      }),
    );
    expect(answer).not.toHaveProperty("links");
    expect(asked).toHaveLength(1);
  });

  // Red if links that could not be made leave the answer looking linkless
  // for no reason.
  it("says why a saved export has no links", async () => {
    const { client } = await exportOf({
      outcome: "saved",
      takeId: "t1",
      folder: { path: "/D/refused.mp4" },
    });
    expect(
      textOf(
        await client.callTool({ name: "export", arguments: { takeId: "t1" } }),
      ),
    ).toMatchObject({ linksError: "the links could not be served" });
    expect(asked.at(-1)).toMatchObject({ isFile: false });
  });
});

describe("demoman-mcp's tools", () => {
  it("lists exactly the tools plans 1 and 2 build", async () => {
    const { client } = await connect({});
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "attach",
      "derive",
      "export",
      "recipe",
      "report",
      "run",
      "snapshot",
      "status",
      "takes",
    ]);
  });

  // Red if a failure is returned as ordinary content: the agent could not
  // tell it from a success (CLAUDE.md, "Report before you forgive"). The
  // link answers ok:false only for the channel's own reasons; a page's
  // refusal arrives as an ok:true report.
  it("marks a refused call isError and keeps its reason", async () => {
    const { client } = await connect({
      run: async () => ({
        ok: false,
        reason: "extensionNotConnected",
        detail: "not connected",
      }),
    });
    const result = await client.callTool({
      name: "run",
      arguments: { script: { steps: [] } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({
      reason: "extensionNotConnected",
      detail: "not connected",
    });
  });

  it("returns a run's report when it finishes inside the cap, and forwards the script whole", async () => {
    const script = {
      target: "http://localhost:4000/",
      steps: [{ kind: "waitForLoad" }],
    };
    const { client, calls } = await connect({
      run: async () => ({ ok: true, value: { outcome: "complete" } }),
    });
    const result = await client.callTool({
      name: "run",
      arguments: { script },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toEqual({ outcome: "complete" });
    // Red if the call's id is not sent with it: the page could not tell its
    // report apart from another run's.
    expect(calls).toEqual([
      { op: "run", args: { script, callId: "id-1", agent: AGENT } },
    ]);
  });

  // Red if the tool's schema still requires `script`, or drops `takeId` on
  // the way to the executor.
  it("passes run({ takeId }) through to the CLI's executor, with no script", async () => {
    const { client, calls } = await connect(
      { run: async () => ({ ok: true, value: { outcome: "complete" } }) },
      200,
      undefined,
    );
    const result = await client.callTool({
      name: "run",
      arguments: { takeId: "scene-1" },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toEqual({ outcome: "complete" });
    expect(calls).toEqual([
      { op: "run", args: { takeId: "scene-1", callId: "id-1", agent: AGENT } },
    ]);
  });

  // Red if the tool drops quality on its way to the CLI's executor.
  it("passes quality through to the CLI's export, and only when set", async () => {
    const { client, calls } = await connect(
      { export: async () => ({ ok: true, value: { outcome: "saved" } }) },
      200,
      undefined,
    );
    await client.callTool({
      name: "export",
      arguments: { takeId: "t1", quality: "full" },
    });
    await client.callTool({ name: "export", arguments: { takeId: "t1" } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      op: "export",
      args: { takeId: "t1", quality: "full" },
    });
    expect((calls[1]?.args as object) ?? {}).not.toHaveProperty("quality");
  });

  // Red if the tool drops maxMB on its way to the CLI's executor, or lets
  // a cap of 0 through to it.
  it("passes maxMB through to the CLI's export, and only a positive one", async () => {
    const { client, calls } = await connect(
      { export: async () => ({ ok: true, value: { outcome: "saved" } }) },
      200,
      undefined,
    );
    await client.callTool({
      name: "export",
      arguments: { takeId: "t1", maxMB: 9.5 },
    });
    await client.callTool({ name: "export", arguments: { takeId: "t1" } });
    const zero = await client.callTool({
      name: "export",
      arguments: { takeId: "t1", maxMB: 0 },
    });
    expect(zero.isError).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      op: "export",
      args: { takeId: "t1", maxMB: 9.5 },
    });
    expect((calls[1]?.args as object) ?? {}).not.toHaveProperty("maxMB");
  });

  // Red if the tool drops fileType on its way to the CLI's executor.
  it("passes fileType through to the CLI's export", async () => {
    const { client, calls } = await connect(
      { export: async () => ({ ok: true, value: { outcome: "saved" } }) },
      200,
      undefined,
    );
    await client.callTool({
      name: "export",
      arguments: { takeId: "t1", fileType: "stills" },
    });
    expect(calls).toEqual([
      {
        op: "export",
        args: expect.objectContaining({ takeId: "t1", fileType: "stills" }),
      },
    ]);
  });

  // Red if the schema strips a misspelt option or refuses a bad width
  // itself: the runner answers both as invalidStillsOptions, naming what it
  // takes, and a stripped key would export defaults reported as followed.
  it("passes a misspelt or out-of-range stills option on for the runner to refuse", async () => {
    const { client, calls } = await connect(
      { export: async () => ({ ok: true, value: { outcome: "saved" } }) },
      200,
      undefined,
    );
    for (const stills of [{ widht: 1920 }, { width: 100 }, { zoom: "video" }]) {
      await client.callTool({
        name: "export",
        arguments: { takeId: "t1", fileType: "stills", stills },
      });
    }
    expect(calls.map((c) => (c.args as { stills?: unknown }).stills)).toEqual([
      { widht: 1920 },
      { width: 100 },
      { zoom: "video" },
    ]);
  });

  // Red if the tool drops a still's size and zoom, or its schema refuses them.
  it("passes stills options through to the CLI's export", async () => {
    const { client, calls } = await connect(
      { export: async () => ({ ok: true, value: { outcome: "saved" } }) },
      200,
      undefined,
    );
    await client.callTool({
      name: "export",
      arguments: {
        takeId: "t1",
        fileType: "stills",
        stills: { width: "native", zoom: "step" },
      },
    });
    expect(calls).toEqual([
      {
        op: "export",
        args: expect.objectContaining({
          stills: { width: "native", zoom: "step" },
        }),
      },
    ]);
  });

  // Red if `run` waits past the cap (an MCP client would time the call out
  // and the agent would never learn the run id), or if `report` cannot find it.
  it("answers stillRunning at the cap, then report returns the run's outcome once it ends", async () => {
    let finish: (o: Outcome) => void = () => {};
    const { client } = await connect(
      {
        run: () =>
          new Promise<Outcome>((r) => {
            finish = r;
          }),
      },
      150,
    );
    const first = await client.callTool({
      name: "run",
      arguments: { script: {} },
    });
    expect(textOf(first)).toEqual({ outcome: "stillRunning", id: "id-1" });
    finish({ ok: true, value: { outcome: "complete" } });
    const later = await client.callTool({
      name: "report",
      arguments: { id: "id-1" },
    });
    expect(textOf(later)).toEqual({ outcome: "complete" });
  });

  // Review Focus 3: after bridgeLost the run is still in the page, and
  // report reads the page's current report rather than answering unknownRun.
  it("reads the page's current report when the run's call was lost", async () => {
    const { client, calls } = await connect({
      run: async () => ({ ok: false, reason: "bridgeLost", detail: "lost" }),
      report: async () => ({
        ok: true,
        value: { outcome: "running", step: 3, of: 9 },
      }),
    });
    const lost = await client.callTool({
      name: "run",
      arguments: { script: {} },
    });
    expect(textOf(lost)).toMatchObject({ reason: "bridgeLost" });
    const after = await client.callTool({
      name: "report",
      arguments: { id: "id-1" },
    });
    expect(textOf(after)).toEqual({ outcome: "running", step: 3, of: 9 });
    // Red if report asks the page for the wrong kind (an export's id must
    // not read #run-report), or without the id: the page must answer for
    // THIS run, not whichever it shows.
    expect(calls).toEqual([
      { op: "run", args: { script: {}, callId: "id-1", agent: AGENT } },
      { op: "report", args: { id: "id-1", of: "run", agent: AGENT } },
    ]);
  });

  // Red if report asks the page for the wrong kind: an export's id must
  // not read the run's report.
  it("reads the export's report when an export's call was lost", async () => {
    const { client, calls } = await connect({
      export: async () => ({ ok: false, reason: "bridgeLost", detail: "lost" }),
      report: async () => ({
        ok: true,
        value: { outcome: "saved", file: { path: "/x.mp4" } },
      }),
    });
    const lost = await client.callTool({
      name: "export",
      arguments: { takeId: "t1" },
    });
    expect(textOf(lost)).toMatchObject({ reason: "bridgeLost" });
    const after = await client.callTool({
      name: "report",
      arguments: { id: "id-1" },
    });
    expect(textOf(after)).toEqual({
      outcome: "saved",
      file: { path: "/x.mp4" },
    });
    expect(calls).toEqual([
      { op: "export", args: { takeId: "t1", callId: "id-1", agent: AGENT } },
      { op: "report", args: { id: "id-1", of: "export", agent: AGENT } },
    ]);
  });

  // Red if report returns STILL_RUNNING's neighbour: a call still pending
  // after the cap must be answered from the page, not by waiting forever.
  it("asks the page for its report when the call is still pending after the cap", async () => {
    const { client, calls } = await connect(
      {
        run: () => new Promise<Outcome>(() => {}),
        report: async () => ({
          ok: true,
          value: { outcome: "running", step: 2, of: 5 },
        }),
      },
      150,
    );
    const first = await client.callTool({
      name: "run",
      arguments: { script: {} },
    });
    expect(textOf(first)).toEqual({ outcome: "stillRunning", id: "id-1" });
    const later = await client.callTool({
      name: "report",
      arguments: { id: "id-1" },
    });
    expect(textOf(later)).toEqual({ outcome: "running", step: 2, of: 5 });
    expect(calls).toEqual([
      { op: "run", args: { script: {}, callId: "id-1", agent: AGENT } },
      { op: "report", args: { id: "id-1", of: "run", agent: AGENT } },
    ]);
  });

  // Red if the token is used after the stillRunning answer (MCP forbids it).
  it("sends no progress after the call answered stillRunning", async () => {
    let emit: (v: unknown) => void = () => {};
    const { client, progressOnWire } = await connect(
      {
        run: (_args, progress) => {
          emit = progress;
          progress({
            outcome: "running",
            step: 1,
            of: 5,
            keyframes: 0,
            note: null,
          });
          return new Promise<Outcome>(() => {});
        },
      },
      150,
    );
    const seen: number[] = [];
    const first = await client.callTool(
      { name: "run", arguments: { script: {} } },
      undefined,
      {
        onprogress: (p) => seen.push(p.progress),
      },
    );
    expect(textOf(first)).toEqual({ outcome: "stillRunning", id: "id-1" });
    // Premise: progress did flow before the cap.
    expect(seen).toEqual([1]);
    expect(progressOnWire).toEqual([1]);
    emit({ outcome: "running", step: 2, of: 5, keyframes: 0, note: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(progressOnWire).toEqual([1]);
  });

  it("answers unknownRun for an id it never issued", async () => {
    const { client } = await connect({});
    const result = await client.callTool({
      name: "report",
      arguments: { id: "nope" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ reason: "unknownRun" });
  });

  it("forwards progress as MCP progress notifications", async () => {
    const { client } = await connect({
      run: async (_args, progress) => {
        progress({
          outcome: "running",
          step: 1,
          of: 2,
          keyframes: 0,
          note: null,
        });
        progress({
          outcome: "running",
          step: 2,
          of: 2,
          keyframes: 0,
          note: null,
        });
        return { ok: true, value: { outcome: "complete" } };
      },
    });
    const seen: Array<{ progress: number; total?: number; message?: string }> =
      [];
    await client.callTool(
      { name: "run", arguments: { script: {} } },
      undefined,
      {
        onprogress: (p) => seen.push(p),
      },
    );
    expect(seen.map((p) => p.progress)).toEqual([1, 2]);
    // No total for a run: Claude Code would add "(100%)" to a line that
    // already counts steps. Red if the run's total comes back.
    expect(seen.map((p) => p.total)).toEqual([undefined, undefined]);
    // The extension's page sends no `doing`: the count it has is of steps done.
    expect(seen[1]?.message).toBe("Step 2 of 2 done");
  });

  it("names the step in flight when the run says what it is doing", async () => {
    const { client } = await connect({
      run: async (_args, progress) => {
        progress({
          outcome: "running",
          doing: 'step 2 of 4 · click "Filter invoices…"',
          step: 1,
          of: 4,
          keyframes: 0,
          note: null,
        });
        return { ok: true, value: { outcome: "complete" } };
      },
    });
    const seen: Array<{ message?: string }> = [];
    await client.callTool(
      { name: "run", arguments: { script: {} } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );
    expect(seen.map((p) => p.message)).toEqual([
      'Step 2 of 4 · click "Filter invoices…"',
    ]);
  });

  // Red without the dedupe (three notifications), or with a progress that
  // stands still on a repeated step (MCP wants it to rise every time).
  it("sends a progress line only when what it says changes, and always rising", async () => {
    const { client } = await connect({
      run: async (_args, progress) => {
        const at = (keyframes: number, note: string | null) =>
          progress({ outcome: "running", step: 1, of: 4, keyframes, note });
        at(0, null);
        at(3, null); // only the keyframe count moved: nothing to show
        at(3, "waiting for the page to settle");
        return { ok: true, value: { outcome: "complete" } };
      },
    });
    const seen: Array<{ progress: number; total?: number; message?: string }> =
      [];
    await client.callTool(
      { name: "run", arguments: { script: {} } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );
    expect(seen.map((p) => p.message)).toEqual([
      "Step 1 of 4 done",
      "Step 1 of 4 done — waiting for the page to settle",
    ]);
    expect(seen[1]?.progress).toBeGreaterThan(seen[0]?.progress ?? Infinity);
    expect(seen[1]?.progress).toBeLessThan(2);
  });

  it("draws an export's render as a bar, and its other phases as a line", async () => {
    const { client } = await connect({
      export: async (_args, progress) => {
        const at = (phase: string, done: number, total: number) =>
          progress({ outcome: "exporting", phase, done, total });
        at("rendering", 0, 0);
        at("rendering", 120, 480);
        at("saving", 0, 0);
        return { ok: true, value: { outcome: "saved" } };
      },
    });
    const seen: Array<{ progress: number; total?: number; message?: string }> =
      [];
    await client.callTool(
      { name: "export", arguments: { takeId: "t" } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );
    expect(seen.map((p) => [p.message, p.total])).toEqual([
      ["Preparing the render", undefined],
      ["Rendering", 480],
      ["Saving the file", undefined],
    ]);
    // Saving has no count of its own, and still rises past the render's.
    expect(seen[2]?.progress).toBeGreaterThan(120);
  });

  // Red while the sender drops a line it has said already even when its bar
  // moved (the bar stood still for a whole render), and red with a
  // notification per frame (the second frame here is under a percent on).
  it("moves an export's bar as frames render, a whole percent at a time", async () => {
    const { client } = await connect({
      export: async (_args, progress) => {
        const at = (done: number) =>
          progress({
            outcome: "exporting",
            phase: "rendering",
            done,
            total: 1000,
          });
        at(100);
        at(105);
        at(500);
        at(999);
        return { ok: true, value: { outcome: "saved" } };
      },
    });
    const seen: Array<{ progress: number; total?: number; message?: string }> =
      [];
    await client.callTool(
      { name: "export", arguments: { takeId: "t" } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );
    expect(seen.map((p) => [p.message, p.progress, p.total])).toEqual([
      ["Rendering", 100, 1000],
      ["Rendering", 500, 1000],
      ["Rendering", 999, 1000],
    ]);
  });

  // Code review finding 4. Red while progressReading ignores `pass`: the
  // second render's lines read "Rendering" again, so the sender drops them
  // as said already, and its frame count from 0 would read as going back.
  it("names each render of a capped export, and its progress never goes back", async () => {
    const { client } = await connect(
      {
        export: async (_args, progress) => {
          const at = (render: number, done: number, total: number) =>
            progress({
              outcome: "exporting",
              phase: "rendering",
              done,
              total,
              pass: { render, upTo: 3 },
            });
          at(1, 100, 480);
          at(1, 400, 480);
          // 60 to 30 fps: the second render has half the frames.
          at(2, 10, 240);
          at(2, 200, 240);
          return { ok: true, value: { outcome: "saved" } };
        },
      },
      200,
      undefined,
    );
    const seen: Array<{ progress: number; total?: number; message?: string }> =
      [];
    await client.callTool(
      { name: "export", arguments: { takeId: "t", maxMB: 9.5 } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );
    expect(seen.map((p) => p.message)).toEqual([
      "Rendering — render 1 of up to 3",
      "Rendering — render 1 of up to 3",
      "Rendering — render 2 of up to 3",
      "Rendering — render 2 of up to 3",
    ]);
    const share = seen.map((p) => p.progress / (p.total ?? Number.NaN));
    for (let i = 1; i < share.length; i++) {
      expect(share[i], `share ${i} of ${share.join(", ")}`).toBeGreaterThan(
        share[i - 1] ?? Infinity,
      );
    }

    // The readings themselves, every frame: distinct per render, and the
    // share of the bar never falls when a render starts again from 0.
    const readings = [
      [1, 100, 480],
      [1, 400, 480],
      [2, 10, 240],
      [2, 200, 240],
    ].map(([render, done, total]) =>
      progressReading({
        outcome: "exporting",
        phase: "rendering",
        done,
        total,
        pass: { render, upTo: 3 },
      }),
    );
    expect(new Set(readings.map((r) => r.message)).size).toBe(2);
    const shares = readings.map((r) => r.at / (r.total ?? Number.NaN));
    for (let i = 1; i < shares.length; i += 1) {
      expect(shares[i], JSON.stringify(readings)).toBeGreaterThanOrEqual(
        shares[i - 1] ?? Infinity,
      );
    }
    // An export with no cap reads as it did.
    expect(
      progressReading({
        outcome: "exporting",
        phase: "rendering",
        done: 120,
        total: 480,
      }),
    ).toEqual({ at: 120, total: 480, message: "Rendering" });
  });

  // Claude Code shows three lines of a result. Red without summaryFirst: the
  // report's own first key (here "run") takes the visible line.
  it("writes a result's summary first, where the folded view shows it", async () => {
    const { client } = await connect({
      run: async () => ({
        ok: true,
        value: {
          run: { id: "run-1" },
          outcome: "complete",
          summary: "Complete: the video matches every step.",
        },
      }),
    });
    const result = await client.callTool({
      name: "run",
      arguments: { script: {} },
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    // Premise: the value put summary last, so the order is this server's.
    expect(text.split("\n")[1]).toBe(
      '  "summary": "Complete: the video matches every step.",',
    );
    expect(textOf(result)).toMatchObject({ outcome: "complete" });
  });

  // Red without the watch: report waits up to 40 s with nothing on screen.
  it("carries a run's progress on through report, and stops when report answers", async () => {
    let emit: (v: unknown) => void = () => {};
    let finish: (o: Outcome) => void = () => {};
    const { client, progressOnWire } = await connect(
      {
        run: (_args, progress) => {
          emit = progress;
          progress({
            outcome: "running",
            step: 1,
            of: 3,
            keyframes: 0,
            note: null,
          });
          return new Promise<Outcome>((r) => {
            finish = r;
          });
        },
      },
      150,
    );
    const first = await client.callTool({
      name: "run",
      arguments: { script: {} },
    });
    expect(textOf(first)).toEqual({ outcome: "stillRunning", id: "id-1" });
    const seen: Array<{ total?: number; message?: string }> = [];
    const report = client.callTool(
      { name: "report", arguments: { id: "id-1" } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );
    await new Promise((r) => setTimeout(r, 20));
    emit({ outcome: "running", step: 2, of: 3, keyframes: 0, note: null });
    await new Promise((r) => setTimeout(r, 20));
    finish({ ok: true, value: { outcome: "complete" } });
    expect(textOf(await report)).toEqual({ outcome: "complete" });
    // The latest line at once, then the next one as it came.
    expect(seen.map((p) => p.message)).toEqual([
      "Step 1 of 3 done",
      "Step 2 of 3 done",
    ]);
    const sent = progressOnWire.length;
    emit({ outcome: "running", step: 3, of: 3, keyframes: 0, note: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(progressOnWire.length, "progress after report answered").toBe(sent);
  });

  it("passes takeId through for derive and export, and takes needs no arguments", async () => {
    const { client, calls } = await connect({
      derive: async () => ({ ok: true, value: { outcome: "derived" } }),
      export: async () => ({
        ok: true,
        value: { outcome: "saved", file: { path: "/x.mp4" } },
      }),
      takes: async () => ({ ok: true, value: [] }),
      status: async () => ({ ok: true, value: { allowAgentRuns: true } }),
    });
    await client.callTool({ name: "derive", arguments: { takeId: "t1" } });
    await client.callTool({ name: "export", arguments: { takeId: "t1" } });
    await client.callTool({ name: "takes", arguments: {} });
    await client.callTool({ name: "status", arguments: {} });
    expect(calls).toEqual([
      { op: "derive", args: { takeId: "t1", agent: AGENT } },
      { op: "export", args: { takeId: "t1", callId: "id-1", agent: AGENT } },
      { op: "takes", args: { agent: AGENT } },
      { op: "status", args: { agent: AGENT } },
    ]);
  });

  // m1. Red if status answers only what the extension said: its description
  // promises the browser, and the protocol is the server's to state.
  // Red if the name is dropped, or a title the client never gave is invented
  // (the extension shows a title as given).
  it("names the agent with the client's own name when it gives no title", async () => {
    const { client, calls } = await connect(
      { takes: async () => ({ ok: true, value: [] }) },
      200,
      { name: "cursor-vscode", version: "1.0.0" },
    );
    await client.callTool({ name: "takes", arguments: {} });
    expect(calls).toEqual([
      { op: "takes", args: { agent: { name: "cursor-vscode" } } },
    ]);
  });

  // The code (2026-10-04): what a person compares with Settings → Agents.
  // Launch B: the CLI has no extension, port or key, so its status names
  // its version and the npm update check instead of the bridge's fields.
  it("answers the CLI's status with version and update, and no bridge fields", async () => {
    const { client } = await connect(
      {
        status: async () => ({
          ok: true,
          value: { executor: "cli", browserRunning: false },
        }),
      },
      200,
      undefined,
      async () => ({ current: "0.1.0", latest: "0.2.0", newer: true }),
    );
    const status = textOf(
      await client.callTool({ name: "status", arguments: {} }),
    );
    expect(status).toMatchObject({
      executor: "cli",
      version: "0.1.0",
      update: { current: "0.1.0", latest: "0.2.0", newer: true },
    });
    for (const gone of ["protocol", "code", "server"]) {
      expect(status, gone).not.toHaveProperty(gone);
    }
  });

  // Review fix: agents read the description before the recipe, so it must
  // name what status answers under the CLI, and nothing it no longer does.
  it("describes the CLI's status by the fields it answers", async () => {
    const { client } = await connect({}, 200, undefined);
    const status = (await client.listTools()).tools.find(
      (t) => t.name === "status",
    );
    const said = status?.description ?? "";
    for (const field of ["version", "browserInstalled", "update"]) {
      expect(said, field).toContain(field);
    }
    expect(said).not.toMatch(/server field/i);
  });

  // Launch C2: agents read the description before the recipe, so the CLI's
  // names what it now answers about demo accounts.
  it("describes demo accounts in the CLI's status, snapshot and run", async () => {
    const { client } = await connect({}, 200, undefined);
    const tools = (await client.listTools()).tools;
    const said = (n: string) =>
      tools.find((t) => t.name === n)?.description ?? "";
    expect(said("status")).toContain("accounts");
    expect(said("status")).toContain("secretsFile");
    expect(said("snapshot")).toContain("account");
    expect(said("snapshot")).toContain("signedIn");
    expect(said("run")).toContain("account");
    expect(said("run")).toContain("project");
  });

  // Review fix: the update check is an optional field; its throw must not
  // cost the agent the browser and run fields, and its reason is said.
  it("answers status when the update check throws, naming why in update", async () => {
    const { client } = await connect(
      { status: async () => ({ ok: true, value: { executor: "cli" } }) },
      200,
      undefined,
      async () => {
        throw new TypeError("latest.indexOf is not a function");
      },
    );
    const result = await client.callTool({ name: "status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toMatchObject({
      executor: "cli",
      version: "0.1.0",
      update: {
        current: "0.1.0",
        check: "failed: latest.indexOf is not a function",
      },
    });
  });

  it("says no update check was set up rather than inventing an answer", async () => {
    const { client } = await connect(
      { status: async () => ({ ok: true, value: { executor: "cli" } }) },
      200,
      undefined,
    );
    const status = textOf(
      await client.callTool({ name: "status", arguments: {} }),
    );
    expect(status).toMatchObject({
      update: {
        current: "0.1.0",
        check: "off: no update check was set up for this server",
      },
    });
  });

  it("states its instructions to the client", async () => {
    const { client } = await connect({});
    expect(client.getInstructions()).toBe(INSTRUCTIONS_CLI);
  });

  // Red if recipe answers anything but the text it was given, or needs the
  // extension: an agent reads it before anything is connected.
  it("answers the recipe as text, without asking the extension", async () => {
    const { client, calls } = await connect({});
    const result = await client.callTool({ name: "recipe", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(
      (result as { content: Array<{ text: string }> }).content[0]?.text,
    ).toBe("RECIPE TEXT");
    expect(calls).toEqual([]);
  });

  // Measured in the planning session (see recipe.test.ts): descriptions past
  // about 2 KB are cut. Red if any tool's grows past it.
  it("keeps every tool description under 2000 characters", async () => {
    const { client } = await connect({});
    const tools = (await client.listTools()).tools;
    // Premise: the loop below reads descriptions.
    expect(tools.length).toBeGreaterThan(5);
    for (const tool of tools) {
      expect((tool.description ?? "").length, tool.name).toBeLessThanOrEqual(
        2000,
      );
    }
  });

  // Final review 2026-10-12, Important 3. Red if this server is described
  // in the archived extension's words: an agent told it drives "the user's
  // own browser, signed in as they are" asks the user to sign in to a
  // browser nobody signed in to, and one told export saves an MP4 waits for
  // a file it may not make.
  it("describes this server's own browser, not the extension's", async () => {
    const { client } = await connect({});
    const cli = Object.fromEntries(
      (await client.listTools()).tools.map((t) => [
        t.name,
        t.description ?? "",
      ]),
    );
    // Premise: the tools compared below are listed.
    for (const name of ["snapshot", "status", "run", "export", "takes"]) {
      expect(cli[name], name).toBeTruthy();
    }
    const all = Object.values(cli).join("\n");
    expect(all).not.toContain("signed in as they are");
    expect(all).not.toContain("extension connected");
    expect(all).not.toContain("the user's browser");
    expect(all).not.toContain("Render a take to an MP4");
    expect(all).not.toContain("The user's Demoman library");
    expect(cli.snapshot).toContain(
      "signed in where the user ran npx demoman signin",
    );
    expect(cli.snapshot).not.toContain("signed in to nothing");
    expect(cli.snapshot).toContain(
      "If landedUrl is not a sign-in page, use it as the target.",
    );
    expect(cli.snapshot).not.toContain("Otherwise use landedUrl");
    expect(cli.status).toContain("refreshedAt");
    expect(cli.export).toContain("--out-dir");
    expect(cli.export).toContain('"saved"');
    expect(cli.export).not.toContain("exportNotBuilt");
    expect(cli.takes).toContain("this demoman-mcp's own browser made");
    // An export opens the window too (it renders in that browser).
    expect(cli.status).toContain("first snapshot, run or export");
  });

  // Launch C2. Red if snapshot drops `account` or `project`: the agent's
  // named persona would be replaced by the site's default in silence.
  it("forwards snapshot's account and project, and run's project (cli)", async () => {
    const { client, calls } = await connect(
      {
        snapshot: async (args) => ({
          ok: true,
          value: { url: args.url, targets: [] },
        }),
        run: async () => ({ ok: true, value: { outcome: "complete" } }),
      },
      200,
      { ...AGENT, version: "1.0.0" },
    );
    await client.callTool({
      name: "snapshot",
      arguments: { url: "http://a/", account: "seller", project: "/repo" },
    });
    await client.callTool({
      name: "snapshot",
      arguments: { url: "http://a/" },
    });
    await client.callTool({
      name: "run",
      arguments: { script: { name: "x" }, project: "/repo" },
    });
    expect(calls[0]?.args).toMatchObject({
      account: "seller",
      project: "/repo",
    });
    expect("account" in (calls[1]?.args ?? {})).toBe(false);
    expect("project" in (calls[1]?.args ?? {})).toBe(false);
    expect(calls[2]?.args).toMatchObject({ project: "/repo" });
  });

  // Red if status drops `project`: a worktree would be told its parent
  // repo's pull-request setting.
  it("status passes project", async () => {
    const { client, calls } = await connect(
      { status: async () => ({ ok: true, value: {} }) },
      200,
      { ...AGENT, version: "1.0.0" },
    );
    await client.callTool({ name: "status", arguments: { project: "/repo" } });
    await client.callTool({ name: "status", arguments: {} });
    expect(calls[0]?.args).toMatchObject({ project: "/repo" });
    expect("project" in (calls[1]?.args ?? {})).toBe(false);
  });

  // Red if attach drops into, pr or project on its way, or sends a pr the
  // agent never gave: a worktree would attach to the wrong branch's PR.
  it("forwards attach's takeId, into, pr and project to the CLI, as a long call", async () => {
    const { client, calls } = await connect(
      {
        attach: async () => ({
          ok: true,
          value: { outcome: "attached", summary: "Attached." },
        }),
      },
      200,
      undefined,
    );
    const out = await client.callTool({
      name: "attach",
      arguments: { takeId: "t1", into: "comment", pr: 12, project: "/repo" },
    });
    expect(out.isError).toBeUndefined();
    expect(textOf(out)).toMatchObject({ outcome: "attached" });
    await client.callTool({
      name: "attach",
      arguments: { takeId: "t1", into: "description" },
    });
    expect(calls).toEqual([
      {
        op: "attach",
        args: {
          takeId: "t1",
          into: "comment",
          pr: 12,
          project: "/repo",
          callId: "id-1",
          agent: AGENT,
        },
      },
      {
        op: "attach",
        args: {
          takeId: "t1",
          into: "description",
          callId: "id-2",
          agent: AGENT,
        },
      },
    ]);
  });

  // Red if the tool drops attach's maxMB on its way to the CLI, sends one
  // the agent never gave, or lets a cap of 0 through to it.
  it("passes attach's maxMB through to the CLI, and only a positive one", async () => {
    const { client, calls } = await connect(
      {
        attach: async () => ({
          ok: true,
          value: { outcome: "attached", summary: "Attached." },
        }),
      },
      200,
      undefined,
    );
    await client.callTool({
      name: "attach",
      arguments: { takeId: "t1", into: "description", maxMB: 9.5 },
    });
    await client.callTool({
      name: "attach",
      arguments: { takeId: "t1", into: "description" },
    });
    const zero = await client.callTool({
      name: "attach",
      arguments: { takeId: "t1", into: "description", maxMB: 0 },
    });
    expect(zero.isError).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      op: "attach",
      args: { takeId: "t1", into: "description", maxMB: 9.5 },
    });
    expect((calls[1]?.args as object) ?? {}).not.toHaveProperty("maxMB");
  });

  it("answers a slow attach stillRunning, and report returns it", async () => {
    let finish: (o: Outcome) => void = () => undefined;
    const { client } = await connect(
      { attach: () => new Promise<Outcome>((r) => (finish = r)) },
      50,
      undefined,
    );
    const first = await client.callTool({
      name: "attach",
      arguments: { takeId: "t1", into: "description" },
    });
    expect(textOf(first)).toEqual({ outcome: "stillRunning", id: "id-1" });
    finish({ ok: true, value: { outcome: "attached", summary: "Attached." } });
    const later = await client.callTool({
      name: "report",
      arguments: { id: "id-1" },
    });
    expect(textOf(later)).toMatchObject({ outcome: "attached" });
  });

  it("describes status's pullRequests (cli)", async () => {
    const { client } = await connect({}, 200, undefined);
    const status = (await client.listTools()).tools.find(
      (t) => t.name === "status",
    );
    expect(status?.description ?? "").toContain("pullRequests");
  });

  // Spec 2026-10-10 §3. Red if snapshot drops `device`: the agent would be
  // handed the desktop's targets for a phone run that cannot find them.
  it("forwards snapshot's device, and refuses one it does not know", async () => {
    const { client, calls } = await connect({
      snapshot: async (args) => ({
        ok: true,
        value: { url: args.url, targets: [] },
      }),
    });
    await client.callTool({
      name: "snapshot",
      arguments: { url: "http://a/", device: "phone" },
    });
    expect(calls).toEqual([
      {
        op: "snapshot",
        args: {
          url: "http://a/",
          device: "phone",
          callId: "id-1",
          agent: AGENT,
        },
      },
    ]);
    const bad = await client.callTool({
      name: "snapshot",
      arguments: { url: "http://a/", device: "galaxy" },
    });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  // Red if snapshot drops `contains`, sends it when absent, or turns the
  // page's refusal into content an agent would read as a snapshot.
  it("forwards snapshot's url and contains, and keeps a refusal's reason", async () => {
    const { client, calls } = await connect({
      snapshot: async (args) =>
        args.url === "http://bad/"
          ? { ok: false, reason: "pageSilent", detail: "no answer" }
          : { ok: true, value: { url: args.url, targets: [] } },
    });
    const okResult = await client.callTool({
      name: "snapshot",
      arguments: { url: "http://a/" },
    });
    expect(textOf(okResult)).toEqual({ url: "http://a/", targets: [] });
    await client.callTool({
      name: "snapshot",
      arguments: { url: "http://a/", contains: "pay" },
    });
    const bad = await client.callTool({
      name: "snapshot",
      arguments: { url: "http://bad/" },
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toEqual({ reason: "pageSilent", detail: "no answer" });
    expect(calls).toEqual([
      {
        op: "snapshot",
        args: { url: "http://a/", callId: "id-1", agent: AGENT },
      },
      {
        op: "snapshot",
        args: {
          url: "http://a/",
          contains: "pay",
          callId: "id-2",
          agent: AGENT,
        },
      },
      {
        op: "snapshot",
        args: { url: "http://bad/", callId: "id-3", agent: AGENT },
      },
    ]);
  });

  // Project A of cli-launch.md. Red while the CLI's timeout answers in the
  // extension's words: an agent told "Demoman's extension did not connect"
  // asks the user about an extension the CLI does not use.
  it("answers browserSilent, not an extension reason, when the CLI's executor never answers", {
    timeout: 3000,
  }, async () => {
    const never = () => new Promise<Outcome>(() => {});
    const { client, calls } = await connect(
      { status: never, takes: never, derive: never },
      150,
      undefined,
    );
    for (const [name, args] of [
      ["status", {}],
      ["takes", {}],
      ["derive", { takeId: "t1" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBe(true);
      const said = textOf(result) as { reason: string; detail: string };
      expect(said.reason, name).toBe("browserSilent");
      expect(said.detail).toContain(`did not answer ${name}`);
      expect(said.detail).not.toMatch(/extension/i);
    }
    // Premise: each request reached the link, so the cap is what answered.
    expect(calls.map((c) => c.op)).toEqual(["status", "takes", "derive"]);
  });

  // Replaces "answers snapshotTimedOut at the cap". Red if a slow snapshot
  // is given up on (a queued one always is slow), or if report asks the page
  // for it (the page keeps no snapshot by id).
  it("answers a slow snapshot stillRunning with an id, and report returns it once it lands", async () => {
    let land: (o: Outcome) => void = () => {};
    const { client, calls } = await connect(
      {
        snapshot: () =>
          new Promise<Outcome>((r) => {
            land = r;
          }),
      },
      150,
    );
    const first = await client.callTool({
      name: "snapshot",
      arguments: { url: "http://a/" },
    });
    expect(textOf(first)).toEqual({ outcome: "stillRunning", id: "id-1" });
    land({ ok: true, value: { url: "http://a/", targets: [] } });
    const r = await client.callTool({
      name: "report",
      arguments: { id: "id-1" },
    });
    expect(textOf(r)).toEqual({ url: "http://a/", targets: [] });
    expect(calls.map((c) => c.op)).toEqual(["snapshot"]);
  });

  // Red if a snapshot's lost call sends report to the page.
  it("answers a snapshot's lost call as it was lost, without asking the page", async () => {
    let land: (o: Outcome) => void = () => {};
    const { client, calls } = await connect(
      {
        snapshot: () =>
          new Promise<Outcome>((r) => {
            land = r;
          }),
      },
      100,
    );
    await client.callTool({
      name: "snapshot",
      arguments: { url: "http://a/" },
    });
    land({ ok: false, reason: "bridgeLost", detail: "the hub went" });
    const r = await client.callTool({
      name: "report",
      arguments: { id: "id-1" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toEqual({ reason: "bridgeLost", detail: "the hub went" });
    expect(calls.map((c) => c.op)).toEqual(["snapshot"]);
  });

  // Final review, finding 3. Red while hubSilent is final for report: a run
  // that was going when its hub went silent carries on in the browser, and
  // only the page can say how it ended.
  it("asks the page for a run whose call answered hubSilent", async () => {
    let lose: (o: Outcome) => void = () => {};
    const { client, calls } = await connect(
      {
        run: () =>
          new Promise<Outcome>((r) => {
            lose = r;
          }),
        report: async () => ({ ok: true, value: { outcome: "complete" } }),
      },
      100,
    );
    await client.callTool({ name: "run", arguments: { script: {} } });
    lose(failure("hubSilent", "the hub went silent"));
    const r = await client.callTool({
      name: "report",
      arguments: { id: "id-1" },
    });
    expect(textOf(r)).toEqual({ outcome: "complete" });
    expect(calls.map((c) => c.op)).toEqual(["run", "report"]);
  });

  // Codex's default approval mode prompts for every call of a tool with no
  // annotations (an unset hint counts as true), so each `report` poll asked
  // first (launch E spec §2). Red if a tool goes unannotated, or a claim
  // drifts from what the table says the tool does.
  it("annotates every tool honestly, and lists exactly TOOL_ANNOTATIONS' tools", async () => {
    const { client } = await connect(
      {},
      200,
      undefined,
      undefined,
      async () => ({ outcome: "opened", url: "http://127.0.0.1:1/?t=x" }),
    );
    const tools = (await client.listTools()).tools;
    const table = TOOL_ANNOTATIONS as Record<string, Record<string, unknown>>;
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(table).sort());
    for (const t of tools) expect(t.annotations, t.name).toEqual(table[t.name]);
    for (const n of ["recipe", "status", "takes", "derive", "report"]) {
      expect(table[n]?.readOnlyHint, n).toBe(true);
    }
    for (const n of ["snapshot", "run"]) {
      expect(table[n], n).toMatchObject({ openWorldHint: true });
    }
    expect(table.snapshot?.destructiveHint).toBe(false);
    // A script clicks and types in an app the user may be signed in to, so
    // it can press Delete; an agent that trusts the hint must not skip
    // asking because of it (/code-review, 2026-10-17).
    expect(table.run?.destructiveHint).toBe(true);
    for (const n of ["export", "studio"]) {
      expect(table[n], n).toMatchObject({ destructiveHint: false });
      expect(table[n]?.readOnlyHint, n).not.toBe(true);
    }
    // It posts under the user's GitHub account, to a PR anyone can read.
    expect(table.attach).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  // Cursor's `agent` CLI cuts tools/call at a hardcoded 60 s, ignores
  // progress and has no setting (Cursor staff, 2026-10-02,
  // forum.cursor.com/t/160548). Red if the cap grows to where an answer plus
  // its overhead could miss it.
  it("keeps the run cap under Cursor's agent CLI 60 s cut", () => {
    expect(RUN_TOOL_CAP_MS).toBeLessThanOrEqual(55_000);
  });

  // Red if the tool is registered whether or not the bin injected a studio:
  // the extension executor and demoman-mcp have none to open.
  it("lists no studio tool unless one was injected", async () => {
    const without = await connect({}, 200, undefined);
    expect(
      (await without.client.listTools()).tools.map((t) => t.name),
    ).not.toContain("studio");
    const calls: Array<{ takeId?: string }> = [];
    const withIt = await connect({}, 200, undefined, undefined, async (a) => {
      calls.push(a);
      return { outcome: "opened", url: "http://127.0.0.1:1/?t=x" };
    });
    expect(
      (await withIt.client.listTools()).tools.map((t) => t.name),
    ).toContain("studio");
  });

  it("passes takeId to the studio and answers what it answered", async () => {
    const calls: Array<{ takeId?: string }> = [];
    const { client } = await connect(
      {},
      200,
      undefined,
      undefined,
      async (a) => {
        calls.push(a);
        return {
          outcome: "opened",
          url: "http://127.0.0.1:1/?t=x",
          ...(a.takeId === undefined ? {} : { takeId: a.takeId }),
          note: "A stale studio record was replaced.",
        };
      },
    );
    const r = await client.callTool({
      name: "studio",
      arguments: { takeId: "take-1" },
    });
    expect(calls).toEqual([{ takeId: "take-1" }]);
    expect(textOf(r)).toEqual({
      outcome: "opened",
      url: "http://127.0.0.1:1/?t=x",
      takeId: "take-1",
      note: "A stale studio record was replaced.",
    });
    expect(r.isError).not.toBe(true);
    await client.callTool({ name: "studio", arguments: {} });
    expect(calls[1]).toEqual({});
  });

  it("answers a studio refusal as an error with its reason and detail", async () => {
    const { client } = await connect(
      {},
      200,
      undefined,
      undefined,
      async () => ({
        reason: "takeNotFound",
        detail: "No take has the id nope.",
      }),
    );
    const r = await client.callTool({
      name: "studio",
      arguments: { takeId: "nope" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toEqual({
      reason: "takeNotFound",
      detail: "No take has the id nope.",
    });
  });
});
