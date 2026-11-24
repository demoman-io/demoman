import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  type DeviceId,
} from "@demoman/scene-schema";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { runAuthored } from "../../src/index.js";
import {
  selectorPageAgent,
  withReplayBrowser,
} from "../helpers/cdp-playwright";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import { createMemoryFrameStore } from "../helpers/frame-store";

/**
 * DEM-154/155: right, double, triple and held clicks and key combos, against
 * real Chromium, asserting what the PAGE received (`inputs-app.html` logs
 * every key and mouse event). The fixture is the runner's; Tasks 4, 6 and 7
 * read the same page by the same names.
 */
const INPUTS_URL = pathToFileURL(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "apps",
    "runner",
    "test",
    "fixtures",
    "inputs-app.html",
  ),
).href;

const clock = () => ({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
});

type Result = Awaited<ReturnType<typeof runAuthored>>;
type Step = DemoScript["steps"][number];

const logOf = async (page: Page): Promise<string[]> =>
  ((await page.locator("#log").textContent()) ?? "")
    .split("\n")
    .filter((l) => l !== "");

/** What the run and the page say, for a failure message. */
const evidence = async (result: Result, page: Page): Promise<string> =>
  JSON.stringify({
    reason: result.reason,
    log: await logOf(page),
    focus: await page.evaluate(
      () => document.activeElement?.id || document.activeElement?.className,
    ),
    field: await page.inputValue("#field"),
  });

/** Runs `steps` against the fixture page and hands the result over. */
async function runInputs(
  steps: Step[],
  then: (
    result: Result,
    page: Page,
    said: () => Promise<string>,
  ) => Promise<void>,
  device?: DeviceId,
  /** Run on the page before the script: fields only this case needs. */
  setup?: (page: Page) => Promise<void>,
): Promise<void> {
  await withReplayBrowser(
    async ({ cdp, page }) => {
      // The premise every case shares: the log starts empty and the page
      // names its platform.
      expect(await logOf(page)).toEqual([]);
      expect(await page.textContent("#platform")).toMatch(/\|/);
      await setup?.(page);
      // What the field's own `input` events say, for the typing premise.
      await page.evaluate(() => {
        (window as unknown as { inputs: string[] }).inputs = [];
        document
          .getElementById("field")
          ?.addEventListener("input", (e) =>
            (window as unknown as { inputs: string[] }).inputs.push(
              (e as InputEvent).data ?? "",
            ),
          );
      });
      const selectors: Record<string, string> = {};
      const script: DemoScript = {
        scriptVersion: 10,
        name: "inputs",
        target: INPUTS_URL,
        steps,
        ...(device === undefined ? {} : { device }),
      };
      const store = createMemoryFrameStore();
      let n = 0;
      const result = await runAuthored(script, {
        cdp,
        page: selectorPageAgent(page, selectors),
        encoder: createNodeFrameEncoder(store, "inputs"),
        store,
        clock: clock(),
        mayReplay: true,
        captureResolved: async (intent) => {
          const css = `#${intent.fingerprint.stableId ?? ""}`;
          selectors[intent.id] = css;
          const box = await page.locator(css).boundingBox();
          if (box === null)
            return {
              anchor: null,
              failureReason: "unresolved",
              intentResolution: null,
              pageUrl: INPUTS_URL,
            };
          return {
            anchor: {
              id: intent.id,
              fingerprint: { ...intent.fingerprint, boundingRect: box },
              resolution: {
                url: INPUTS_URL,
                actionIndex: 0,
                entryState: false,
                strategy: "stableId",
                failureReason: null,
                candidates: 1,
              },
            },
            failureReason: null,
            intentResolution: {
              strategy: "stableId",
              candidates: 1,
              failureReason: null,
            },
            pageUrl: INPUTS_URL,
          };
        },
        newId: (prefix) => `${prefix}-${++n}`,
        sceneId: "inputs",
        createdAt: "2026-11-23T00:00:00.000Z",
        viewport: { width: 1024, height: 640 },
        startingBranding: BRANDING_DEFAULTS,
        cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
      });
      await then(result, page, () => evidence(result, page));
    },
    { url: INPUTS_URL, readySelector: "#items" },
  );
}

const on = (stableId: string) => ({ stableId });
const mouse = (lines: string[]) =>
  lines.filter((l) => /^mouse|^click|^dbl|^context/.test(l));

describe("clicks and keys, against a real page", () => {
  it("a double-click presses twice with detail 1 then 2, fires one dblclick, and renames the row", async () => {
    await runInputs(
      [{ do: "waitForLoad" }, { do: "click", on: on("row2"), clicks: 2 }],
      async (result, page, said) => {
        const lines = await logOf(page);
        expect(result.reason, await said()).toBeNull();
        const downs = lines.filter((l) => l.startsWith("mousedown"));
        expect(downs, await said()).toEqual([
          "mousedown button 0 detail 1",
          "mousedown button 0 detail 2",
        ]);
        expect(
          lines.filter((l) => l.startsWith("dblclick")),
          await said(),
        ).toHaveLength(1);
        expect(
          await page.locator("#row2 input.rename").count(),
          await said(),
        ).toBe(1);
      },
    );
  });

  it("a triple-click adds a press with detail 3", async () => {
    await runInputs(
      [{ do: "waitForLoad" }, { do: "click", on: on("row2"), clicks: 3 }],
      async (result, page, said) => {
        expect(result.reason, await said()).toBeNull();
        const downs = (await logOf(page)).filter((l) =>
          l.startsWith("mousedown"),
        );
        expect(
          downs.map((l) => l.split(" ").slice(-1)[0]),
          await said(),
        ).toEqual(["1", "2", "3"]);
      },
    );
  });

  it("a right-click presses button 2, opens the page's own menu, and fires no click", async () => {
    await runInputs(
      [{ do: "waitForLoad" }, { do: "click", on: on("row2"), button: "right" }],
      async (result, page, said) => {
        const lines = await logOf(page);
        expect(result.reason, await said()).toBeNull();
        expect(
          lines.filter((l) => l.startsWith("mousedown")),
          await said(),
        ).toEqual(["mousedown button 2 detail 1"]);
        expect(
          lines.filter((l) => l.startsWith("contextmenu")),
          await said(),
        ).toHaveLength(1);
        expect(
          lines.filter((l) => l.startsWith("click")),
          await said(),
        ).toEqual([]);
        expect(await page.isVisible("#menu"), await said()).toBe(true);
      },
    );
  });

  it("a right-click on an element with no menu of its own leaves Chrome's menu shut", async () => {
    await runInputs(
      [
        { do: "waitForLoad" },
        { do: "click", on: on("plain"), button: "right" },
      ],
      async (result, page, said) => {
        expect(result.reason, await said()).toBeNull();
        // The line is logged once the event is done, after every listener.
        await page.waitForFunction(() =>
          document.getElementById("log")?.textContent?.includes("settled"),
        );
        const lines = await logOf(page);
        // Premise: the page's own contextmenu arrived, and it has no handler
        // that prevents it (the line comes from the fixture's logger only).
        expect(
          lines.filter((l) => l.startsWith("contextmenu button 2")),
          await said(),
        ).toHaveLength(1);
        expect(
          lines.filter((l) => l.startsWith("contextmenu settled")),
          await said(),
        ).toEqual(["contextmenu settled defaultPrevented true"]);
      },
    );
  });

  it("a type over a pre-filled field replaces its text, with no modifier key", async () => {
    await runInputs(
      [{ do: "waitForLoad" }, { do: "type", into: on("field"), text: "Acme" }],
      async (result, page, said) => {
        expect(result.reason, await said()).toBeNull();
        // Premise: the field started with text to replace.
        expect(await page.getAttribute("#field", "value"), await said()).toBe(
          "Northwind",
        );
        expect(await page.inputValue("#field"), await said()).toBe("Acme");
        expect(result.steps[1]?.fieldNotCleared, await said()).toBeUndefined();
        // No keydown an app's ⌘A or Ctrl+A handler could catch.
        expect(
          (await logOf(page)).filter((l) => / (meta|ctrl)/.test(l)),
          await said(),
        ).toEqual([]);
      },
    );
  });

  it("a type into a field inside a shadow root replaces its text", async () => {
    await runInputs(
      [
        { do: "waitForLoad" },
        { do: "type", into: on("shadowed"), text: "Acme" },
      ],
      async (result, page, said) => {
        const inner = await page.evaluate(() => {
          const input = document
            .getElementById("shadowed")
            ?.shadowRoot?.querySelector("input");
          return input
            ? { value: input.value, prefilled: input.defaultValue }
            : null;
        });
        const why = `${await said()} shadow field: ${JSON.stringify(inner)}`;
        expect(result.reason, why).toBeNull();
        // Premise: the inner field was pre-filled.
        expect(inner?.prefilled, why).toBe("Northwind");
        expect(inner?.value, why).toBe("Acme");
      },
    );
  });

  // No selection offsets on these: coverage is the document's selection.
  // Added on the page here: only these two cases need them.
  it.each([
    ["email", "sales@northwind.test", "ops@acme.test"],
    ["number", "4800", "125"],
  ])(
    "a type over a pre-filled %s field replaces it, with no note",
    async (id, prefilled, typed) => {
      const addField = (page: Page) =>
        page.evaluate(
          ([id, value]) => {
            const f = document.createElement("input");
            f.id = id as string;
            f.type = id as string;
            f.setAttribute("value", value as string);
            f.autocomplete = "off";
            f.style.cssText =
              "position:absolute;left:280px;top:220px;width:200px;height:28px;box-sizing:border-box";
            document.body.append(f);
          },
          [id, prefilled],
        );
      await runInputs(
        [{ do: "waitForLoad" }, { do: "type", into: on(id), text: typed }],
        async (result, page, said) => {
          const field = await page.evaluate((id) => {
            const f = document.getElementById(id) as HTMLInputElement;
            return {
              value: f.value,
              prefilled: f.defaultValue,
              offsets: f.selectionStart,
            };
          }, id);
          const why = `${await said()} ${id}: ${JSON.stringify(field)}; step: ${JSON.stringify(result.steps[1])}`;
          expect(result.reason, why).toBeNull();
          // Premise: pre-filled, and with no offsets to read.
          expect(field.prefilled, why).toBe(prefilled);
          expect(field.offsets, why).toBeNull();
          expect(field.value, why).toBe(typed);
          expect(result.steps[1]?.fieldNotCleared, why).toBeUndefined();
        },
        undefined,
        addField,
      );
    },
  );

  it("a type into a field that will not select says it could not clear it", async () => {
    await runInputs(
      [
        { do: "waitForLoad" },
        { do: "type", into: on("stubborn"), text: "Acme" },
      ],
      async (result, page, said) => {
        const why = `${await said()} stubborn: ${await page.inputValue("#stubborn")}; step: ${JSON.stringify(result.steps[1])}`;
        expect(result.reason, why).toBeNull();
        // Premise: the select did nothing, so the text went in beside.
        expect(await page.inputValue("#stubborn"), why).not.toBe("Acme");
        expect(result.steps[1]?.fieldNotCleared, why).toEqual({
          before: "Northwind",
        });
      },
    );
  });

  it("a Shift-click holds Shift around the press and selects the range", async () => {
    await runInputs(
      [
        { do: "waitForLoad" },
        { do: "click", on: on("row1") },
        { do: "click", on: on("row3"), holding: "Shift" },
      ],
      async (result, page, said) => {
        expect(result.reason, await said()).toBeNull();
        const lines = await logOf(page);
        // Premise: the plain click on row 1 selected row 1 alone.
        expect(lines[0], await said()).toBe("mousedown button 0 detail 1");
        const key = lines.indexOf("keydown Shift shift");
        const down = lines.indexOf("mousedown button 0 detail 1 shift");
        const up = lines.indexOf("mouseup button 0 detail 1 shift");
        const lifted = lines.indexOf("keyup Shift");
        expect(key, await said()).toBeGreaterThan(-1);
        expect(key, await said()).toBeLessThan(down);
        expect(down, await said()).toBeLessThan(up);
        expect(up, await said()).toBeLessThan(lifted);
        const selected = await page.evaluate(() =>
          [...document.querySelectorAll("#items > div")].map((r) =>
            r.classList.contains("selected"),
          ),
        );
        expect(selected, await said()).toEqual([
          true,
          true,
          true,
          false,
          false,
        ]);
      },
    );
  });

  it("holding Mod+Shift puts both on the click line", async () => {
    await runInputs(
      [
        { do: "waitForLoad" },
        { do: "click", on: on("row2"), holding: "Mod+Shift" },
      ],
      async (result, page, said) => {
        expect(result.reason, await said()).toBeNull();
        expect(await logOf(page), await said()).toContain(
          "click button 0 detail 1 meta shift",
        );
      },
    );
  });

  it("Mod+K opens the palette, and the page sees k with meta", async () => {
    await runInputs(
      [{ do: "waitForLoad" }, { do: "press", key: "Mod+K" }],
      async (result, page, said) => {
        expect(result.reason, await said()).toBeNull();
        expect(await page.isVisible("#palette"), await said()).toBe(true);
        expect(await logOf(page), await said()).toContain("keydown k meta");
      },
    );
    // Premise, on a fresh page: the palette is closed until the key.
    await withReplayBrowser(
      async ({ page }) => {
        expect(await page.isHidden("#palette")).toBe(true);
        const mac = /Mac/.test(await page.evaluate(() => navigator.platform));
        expect(await page.textContent("#hint")).toBe(mac ? "⌘K" : "Ctrl K");
      },
      { url: INPUTS_URL, readySelector: "#items" },
    );
  });

  it("Mod+A selects the whole field and Mod+Z undoes what was typed over it", async () => {
    await runInputs(
      [
        { do: "waitForLoad" },
        { do: "click", on: on("field") },
        { do: "press", key: "Mod+A" },
      ],
      async (result, page, said) => {
        expect(result.reason, await said()).toBeNull();
        const sel = await page.evaluate(() => {
          const f = document.getElementById("field") as HTMLInputElement;
          return [f.value, f.selectionStart, f.selectionEnd];
        });
        expect(sel, await said()).toEqual(["Northwind", 0, 9]);
      },
    );
    await runInputs(
      [
        { do: "waitForLoad" },
        { do: "type", into: on("field"), text: "x" },
        { do: "press", key: "Mod+Z" },
      ],
      async (result, page, said) => {
        expect(result.reason, await said()).toBeNull();
        // Premise: "x" really was typed over the text, so the undo has
        // something to undo: the field saw an input event carrying "x".
        expect(
          await page.evaluate(
            () => (window as unknown as { inputs: string[] }).inputs,
          ),
          await said(),
        ).toContain("x");
        expect(await page.inputValue("#field"), await said()).toBe("Northwind");
      },
    );
  });

  it("Ctrl+A in the field leaves the caret at 0, the Mac meaning, not select-all", async () => {
    await runInputs(
      [
        { do: "waitForLoad" },
        { do: "click", on: on("field") },
        { do: "press", key: "End" },
        { do: "press", key: "Ctrl+A" },
      ],
      async (result, page, said) => {
        expect(result.reason, await said()).toBeNull();
        // Premise: the caret was at the end before Ctrl+A.
        expect(await logOf(page), await said()).toContain("keydown End");
        const sel = await page.evaluate(() => {
          const f = document.getElementById("field") as HTMLInputElement;
          return [f.selectionStart, f.selectionEnd];
        });
        expect(sel, await said()).toEqual([0, 0]);
      },
    );
  });

  it.each([
    ["clicks", { clicks: 2 }],
    ["button", { button: "right" }],
    ["holding", { holding: "Shift" }],
  ] as const)(
    "a touch take carrying %s stops with unperformableStep and taps nothing",
    async (_name, extra) => {
      // Straight to the engine, without the script parse, as a caller that
      // skipped it would.
      const loose = {
        do: "click",
        on: on("row2"),
        ...extra,
      } as unknown as Step;
      await runInputs(
        [{ do: "waitForLoad" }, loose],
        async (result, page, said) => {
          expect(result.reason, await said()).toBe("unperformableStep");
          expect(mouse(await logOf(page)), await said()).toEqual([]);
        },
        "phone",
      );
    },
  );
});
