// `demoman login` and `demoman logout`: the sign-in to Demoman's hosted
// service (links). Not `signin`, which signs in to the person's own app.
import { spawn } from "node:child_process";
import {
  deleteCredential,
  type Fetch,
  HostedClient,
  pollLogin,
  readCredential,
  startLogin,
  writeCredential,
} from "@demoman/runner/package";

export type LoginDeps = {
  home: string;
  base: string;
  fetchImpl?: Fetch;
  say: (line: string) => void;
  open?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

/** Opens a URL with the platform's opener; a machine with none (a server,
 *  CI) just has the printed address. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The address is printed above; opening it is a convenience.
  }
}

export async function runLogin(d: LoginDeps): Promise<number> {
  const had = readCredential(d.home);
  if (had.ok) {
    d.say(
      `already signed in as ${had.credential.login} (workspace ${had.credential.workspace.name}); \`demoman logout\` signs out`,
    );
    return 0;
  }
  const started = await startLogin(d.base, d.fetchImpl);
  if (!started.ok) {
    d.say(`demoman: login: ${started.detail}`);
    return 1;
  }
  const s = started.value;
  d.say(`Open ${s.verifyUrl}`);
  d.say(`and approve the code ${s.userCode} to sign in this computer.`);
  (d.open ?? openInBrowser)(s.verifyUrl);
  const sleep =
    d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const polled = await pollLogin(d.base, s.code, d.fetchImpl);
    if (!polled.ok) {
      d.say(`demoman: login: ${polled.detail}`);
      return 1;
    }
    if ("token" in polled.value) {
      const v = polled.value;
      writeCredential(d.home, {
        base: d.base,
        token: v.token,
        login: v.login,
        workspace: v.workspace,
      });
      d.say(`signed in as ${v.login} (workspace ${v.workspace.name})`);
      return 0;
    }
    await sleep(s.intervalMs);
  }
}

export async function runLogout(d: LoginDeps): Promise<number> {
  const had = readCredential(d.home);
  if (!had.ok) {
    if ("unreadable" in had) {
      deleteCredential(d.home);
      d.say(`removed an unreadable sign-in (${had.unreadable})`);
      return 0;
    }
    d.say("not signed in to Demoman on this computer");
    return 0;
  }
  const revoked = await new HostedClient(had.credential, d.fetchImpl).logout();
  deleteCredential(d.home);
  // Signed out of the server already: the sign-in is gone either way.
  if (revoked.ok || revoked.reason === "signedOut") {
    d.say(`signed out ${had.credential.login}`);
    return 0;
  }
  d.say(
    `signed out on this computer, but the sign-in could not be revoked on Demoman's service (${revoked.detail}); it stays valid there until revoked`,
  );
  return 1;
}
