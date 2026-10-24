// apps/runner/test/login-app.ts
//
// A cookie-login app for launch C's lanes, shaped like KitchenLink's
// phx.gen.auth: a session cookie with no Max-Age (so a browser-session
// cookie), a redirect to the sign-in page that carries `return_to`, and a
// sign-in page with a visible password field. Every lane that uses it
// asserts the premise it relies on (see login-app.test.ts).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { SessionFile } from "../src/executor/sessions.js";

export const SESSION_COOKIE = "demo_session";
/** The sign-in page's background: a colour nothing else here paints. */
export const LOGIN_RGB: [number, number, number] = [255, 0, 255];

export interface LoginApp {
  url: string;
  /** POSTs to /login so far: how a lane waits for an auto sign-in. */
  signIns(): number;
  /** Lets a waiting `?auto=1` sign-in form submit itself (once). A lane calls
   *  it when `signin` asks for the sign-in, so the form never submits before
   *  `signin` has read the page — a condition, not a delay. */
  releaseSignIn(): void;
  /** GETs of `pathname` so far: how a lane shows which page a run reached
   *  when its report does not carry the URL. */
  gets(pathname: string): number;
  /** Every cookie issued so far stops being valid: an expired session. */
  expireAll(): void;
  /** The cookie value a signed-in browser holds now. */
  validCookie(): string;
  /** The cookie value a browser signed in as this email holds now
   *  (accounts option). */
  validCookieFor(email: string): string;
  /** The signed-in email of each /app page served, in order: who the
   *  dashboard was served to (lastPage() holds POST answers only). */
  dashboardsServedTo(): string[];
  /** POSTs to /login that signed this email in (accounts option). */
  signInsAs(email: string): number;
  /** Every POST body received, raw. */
  bodies(): string[];
  /** The last HTML page sent in answer to a POST (the wrong-password echo):
   *  later GETs of other pages do not replace it. */
  lastPage(): string;
  /** Event streams `/held` has open: one per live `/held-page`. */
  held(): number;
  close(): Promise<void>;
}

export interface LoginAppOptions {
  /** email -> password. Given: POST /login checks them, the cookie names
   *  the account, and a wrong password echoes what was typed. Absent:
   *  C's behaviour (any POST signs in). */
  accounts?: Record<string, string>;
  /** With accounts: a successful sign-in also writes the posted password
   *  into localStorage (an app that remembers it). */
  leakPasswordToStorage?: boolean;
  /** With accounts: a successful sign-in also sets a cookie holding the
   *  posted password URL-encoded (review 2026-10-16). */
  leakEncodedPasswordToCookie?: boolean;
}

const page = (title: string, body: string, background: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{margin:0;font:16px/1.4 sans-serif;background:${background};min-height:100vh}` +
  `main{padding:40px}input,button{display:block;margin:12px 0;font-size:16px;padding:8px}</style>` +
  `</head><body><main>${body}</main></body></html>`;

export async function serveLoginApp(
  options: LoginAppOptions = {},
): Promise<LoginApp> {
  let generation = 0;
  let signIns = 0;
  let released = false;
  let last = "";
  const getCounts = new Map<string, number>();
  const asCounts = new Map<string, number>();
  const bodies: string[] = [];
  const served: string[] = [];
  const held = new Set<import("node:http").ServerResponse>();
  const streams = new Set<import("node:http").ServerResponse>();
  const valid = () => `valid-${generation}`;
  const server = createServer(async (req, res) => {
    let body = "";
    if (req.method === "POST") {
      for await (const chunk of req) body += String(chunk);
      bodies.push(body);
    }
    const posted = new URLSearchParams(body);
    const url = new URL(req.url ?? "/", "http://fixture");
    if (req.method === "GET") {
      getCounts.set(url.pathname, (getCounts.get(url.pathname) ?? 0) + 1);
    }
    const cookies = (req.headers.cookie ?? "").split(/;\s*/);
    const cookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    const cookieValue = cookie?.slice(SESSION_COOKIE.length + 1) ?? "";
    const signedIn =
      options.accounts === undefined
        ? cookieValue === valid()
        : cookieValue.startsWith(`${valid()}-`);
    const currentEmail = signedIn
      ? decodeURIComponent(cookieValue.slice(valid().length + 1))
      : null;
    const form = (action: string, button = "<button>Sign in</button>") =>
      `<h1>Sign in</h1><form id="signin" method="post" action="${action}">` +
      `<input id="user_email" name="email" aria-label="Email" value="ada@example.com">` +
      `<input id="user_password" type="password" name="password" aria-label="Password">` +
      `${button}</form>`;
    const html = (text: string) => {
      if (req.method === "POST") last = text;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(text);
    };
    if (req.method === "POST" && url.pathname === "/login") {
      signIns += 1;
      released = false;
      const back = url.searchParams.get("return_to") ?? "";
      let value = valid();
      if (options.accounts !== undefined) {
        const email = posted.get("email") ?? "";
        const password = posted.get("password") ?? "";
        if (
          options.accounts[email] !== password ||
          !(email in options.accounts)
        ) {
          html(
            page(
              "Sign in",
              `${form("/login")}<p id="error">No account for ${email} with password ${password}</p>`,
              "#ff00ff",
            ),
          );
          return;
        }
        asCounts.set(email, (asCounts.get(email) ?? 0) + 1);
        value = `${valid()}-${encodeURIComponent(email)}`;
      }
      if (options.leakPasswordToStorage === true) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax`,
        });
        res.end(
          `<!doctype html><script>localStorage.setItem('remembered',${JSON.stringify(posted.get("password") ?? "")});location.assign('/app')</script>`,
        );
        return;
      }
      const session = `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax`;
      res.writeHead(302, {
        "set-cookie":
          options.leakEncodedPasswordToCookie === true
            ? [
                session,
                `remembered=${encodeURIComponent(posted.get("password") ?? "")}; Path=/`,
              ]
            : session,
        location: back.startsWith("/") ? back : "/app",
      });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/logout") {
      res.writeHead(204, {
        "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0`,
      });
      res.end();
      return;
    }
    // `?auto=1`'s sign-in form asks every 700 ms whether a lane released it,
    // then submits. Gaps over 500 ms, so the page still reaches networkidle.
    // A release is for a form on screen: serving a new one takes back any
    // release no form used (a lane that released on a page without one).
    const autoSubmit = (): string => {
      if (!url.searchParams.has("auto")) return "";
      released = false;
      return `<script>(function tick(){fetch('/release').then(r=>r.json()).then(go=>go?document.forms[0].submit():setTimeout(tick,700))})()</script>`;
    };
    switch (url.pathname) {
      case "/login-late":
        // LiveView's phx-trigger-action shape: the click does not submit;
        // the form is submitted 400 ms later.
        html(
          page(
            "Sign in",
            `${form("/login", '<button type="button" id="go">Sign in</button>')}` +
              `<script>document.getElementById('go').addEventListener('click',()=>setTimeout(()=>document.getElementById('signin').submit(),400))</script>`,
            "#ff00ff",
          ),
        );
        return;
      case "/login-late-replace":
        // /login-late whose page rewrites its own URL on load (LiveView's
        // join-time replaceState): same-document navigations on load and on click, no submit.
        html(
          page(
            "Sign in",
            `${form("/login", '<button type="button" id="go">Sign in</button>')}` +
              `<script>history.replaceState(null,'',location.pathname+'?joined=1');fetch('/rewrote-load');document.getElementById('go').addEventListener('click',()=>{history.replaceState(null,'',location.pathname+'?clicked=1');fetch('/rewrote-click');setTimeout(()=>document.getElementById('signin').submit(),400)})</script>`,
            "#ff00ff",
          ),
        );
        return;
      case "/login-email":
        // Page one of a two-page sign-in: Next moves to the password page.
        html(
          page(
            "Sign in",
            `<h1>Sign in</h1><input id="user_email" aria-label="Email">` +
              `<button type="button" id="next-page">Next</button>` +
              `<script>document.getElementById('next-page').addEventListener('click',()=>location.assign('/login-password?email='+encodeURIComponent(document.getElementById('user_email').value)))</script>`,
            "#ff00ff",
          ),
        );
        return;
      case "/login-password":
        // Page two: the late-submitting form, carrying the email on.
        html(
          page(
            "Sign in",
            `<h1>Sign in</h1><form id="signin" method="post" action="/login">` +
              `<input type="hidden" name="email" value="${(url.searchParams.get("email") ?? "").replace(/[<>"&]/g, "")}">` +
              `<input id="user_password" type="password" name="password" aria-label="Password">` +
              `<button type="button" id="go">Sign in</button></form>` +
              `<script>document.getElementById('go').addEventListener('click',()=>setTimeout(()=>document.getElementById('signin').submit(),400))</script>`,
            "#ff00ff",
          ),
        );
        return;
      case "/hang":
        // Never answers; released when the app closes.
        held.add(res);
        return;
      case "/vanishing-login":
        html(
          page(
            "Sign in",
            // Removed the moment the email field is typed into, not on a
            // timer: a timer races the steps that follow it (a step can run
            // inside the 50 ms), and the field must be gone for step 3.
            `${form("/login")}<script>document.getElementById('user_email').addEventListener('input',()=>document.getElementById('user_password')?.remove())</script>`,
            "#ff00ff",
          ),
        );
        return;
      case "/bounce": {
        res.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
        res.end();
        return;
      }
      case "/release":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(released));
        return;
      case "/inplace":
        // An app that shows its sign-in form at the page asked for, with no
        // redirect (final review 3), and its content there once signed in.
        html(
          signedIn
            ? page("Dashboard", `<h1>Dashboard</h1><p>Signed in</p>`, "#ffffff")
            : page(
                "Sign in",
                form("/login?return_to=%2Finplace") + autoSubmit(),
                "#ff00ff",
              ),
        );
        return;
      case "/late": {
        // Sends a signed-out browser to the sign-in page from script, a
        // moment after load (final review 4): no HTTP redirect to see.
        const auto = url.searchParams.has("auto") ? "&auto=1" : "";
        html(
          signedIn
            ? page("Dashboard", `<h1>Dashboard</h1><p>Signed in</p>`, "#ffffff")
            : page(
                "Loading",
                `<h1>Loading</h1><script>setTimeout(()=>location.assign('/login?return_to=%2Flate${auto}'),300)</script>`,
                "#ffffff",
              ),
        );
        return;
      }
      case "/goodbye":
        // A public page: no login, no password field.
        html(page("Goodbye", `<h1>Goodbye</h1>`, "#ffffff"));
        return;
      case "/moved":
        // A redirect to a page that is not a sign-in page, carrying a query
        // that must not reach the report.
        res.writeHead(302, { location: "/goodbye?invite=tok-moved-5521" });
        res.end();
        return;
      case "/app": {
        if (!signedIn) {
          const auto = url.searchParams.has("auto") ? "&auto=1" : "";
          res.writeHead(302, {
            location: `/login?return_to=%2Fapp${auto}`,
          });
          res.end();
          return;
        }
        served.push(currentEmail ?? "someone");
        html(
          page(
            "Dashboard",
            `<h1>Dashboard</h1>` +
              `<p id="whoami">${currentEmail ?? "someone"}</p>` +
              `<button id="next" onclick="document.getElementById('done').hidden=false">Next</button>` +
              `<p id="done" hidden>Done</p>` +
              `<button id="signout" onclick="fetch('/logout',{method:'POST'}).then(()=>location.assign('/app'))">Sign out</button>` +
              // Signs out and ends on a public page, not the sign-in page.
              `<button id="leave" onclick="fetch('/logout',{method:'POST'}).then(()=>location.assign('/goodbye'))">Leave</button>` +
              `<a href="/account/password">Change password</a> ` +
              `<a href="/hostile">Hostile page</a>`,
            "#ffffff",
          ),
        );
        return;
      }
      case "/magic": {
        // A KitchenLink-shaped app: signed out, it redirects to a magic-link
        // page with no password field (launch C2 check, 2026-10-16).
        if (!signedIn) {
          res.writeHead(302, { location: "/magic-login?return_to=%2Fmagic" });
          res.end();
          return;
        }
        html(
          page(
            "Magic",
            `<h1>Orders</h1><p id="whoami">${currentEmail ?? "someone"}</p>`,
            "#ffffff",
          ),
        );
        return;
      }
      case "/magic-login":
        html(
          page(
            "Log in",
            `<h1>Log in</h1><input id="magic_email" type="email" aria-label="Email"><button>Email me a link</button>`,
            "#ffffff",
          ),
        );
        return;
      case "/dev/sign-in-as": {
        // A dev-only route that signs a known email in by GET, as an agent
        // adds to a magic-link app; an unknown email is a 404.
        const email = url.searchParams.get("email") ?? "";
        if (options.accounts !== undefined && !(email in options.accounts)) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("No user with that email");
          return;
        }
        asCounts.set(email, (asCounts.get(email) ?? 0) + 1);
        const value =
          options.accounts === undefined
            ? valid()
            : `${valid()}-${encodeURIComponent(email)}`;
        res.writeHead(302, {
          "set-cookie": `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax`,
          location: "/magic",
        });
        res.end();
        return;
      }
      case "/admin-only":
        // Always the sign-in page, whoever asks: an area this app's
        // accounts cannot open (launch C2, signInFailed).
        res.writeHead(302, { location: "/login?return_to=%2Fadmin-only" });
        res.end();
        return;
      case "/account/password": {
        // An in-app page with a password field, behind the login: a run that
        // stops here is not signed out (launch C, mid-run re-label).
        if (!signedIn) {
          res.writeHead(302, {
            location: "/login?return_to=%2Faccount%2Fpassword",
          });
          res.end();
          return;
        }
        html(
          page(
            "Change password",
            `<h1>Change password</h1>` +
              `<input type="password" aria-label="New password">` +
              `<button>Save</button>`,
            "#ffffff",
          ),
        );
        return;
      }
      case "/login": {
        const back = url.searchParams.get("return_to");
        const action =
          back === null || back === "/app"
            ? "/login"
            : `/login?return_to=${encodeURIComponent(back)}`;
        html(
          page(
            "Sign in",
            `${form(action)}<a href="/signup">Create account</a>${autoSubmit()}`,
            "#ff00ff",
          ),
        );
        return;
      }
      case "/signup":
        html(
          page(
            "Create account",
            `<h1>Create account</h1><input aria-label="Email">` +
              `<input type="password" aria-label="Choose a password">` +
              `<button>Create account</button>`,
            "#ffffff",
          ),
        );
        return;
      case "/typing":
        html(
          page(
            "Fields",
            `<input type="password" data-testid="pw" aria-label="Password">` +
              `<input type="text" data-testid="nick" aria-label="Nickname">` +
              // A password field the way most sign-in forms label it: a
              // snapshot lists the label and never the input (launch C,
              // final review 1).
              `<label for="acct-pw">Account password</label>` +
              `<input id="acct-pw" type="password">`,
            "#ffffff",
          ),
        );
        return;
      case "/opener":
        // A page that opens another, as a recorded app's pop-out does.
        html(
          page(
            "Opener",
            `<h1>Opener</h1><script>window.open("/held-page")</script>`,
            "#ffffff",
          ),
        );
        return;
      case "/held-page":
        // Alive exactly while its event stream is: `held()` counts it.
        html(
          page(
            "Held",
            `<h1>Held</h1><script>new EventSource("/held")</script>`,
            "#ffffff",
          ),
        );
        return;
      case "/held":
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": open\n\n");
        streams.add(res);
        res.on("close", () => streams.delete(res));
        return;
      case "/forged-login": {
        // The password field claims to live on `?claim=`'s origin: an own
        // `ownerDocument` getter, which page-world code reads (audit run 1).
        // Its input listener posts whatever is typed, as a thief's would.
        const claim = JSON.stringify(url.searchParams.get("claim") ?? "");
        html(
          page(
            "Sign in",
            `${form("/login")}<script>const f=document.getElementById("user_password");` +
              `Object.defineProperty(f,"ownerDocument",{configurable:true,get:()=>({location:{origin:${claim}}})});` +
              `f.addEventListener("input",()=>navigator.sendBeacon("/leak",f.value))</script>`,
            "#ff00ff",
          ),
        );
        return;
      }
      case "/hostile":
        // A page whose own script breaks querySelectorAll: the sign-in check
        // cannot read it (launch C's `landing.unchecked`).
        html(
          page(
            "Hostile",
            `<button>Next</button><script>Document.prototype.querySelectorAll=function(){throw new Error("hostile page")}</script>`,
            "#ffffff",
          ),
        );
        return;
      case "/hostile-check":
        // Breaks only the sign-in check (it asks a password field whether it
        // is visible), not the snapshot's walk: a snapshot whose check
        // cannot read the page (`session: "unchecked"`). /hostile breaks the
        // walk too.
        html(
          page(
            "Hostile check",
            `<button>Next</button><input type="password" aria-label="Code">` +
              `<script>const o=Element.prototype.checkVisibility;Element.prototype.checkVisibility=function(...a){if(this.getAttribute("type")==="password")throw new Error("hostile check");return o.apply(this,a)}</script>`,
            "#ffffff",
          ),
        );
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    signIns: () => signIns,
    releaseSignIn: () => {
      released = true;
    },
    gets: (pathname) => getCounts.get(pathname) ?? 0,
    held: () => streams.size,
    expireAll: () => {
      generation += 1;
    },
    validCookie: valid,
    validCookieFor: (email) => `${valid()}-${encodeURIComponent(email)}`,
    dashboardsServedTo: () => [...served],
    signInsAs: (email) => asCounts.get(email) ?? 0,
    bodies: () => [...bodies],
    lastPage: () => last,
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of held) r.destroy();
        for (const r of streams) r.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A session file for this app, holding `value` as its cookie. */
export const sessionFor = (app: LoginApp, value: string): SessionFile => ({
  sessionVersion: 1,
  site: "localhost",
  savedAt: "2026-10-15T09:00:00.000Z",
  refreshedAt: null,
  startUrl: `${app.url}/app`,
  signInUrl: `${app.url}/login?return_to=%2Fapp`,
  state: {
    cookies: [
      {
        name: SESSION_COOKIE,
        value,
        domain: "127.0.0.1",
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

/** `env` with each `DEMOMAN_SECRET_*` bound to `origin` by its `_ORIGIN`,
 *  as an environment secret must be to be typed (rc.3). */
export const boundTo = (
  env: NodeJS.ProcessEnv,
  origin: string,
): NodeJS.ProcessEnv => ({
  ...env,
  ...Object.fromEntries(
    Object.keys(env)
      .filter((k) => k.startsWith("DEMOMAN_SECRET_") && !k.endsWith("_ORIGIN"))
      .map((k) => [`${k}_ORIGIN`, origin]),
  ),
});
