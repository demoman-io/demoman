// Where an export frame's time goes, in the browser exports render in.
//   node apps/runner/compare/render-cost-probe.mjs [--headed] [--width 1920 --height 1500]
// Run from a repo with `pnpm install` done. Launches Playwright's full
// Chromium as the CLI's executor does (headless unless --headed), prints
// chrome://gpu's feature lines, then times 120 frames of each stage at the
// export size: a 3840x2400 frame drawn scaled, the same with the frame
// chrome's two shadow passes (presentation.ts's drawFrameChrome at scale
// 1.9), and WebCodecs H.264 encode of the canvas alone. Each batch ends on a
// 1x1 getImageData, so queued GPU work is charged to the batch that queued it.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    headed: { type: "boolean" },
    // The executor's headless launch stands in for a display (launch.ts's
    // displayArgs); this passes the same flags for a 1512x982 @2x screen.
    "as-executor": { type: "boolean" },
    width: { type: "string" },
    height: { type: "string" },
  },
});
const require = createRequire(join(process.cwd(), "apps", "runner", "x.js"));
const { chromium } = require("playwright");
const width = Number(values.width ?? 1920);
const height = Number(values.height ?? 1500);

const browser = await chromium.launch({
  headless: !values.headed,
  executablePath: chromium.executablePath(),
  ...(values["as-executor"]
    ? {
        args: [
          "--screen-info={3024x1964 devicePixelRatio=2}",
          "--window-size=1512,982",
        ],
      }
    : {}),
});
try {
  const page = await (values["as-executor"]
    ? await browser.newContext({ viewport: null })
    : await browser.newContext()
  ).newPage();
  await page.goto("chrome://gpu");
  await page.waitForTimeout(1500);
  // The feature table lives in chrome://gpu's shadow DOM; innerText of the
  // host page is empty, so walk every shadow root for its text.
  const gpu = await page.evaluate(() => {
    const texts = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          texts.push(el.shadowRoot.textContent ?? "");
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    const text = texts.join("\n");
    const want =
      /(Canvas|Compositing|Rasterization|Video Encode|Video Decode|WebGL|Skia Backend|GL_RENDERER)[^\n]{0,80}/g;
    return [...new Set(text.match(want) ?? [])].slice(0, 20);
  });
  console.info(
    `[probe] ${values.headed ? "headed" : "headless"} chrome://gpu:`,
  );
  for (const l of gpu) console.info(`[probe]   ${l.trim()}`);

  // WebCodecs needs a secure context: a loopback page, as exports render on.
  const server = createServer((_, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html>"),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  server.unref();
  const result = await page.evaluate(
    async ([w, h]) => {
      const N = 120;
      const src = new OffscreenCanvas(3840, 2400);
      const s = src.getContext("2d");
      const grad = s.createLinearGradient(0, 0, 3840, 2400);
      grad.addColorStop(0, "#3b82f6");
      grad.addColorStop(1, "#f97316");
      s.fillStyle = grad;
      s.fillRect(0, 0, 3840, 2400);
      for (let i = 0; i < 400; i++) {
        s.fillStyle = `hsl(${i * 7},70%,50%)`;
        s.fillRect((i * 97) % 3800, (i * 61) % 2380, 40, 20);
      }
      const gpuBitmap = await createImageBitmap(src);
      // A keyframe as exports load one: a JPEG blob through createImageBitmap
      // (render-entry.ts's `load`).
      const jpegBitmap = await createImageBitmap(
        await src.convertToBlob({ type: "image/jpeg", quality: 0.9 }),
      );
      let bitmap = gpuBitmap;
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      const flush = () => ctx.getImageData(0, 0, 1, 1);
      let frame = { x: w * 0.12, y: h * 0.12, w: w * 0.76, h: h * 0.76 };
      // drawFrameChrome multiplies the shadow by the camera's zoom.
      let zoom = 1;
      const rounded = () => {
        ctx.beginPath();
        ctx.roundRect(frame.x, frame.y, frame.w, frame.h, 24);
      };
      const draw = (shadows) => {
        ctx.fillStyle = "#e2e8f0";
        ctx.fillRect(0, 0, w, h);
        if (shadows) {
          const scale = 1.9 * zoom;
          for (const pass of [
            { blur: 60 * scale, offset: 30 * scale, alpha: 0.18 },
            { blur: 12 * scale, offset: 4 * scale, alpha: 0.12 },
          ]) {
            ctx.save();
            ctx.shadowColor = `rgba(15, 23, 42, ${pass.alpha})`;
            ctx.shadowBlur = pass.blur;
            ctx.shadowOffsetY = pass.offset;
            ctx.fillStyle = "#000";
            rounded();
            ctx.fill();
            ctx.restore();
          }
        }
        ctx.save();
        rounded();
        ctx.clip();
        ctx.drawImage(bitmap, frame.x, frame.y, frame.w, frame.h);
        ctx.restore();
      };
      // One readback per batch, not per frame: Chrome moves a 2D canvas that
      // is read back often off the GPU, which would measure the wrong canvas.
      const time = (fn) => {
        const t = performance.now();
        for (let i = 0; i < N; i++) fn();
        flush();
        return (performance.now() - t) / N;
      };
      const plainMs = time(() => draw(false));
      const shadowMs = time(() => draw(true));

      // camera-blur.ts's paintCameraBlur: copy the frame, then six scaled,
      // translucent passes of it.
      const scratch = new OffscreenCanvas(w, h);
      const sctx = scratch.getContext("2d");
      const blur = (passes = 6) => {
        sctx.globalCompositeOperation = "copy";
        sctx.drawImage(canvas, 0, 0);
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "medium";
        for (let i = 0; i < passes; i++) {
          const k = 1 + i * 0.01;
          ctx.setTransform(k, 0, 0, k, -i * 4, -i * 3);
          ctx.globalAlpha = 1 / (i + 2);
          ctx.drawImage(scratch, 0, 0);
        }
        ctx.restore();
      };
      const frames = {};

      // The export's own loop: a fresh draw every frame, handed to a live
      // encoder before the next draw starts.
      const loop = async (hardwareAcceleration, frameFn) => {
        const encoder = new VideoEncoder({ output: () => {}, error: () => {} });
        encoder.configure({
          codec: "avc1.640033",
          width: w,
          height: h,
          bitrate: 8_000_000,
          framerate: 60,
          hardwareAcceleration,
        });
        const t = performance.now();
        for (let i = 0; i < N; i++) {
          frameFn();
          const vf = new VideoFrame(canvas, { timestamp: (i * 1e6) / 60 });
          encoder.encode(vf, { keyFrame: i % 120 === 0 });
          vf.close();
          if (encoder.encodeQueueSize > 4) {
            await new Promise((r) =>
              encoder.addEventListener("dequeue", r, { once: true }),
            );
          }
        }
        await encoder.flush();
        encoder.close();
        return (performance.now() - t) / N;
      };
      for (const [name, source] of [
        ["gpu source", gpuBitmap],
        ["jpeg source", jpegBitmap],
      ]) {
        bitmap = source;
        for (const accel of ["no-preference", "prefer-software"]) {
          frames[`loop, ${name}, ${accel}`] = await loop(accel, () =>
            draw(true),
          );
          frames[`loop, ${name}, ${accel}, blur`] = await loop(accel, () => {
            draw(true);
            blur();
          });
        }
      }
      // Shapes an export reaches mid-zoom, on a keyframe-like source.
      bitmap = jpegBitmap;
      const accel = "no-preference";
      frames["loop, jpeg, no shadows"] = await loop(accel, () => draw(false));
      frames["loop, jpeg, shadows"] = await loop(accel, () => draw(true));
      frames["loop, jpeg, 24 blur passes"] = await loop(accel, () => {
        draw(true);
        blur(24);
      });
      zoom = 2;
      frame = { x: -w * 0.3, y: -h * 0.3, w: w * 1.6, h: h * 1.6 };
      frames["loop, jpeg, shadows at 2x zoom"] = await loop(accel, () =>
        draw(true),
      );
      frames["loop, jpeg, shadows at 2x zoom + 24 blur passes"] = await loop(
        accel,
        () => {
          draw(true);
          blur(24);
        },
      );
      zoom = 1;
      frame = { x: w * 0.12, y: h * 0.12, w: w * 0.76, h: h * 0.76 };
      // compose.ts's order: background and chrome under the camera's
      // transform (shadow scaled by its zoom), the frame at "high" quality.
      const composeLike = (z) => {
        const cx = frame.x + frame.w / 2;
        const cy = frame.y + frame.h / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(z, z);
        ctx.translate(-cx, -cy);
        ctx.fillStyle = "#e2e8f0";
        ctx.fillRect(-w, -h, 3 * w, 3 * h);
        const scale = (frame.h / 800) * z;
        for (const pass of [
          { blur: 60 * scale, offset: 30 * scale, alpha: 0.18 },
          { blur: 12 * scale, offset: 4 * scale, alpha: 0.12 },
        ]) {
          ctx.save();
          ctx.shadowColor = `rgba(15, 23, 42, ${pass.alpha})`;
          ctx.shadowBlur = pass.blur;
          ctx.shadowOffsetY = pass.offset;
          ctx.fillStyle = "#000";
          rounded();
          ctx.fill();
          ctx.restore();
        }
        rounded();
        ctx.clip();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(
          bitmap,
          cx - (frame.w * z) / 2,
          cy - (frame.h * z) / 2,
          frame.w * z,
          frame.h * z,
        );
        ctx.restore();
      };
      for (const z of [1, 2]) {
        frames[`loop, compose-like at ${z}x`] = await loop(accel, () =>
          composeLike(z),
        );
        frames[`loop, compose-like at ${z}x + 24 blur passes`] = await loop(
          accel,
          () => {
            composeLike(z);
            blur(24);
          },
        );
      }
      bitmap = gpuBitmap;

      const encodeWith = async (hardwareAcceleration) => {
        const config = {
          codec: "avc1.640033",
          width: w,
          height: h,
          bitrate: 8_000_000,
          framerate: 60,
          hardwareAcceleration,
        };
        const support = await VideoEncoder.isConfigSupported(config);
        if (!support.supported) return { supported: false };
        let error = null;
        const encoder = new VideoEncoder({
          output: () => {},
          error: (e) => {
            error = String(e);
          },
        });
        encoder.configure(config);
        draw(true);
        const t = performance.now();
        for (let i = 0; i < N; i++) {
          const vf = new VideoFrame(canvas, { timestamp: (i * 1e6) / 60 });
          encoder.encode(vf, { keyFrame: i % 120 === 0 });
          vf.close();
          if (encoder.encodeQueueSize > 4) {
            await new Promise((r) =>
              encoder.addEventListener("dequeue", r, { once: true }),
            );
          }
        }
        await encoder.flush();
        encoder.close();
        return { supported: true, ms: (performance.now() - t) / N, error };
      };
      return {
        plainMs,
        shadowMs,
        frames,
        encodeHw: await encodeWith("prefer-hardware"),
        encodeSw: await encodeWith("prefer-software"),
        encodeAny: await encodeWith("no-preference"),
      };
    },
    [width, height],
  );
  const ms = (v) => `${v.toFixed(2)} ms`;
  const enc = (e) =>
    e.supported
      ? `${ms(e.ms)}${e.error ? ` (error: ${e.error})` : ""}`
      : "unsupported";
  console.info(`[probe] ${width}x${height}, per frame, 120 frames each:`);
  console.info(`[probe]   draw, no shadows:      ${ms(result.plainMs)}`);
  console.info(`[probe]   draw, with shadows:    ${ms(result.shadowMs)}`);
  console.info(
    "[probe] the export's loop: draw, new VideoFrame(canvas), encode, per frame:",
  );
  for (const [name, v] of Object.entries(result.frames)) {
    console.info(`[probe]   ${name.padEnd(44)} ${ms(v)}`);
  }
  console.info(`[probe]   encode prefer-hardware: ${enc(result.encodeHw)}`);
  console.info(`[probe]   encode prefer-software: ${enc(result.encodeSw)}`);
  console.info(`[probe]   encode no-preference:   ${enc(result.encodeAny)}`);
} finally {
  await browser.close();
}
