import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_FILE,
  type AppSpec,
  FLOWS_DIR,
  RECEIPT_DIR,
  scriptDigest,
  serializeApp,
} from "@demoman/run-core";
import type { GitRunner, Verified } from "@demoman/runner/package";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubFacts } from "../src/ci-github.js";
import type { NeededSecret } from "../src/ci-secrets.js";
import {
  applyCiSetup,
  type CiDeps,
  type CiPlan,
  type CiStop,
  defaultTrigger,
  planCiSetup,
  planLines,
  triggerOffers,
} from "../src/ci-setup.js";
import { DEPLOYMENT_MAIN } from "../src/ci-workflow.js";

const ORIGIN = "http://127.0.0.1:3999";
const VALUE = "hunter2-very-secret-value";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const app = (over: Partial<AppSpec> = {}): AppSpec => ({
  appVersion: 1,
  install: ["pnpm install --frozen-lockfile"],
  start: "pnpm run dev",
  url: `${ORIGIN}/`,
  timeoutSeconds: 120,
  env: {},
  secrets: [],
  services: {
    postgres: {
      image: "postgres:16",
      ports: ["5432:5432"],
      env: {},
      options: null,
    },
  },
  ...over,
});

/** A repo with one commit-delivered flow, its receipt, screens and output. */
const SCRIPT = {
  scriptVersion: 1,
  name: "Checkout",
  target: `${ORIGIN}/`,
  viewport: { width: 1280, height: 800 },
  steps: [{ do: "waitForLoad" }],
} as const;
const EDITED = { ...SCRIPT, steps: [{ do: "click", target: { text: "Pay" } }] };

/** `digest`: the receipt's script digest is the committed script's (match),
 *  another script's (edited), or not recorded (absent). */
async function repo(
  o: {
    flows?: boolean;
    appJson?: string;
    digest?: "match" | "edited" | "absent";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "demoman-ci-setup-"));
  dirs.push(root);
  const flow = randomUUID();
  if (o.flows !== false) {
    await mkdir(join(root, FLOWS_DIR), { recursive: true });
    await writeFile(
      join(root, FLOWS_DIR, "checkout.json"),
      JSON.stringify({
        keptVersion: 2,
        flow,
        deliver: "commit",
        name: "Checkout",
        script: SCRIPT,
        scale: 1,
        logo: null,
        wallpaper: null,
        outputs: [
          {
            path: "docs/o.mp4",
            fileType: "mp4",
            aspect: "16:9",
            quality: "share",
          },
        ],
        report: null,
      }),
    );
    await mkdir(join(root, RECEIPT_DIR, "checkout.screens"), {
      recursive: true,
    });
    await writeFile(
      join(root, RECEIPT_DIR, "checkout.json"),
      JSON.stringify({
        receiptVersion: 2,
        flow,
        video: "take-1",
        filmedAt: null,
        filmedCode: { commit: "abc", tree: "def", dirty: false },
        recordedRevision: null,
        ...{
          match: { scriptDigest: digestOf(SCRIPT) },
          edited: { scriptDigest: digestOf(EDITED) },
          absent: {},
        }[o.digest ?? "match"],
        screensDir: "checkout.screens",
        screensSize: { width: 1280, height: 800 },
        screens: { steps: 1, moments: [{ step: null, ms: 100 }] },
      }),
    );
    await writeFile(
      join(root, RECEIPT_DIR, "checkout.screens", "0.webp"),
      "img",
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "o.mp4"), "video");
  }
  if (o.appJson !== undefined) {
    await mkdir(join(root, ".demoman"), { recursive: true });
    await writeFile(join(root, APP_FILE), o.appJson);
  }
  return root;
}

const facts = (over: Partial<GithubFacts> = {}): GithubFacts => ({
  slug: "o/r",
  defaultBranch: "trunk",
  canPush: true,
  isAdmin: true,
  deployments: [],
  hasReleases: false,
  workflowOnDefault: false,
  setupBranch: null,
  ...over,
});

const passed: Verified = {
  passed: true,
  flow: "Checkout",
  outcome: "unchanged",
  recordSeconds: 8,
  appSeconds: 4,
  lines: [],
};
const account = (name: string): NeededSecret => ({
  name,
  for: "account",
  why: "account seller",
});

/** Every dep faked; `calls` names each in the order it ran. */
function fakes(
  o: {
    github?: Awaited<ReturnType<CiDeps["readGithub"]>>;
    needed?: NeededSecret[];
    local?: Awaited<ReturnType<CiDeps["localValues"]>>;
    existing?: string[];
    verified?: Verified;
    head?: Record<string, string>;
    onDefault?: string[];
    detected?: Awaited<ReturnType<CiDeps["detectApp"]>>;
  } = {},
) {
  const calls: string[] = [];
  const logged: string[] = [];
  const seen: {
    verify?: Parameters<CiDeps["verifySetup"]>;
    pr?: Parameters<CiDeps["openSetupPr"]>[0];
    set?: Parameters<CiDeps["setSecrets"]>;
  } = {};
  const shown = { ...(o.head ?? {}) };
  const gitArgs: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(`git ${args[0]}`);
    gitArgs.push(args);
    if (args[0] === "ls-tree")
      return { code: 0, stdout: (o.onDefault ?? []).join("\n"), stderr: "" };
    if (args[0] === "show") {
      const text = shown[args[1] as string];
      return text === undefined
        ? { code: 128, stdout: "", stderr: "fatal: path does not exist" }
        : { code: 0, stdout: text, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const deps: CiDeps = {
    version: "0.9.0",
    env: {},
    git,
    log: (l) => logged.push(l),
    readGithub: async () => {
      calls.push("readGithub");
      return o.github ?? facts();
    },
    detectApp: async () => {
      calls.push("detectApp");
      return (
        o.detected ?? {
          draft: app(),
          source: { kind: "packageJson", file: "package.json" },
          holes: [],
        }
      );
    },
    neededSecrets: async () => {
      calls.push("neededSecrets");
      return { needed: o.needed ?? [] };
    },
    localValues: async () => {
      calls.push("localValues");
      return o.local ?? { values: new Map(), missing: [], tooShort: [] };
    },
    envFileValues: async () => {
      calls.push("envFileValues");
      return new Map();
    },
    existingSecrets: async () => {
      calls.push("existingSecrets");
      return o.existing ?? [];
    },
    verifySetup: async (...a) => {
      calls.push("verifySetup");
      seen.verify = a;
      return o.verified ?? passed;
    },
    setSecrets: async (...a) => {
      calls.push("setSecrets");
      seen.set = a;
      return { set: [...a[1].keys()], kept: [], failed: [] };
    },
    allowActionPullRequests: async () => {
      calls.push("allowActionPullRequests");
      return { kind: "turnedOn" };
    },
    openSetupPr: async (a) => {
      calls.push("openSetupPr");
      seen.pr = a;
      return {
        opened: {
          number: 7,
          url: "https://github.com/o/r/pull/7",
          branch: "demoman/setup",
          sha: "s1",
        },
      };
    },
    watchSetupRun: async () => {
      calls.push("watchSetupRun");
      return {
        passed: {
          runUrl: "https://run",
          artifactUrl: "https://art",
          lines: [],
        },
      };
    },
  };
  return { deps, calls, logged, seen, gitArgs };
}

const digestOf = (s: unknown) =>
  scriptDigest(s as Parameters<typeof scriptDigest>[0]);

const isStop = (r: unknown): r is CiStop =>
  typeof r === "object" && r !== null && "reason" in r;
async function plan(
  root: string,
  f: ReturnType<typeof fakes>,
  choices = {},
  values = new Map<string, string>(),
) {
  const r = await planCiSetup(root, { app: app(), ...choices }, f.deps, values);
  return r;
}
async function okPlan(
  root: string,
  f: ReturnType<typeof fakes>,
  choices = {},
  values = new Map<string, string>(),
) {
  const r = await plan(root, f, choices, values);
  if (isStop(r)) throw new Error(`stopped: ${r.reason}: ${r.detail}`);
  return r;
}

describe("triggerOffers and defaultTrigger", () => {
  it("lists deployment per environment, release, daily, push, in that order", () => {
    const offers = triggerOffers(
      facts({
        deployments: [
          { environment: "production", url: "https://x.example", sha: "a" },
        ],
        hasReleases: true,
      }),
    );
    expect(offers.map((o) => [o.trigger, o.offered])).toEqual([
      [{ deployment: "production" }, true],
      ["release", true],
      ["daily", true],
      ["push", true],
    ]);
    // The real branch, not "main".
    expect(offers[3]?.label).toContain("trunk");
  });

  it("offers no deployment without one on record and no release without one", () => {
    const offers = triggerOffers(facts());
    const of = (t: string) =>
      offers.find(
        (o) => (typeof o.trigger === "string" ? o.trigger : "deployment") === t,
      );
    expect(of("deployment")?.offered).toBe(false);
    expect(of("release")?.offered).toBe(false);
    expect(of("daily")?.offered).toBe(true);
  });

  // Decision 3: deployment, else release, else daily; never push.
  it("defaults to deployment, else release, else daily, never push", () => {
    const dep = facts({
      deployments: [
        { environment: "production", url: "https://x.example", sha: "a" },
      ],
      hasReleases: true,
    });
    expect(defaultTrigger(triggerOffers(dep))).toEqual({
      deployment: "production",
    });
    expect(defaultTrigger(triggerOffers(facts({ hasReleases: true })))).toBe(
      "release",
    );
    expect(defaultTrigger(triggerOffers(facts()))).toBe("daily");
    // Even when push is the first offered, it is never the default.
    expect(
      defaultTrigger([
        { trigger: "push", label: "", offered: true, why: "" },
        { trigger: "daily", label: "", offered: true, why: "" },
      ]),
    ).toBe("daily");
  });
});

// Finding 7. Red: offer every environment, or take the newest offered.
describe("which deployment is offered and the default", () => {
  const d = (
    environment: string,
    more: Partial<GithubFacts["deployments"][number]> = {},
  ) => ({
    environment,
    url: `https://${environment}.example`,
    sha: "a",
    ...more,
  });

  it("offers no environment the workflow cannot quote, saying why", () => {
    const offers = triggerOffers(facts({ deployments: [d("prod's")] }));
    expect(offers[0]).toMatchObject({
      trigger: { deployment: "prod's" },
      offered: false,
    });
    expect(offers[0]?.why).toContain("cannot quote");
    expect(defaultTrigger(offers)).toBe("daily");
  });

  it("defaults to a production environment over a newer other one", () => {
    const offers = triggerOffers(
      facts({
        deployments: [d("staging"), d("live", { production: true })],
      }),
    );
    expect(offers.map((o) => o.trigger)).toEqual([
      { deployment: "live" },
      { deployment: "staging" },
      "release",
      "daily",
      "push",
    ]);
    expect(defaultTrigger(offers)).toEqual({ deployment: "live" });
  });

  it("offers a transient environment but never defaults to it", () => {
    const offers = triggerOffers(
      facts({
        deployments: [d("pr-12", { transient: true })],
        hasReleases: true,
      }),
    );
    expect(offers[0]).toMatchObject({ offered: true, transient: true });
    expect(defaultTrigger(offers)).toBe("release");
  });
});

describe("planCiSetup stops, in order, before anything later runs", () => {
  it("gh unusable: its reason and detail, nothing else read", async () => {
    const f = fakes({
      github: {
        reason: "ghSignedOut",
        detail: "gh is not signed in; run `gh auth login`",
      },
    });
    const r = await plan(await repo(), f);
    expect(r).toEqual({
      reason: "ghSignedOut",
      detail: "gh is not signed in; run `gh auth login`",
    });
    expect(f.calls).toEqual(["readGithub"]);
  });

  it("already set up on the default branch", async () => {
    const f = fakes({ github: facts({ workflowOnDefault: true }) });
    const r = await plan(await repo(), f);
    expect(isStop(r) && r.reason).toBe("alreadySetUp");
    expect(f.calls).toEqual(["readGithub"]);
  });

  it("an open setup pull request, named", async () => {
    const f = fakes({
      github: facts({
        setupBranch: {
          pr: { number: 9, url: "https://github.com/o/r/pull/9" },
        },
      }),
    });
    const r = await plan(await repo(), f);
    expect(isStop(r) && r.reason).toBe("setupPrOpen");
    expect(isStop(r) && r.detail).toContain("https://github.com/o/r/pull/9");
    expect(f.calls).toEqual(["readGithub"]);
  });

  it("no repo flows: names `npx demoman add`", async () => {
    const f = fakes();
    const r = await plan(await repo({ flows: false }), f, { app: undefined });
    expect(isStop(r) && r.reason).toBe("noRepoFlows");
    expect(isStop(r) && r.detail).toContain("npx demoman add");
    expect(f.calls).toEqual(["readGithub"]);
  });

  it("a deployment trigger with no deployment on record", async () => {
    const f = fakes();
    const r = await plan(await repo(), f, {
      trigger: { deployment: "production" },
    });
    expect(isStop(r) && r.reason).toBe("noDeployment");
    expect(f.calls).toEqual(["readGithub"]);
  });

  it("a deployment trigger with route main: DEPLOYMENT_MAIN", async () => {
    const f = fakes({
      github: facts({
        deployments: [
          { environment: "production", url: "https://x.example", sha: "a" },
        ],
      }),
    });
    const r = await plan(await repo(), f, {
      trigger: { deployment: "production" },
      route: "main",
    });
    expect(r).toEqual({ reason: "routeRefused", detail: DEPLOYMENT_MAIN });
    expect(f.calls).toEqual(["readGithub"]);
  });

  it("holes in the detected app: each named, no secrets read, no check", async () => {
    const f = fakes({
      detected: {
        draft: { ...app(), start: null, url: null },
        source: { kind: "packageJson", file: "package.json" },
        holes: [
          { field: "start", why: "no start or dev script" },
          { field: "url", why: "no recorded origin to serve" },
        ],
      },
    });
    const r = await plan(await repo(), f, { app: undefined });
    expect(isStop(r) && r.reason).toBe("appHoles");
    expect(isStop(r) && r.detail).toContain("start (no start or dev script)");
    expect(isStop(r) && r.detail).toContain(
      "url (no recorded origin to serve)",
    );
    expect(isStop(r) && r.proposal?.holes).toHaveLength(2);
    expect(f.calls.filter((c) => !c.startsWith("git"))).toEqual([
      "readGithub",
      "detectApp",
    ]);
  });

  it("a missing secret: named, never a value, and the check never ran", async () => {
    const f = fakes({
      needed: [
        account("DEMOMAN_SECRET_SELLER"),
        account("DEMOMAN_SECRET_SELLER_ORIGIN"),
        account("DEMOMAN_SECRET_BUYER"),
      ],
      local: {
        values: new Map([["DEMOMAN_SECRET_SELLER", VALUE]]),
        missing: [],
        tooShort: [],
      },
    });
    const r = await plan(
      await repo(),
      f,
      {},
      new Map([["DEMOMAN_SECRET_SELLER_ORIGIN", ORIGIN]]),
    );
    expect(isStop(r) && r.reason).toBe("secretMissing");
    expect(isStop(r) && r.detail).toContain("DEMOMAN_SECRET_BUYER");
    expect(isStop(r) && r.secrets?.map((n) => n.name)).toEqual([
      "DEMOMAN_SECRET_BUYER",
    ]);
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(f.calls).not.toContain("verifySetup");
  });

  it("a secret too short: named, never its value", async () => {
    const f = fakes({
      needed: [account("DEMOMAN_SECRET_SELLER")],
      local: {
        values: new Map(),
        missing: [],
        tooShort: ["DEMOMAN_SECRET_SELLER"],
      },
    });
    const r = await plan(await repo(), f);
    expect(isStop(r) && r.reason).toBe("secretTooShort");
    expect(isStop(r) && r.detail).toContain("DEMOMAN_SECRET_SELLER");
    expect(f.calls).not.toContain("verifySetup");
    // A short value given by the door is refused the same way.
    const g = fakes({ needed: [account("DEMOMAN_SECRET_SELLER")] });
    const s = await plan(
      await repo(),
      g,
      {},
      new Map([["DEMOMAN_SECRET_SELLER", "ab"]]),
    );
    expect(isStop(s) && s.reason).toBe("secretTooShort");
    expect(JSON.stringify(s)).not.toContain('"ab"');
  });

  // Finding 8, red: the minimum applies to the app's secrets again.
  it("an app secret shorter than the account minimum is planned, not refused", async () => {
    const f = fakes({
      needed: [{ name: "PIN", for: "app", why: "app.json" }],
    });
    const values = new Map([["PIN", "1234"]]);
    const p = await okPlan(await repo(), f, {}, values);
    expect(p.secrets).toEqual([{ name: "PIN", status: "set" }]);
  });

  it("an unread secrets.env is said with the missing names", async () => {
    const f = fakes({
      needed: [account("DEMOMAN_SECRET_SELLER")],
      local: {
        values: new Map(),
        missing: ["DEMOMAN_SECRET_SELLER"],
        tooShort: [],
        unread: ".demoman/secrets.env is not ignored by git",
      },
    });
    const r = await plan(await repo(), f);
    expect(isStop(r) && r.reason).toBe("secretMissing");
    expect(isStop(r) && r.detail).toContain(
      ".demoman/secrets.env is not ignored by git",
    );
  });

  it("a failed check is a stop with its step, detail and tail", async () => {
    const f = fakes({
      verified: {
        passed: false,
        step: "app",
        reason: "appNeverAnswered",
        detail: "nothing answered",
        tail: "last lines",
      },
    });
    const r = await plan(await repo(), f);
    expect(r).toMatchObject({
      reason: "appNeverAnswered",
      step: "app",
      tail: "last lines",
    });
    expect(isStop(r) && r.detail).toContain("nothing answered");
    // Nothing ran after the check.
    expect(f.calls.at(-1)).toBe("verifySetup");
  });

  // Red if a check's output reaches a stop unredacted: the app gets every value.
  it("a value the app echoed is redacted from the check's detail and tail", async () => {
    const f = fakes({
      needed: [
        account("DEMOMAN_SECRET_SELLER"),
        account("DEMOMAN_SECRET_SELLER_ORIGIN"),
      ],
      verified: {
        passed: false,
        step: "app",
        reason: "appExited",
        detail: `exited; env had ${VALUE}`,
        tail: `SELLER=${VALUE}\nORIGIN=${ORIGIN}`,
      },
    });
    const r = await plan(
      await repo(),
      f,
      {},
      new Map([
        ["DEMOMAN_SECRET_SELLER", VALUE],
        ["DEMOMAN_SECRET_SELLER_ORIGIN", ORIGIN],
      ]),
    );
    expect(isStop(r) && r.tail).toBe(`SELLER=<redacted>\nORIGIN=${ORIGIN}`);
    expect(isStop(r) && r.detail).toContain("env had <redacted>");
    expect(JSON.stringify(r)).not.toContain(VALUE);
  });

  it("a passed check's lines are redacted too", async () => {
    const f = fakes({
      needed: [account("DEMOMAN_SECRET_SELLER")],
      verified: { ...passed, lines: [`started with ${VALUE}`] },
    });
    const p = await okPlan(
      await repo(),
      f,
      {},
      new Map([["DEMOMAN_SECRET_SELLER", VALUE]]),
    );
    expect("passed" in p.check && p.check.lines).toEqual([
      "started with <redacted>",
    ]);
  });

  it("a stopped check is said as stopped", async () => {
    const f = fakes({
      verified: {
        passed: false,
        step: "app",
        reason: "checkStopped",
        detail: "stopped; removed the checkout at /tmp/x",
        tail: "",
      },
    });
    const r = await plan(await repo(), f);
    expect(r).toEqual({
      reason: "checkStopped",
      detail: "stopped; removed the checkout at /tmp/x; nothing was written",
    });
  });

  // Red: drop the plan's appOriginMismatch check; CI's refresh refuses it
  // after the check passed on the one flow it recorded.
  it("an app.json that serves some flows but not all stops before the check, naming each", async () => {
    const f = fakes();
    const r = await plan(await repo(), f, {
      app: app({ url: "http://localhost:4000/" }),
    });
    expect(isStop(r) && r.reason).toBe("appOriginMismatch");
    expect(isStop(r) && r.detail).toContain(
      "starts the app at http://localhost:4000, but Checkout (http://127.0.0.1:3999) records elsewhere",
    );
    expect(f.calls).not.toContain("verifySetup");
    expect(f.calls).not.toContain("neededSecrets");
  });

  it("a deployment trigger records the deployed app, so app.json's origin is not compared", async () => {
    const f = fakes({
      github: facts({
        deployments: [
          { environment: "production", url: "https://x.example", sha: "a" },
        ],
      }),
    });
    await okPlan(await repo(), f, {
      app: app({ url: "http://localhost:4000/" }),
    });
  });

  it("a release trigger with no release on record is refused", async () => {
    const f = fakes();
    const r = await plan(await repo(), f, { trigger: "release" });
    expect(isStop(r) && r.reason).toBe("noRelease");
    expect(f.calls).toEqual(["readGithub"]);
  });

  it("a read that fails other than missing is a named stop, not a rejection", async () => {
    const root = await repo();
    // A file where the screens folder should be: readdir fails ENOTDIR.
    await rm(join(root, RECEIPT_DIR, "checkout.screens"), { recursive: true });
    await writeFile(
      join(root, RECEIPT_DIR, "checkout.screens"),
      "not a folder",
    );
    const r = await plan(root, fakes());
    expect(isStop(r) && r.reason).toBe("setupUnreadable");
    expect(isStop(r) && r.detail).toContain("ENOTDIR");
    expect(isStop(r) && r.detail).toContain("checkout.screens");
  });
});

describe("planCiSetup's plan", () => {
  it("says what the check will run before it runs, and passes the stop signal through", async () => {
    const f = fakes();
    const signal = new AbortController().signal;
    f.deps.signal = signal;
    const order: string[] = [];
    const log = f.deps.log;
    f.deps.log = (l) => {
      order.push("log");
      log(l);
    };
    const verify = f.deps.verifySetup;
    f.deps.verifySetup = (...a) => {
      order.push("verify");
      return verify(...a);
    };
    await okPlan(await repo(), f);
    expect(order[0]).toBe("log");
    expect(f.logged[0]).toContain("pnpm install --frozen-lockfile");
    expect(f.logged[0]).toContain("pnpm run dev");
    expect(f.logged[0]).toContain("postgres");
    expect(f.seen.verify?.[1].signal).toBe(signal);
  });

  it("a deployment check names the deployment URL and has no app to start", async () => {
    const f = fakes({
      github: facts({
        deployments: [
          { environment: "production", url: "https://x.example", sha: "a" },
        ],
      }),
    });
    const p = await okPlan(await repo(), f, { app: undefined });
    expect(p.trigger).toEqual({ deployment: "production" });
    expect(p.app).toBeNull();
    expect(f.calls).not.toContain("detectApp");
    expect(f.logged[0]).toContain("https://x.example");
    expect(f.seen.verify?.[0].target).toEqual({
      baseUrl: "https://x.example",
      environment: "production",
    });
  });

  // R30, red: planLines says "Starts the app" whenever app.json is there.
  it("a deployment plan with app.json says it records the deployment and starts no app", async () => {
    const f = fakes({
      github: facts({
        deployments: [
          { environment: "production", url: "https://x.example", sha: "a" },
        ],
      }),
    });
    const p = await okPlan(await repo(), f);
    expect(p.app, "premise: app.json is in the plan").not.toBeNull();
    const said = planLines(p);
    expect(said).toContain(
      "Starts no app: records the newest successful production deployment (now https://x.example).",
    );
    expect(said.join("\n")).not.toContain("Starts the app");
  });

  it("holds the workflow, app.json and the flow's delivery when none is on the default branch", async () => {
    const f = fakes();
    const p = await okPlan(await repo({ digest: "match" }), f);
    // The receipt's digest is the committed script's: the whole delivery.
    expect(p.scriptOnly).toEqual([]);
    expect(p.files).toEqual([
      ".github/workflows/demoman.yml",
      APP_FILE,
      `${FLOWS_DIR}/checkout.json`,
      `${RECEIPT_DIR}/checkout.json`,
      `${RECEIPT_DIR}/checkout.screens/0.webp`,
      "docs/o.mp4",
    ]);
    expect(p.branch).toBe("demoman/setup");
    expect(p.title).toBe("Set up Demoman");
    // The check sees the same files.
    expect(f.seen.verify?.[0].files.map((x) => x.path)).toEqual(p.files);
  });

  it("leaves out a flow already on the default branch", async () => {
    const f = fakes({ onDefault: [`${FLOWS_DIR}/checkout.json`] });
    const p = await okPlan(await repo(), f);
    expect(p.files).not.toContain(`${FLOWS_DIR}/checkout.json`);
    expect(p.files).not.toContain("docs/o.mp4");
    // The flow folders only, never the whole tree (git's output buffer).
    expect(f.gitArgs.find((a) => a[0] === "ls-tree")).toEqual([
      "ls-tree",
      "-r",
      "--name-only",
      "origin/trunk",
      "--",
      ".demoman",
    ]);
  });

  // R6: the working tree's app.json, proposed unless committed as is.
  it("reads app.json from the working tree and leaves it out when committed as is", async () => {
    const text = serializeApp(app());
    const committed = fakes({
      head: { [`HEAD:${APP_FILE}`]: text, [`origin/trunk:${APP_FILE}`]: text },
    });
    const p = await okPlan(await repo({ appJson: text }), committed, {
      app: undefined,
    });
    expect(p.app?.spec.start).toBe("pnpm run dev");
    expect(committed.calls).not.toContain("detectApp");
    expect(p.files).not.toContain(APP_FILE);

    const edited = fakes({
      head: { [`HEAD:${APP_FILE}`]: serializeApp(app({ start: "npm start" })) },
    });
    const q = await okPlan(await repo({ appJson: text }), edited, {
      app: undefined,
    });
    expect(q.files).toContain(APP_FILE);
  });

  // R5: a delivery that does not match the committed script goes in as the script alone.
  // R24: match, edited and absent.
  it.each([
    ["edited", "does not match the script being committed"],
    ["absent", "no script digest in its receipt"],
  ] as const)(
    "a receipt whose digest is %s: the script alone, said",
    async (digest, why) => {
      const p = await okPlan(await repo({ digest }), fakes());
      expect(p.files).toContain(`${FLOWS_DIR}/checkout.json`);
      for (const f of [
        `${RECEIPT_DIR}/checkout.json`,
        `${RECEIPT_DIR}/checkout.screens/0.webp`,
        "docs/o.mp4",
      ])
        expect(p.files).not.toContain(f);
      expect(p.scriptOnly).toEqual([{ flow: "Checkout", why }]);
      expect(planLines(p).join("\n")).toContain(
        `Checkout: the script alone (${why}); the first run delivers it as new.`,
      );
    },
  );

  it("a flow whose delivery is incomplete goes in as the script alone, said", async () => {
    const root = await repo();
    await rm(join(root, "docs", "o.mp4"));
    const p = await okPlan(root, fakes());
    expect(p.files).toContain(`${FLOWS_DIR}/checkout.json`);
    expect(p.files).not.toContain(`${RECEIPT_DIR}/checkout.json`);
    expect(p.scriptOnly).toEqual([
      { flow: "Checkout", why: "docs/o.mp4 is missing" },
    ]);
    expect(planLines(p).join("\n")).toContain(
      "Checkout: the script alone (docs/o.mp4 is missing)",
    );
  });

  it("an app.json that does not parse stops, naming the file", async () => {
    const f = fakes();
    const r = await plan(await repo({ appJson: "{" }), f, { app: undefined });
    expect(isStop(r) && r.reason).toBe("appInvalid");
    expect(f.calls).not.toContain("neededSecrets");
  });

  it("secrets: set, replace, keep by what GitHub has", async () => {
    const f = fakes({
      needed: [
        account("DEMOMAN_SECRET_A"),
        account("DEMOMAN_SECRET_B"),
        account("DEMOMAN_SECRET_C"),
      ],
      existing: ["DEMOMAN_SECRET_B", "DEMOMAN_SECRET_C"],
    });
    const values = new Map([
      ["DEMOMAN_SECRET_A", VALUE],
      ["DEMOMAN_SECRET_B", VALUE],
      ["DEMOMAN_SECRET_C", VALUE],
    ]);
    const p = await okPlan(
      await repo(),
      f,
      { replaceSecrets: ["DEMOMAN_SECRET_C"] },
      values,
    );
    expect(p.secrets).toEqual([
      { name: "DEMOMAN_SECRET_A", status: "set" },
      { name: "DEMOMAN_SECRET_B", status: "keep" },
      { name: "DEMOMAN_SECRET_C", status: "replace" },
    ]);
    // The check gets the values; the plan never does.
    expect(f.seen.verify?.[0].secrets).toEqual(Object.fromEntries(values));
    expect(JSON.stringify(p)).not.toContain(VALUE);
    const lines = planLines(p);
    for (const n of [
      "DEMOMAN_SECRET_A",
      "DEMOMAN_SECRET_B",
      "DEMOMAN_SECRET_C",
    ])
      expect(lines.some((l) => l.includes(n))).toBe(true);
    expect(lines.join("\n")).not.toContain(VALUE);
  });

  it("push cost: null unless push, else flows × (record + app) seconds", async () => {
    const daily = await okPlan(await repo(), fakes(), { trigger: "daily" });
    expect(daily.pushCost).toBeNull();
    const push = await okPlan(await repo(), fakes(), { trigger: "push" });
    expect(push.pushCost).toBe(
      "about 12 s of runner time per merge: the app starts in 4 s, then 1 flow × 8 s measured here",
    );
    expect(planLines(push).join("\n")).toContain(push.pushCost as string);
  });

  it("a skipped check stays in the plan as said", async () => {
    const f = fakes({ verified: { skipped: "Docker does not answer here" } });
    const p = await okPlan(await repo(), f);
    expect(p.check).toEqual({ skipped: "Docker does not answer here" });
    expect(planLines(p).join("\n")).toContain("Docker does not answer here");
  });
});

describe("applyCiSetup", () => {
  async function ready(over: Parameters<typeof fakes>[0] = {}) {
    const f = fakes({ needed: [account("DEMOMAN_SECRET_A")], ...over });
    const values = new Map([["DEMOMAN_SECRET_A", VALUE]]);
    const p = await okPlan(await repo(), f, {}, values);
    f.calls.length = 0;
    return { f, p, values };
  }

  // Red if apply reads the files again: an edit while the confirmation
  // waits would reach the pull request unchecked.
  it("commits the bytes the check ran with, never a fresh read", async () => {
    const f = fakes();
    const root = await repo();
    const p = await okPlan(root, f);
    const flowPath = `${FLOWS_DIR}/checkout.json`;
    const checked = f.seen.verify?.[0].files.find((x) => x.path === flowPath);
    await writeFile(join(root, flowPath), "edited after the plan");
    await applyCiSetup(p, f.deps, new Map());
    const sent = f.seen.pr?.files.find((x) => x.path === flowPath);
    expect(Buffer.from(sent?.text ?? "").toString()).toBe(
      Buffer.from(checked?.text ?? "").toString(),
    );
    expect(Buffer.from(sent?.text ?? "").toString()).not.toBe(
      "edited after the plan",
    );
    // Never serialized: the plan as JSON, and a copy, carry no bytes.
    expect(JSON.stringify(p)).not.toContain("contents");
    const copied = await applyCiSetup({ ...p }, f.deps, new Map());
    expect(isStop(copied) && copied.reason).toBe("planWithoutFiles");
  });

  it("sets secrets, turns the setting on, opens the PR, then watches", async () => {
    const { f, p, values } = await ready();
    const r = await applyCiSetup(p, f.deps, values);
    expect(f.calls.filter((c) => !c.startsWith("git"))).toEqual([
      "setSecrets",
      "allowActionPullRequests",
      "openSetupPr",
      "watchSetupRun",
    ]);
    expect(r).toMatchObject({
      setting: { kind: "turnedOn" },
      watched: { passed: {} },
    });
    expect(f.seen.pr?.files.map((x) => x.path)).toEqual(p.files);
    expect(f.seen.pr?.base).toBe("trunk");
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(f.seen.pr?.body).not.toContain(VALUE);
  });

  it("a secret refusal: no setting call, no PR, names what was set and refused", async () => {
    const { f, p, values } = await ready();
    f.deps.setSecrets = async () => {
      f.calls.push("setSecrets");
      return {
        set: [],
        kept: [],
        failed: [{ name: "DEMOMAN_SECRET_A", said: "HTTP 403" }],
      };
    };
    const r = await applyCiSetup(p, f.deps, values);
    expect(isStop(r) && r.reason).toBe("secretRefused");
    expect(isStop(r) && r.detail).toContain("DEMOMAN_SECRET_A");
    expect(f.calls).not.toContain("allowActionPullRequests");
    expect(f.calls).not.toContain("openSetupPr");
    expect(JSON.stringify(r)).not.toContain(VALUE);
  });

  it.each([
    ["refused", "actionsRefused"],
    ["unknown", "actionsUnknown"],
  ] as const)(
    "a setting %s: no PR, and the answer names the setting's URL",
    async (kind, reason) => {
      const { f, p, values } = await ready();
      f.deps.allowActionPullRequests = async () => {
        f.calls.push("allowActionPullRequests");
        return {
          kind,
          detail: "GitHub said no",
          url: "https://github.com/o/r/settings/actions",
        };
      };
      const r = await applyCiSetup(p, f.deps, values);
      expect(isStop(r) && r.reason).toBe(reason);
      expect(isStop(r) && r.detail).toContain(
        "https://github.com/o/r/settings/actions",
      );
      expect(f.calls).not.toContain("openSetupPr");
    },
  );

  it("route main never touches the Actions setting", async () => {
    const f = fakes();
    const p = await okPlan(await repo(), f, {
      trigger: "daily",
      route: "main",
    });
    expect(p.actionsSetting).toBe("notNeeded");
    const r = await applyCiSetup(p, f.deps, new Map());
    expect(f.calls).not.toContain("allowActionPullRequests");
    expect(r).toMatchObject({ setting: null });
  });

  // Red: the line is said only after the watch (up to 33 minutes later).
  it("says the pull request's link before the watch starts", async () => {
    const { f, p, values } = await ready();
    const watch = f.deps.watchSetupRun;
    let before: string[] = [];
    f.deps.watchSetupRun = (a) => {
      before = [...f.logged];
      return watch(a);
    };
    await applyCiSetup(p, f.deps, values);
    expect(before).toContain(
      "Opened the setup pull request: https://github.com/o/r/pull/7",
    );
  });

  it("a PR failure: no watch", async () => {
    const { f, p, values } = await ready();
    f.deps.openSetupPr = async () => {
      f.calls.push("openSetupPr");
      return { failed: "push", detail: "git push exited 1" };
    };
    const r = await applyCiSetup(p, f.deps, values);
    expect(isStop(r) && r.reason).toBe("prFailed");
    expect(isStop(r) && r.detail).toContain("git push exited 1");
    expect(f.calls).not.toContain("watchSetupRun");
  });

  it("a deployment trigger with route main: DEPLOYMENT_MAIN, nothing done", async () => {
    const { f, p, values } = await ready();
    const bad: CiPlan = {
      ...p,
      trigger: { deployment: "production" },
      route: "main",
    };
    const r = await applyCiSetup(bad, f.deps, values);
    expect(r).toEqual({ reason: "routeRefused", detail: DEPLOYMENT_MAIN });
    expect(f.calls.filter((c) => !c.startsWith("git"))).toEqual([]);
  });

  it("a value the plan needs and apply was not given stops before anything", async () => {
    const { f, p } = await ready();
    const r = await applyCiSetup(p, f.deps, new Map());
    expect(isStop(r) && r.reason).toBe("secretMissing");
    expect(f.calls).toEqual([]);
  });
});
