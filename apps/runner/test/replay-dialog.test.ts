import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SceneDocument } from "@demoman/scene-schema";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { fixtureScene } from "../../../packages/compositor/scripts/fixture-scene.js";
import { createFileFrameStore } from "../src/frame-store.js";
import { launch } from "../src/launch.js";
import { replayPhase } from "../src/replay.js";

/**
 * DEM-161, the runner's re-record (`replayPhase` → `runReplay`): a take's
 * click that opens `confirm()` is answered by the engine alone. Without a
 * Playwright `dialog` listener Playwright dismisses it too, racing the
 * engine's OK; the page says which answer won.
 */
let server: Server;
let url = "";

beforeAll(async () => {
  const html = await readFile(
    new URL("./fixtures/confirm-dialog-app.html", import.meta.url),
    "utf8",
  );
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}, 20_000); // a server, not a browser: ~2 ms here.

afterAll(() => {
  server?.close();
});

/** The fixture take's meta, with one click on `#delete` that recorded a
 *  default OK (so the re-record answers OK too). */
function confirmTake(): SceneDocument {
  const base = fixtureScene();
  const anchor = base.anchors[0];
  if (anchor === undefined) throw new Error("premise: the fixture's anchor");
  return {
    ...base,
    anchors: [
      {
        ...anchor,
        id: "a-delete",
        fingerprint: {
          ...anchor.fingerprint,
          stableId: "delete",
          role: "button",
          accessibleName: "Delete project",
          textContent: "Delete project",
          treePath: "body:1/button:1",
          boundingRect: { x: 40, y: 100, width: 130, height: 36 },
        },
      },
    ],
    actions: [
      {
        id: "act-1",
        kind: "click",
        anchorId: "a-delete",
        timestamp: 1000,
        marker: "click:a-delete",
        button: "left",
        dialogs: [
          {
            kind: "confirm",
            host: "127.0.0.1",
            message: "Delete Northwind?",
            answer: "accept",
            by: "default",
            beatMs: 1500,
          },
        ],
      },
    ],
    camera: [],
  } as SceneDocument;
}

describe("a re-record of a take whose click opens confirm()", () => {
  it("ends on the engine's answer, not Playwright's", async () => {
    const take = confirmTake();
    // Premise: the take recorded an OK, and Playwright's own answer is Cancel.
    expect(take.actions[0]).toMatchObject({
      dialogs: [{ answer: "accept" }],
    });
    const root = mkdtempSync(join(tmpdir(), "demoman-replay-dialog-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const launched = await launch();
    try {
      const { result } = await replayPhase({
        scene: take,
        targetUrl: url,
        store: createFileFrameStore(root),
        launched,
        report: () => undefined,
      });
      const said = JSON.stringify({
        reason: result.reason,
        completed: result.completed,
        dialogs: result.dialogs,
        page: await launched.page.innerText("body"),
      });
      expect(result.reason, said).toBeNull();
      expect(result.dialogs, said).toEqual([
        expect.objectContaining({ kind: "confirm", answer: "accept" }),
      ]);
      expect(await launched.page.innerText("#answer"), said).toBe(
        "confirm() answered true",
      );
    } finally {
      await launched.close();
    }
  }, 120_000); // 2.2 s here, its own browser; 5x is 11 s.
});
