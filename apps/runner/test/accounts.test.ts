import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseAccount,
  findAccounts,
  parseAccounts,
  secretNamesIn,
} from "../src/executor/accounts.js";

const ORIGIN = "http://localhost:4000";
const seller = {
  about: "Sonny BBQ, a seller with 6 custom requests",
  checkUrl: "/admin/dashboard",
  signIn: [
    { do: "goto", url: "/users/log-in" },
    {
      do: "type",
      into: { role: "textbox", name: "Email" },
      text: "seller@demo.test",
    },
    {
      do: "type",
      into: { stableId: "user_password" },
      text: "{secret:KL_SELLER_PASSWORD}",
    },
    { do: "click", on: { role: "button", name: "Log in" } },
  ],
};
const good = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    accountsVersion: 1,
    sites: { [ORIGIN]: { default: "seller", accounts: { seller } } },
    ...over,
  });

describe("parseAccounts", () => {
  it("reads a file, resolving paths against the origin", () => {
    const r = parseAccounts("/p/.demoman/accounts.json", good());
    if (!r.ok) throw new Error(r.detail);
    const site = r.file.sites.get(ORIGIN);
    expect(site?.site).toBe("localhost");
    expect(site?.defaultAccount).toBe("seller");
    const a = site?.accounts.get("seller");
    expect(a?.checkUrl).toBe(`${ORIGIN}/admin/dashboard`);
    expect(a?.signIn[0]).toEqual({ do: "goto", url: `${ORIGIN}/users/log-in` });
    expect(r.file.dir).toBe("/p/.demoman");
  });

  it.each([
    ["a newer version", good({ accountsVersion: 2 }), "accountsVersion"],
    ["an unknown key", good({ extra: 1 }), "extra"],
    [
      "a site key that is not an origin",
      JSON.stringify({
        accountsVersion: 1,
        sites: { [`${ORIGIN}/app`]: { accounts: { seller } } },
      }),
      "sites",
    ],
    [
      "a default naming no account",
      JSON.stringify({
        accountsVersion: 1,
        sites: { [ORIGIN]: { default: "admin", accounts: { seller } } },
      }),
      "default",
    ],
    [
      "a first step that is not a goto",
      JSON.stringify({
        accountsVersion: 1,
        sites: {
          [ORIGIN]: {
            accounts: { seller: { ...seller, signIn: seller.signIn.slice(1) } },
          },
        },
      }),
      "signIn",
    ],
    [
      "a goto off the origin",
      JSON.stringify({
        accountsVersion: 1,
        sites: {
          [ORIGIN]: {
            accounts: {
              seller: {
                ...seller,
                signIn: [
                  { do: "goto", url: "https://evil.test/login" },
                  ...seller.signIn.slice(1),
                ],
              },
            },
          },
        },
      }),
      "signIn.0.url",
    ],
    [
      "a checkUrl off the origin",
      JSON.stringify({
        accountsVersion: 1,
        sites: {
          [ORIGIN]: {
            accounts: { seller: { ...seller, checkUrl: "https://evil.test/" } },
          },
        },
      }),
      "checkUrl",
    ],
    [
      "a bad secret name",
      JSON.stringify({
        accountsVersion: 1,
        sites: {
          [ORIGIN]: {
            accounts: {
              seller: {
                ...seller,
                signIn: [
                  seller.signIn[0],
                  {
                    do: "type",
                    into: { stableId: "pw" },
                    text: "{secret:kl-pass}",
                  },
                ],
              },
            },
          },
        },
      }),
      "signIn.1.text",
    ],
    [
      "an account name that cannot be a file name",
      JSON.stringify({
        accountsVersion: 1,
        sites: { [ORIGIN]: { accounts: { "../x": seller } } },
      }),
      "accounts",
    ],
    [
      "two names that differ only in case (one file on a case-insensitive disk)",
      JSON.stringify({
        accountsVersion: 1,
        sites: { [ORIGIN]: { accounts: { Seller: seller, seller } } },
      }),
      "accounts",
    ],
  ])("refuses %s, naming the field", (_label, text, field) => {
    const r = parseAccounts("/p/.demoman/accounts.json", text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toContain("/p/.demoman/accounts.json");
    expect(r.field).toContain(field);
  });
});

describe("parseAccounts on a secret name ending _ORIGIN (rc.3)", () => {
  const withSecret = (name: string) =>
    JSON.stringify({
      accountsVersion: 1,
      sites: {
        [ORIGIN]: {
          accounts: {
            seller: {
              ...seller,
              signIn: [
                seller.signIn[0],
                {
                  do: "type",
                  into: { stableId: "pw" },
                  text: `{secret:${name}}`,
                },
              ],
            },
          },
        },
      },
    });
  it("refuses it: DEMOMAN_SECRET_<NAME>_ORIGIN is another secret's site", () => {
    const r = parseAccounts(
      "/p/.demoman/accounts.json",
      withSecret("KL_ORIGIN"),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toContain("signIn.1.text");
    expect(r.detail).toContain("{secret:KL_ORIGIN}");
    expect(r.detail).toContain("_ORIGIN");
  });
  it("takes a name that only contains ORIGIN (positive control)", () => {
    for (const name of ["ORIGIN_KL", "KL_ORIGINAL"]) {
      expect(
        parseAccounts("/p/.demoman/accounts.json", withSecret(name)).ok,
        name,
      ).toBe(true);
    }
  });
});

describe("parseAccounts on an account name with a capital (C2 residual r2)", () => {
  it("names the account and the rule, not zod's own text", () => {
    const r = parseAccounts(
      "/p/.demoman/accounts.json",
      JSON.stringify({
        accountsVersion: 1,
        sites: { [ORIGIN]: { accounts: { Seller: seller } } },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toContain('account name "Seller"');
    expect(r.detail).toContain("lower-case letters");
    expect(r.detail).not.toContain("Invalid key in record");
  });
});

describe("parseAccounts on text that is not JSON (final review T2)", () => {
  it("refuses it as not JSON, with no field to name", () => {
    const r = parseAccounts("/p/.demoman/accounts.json", "{");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe("");
    expect(r.detail).toMatch(/not JSON/);
    expect(r.detail).toContain("/p/.demoman/accounts.json");
  });
});

describe("secretNamesIn", () => {
  it("lists each name once", () => {
    expect(secretNamesIn("{secret:A}-{secret:B_2}-{secret:A}")).toEqual([
      "A",
      "B_2",
    ]);
    expect(secretNamesIn("no secrets")).toEqual([]);
  });
});

describe("findAccounts", () => {
  let root: string;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("finds the file in a parent folder, stopping at the git root", async () => {
    root = await mkdtemp(join(tmpdir(), "demoman-accounts-"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".demoman"));
    await mkdir(join(root, "apps", "web"), { recursive: true });
    await writeFile(join(root, ".demoman", "accounts.json"), good());
    const found = await findAccounts(join(root, "apps", "web"));
    expect(found.kind).toBe("found");
    if (found.kind === "found") {
      expect(found.file.path).toBe(join(root, ".demoman", "accounts.json"));
    }
  });

  it("answers none, naming where it looked from", async () => {
    root = await mkdtemp(join(tmpdir(), "demoman-accounts-"));
    await mkdir(join(root, ".git"));
    const found = await findAccounts(root);
    expect(found).toEqual({ kind: "none", searchedFrom: root });
  });

  it("does not look above the git root", async () => {
    root = await mkdtemp(join(tmpdir(), "demoman-accounts-"));
    await mkdir(join(root, ".demoman"));
    await writeFile(join(root, ".demoman", "accounts.json"), good());
    await mkdir(join(root, "repo", ".git"), { recursive: true });
    // Premise: a file exists above the repo.
    expect((await findAccounts(root)).kind).toBe("found");
    expect((await findAccounts(join(root, "repo"))).kind).toBe("none");
  });

  it("answers invalid for a file it cannot use", async () => {
    root = await mkdtemp(join(tmpdir(), "demoman-accounts-"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".demoman"));
    await writeFile(join(root, ".demoman", "accounts.json"), "{");
    const found = await findAccounts(root);
    expect(found.kind).toBe("invalid");
  });
});

describe("chooseAccount", () => {
  const parsed = parseAccounts("/p/.demoman/accounts.json", good());
  if (!parsed.ok) throw new Error(parsed.detail);
  const found = { kind: "found" as const, file: parsed.file };

  it("takes the site's default", () => {
    const c = chooseAccount(found, `${ORIGIN}/admin/orders`, undefined);
    expect(c.kind === "account" && c.account.name).toBe("seller");
  });
  it("takes a named account", () => {
    const c = chooseAccount(found, `${ORIGIN}/admin/orders`, "seller");
    expect(c.kind === "account" && c.account.name).toBe("seller");
  });
  it("refuses an account the site does not have, listing the ones it does", () => {
    const c = chooseAccount(found, `${ORIGIN}/admin/orders`, "admin");
    expect(c.kind).toBe("refused");
    if (c.kind !== "refused") return;
    expect(c.reason).toBe("unknownAccount");
    expect(c.detail).toContain("seller");
    expect(c.field).toBe("account");
  });
  it("falls back to the manual session on a site with no entry", () => {
    expect(chooseAccount(found, "http://localhost:5173/", undefined)).toEqual({
      kind: "manual",
    });
  });
  it("refuses a named account on a site with no entry", () => {
    expect(chooseAccount(found, "http://localhost:5173/", "seller").kind).toBe(
      "refused",
    );
  });
  it("falls back to the manual session with no file, and refuses a name", () => {
    const none = { kind: "none" as const, searchedFrom: "/p" };
    expect(chooseAccount(none, `${ORIGIN}/`, undefined)).toEqual({
      kind: "manual",
    });
    const c = chooseAccount(none, `${ORIGIN}/`, "seller");
    expect(c.kind === "refused" && c.detail).toContain("/p");
  });
  it("refuses every call while the file is invalid", () => {
    const bad = {
      kind: "invalid" as const,
      path: "/p/.demoman/accounts.json",
      detail: "x",
      field: "sites",
    };
    const c = chooseAccount(bad, `${ORIGIN}/`, undefined);
    expect(c.kind === "refused" && c.reason).toBe("accountsInvalid");
  });
  it("refuses a site with no default when the script names none", () => {
    const r = parseAccounts(
      "/p/.demoman/accounts.json",
      JSON.stringify({
        accountsVersion: 1,
        sites: { [ORIGIN]: { accounts: { seller } } },
      }),
    );
    if (!r.ok) throw new Error(r.detail);
    const c = chooseAccount(
      { kind: "found", file: r.file },
      `${ORIGIN}/`,
      undefined,
    );
    expect(c.kind === "refused" && c.reason).toBe("unknownAccount");
  });
});
