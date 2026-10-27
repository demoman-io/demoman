import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { serveFixtureApp } from "../../runner/test/fixture.js";
import { sampleMp4 } from "../../runner/test/mp4-probe.js";
import { connect, installPacked, text } from "../test/packed-install.js";

type Answer = Record<string, any>;
async function finished(c: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>): Promise<Answer> {
  let v = JSON.parse(text(await c.callTool({ name, arguments: args })));
  while (["running", "stillRunning", "exporting", "queued"].includes(v.outcome)) {
    v = JSON.parse(text(await c.callTool({ name: "report", arguments: { id: v.id } })));
  }
  return v;
}

it("spike: 1920x1080@2 share take of >= 20 s", async () => {
  const packed = await installPacked();
  const app = await serveFixtureApp();
  const home = await mkdtemp(join(tmpdir(), "demoman-spike-"));
  const c = await connect(process.execPath, [packed.bin, "mcp", "--out-dir", join(home, "out")], {
    DEMOMAN_HOME: home,
    DEMOMAN_NO_UPDATE_CHECK: "1",
    DEMOMAN_DISPLAY: "1920x1080@2",
  });
  const tag = `SPIKE repeat=${process.env.REPEAT ?? "?"} runner=${process.env.ImageOS ?? "?"}`;
  try {
    const run = await finished(c, "run", {
      video: { new: "Spike", confirmedNew: true },
      script: {
        scriptVersion: 1,
        name: "Spike",
        target: app.url,
        viewport: { width: 1920, height: 1080 },
        steps: [
          { do: "waitForLoad" },
          { do: "pause", ms: 5000 },
          { do: "click", on: { text: "Place order" } },
          { do: "pause", ms: 6000 },
          { do: "pause", ms: 6000 },
          { do: "pause", ms: 6000 },
        ],
      },
    });
    console.log(`${tag} run.outcome=${run.outcome} degradations=${JSON.stringify(run.frames?.degradations)} summary=${JSON.stringify(run.summary)}`);
    console.log(`${tag} runjson=${JSON.stringify(run).slice(0, 1500)}`);
    const exported = await finished(c, "export", { takeId: run.provenance?.takeId, quality: "share" });
    let extra = "";
    const path = exported.file?.path;
    if (path) {
      const size = (await stat(path)).size;
      const read = await sampleMp4(await readFile(path), { colors: [] });
      extra = ` size=${size} duration=${read.durationSec.toFixed(1)}s dims=${read.width}x${read.height}`;
    }
    console.log(`${tag} export.outcome=${exported.outcome}${extra} summary=${JSON.stringify(exported.summary)}`);
    console.log(`${tag} exportjson=${JSON.stringify(exported).slice(0, 1500)}`);
    expect(run.outcome).toBe("complete");
  } finally {
    await c.close();
    app.close();
    await packed.cleanup();
  }
}, 900_000);
