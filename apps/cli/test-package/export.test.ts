import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LOGO_SVG, serveFixtureApp } from "../../runner/test/fixture.js";
import { sampleMp4 } from "../../runner/test/mp4-probe.js";
import { connect, installPacked, text } from "../test/packed-install.js";

const GREEN: [number, number, number] = [0, 200, 83];
// The fixture's invoice panel (#111827), which "Place order" slides in.
const PANEL: [number, number, number] = [17, 24, 39];

let packed: Awaited<ReturnType<typeof installPacked>>;
let app: Awaited<ReturnType<typeof serveFixtureApp>>;
let home: string;
beforeAll(async () => {
  packed = await installPacked();
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-package-"));
  await writeFile(join(home, "acme.svg"), LOGO_SVG);
});
afterAll(async () => {
  app?.close();
  await packed?.cleanup();
  await rm(home, { recursive: true, force: true });
});

type Client = Awaited<ReturnType<typeof connect>>;
/** The fields of a run, export or report answer this lane reads. */
type Answer = {
  outcome: string;
  id?: string;
  provenance?: { takeId?: string };
  file?: { path: string };
};
/** Calls a long tool, then polls report until it is done — no sleeps:
 *  report itself waits up to ~40 s. */
async function finished(
  c: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Answer> {
  let v = JSON.parse(
    text(await c.callTool({ name, arguments: args })),
  ) as Answer;
  while (
    ["running", "stillRunning", "exporting", "queued"].includes(v.outcome)
  ) {
    v = JSON.parse(
      text(await c.callTool({ name: "report", arguments: { id: v.id } })),
    ) as Answer;
  }
  return v;
}

it("runs and exports the fixture take from the packed install, and the film shows it", async () => {
  const c = await connect(
    process.execPath,
    [packed.bin, "mcp", "--out-dir", join(home, "out")],
    { DEMOMAN_HOME: home, DEMOMAN_NO_UPDATE_CHECK: "1" },
  );
  try {
    const run = await finished(c, "run", {
      script: {
        scriptVersion: 1,
        name: "Place an order",
        target: app.url,
        viewport: { width: 1280, height: 800 },
        look: {
          branding: {
            background: { kind: "solid", color: "#00c853" },
            logo: {
              ref: "acme.svg",
              corner: "bottom-right",
              size: 0.1,
              opacity: 1,
            },
            padding: 0.08,
          },
          canvas: { aspect: "9:16" },
        },
        steps: [
          { do: "waitForLoad" },
          { do: "click", on: { text: "Place order" } },
          { do: "pause", ms: 1200 },
        ],
      },
    });
    expect(run.outcome, JSON.stringify(run)).toBe("complete");
    const exported = await finished(c, "export", {
      takeId: run.provenance?.takeId,
    });
    expect(exported.outcome, JSON.stringify(exported)).toBe("saved");
    const path = exported.file?.path;
    if (path === undefined) throw new Error("saved names no file.path");
    const read = await sampleMp4(await readFile(path), {
      colors: [GREEN, PANEL],
    });
    // No quality asked for: the default export is high, 1080x1920 at 9:16
    // (720x1280 is quality "share", GitHub's).
    expect([read.width, read.height]).toEqual([1080, 1920]);
    const counts = read.readings.map((r) => r.colorCounts);
    const green = Math.max(...counts.map((c) => c[0] ?? 0));
    expect(green, "the brand background is not in the film").toBeGreaterThan(
      50,
    );
    // Not blank and not frozen: the panel the click opens is absent at the
    // start (the fixture's premise) and present later.
    const panelFirst = counts[0]?.[1] ?? 0;
    const panelMost = Math.max(...counts.map((c) => c[1] ?? 0));
    console.info(
      `[package] green max ${green}; panel first ${panelFirst}, most ${panelMost}; ${read.readings.length} readings over ${read.durationSec.toFixed(1)} s`,
    );
    expect(panelMost, JSON.stringify(counts)).toBeGreaterThan(
      panelFirst * 4 + 500,
    );
  } finally {
    await c.close();
  }
});
