import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSecretSweep,
  readSecretsFile,
  resolveSecrets,
  SecretError,
  sweptSink,
} from "../src/executor/secrets-env.js";

let repo: string;
let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "demoman-secrets-"));
  git("init", "-q");
  dir = join(repo, ".demoman");
  await mkdir(dir);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const reasonOf = async (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: unknown) => (e instanceof SecretError ? e.reason : String(e)),
  );

describe("readSecretsFile", () => {
  it("answers absent when there is no file", async () => {
    const s = await readSecretsFile(dir);
    expect(s.status).toBe("absent");
    expect(s.values.size).toBe(0);
  });

  it("reads an ignored file", async () => {
    await writeFile(join(repo, ".gitignore"), ".demoman/secrets.env\n");
    await writeFile(
      join(dir, "secrets.env"),
      '# demo\nDEMOMAN_SECRET_KL_PASSWORD="correct horse"\n\n',
    );
    const s = await readSecretsFile(dir);
    expect(s.status).toBe("ignored");
    expect(s.values.get("KL_PASSWORD")).toBe("correct horse");
  });

  it("refuses a file git does not ignore, naming the line to add", async () => {
    await writeFile(
      join(dir, "secrets.env"),
      "DEMOMAN_SECRET_KL_PASSWORD=correct horse\n",
    );
    const e = await readSecretsFile(dir).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SecretError);
    expect((e as SecretError).reason).toBe("secretsFileNotIgnored");
    expect((e as SecretError).message).toContain(".demoman/secrets.env");
    expect((e as SecretError).message).not.toContain("correct horse");
  });

  it("refuses a file git tracks, even when a .gitignore names it later", async () => {
    await writeFile(
      join(dir, "secrets.env"),
      "DEMOMAN_SECRET_KL_PASSWORD=correct horse\n",
    );
    git("add", ".demoman/secrets.env");
    await writeFile(join(repo, ".gitignore"), ".demoman/secrets.env\n");
    expect(await reasonOf(readSecretsFile(dir))).toBe("secretsFileNotIgnored");
  });

  it("refuses a line that is not DEMOMAN_SECRET_NAME=value, by number, without the value", async () => {
    await writeFile(join(repo, ".gitignore"), ".demoman/secrets.env\n");
    await writeFile(
      join(dir, "secrets.env"),
      "DEMOMAN_SECRET_A=abcdefgh\nAWS_KEY=hunter2hunter2\n",
    );
    const e = await readSecretsFile(dir).catch((x: unknown) => x);
    expect((e as SecretError).reason).toBe("secretsFileInvalid");
    expect((e as SecretError).message).toContain("line 2");
    expect((e as SecretError).message).not.toContain("hunter2");
  });

  it("reads outside a git repository, and says it could not check", async () => {
    const bare = await mkdtemp(join(tmpdir(), "demoman-nogit-"));
    try {
      await mkdir(join(bare, ".demoman"));
      await writeFile(
        join(bare, ".demoman", "secrets.env"),
        "DEMOMAN_SECRET_A=abcdefgh\n",
      );
      const s = await readSecretsFile(join(bare, ".demoman"));
      expect(s.status).toBe("notGit");
      expect(s.values.get("A")).toBe("abcdefgh");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("readSecretsFile and what it does not trust (audit run 1)", () => {
  // Red: run `git check-ignore` without `-c core.fsmonitor=false`, and the
  // checked folder's own config names a program git runs as the user.
  it("never runs a program the repository's config names", async () => {
    const marker = join(repo, "fsmonitor-ran");
    const hook = join(repo, "hook.sh");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git("config", "core.fsmonitor", hook);
    await writeFile(join(repo, ".gitignore"), ".demoman/secrets.env\n");
    // Premise: git does run it while reading the index here.
    git("add", ".gitignore");
    git("status", "--short");
    await access(marker);
    await rm(marker);
    await writeFile(join(dir, "secrets.env"), "DEMOMAN_SECRET_A=abcdefgh\n");
    expect((await readSecretsFile(dir)).status).toBe("ignored");
    await expect(access(marker)).rejects.toThrow();
  });

  // Red: read secrets.env through a link — outside git, nothing else says
  // whose secrets they are.
  it("refuses a secrets.env that is a link, without reading what it points at", async () => {
    const bare = await mkdtemp(join(tmpdir(), "demoman-nogit-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "demoman-other-project-"));
    try {
      await mkdir(join(bare, ".demoman"));
      await writeFile(
        join(elsewhere, "secrets.env"),
        "DEMOMAN_SECRET_A=another-projects-secret\n",
      );
      await symlink(
        join(elsewhere, "secrets.env"),
        join(bare, ".demoman", "secrets.env"),
      );
      const e = await readSecretsFile(join(bare, ".demoman")).catch(
        (x: unknown) => x,
      );
      expect((e as SecretError).reason).toBe("secretsFileInvalid");
      expect((e as SecretError).message).toContain("not a regular file");
      expect((e as SecretError).message).not.toContain("another-projects");
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  // Red: O_NOFOLLOW alone, which looks only at the file's own name.
  it("refuses a .demoman folder that is a link to another project's", async () => {
    const bare = await mkdtemp(join(tmpdir(), "demoman-nogit-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "demoman-other-project-"));
    try {
      await writeFile(
        join(elsewhere, "secrets.env"),
        "DEMOMAN_SECRET_A=another-projects-secret\n",
      );
      await symlink(elsewhere, join(bare, ".demoman"));
      // The fixture: the file is reachable through the link.
      await expect(
        readFile(join(bare, ".demoman", "secrets.env"), "utf8"),
      ).resolves.toContain("another-projects-secret");
      const e = await readSecretsFile(join(bare, ".demoman")).catch(
        (x: unknown) => x,
      );
      expect((e as SecretError).reason).toBe("secretsFileInvalid");
      expect((e as SecretError).message).toContain("is a link");
      expect((e as SecretError).message).not.toContain("another-projects");
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("readSecretsFile when git itself fails (final review I3)", () => {
  it("refuses, with git's words, instead of reading as 'not a git repository'", async () => {
    await writeFile(join(dir, "secrets.env"), "DEMOMAN_SECRET_A=abcdefgh\n");
    await writeFile(join(repo, ".gitignore"), ".demoman/secrets.env\n");
    // Premise: before the corruption git answers "ignored" for this file.
    expect((await readSecretsFile(dir)).status).toBe("ignored");
    await writeFile(join(repo, ".git", "config"), "[core\n garbage\n");
    // Premise: git itself now fails with something other than "not a
    // repository" or "not ignored".
    let gitSaid = "";
    try {
      execFileSync("git", ["check-ignore", "-q", "--", "secrets.env"], {
        cwd: dir,
        stdio: "pipe",
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      expect(err.status).not.toBe(1);
      gitSaid = String(err.stderr);
      expect(gitSaid).not.toMatch(/not a git repository/i);
    }
    expect(gitSaid).not.toBe("");
    const failure = await readSecretsFile(dir).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(SecretError);
    expect((failure as SecretError).reason).toBe("secretsFileNotIgnored");
    expect((failure as SecretError).message).toContain(
      "git could not say whether",
    );
    expect((failure as SecretError).message).toContain(gitSaid.trim());
    expect((failure as SecretError).message).not.toContain("abcdefgh");
  });
});

describe("resolveSecrets", () => {
  // Not the example origin the messages give, so a message that only
  // quotes the example cannot pass for one that names this site.
  const SITE = "http://localhost:4100";
  /** A secrets.env holding KL_PASSWORD, bound to `origin` unless null. */
  const fileFor = (origin: string | null = SITE) => ({
    path: "/p/.demoman/secrets.env",
    status: "ignored" as const,
    values: new Map([
      ["KL_PASSWORD", "from-the-file"],
      ...(origin === null
        ? []
        : ([["KL_PASSWORD_ORIGIN", origin]] as [string, string][])),
    ]),
  });
  const file = fileFor();
  const at = { origin: SITE };
  /** The environment secret, bound to `origin` (rc.3). */
  const bound = (value: string, origin: string = SITE) => ({
    DEMOMAN_SECRET_KL_PASSWORD: value,
    DEMOMAN_SECRET_KL_PASSWORD_ORIGIN: origin,
  });
  const refusal = (fn: () => unknown): SecretError => {
    try {
      fn();
    } catch (e) {
      if (e instanceof SecretError) return e;
      throw e;
    }
    throw new Error("resolved");
  };

  it("prefers the environment over the file", () => {
    const r = resolveSecrets(
      "pw={secret:KL_PASSWORD}",
      bound("from-the-env"),
      file,
      at,
    );
    expect(r.text).toBe("pw=from-the-env");
    expect(r.used).toEqual([{ name: "KL_PASSWORD", value: "from-the-env" }]);
  });
  it('treats an empty variable as unset (CI expands a missing secret to "")', () => {
    expect(
      resolveSecrets("{secret:KL_PASSWORD}", bound(""), file, at).text,
    ).toBe("from-the-file");
    // And with no file value either, it is missing, not "too short".
    expect(() =>
      resolveSecrets("{secret:NOPE}", { DEMOMAN_SECRET_NOPE: "" }, file, at),
    ).toThrow(/has no value/);
  });
  it("falls back to the file", () => {
    expect(resolveSecrets("{secret:KL_PASSWORD}", {}, file, at).text).toBe(
      "from-the-file",
    );
  });
  it("never reads a variable without the prefix", () => {
    expect(() =>
      resolveSecrets(
        "{secret:HOME}",
        { HOME: "/Users/someone-long" },
        file,
        at,
      ),
    ).toThrow(/DEMOMAN_SECRET_HOME/);
  });
  it("names a missing secret and both places looked", () => {
    const e = refusal(() => resolveSecrets("{secret:NOPE}", {}, file, at));
    expect(e.reason).toBe("secretMissing");
    expect(e.message).toContain("DEMOMAN_SECRET_NOPE");
    expect(e.message).toContain("/p/.demoman/secrets.env");
    // Launch E: Codex hands an MCP server only an allow-list of the shell's
    // environment, so "set it in the environment" alone misleads there.
    expect(e.message).toContain("Codex does");
  });
  it("refuses a value under 8 characters without printing it", () => {
    const e = refusal(() =>
      resolveSecrets(
        "{secret:S}",
        { DEMOMAN_SECRET_S: "short1", DEMOMAN_SECRET_S_ORIGIN: SITE },
        file,
        at,
      ),
    );
    expect(e.reason).toBe("secretTooShort");
    expect(e.message).not.toContain("short1");
  });
  it("leaves text without references alone", () => {
    expect(resolveSecrets("seller@demo.test", {}, file, at)).toEqual({
      text: "seller@demo.test",
      used: [],
    });
  });

  describe("an environment secret is bound to its site (rc.3)", () => {
    it("refuses one with no _ORIGIN, naming the variable to set and not the value", () => {
      const e = refusal(() =>
        resolveSecrets(
          "{secret:KL_PASSWORD}",
          { DEMOMAN_SECRET_KL_PASSWORD: "from-the-env" },
          file,
          at,
        ),
      );
      expect(e.reason).toBe("secretUnbound");
      expect(e.message).toContain("names no site");
      expect(e.message).toContain("set DEMOMAN_SECRET_KL_PASSWORD_ORIGIN");
      expect(e.message).toContain(`this sign-in is for ${SITE}`);
      expect(e.message).not.toContain("from-the-env");
    });
    it("refuses it rather than fall back to the file (positive control: the file holds the name)", () => {
      expect(file.values.has("KL_PASSWORD")).toBe(true);
      expect(
        refusal(() =>
          resolveSecrets(
            "{secret:KL_PASSWORD}",
            { DEMOMAN_SECRET_KL_PASSWORD: "from-the-env" },
            file,
            at,
          ),
        ).reason,
      ).toBe("secretUnbound");
    });
    it("treats an empty _ORIGIN as unset", () => {
      expect(
        refusal(() =>
          resolveSecrets(
            "{secret:KL_PASSWORD}",
            bound("from-the-env", ""),
            file,
            at,
          ),
        ).message,
      ).toContain("names no site");
    });
    it("refuses one bound to another site, naming both, without the value", () => {
      const e = refusal(() =>
        resolveSecrets(
          "{secret:KL_PASSWORD}",
          bound("from-the-env", "https://evil.example"),
          file,
          at,
        ),
      );
      expect(e.reason).toBe("secretOffOrigin");
      expect(e.message).toContain("https://evil.example");
      expect(e.message).toContain(SITE);
      expect(e.message).toContain("DEMOMAN_SECRET_KL_PASSWORD_ORIGIN");
      expect(e.message).not.toContain("from-the-env");
    });
    it("tells a port apart: the same host on another port is another site", () => {
      expect(
        refusal(() =>
          resolveSecrets(
            "{secret:KL_PASSWORD}",
            bound("from-the-env", "http://localhost:4101"),
            file,
            at,
          ),
        ).reason,
      ).toBe("secretOffOrigin");
    });
    it("accepts the origin with a trailing slash, or in another case", () => {
      for (const origin of [`${SITE}/`, "HTTP://LOCALHOST:4100"]) {
        expect(
          resolveSecrets(
            "{secret:KL_PASSWORD}",
            bound("from-the-env", origin),
            file,
            at,
          ).text,
          origin,
        ).toBe("from-the-env");
      }
    });
    it("refuses a binding that is not an origin (a path, a bare host)", () => {
      for (const origin of [`${SITE}/login`, "localhost:4000", "not a url"]) {
        const e = refusal(() =>
          resolveSecrets(
            "{secret:KL_PASSWORD}",
            bound("from-the-env", origin),
            file,
            at,
          ),
        );
        expect(e.reason, origin).toBe("secretUnbound");
        expect(e.message, origin).toContain("is not an origin");
      }
    });
    it("says the environment was withheld before asking for a binding", () => {
      const e = refusal(() =>
        resolveSecrets(
          "{secret:NOPE}",
          { DEMOMAN_SECRET_NOPE: "from-the-env" },
          file,
          { origin: SITE, envWithheld: "it was reached through `project`" },
        ),
      );
      expect(e.reason).toBe("secretMissing");
      expect(e.message).toContain("reached through `project`");
    });
  });

  describe("a secrets.env value is bound to its site too (audit run 1)", () => {
    // Red: return file values unchecked — accounts.json is committed, and
    // its author can name any site for a password someone else wrote.
    it("refuses one bound to another site, naming both, without the value", () => {
      const e = refusal(() =>
        resolveSecrets("{secret:KL_PASSWORD}", {}, file, {
          origin: "https://anywhere.example",
        }),
      );
      expect(e.reason).toBe("secretOffOrigin");
      expect(e.message).toContain(SITE);
      expect(e.message).toContain("https://anywhere.example");
      expect(e.message).not.toContain("from-the-file");
    });
    it("refuses one with no _ORIGIN line, naming the line to add", () => {
      const e = refusal(() =>
        resolveSecrets("{secret:KL_PASSWORD}", {}, fileFor(null), at),
      );
      expect(e.reason).toBe("secretUnbound");
      expect(e.message).toContain(`DEMOMAN_SECRET_KL_PASSWORD_ORIGIN=${SITE}`);
      expect(e.message).not.toContain("from-the-file");
    });
    it("refuses an _ORIGIN line that is not an origin", () => {
      const e = refusal(() =>
        resolveSecrets(
          "{secret:KL_PASSWORD}",
          {},
          fileFor(`${SITE}/login`),
          at,
        ),
      );
      expect(e.reason).toBe("secretUnbound");
      expect(e.message).toContain("is not an origin");
    });
    it("types one bound to this site (positive control)", () => {
      expect(resolveSecrets("{secret:KL_PASSWORD}", {}, file, at).text).toBe(
        "from-the-file",
      );
    });
  });
});

describe("the sweep", () => {
  it("replaces every value it was given, everywhere in a value", () => {
    const sweep = createSecretSweep();
    sweep.add("KL_PASSWORD", "hunter2hunter2");
    expect(sweep.scrub("no account for hunter2hunter2@x")).toBe(
      "no account for {secret:KL_PASSWORD}@x",
    );
    expect(
      sweep.scrubValue({
        detail: "x hunter2hunter2",
        list: ["hunter2hunter2"],
        n: 3,
        nil: null,
      }),
    ).toEqual({
      detail: "x {secret:KL_PASSWORD}",
      list: ["{secret:KL_PASSWORD}"],
      n: 3,
      nil: null,
    });
  });
  it("is a no-op with nothing added (positive control)", () => {
    const sweep = createSecretSweep();
    expect(sweep.scrub("hunter2hunter2")).toBe("hunter2hunter2");
  });
  it("replaces a value as an app keeps it: URL-encoded, JSON-escaped, base64 (review 2026-10-16)", () => {
    const value = 'p@ss w0rd!"x\\';
    const forms = {
      url: encodeURIComponent(value),
      json: JSON.stringify(value).slice(1, -1),
      b64: Buffer.from(value).toString("base64"),
      b64url: Buffer.from(value).toString("base64url"),
    };
    // Premise: every form differs from the value as typed, so a sweep that
    // knew only the raw value would leave each one in place.
    for (const form of Object.values(forms)) expect(form).not.toBe(value);
    const sweep = createSecretSweep();
    sweep.add("KL_PASSWORD", value);
    for (const [kind, form] of Object.entries(forms)) {
      expect(sweep.scrub(`a=${form};`), kind).toBe("a={secret:KL_PASSWORD};");
    }
  });
});

describe("the sweep and a form's spelling (audit run 1)", () => {
  // Red: formsOf without the form-urlencoded spelling — a GET form puts the
  // password in a URL that Playwright's call log quotes into a refusal.
  it("replaces a value as a form submits it: space as +, ! ' ( ) ~ escaped", () => {
    const value = "it's (a) pass~word!";
    const form = new URLSearchParams({ k: value }).toString().slice(2);
    // Premise: this spelling is none of the forms the sweep knew already.
    expect(form).not.toBe(value);
    expect(form).not.toBe(encodeURIComponent(value));
    const sweep = createSecretSweep();
    sweep.add("KL_PASSWORD", value);
    expect(sweep.scrub(`/login?password=${form}&x=1`)).toBe(
      "/login?password={secret:KL_PASSWORD}&x=1",
    );
  });

  // Red: percent-encodings in upper-case hex only.
  it("replaces a percent-encoding in lower-case hex", () => {
    const value = "p@ss/word?";
    const lower = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (h) =>
      h.toLowerCase(),
    );
    expect(lower).not.toBe(encodeURIComponent(value));
    const sweep = createSecretSweep();
    sweep.add("KL_PASSWORD", value);
    expect(sweep.scrub(`a=${lower};`)).toBe("a={secret:KL_PASSWORD};");
  });
});

describe("sweptSink", () => {
  it("hands a progress sink only swept values, and leaves an absent sink absent", () => {
    const sweep = createSecretSweep();
    sweep.add("KL", "correct-horse-battery");
    const seen: unknown[] = [];
    const sink = sweptSink(sweep, (v: unknown) => seen.push(v));
    sink?.({ note: "threw: correct-horse-battery", step: 1 });
    expect(seen).toEqual([{ note: "threw: {secret:KL}", step: 1 }]);
    expect(sweptSink(sweep, undefined)).toBeUndefined();
  });
});
