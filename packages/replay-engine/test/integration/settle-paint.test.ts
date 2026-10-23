import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SETTLE_PAINT_TIMEOUT_MS,
  type SettleReport,
  settlePaintExpression,
} from "../../src/index.js";

/**
 * The claim the fake CDP cannot make.
 *
 * The engine's unit tests prove that the probe is asked, awaited, and
 * reported on — but they take the probe's answer from a stub, so they cannot
 * prove the thing the whole mechanism rests on: that `load` fires while an
 * image on the first screen is still arriving, and that this expression
 * waits for it. Only a browser can answer that, so it is asked here.
 *
 * The image is `loading="lazy"` because that is the shape that bit us. A
 * lazy image does not block the load event no matter where it sits, so a
 * page whose first screen is lazily-loaded — which is most content sites,
 * Wikipedia included — fires `load` with its pictures missing.
 */

/** Serves a page whose only image is lazy and answers slowly. */
async function withSlowImagePage(
  delayMs: number,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  // 1x1 transparent PNG.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const html = `<!doctype html>
<meta charset="utf-8">
<title>slow image</title>
<style>body { margin: 0 } img { width: 200px; height: 200px }</style>
<img loading="lazy" src="/slow.png" alt="slow">
`;
  const server: Server = createServer((req, res) => {
    if (req.url === "/slow.png") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png);
      }, delayMs);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/**
 * Serves a page that commits before its markup arrives: the first bytes go
 * out at once and the rest — the `<img>` included — `delayMs` later. This is
 * the shape of a navigation that has not finished parsing, which is what the
 * probe sees when `Page.navigate` never fires `load` and the engine settles
 * against whatever document is there (see `createNavigatingGuard`).
 */
async function withDeferredBodyPage(
  delayMs: number,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/slow.png") return; // never answers
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<!doctype html><meta charset=utf-8><title>deferred</title>");
    setTimeout(() => {
      res.end(`<img loading="lazy" src="/slow.png" alt="slow">`);
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/**
 * Serves a page that is still building itself after `load`: a fixed loading
 * bar at the top, repainted every frame the way Phoenix LiveView's `topbar`
 * repaints (`canvas.width = innerWidth` on each animation frame), removed
 * `barMs` after `load`. `barMs` of `Infinity` never removes it.
 *
 * The shape that bit an agent take on 2026-10-03: the LiveView join
 * outlasted `load`, the topbar was still sweeping, and the probe — which
 * asked only about parsing, images and fonts — called the page settled. The
 * opening keyframe carried the bar and held it for two seconds of video.
 */
async function withLoadingBarPage(
  barMs: number,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const stop = Number.isFinite(barMs) ? String(barMs) : "null";
  const html = `<!doctype html>
<meta charset="utf-8">
<title>loading bar</title>
<style>body { margin: 0 } canvas { position: fixed; top: 0; left: 0 }</style>
<h1>hero</h1>
<script>
addEventListener("load", () => {
  const bar = document.createElement("canvas");
  bar.id = "bar";
  document.body.append(bar);
  const started = performance.now();
  const stopAfter = ${stop};
  const loop = () => {
    if (stopAfter !== null && performance.now() - started >= stopAfter) {
      bar.remove();
      return;
    }
    bar.width = innerWidth;
    bar.height = 15;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
</script>
`;
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

describe("the settle probe against a real browser", () => {
  // One browser for the file, not one per test. Each `chromium.launch()`
  // measured between 1.9s and 13.3s on a loaded machine, so four of them put
  // the file's worst case past its own timeout while the work it is timing
  // takes about a second.
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("waits for a first-screen image that `load` did not wait for", async () => {
    await withSlowImagePage(600, async (url) => {
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
      });
      try {
        const session = await page.context().newCDPSession(page);
        await page.goto(url, { waitUntil: "load" });

        // The premise, and the whole reason this file exists: `load` has
        // fired and the image on the first screen is still arriving. If
        // Chromium ever starts blocking `load` on lazy images this fails
        // here, loudly, instead of the test below passing for free.
        expect(await page.evaluate(() => document.images[0]?.complete)).toBe(
          false,
        );

        const reply = (await session.send("Runtime.evaluate", {
          expression: settlePaintExpression(SETTLE_PAINT_TIMEOUT_MS),
          awaitPromise: true,
          returnByValue: true,
        })) as { result?: { value?: SettleReport } };

        expect(reply.result?.value).toMatchObject({
          settled: true,
          pending: 0,
          fonts: "ok",
        });
        // And the wait was real: the image the probe waited for is now here.
        expect(await page.evaluate(() => document.images[0]?.complete)).toBe(
          true,
        );
      } finally {
        await page.close();
      }
    });
  });

  // The other half of the contract: it gives up rather than hanging, and its
  // reply says what was still outstanding so the engine can report it.
  it("reports what is outstanding when the image never arrives", async () => {
    await withSlowImagePage(60_000, async (url) => {
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
      });
      try {
        const session = await page.context().newCDPSession(page);
        // `load`, not `commit`: this test is about an image that never
        // arrives, and a document that has not parsed its `<img>` yet has no
        // outstanding image to report. Waiting for `load` — which a lazy
        // image does not block — puts the page in the one state the question
        // is about. Under `commit` the two raced, and CI lost the race.
        await page.goto(url, { waitUntil: "load" });

        const reply = (await session.send("Runtime.evaluate", {
          expression: settlePaintExpression(500),
          awaitPromise: true,
          returnByValue: true,
        })) as { result?: { value?: SettleReport } };

        expect(reply.result?.value?.settled).toBe(false);
        expect(reply.result?.value?.pending).toBe(1);
      } finally {
        await page.close();
      }
    });
  });

  /**
   * The hole the `commit` race above was standing in.
   *
   * `document.images` is only as long as the markup that has arrived, so a
   * document still being parsed reports an empty list — and an empty list
   * read as "nothing outstanding" ends the wait on the first pass and calls a
   * page that has loaded nothing a settled one. The engine reaches this state
   * for real: `createNavigatingGuard` races `load` against
   * NAVIGATE_TIMEOUT_MS and settles against whatever document is there when
   * the timeout wins.
   *
   * The image here is in the half of the markup that arrives after the probe
   * has already started, and it never comes. Before the parse check the probe
   * broke out at once with `pending: 0` and reported `settled: true`; the
   * image it had not seen yet is the one it is supposed to be waiting for.
   */
  it("counts an image in markup that had not arrived when it was asked", async () => {
    await withDeferredBodyPage(300, async (url) => {
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
      });
      try {
        const session = await page.context().newCDPSession(page);
        await page.goto(url, { waitUntil: "commit" });
        // The premise: nothing is parsed yet, so there is no image to find.
        expect(await page.evaluate(() => document.readyState)).toBe("loading");
        expect(await page.evaluate(() => document.images.length)).toBe(0);

        const reply = (await session.send("Runtime.evaluate", {
          expression: settlePaintExpression(SETTLE_PAINT_TIMEOUT_MS),
          awaitPromise: true,
          returnByValue: true,
        })) as { result?: { value?: SettleReport } };

        expect(reply.result?.value?.settled).toBe(false);
        expect(reply.result?.value?.pending).toBe(1);
      } finally {
        await page.close();
      }
    });
  });

  /**
   * And when the parse itself is what outlasts the deadline, the reply says
   * so. "Still parsing" and "an image never came" are different faults with
   * different fixes, and `pending: 0` alone cannot tell them apart — the
   * engine's degradation message reads `ready` to say which one it was.
   */
  it("says a document that never finished parsing was still parsing", async () => {
    await withDeferredBodyPage(60_000, async (url) => {
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
      });
      try {
        const session = await page.context().newCDPSession(page);
        await page.goto(url, { waitUntil: "commit" });

        const reply = (await session.send("Runtime.evaluate", {
          expression: settlePaintExpression(500),
          awaitPromise: true,
          returnByValue: true,
        })) as { result?: { value?: SettleReport } };

        expect(reply.result?.value?.settled).toBe(false);
        expect(reply.result?.value?.ready).toBe("loading");
      } finally {
        await page.close();
      }
    });
  });

  /**
   * "Loaded" is more than parsed, pictured and lettered: an app that is
   * still connecting draws its own loading state, and a frame taken then is
   * a frame of the loading state. Nothing about images or fonts can see it,
   * so the probe also waits for the document to stop changing.
   */
  it("waits for a page that is still changing after `load` to stop", async () => {
    await withLoadingBarPage(1200, async (url) => {
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
      });
      try {
        const session = await page.context().newCDPSession(page);
        await page.goto(url, { waitUntil: "load" });

        // The premise: `load` has fired, the bar is up, and nothing the probe
        // already asked about is outstanding — no image on the page, parse
        // done. Without the bar on screen here, the assertion below would
        // pass whether or not the probe waited for anything.
        expect(
          await page.evaluate(() => ({
            bar: document.getElementById("bar") !== null,
            images: document.images.length,
            ready: document.readyState,
          })),
        ).toEqual({ bar: true, images: 0, ready: "complete" });

        const reply = (await session.send("Runtime.evaluate", {
          expression: settlePaintExpression(SETTLE_PAINT_TIMEOUT_MS),
          awaitPromise: true,
          returnByValue: true,
        })) as { result?: { value?: SettleReport } };

        expect(reply.result?.value).toMatchObject({
          settled: true,
          pending: 0,
          quiet: true,
        });
        // And the wait was real: the bar the probe waited out is gone.
        expect(
          await page.evaluate(() => document.getElementById("bar") !== null),
        ).toBe(false);
      } finally {
        await page.close();
      }
    });
  });

  // Bounded like the image wait, and the reply says which wait it lost, so
  // the engine's note can name "still changing" rather than an image count
  // of zero that reads as though nothing was wrong.
  it("reports a page that never stops changing as unsettled, and why", async () => {
    await withLoadingBarPage(Number.POSITIVE_INFINITY, async (url) => {
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
      });
      try {
        const session = await page.context().newCDPSession(page);
        await page.goto(url, { waitUntil: "load" });
        expect(
          await page.evaluate(() => document.getElementById("bar") !== null),
        ).toBe(true);

        const reply = (await session.send("Runtime.evaluate", {
          expression: settlePaintExpression(500, 700),
          awaitPromise: true,
          returnByValue: true,
        })) as { result?: { value?: SettleReport } };

        expect(reply.result?.value).toMatchObject({
          settled: false,
          pending: 0,
          ready: "complete",
          quiet: false,
        });
      } finally {
        await page.close();
      }
    });
  });
});
