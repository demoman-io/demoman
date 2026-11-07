// The person's Demoman sign-in on this machine (`demoman login`): one file,
// readable by them alone. Its absence is what "signed out" means: nothing
// may call the hosted service without it.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type Credential = {
  base: string;
  token: string;
  login: string;
  workspace: { id: string; name: string };
};

export type CredentialRead =
  | { ok: true; credential: Credential }
  | { ok: false; none: string }
  | { ok: false; unreadable: string };

const dirOf = (home: string) => join(home, "hosted");
const fileOf = (home: string) => join(dirOf(home), "credential.json");

export function readCredential(home: string): CredentialRead {
  let text: string;
  try {
    text = readFileSync(fileOf(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: false, none: "not signed in to Demoman on this computer" };
    return {
      ok: false,
      unreadable: `${fileOf(home)} could not be read (${(error as Error).message})`,
    };
  }
  try {
    const c = JSON.parse(text) as Partial<Credential>;
    if (
      typeof c.base === "string" &&
      typeof c.token === "string" &&
      typeof c.login === "string" &&
      typeof c.workspace?.id === "string" &&
      typeof c.workspace.name === "string"
    )
      return {
        ok: true,
        credential: {
          base: c.base,
          token: c.token,
          login: c.login,
          workspace: { id: c.workspace.id, name: c.workspace.name },
        },
      };
    return {
      ok: false,
      unreadable: `${fileOf(home)} is not a Demoman sign-in`,
    };
  } catch (error) {
    return {
      ok: false,
      unreadable: `${fileOf(home)} is not JSON (${(error as Error).message})`,
    };
  }
}

export function writeCredential(home: string, c: Credential): void {
  mkdirSync(dirOf(home), { recursive: true, mode: 0o700 });
  chmodSync(dirOf(home), 0o700);
  writeFileSync(fileOf(home), `${JSON.stringify(c, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(fileOf(home), 0o600);
}

export function deleteCredential(home: string): void {
  rmSync(fileOf(home), { force: true });
}

/** Where the hosted service is: `DEMOMAN_HOSTED_URL`, else demoman.io. */
export function hostedBase(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.DEMOMAN_HOSTED_URL;
  return v !== undefined && v !== ""
    ? v.replace(/\/+$/, "")
    : "https://demoman.io";
}
