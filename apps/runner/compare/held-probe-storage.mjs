// Probe: does context.storageState({indexedDB:true}) answer on a page whose
// clock is paused, and what lets it? Prints one line per way tried, with how
// often the page's own 1 s timer has fired by then.
// Run: node apps/runner/compare/held-probe-storage.mjs
import { createServer } from "node:http";
import { chromium } from "playwright";

const server = createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<link rel=icon href='data:,'><p>x</p><script>
    window.fired = 0; setInterval(() => window.fired++, 1000);
    const r = indexedDB.open("d", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("s");
    r.onsuccess = () => { r.result.transaction("s", "readwrite").objectStore("s").put("v", "k"); window.ready = true; };
  </script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  executablePath: chromium.executablePath(),
});
const page = await browser.newPage();
const s = await page.context().newCDPSession(page);
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction("window.ready");
const within = (ms, p, late) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(late), ms))]);
const read = async (name, before) => {
  await s.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
  await before?.();
  const t = Date.now();
  const got = await within(
    4000,
    page
      .context()
      .storageState({ indexedDB: true })
      .then(
        (st) =>
          `answered in ${Date.now() - t} ms, ${st.origins[0]?.indexedDB?.length ?? 0} database(s)`,
      ),
    "no answer in 4000 ms",
  );
  const fired = await within(2000, page.evaluate("window.fired"), "?");
  console.log(`${name}: ${got}; the page's 1 s timer has fired ${fired} times`);
};
await read("paused");
await read("advance, budget 1000 ms", () =>
  s.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 1000 }),
);
await read("advance, no budget", () =>
  s.send("Emulation.setVirtualTimePolicy", { policy: "advance" }),
);
await browser.close();
server.close();
