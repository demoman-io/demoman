import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionStore,
  filesFor,
  mergeStates,
  SessionError,
  type SessionFile,
  samePage,
  siteOf,
  sliceForSite,
  writeBackOf,
} from "../src/executor/sessions.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-sessions-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const cookie = (name: string, domain: string) => ({
  name,
  value: "v",
  domain,
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: "Lax" as const,
});
const fileFor = (
  site: string,
  over: Partial<SessionFile> = {},
): SessionFile => ({
  sessionVersion: 1,
  site,
  savedAt: "2026-10-15T10:00:00.000Z",
  refreshedAt: null,
  startUrl: `https://${site}/app`,
  signInUrl: `https://${site}/users/log-in`,
  state: { cookies: [cookie("s", site)], origins: [] },
  ...over,
});

describe("siteOf", () => {
  it("is the registrable domain", () => {
    expect(siteOf("https://app.kitchenlink.com/x")).toBe("kitchenlink.com");
    expect(siteOf("https://a.b.example.co.uk/")).toBe("example.co.uk");
  });
  it("is one site, localhost, for every loopback host and port", () => {
    expect(siteOf("http://localhost:4000/")).toBe("localhost");
    expect(siteOf("http://localhost:5173/")).toBe("localhost");
    expect(siteOf("http://127.0.0.1:8080/")).toBe("localhost");
    expect(siteOf("http://[::1]:3000/")).toBe("localhost");
    expect(siteOf("http://app.localhost/")).toBe("localhost");
  });
  it("is the host itself for an address with no registrable domain", () => {
    expect(siteOf("http://10.0.0.5:3000/")).toBe("10.0.0.5");
  });
  it("is null for what is not a URL", () => {
    expect(siteOf("not a url")).toBeNull();
  });
});

describe("samePage", () => {
  it("compares origin and path, ignoring the query, the hash and a trailing slash", () => {
    expect(
      samePage(
        "https://app.kitchenlink.com/users/log-in?return_to=%2Fapp",
        "https://app.kitchenlink.com/users/log-in/",
      ),
    ).toBe(true);
  });
  it("tells two ports apart", () => {
    expect(
      samePage("http://localhost:4000/login", "http://localhost:5173/login"),
    ).toBe(false);
  });
  it("tells two paths apart", () => {
    expect(samePage("https://x.com/login", "https://x.com/app")).toBe(false);
  });
});

describe("the store", () => {
  it("reads nothing, with an empty stamp, when no session was ever saved", async () => {
    const read = await createSessionStore(home).read();
    expect(read).toEqual({ files: [], stamp: "" });
  });

  it("saves at 0600 in a 0700 folder and reads it back", async () => {
    const store = createSessionStore(home);
    const path = await store.save(fileFor("kitchenlink.com"));
    expect(path).toBe(join(home, "sessions", "kitchenlink.com.json"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
    const read = await store.read();
    expect(read.files.map((f) => f.site)).toEqual(["kitchenlink.com"]);
    expect(read.stamp).not.toBe("");
  });

  it("leaves no temp file behind after a save", async () => {
    const store = createSessionStore(home);
    await store.save(fileFor("kitchenlink.com"));
    expect(await readdir(store.dir)).toEqual(["kitchenlink.com.json"]);
  });

  it("changes its stamp when a file changes", async () => {
    const store = createSessionStore(home);
    await store.save(fileFor("kitchenlink.com"));
    const before = (await store.read()).stamp;
    await store.save(
      fileFor("kitchenlink.com", {
        savedAt: "2026-10-16T10:00:00.000Z",
        startUrl: "https://kitchenlink.com/a-longer-start-url",
      }),
    );
    expect((await store.read()).stamp).not.toBe(before);
  });

  it("refuses a file other users can read, naming the chmod", async () => {
    const store = createSessionStore(home);
    const path = await store.save(fileFor("kitchenlink.com"));
    await chmod(path, 0o644);
    await expect(store.read()).rejects.toThrow(SessionError);
    await expect(store.read()).rejects.toThrow(`chmod 600 ${path}`);
  });

  it("refuses a folder other users can enter, naming the chmod", async () => {
    const store = createSessionStore(home);
    await store.save(fileFor("kitchenlink.com"));
    await chmod(store.dir, 0o755);
    await expect(store.read()).rejects.toThrow(`chmod 700 ${store.dir}`);
  });

  it("refuses a file that is not a session, naming it", async () => {
    const dir = join(home, "sessions");
    await mkdir(dir, { mode: 0o700 });
    const path = join(dir, "broken.json");
    await writeFile(path, "{not json", { mode: 0o600 });
    await expect(createSessionStore(home).read()).rejects.toThrow(path);
  });
});

describe("states", () => {
  it("merges every site's cookies and origins", () => {
    const merged = mergeStates([
      fileFor("kitchenlink.com"),
      fileFor("google.com", {
        state: {
          cookies: [cookie("g", ".accounts.google.com")],
          origins: [
            { origin: "https://accounts.google.com", localStorage: [] },
          ],
        },
      }),
    ]);
    expect(merged.cookies.map((c) => c.name)).toEqual(["s", "g"]);
    expect(merged.origins.map((o) => o.origin)).toEqual([
      "https://accounts.google.com",
    ]);
  });

  it("slices a state to one site's cookies and origins", () => {
    const sliced = sliceForSite(
      {
        cookies: [
          cookie("k", "app.kitchenlink.com"),
          cookie("g", ".google.com"),
        ],
        origins: [
          { origin: "https://app.kitchenlink.com", localStorage: [] },
          { origin: "https://www.google.com", localStorage: [] },
        ],
      },
      "kitchenlink.com",
    );
    expect(sliced.cookies.map((c) => c.name)).toEqual(["k"]);
    expect(sliced.origins.map((o) => o.origin)).toEqual([
      "https://app.kitchenlink.com",
    ]);
  });

  it("writes back the site's cookies, and storage only for the origins the saved session holds", () => {
    const signedIn = {
      origin: "http://localhost:4000",
      localStorage: [{ name: "t", value: "2" }],
    };
    const otherApp = { origin: "http://localhost:3001", localStorage: [] };
    const state = {
      cookies: [cookie("sid", "localhost")],
      origins: [signedIn, otherApp],
    };
    // Premise: both origins are the session's site, so slicing alone keeps both.
    expect(sliceForSite(state, "localhost").origins).toHaveLength(2);
    const back = writeBackOf(state, {
      sessionVersion: 1,
      site: "localhost",
      savedAt: "2026-10-15T09:00:00.000Z",
      refreshedAt: null,
      startUrl: "http://localhost:4000/",
      signInUrl: null,
      state: {
        cookies: [],
        origins: [{ origin: "http://localhost:4000", localStorage: [] }],
      },
    });
    expect(back.cookies.map((c) => c.name)).toEqual(["sid"]);
    expect(back.origins).toEqual([signedIn]);
  });
});

describe("account sessions (launch C2)", () => {
  const acct = (origin: string, name: string, cookie: string): SessionFile => ({
    sessionVersion: 1,
    site: "localhost",
    savedAt: "2026-10-15T09:00:00.000Z",
    refreshedAt: null,
    startUrl: `${origin}/admin/dashboard`,
    signInUrl: `${origin}/users/log-in`,
    account: { origin, name },
    state: {
      cookies: [
        {
          name: "sid",
          value: cookie,
          domain: "localhost",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
  });

  it("saves under the origin's folder at 0700 and 0600, and reads it back", async () => {
    const store = createSessionStore(home);
    const path = await store.save(
      acct("http://localhost:4000", "seller", "s1"),
    );
    expect(path).toBe(
      join(home, "sessions", "http_3a_2f_2flocalhost_3a4000", "seller.json"),
    );
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const { files } = await store.read();
    expect(files.map((f) => f.account?.name)).toEqual(["seller"]);
  });

  it("keeps two origins that differ only in punctuation apart (review 2026-10-16)", async () => {
    const store = createSessionStore(home);
    const a = await store.save(acct("https://my-app.test", "seller", "s1"));
    const b = await store.save(acct("https://my.app.test", "seller", "s2"));
    expect(a).not.toBe(b);
    const { files } = await store.read();
    expect(files.map((f) => f.account?.origin).sort()).toEqual([
      "https://my-app.test",
      "https://my.app.test",
    ]);
  });

  it("refuses an origin folder open to others, naming the chmod", async () => {
    const store = createSessionStore(home);
    const path = await store.save(
      acct("http://localhost:4000", "seller", "s1"),
    );
    await chmod(dirname(path), 0o755);
    await expect(store.read()).rejects.toThrow(/chmod 700/);
  });

  it("refuses an account file open to others, naming the chmod", async () => {
    const store = createSessionStore(home);
    const path = await store.save(
      acct("http://localhost:4000", "seller", "s1"),
    );
    await chmod(path, 0o644);
    await expect(store.read()).rejects.toThrow(/chmod 600/);
  });

  it("refuses an account file that does not belong in its folder", async () => {
    const store = createSessionStore(home);
    const path = await store.save(
      acct("http://localhost:4000", "seller", "s1"),
    );
    const moved = join(dirname(path), "customer.json");
    await rename(path, moved);
    await expect(store.read()).rejects.toThrow(/does not belong in/);
  });

  it("keeps two accounts of one origin apart", async () => {
    const store = createSessionStore(home);
    await store.save(acct("http://localhost:4000", "seller", "s1"));
    await store.save(acct("http://localhost:4000", "customer", "c1"));
    const { files } = await store.read();
    expect(files.map((f) => f.account?.name).sort()).toEqual([
      "customer",
      "seller",
    ]);
  });

  it("chooses one account per site, and no manual session for that site", () => {
    const manual: SessionFile = {
      ...acct("http://localhost:4000", "x", "m1"),
      account: undefined,
    };
    const elsewhere: SessionFile = {
      ...manual,
      site: "example.com",
      state: { cookies: [], origins: [] },
    };
    const seller = acct("http://localhost:4000", "seller", "s1");
    const customer = acct("http://localhost:4000", "customer", "c1");
    const all = [manual, elsewhere, seller, customer];
    const chosen = filesFor(all, {
      site: "localhost",
      origin: "http://localhost:4000",
      name: "seller",
    });
    expect(chosen).toEqual([elsewhere, seller]);
    // No account chosen: the manual sessions only (C's behaviour).
    expect(filesFor(all, null)).toEqual([manual, elsewhere]);
  });

  it("still loads a symlinked site file, and refuses a dangling link by name", async () => {
    const store = createSessionStore(home);
    const real = await store.save(
      acct("http://localhost:4000", "seller", "s1"),
    );
    const manual: SessionFile = {
      ...acct("http://localhost:4000", "x", "m1"),
      account: undefined,
    };
    const target = join(home, "elsewhere.json");
    await writeFile(target, JSON.stringify(manual), { mode: 0o600 });
    const link = store.pathOf("localhost");
    await symlink(target, link);
    const { files } = await store.read();
    expect(files.map((f) => f.account?.name ?? "manual").sort()).toEqual([
      "manual",
      "seller",
    ]);
    await rm(target);
    await expect(store.read()).rejects.toThrow(link);
    expect(real).toContain("seller.json");
  });
});
