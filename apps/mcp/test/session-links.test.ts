import { afterEach, describe, expect, it } from "vitest";
import { createSessionLinks, type SessionLinks } from "../src/session-links";

const servers: Array<() => void> = [];
afterEach(() => {
  for (const close of servers.splice(0)) close();
});

const saved = {
  takeId: "take-1",
  path: "/Users/me/Downloads/Checkout demo.mp4",
  isFile: true,
};

function setup(over: Parameters<typeof createSessionLinks>[0] | object = {}) {
  const did: string[] = [];
  const logged: string[] = [];
  const links = createSessionLinks({
    platform: "darwin",
    studio: async ({ takeId }) => {
      did.push(`studio ${takeId}`);
      return { outcome: "opened", url: "http://x", takeId };
    },
    copy: async (path) => {
      did.push(`copy ${path}`);
    },
    log: (line) => logged.push(line),
    ...over,
  });
  servers.push(links.close);
  return { links, did, logged };
}

async function linksOf(
  links: ReturnType<typeof createSessionLinks>,
  s = saved,
): Promise<SessionLinks> {
  const got = await links.linksFor(s);
  if ("error" in got) throw new Error(got.error);
  return got;
}

const click = async (url: string | undefined) => {
  if (url === undefined) throw new Error("no such link");
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
};

describe("the links a saved export ends on", () => {
  // Red if a link does another action, or acts on another export's file.
  it("each link does its one action, on its own export", async () => {
    const { links, did } = setup();
    const a = await linksOf(links);
    const b = await linksOf(links, {
      takeId: "take-2",
      path: "/D/other.mp4",
      isFile: true,
    });
    // Premise: both exports got all three, the actions on loopback.
    for (const l of [a, b]) {
      expect(Object.keys(l).sort()).toEqual(["copy", "file", "studio"]);
      expect(l.copy).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/copy\/[\w-]{20,}$/);
    }
    expect((await click(a.studio)).text).toContain("Opened in the studio.");
    expect((await click(b.copy)).text).toContain("Copied other.mp4.");
    expect(did).toEqual(["studio take-1", "copy /D/other.mp4"]);
  });

  // Red if the file link goes through the server (a tab), or a space in
  // the name breaks it.
  it("links the file itself, with no server between", () =>
    setup()
      .links.linksFor(saved)
      .then((l) => {
        expect(l).toMatchObject({
          file: "file:///Users/me/Downloads/Checkout%20demo.mp4",
        });
      }));

  // Red if a done tab stays open, or a failed one closes before it is read.
  it("closes the tab when the action worked, and only then", async () => {
    const { links } = setup({
      copy: async () => {
        throw new Error("no clipboard");
      },
    });
    const l = await linksOf(links);
    const done = await click(l.studio);
    const failed = await click(l.copy);
    // Premise: one worked and one did not.
    expect([done.status, failed.status]).toEqual([200, 500]);
    expect(done.text).toContain("window.close()");
    expect(failed.text).not.toContain("window.close()");
  });

  // Red if an action link carries the path, or a made-up token is acted on.
  it("names no path, and acts on no token it did not hand out", async () => {
    const { links, did } = setup();
    const l = await linksOf(links);
    expect(JSON.stringify([l.studio, l.copy])).not.toContain("Downloads");
    const forged = (l.copy as string).replace(/[^/]+$/, "made-up-token");
    expect(await click(forged)).toMatchObject({
      status: 404,
      text: expect.stringContaining("not a link this Demoman session made"),
    });
    expect(did).toEqual([]);
  });

  // Red if a failed action reads as done, or its reason is lost.
  it("says why an action failed, on the page and in the log", async () => {
    const { links, logged } = setup({
      copy: async () => {
        throw new Error("The file does not exist.");
      },
      studio: async () => ({
        reason: "studioDidNotStart",
        detail: "the studio log says no",
      }),
    });
    const l = await linksOf(links);
    expect(await click(l.copy)).toEqual({
      status: 500,
      text: expect.stringContaining(
        "That did not work: The file does not exist.",
      ),
    });
    expect((await click(l.studio)).text).toContain(
      "That did not work: the studio log says no",
    );
    expect(logged).toEqual([
      "a copy link failed: The file does not exist.",
      "a studio link failed: the studio log says no",
    ]);
  });

  it("gives a stills folder no Copy, and no studio where there is none", async () => {
    const { links } = setup({ studio: undefined });
    const l = await linksOf(links, { ...saved, isFile: false });
    expect(Object.keys(l)).toEqual(["file"]);
  });

  it("gives no Copy off macOS", async () => {
    const { links } = setup({ platform: "linux" });
    expect(Object.keys(await linksOf(links)).sort()).toEqual([
      "file",
      "studio",
    ]);
  });

  // Red if a page's text can write markup into the tab.
  it("escapes what the page says", async () => {
    const { links } = setup({
      copy: async () => {
        throw new Error("<script>alert(1)</script>");
      },
    });
    const { text } = await click((await linksOf(links)).copy);
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});
