import type { CiState } from "@demoman/studio-protocol";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import libraryHtml from "../../../pages/entrypoints/library/index.html?raw";
import type { CiEvent } from "../../../pages/src/platform/types";
import {
  openRepoSheet,
  type RepoCiDoor,
  type RepoSheetResult,
} from "../../../pages/src/shell/repo-sheet";
import { mountShell, pageParts } from "../helpers/shell-css";

/**
 * The Add to repo sheet's CI steps in Chromium, driven through the real
 * dialog with a stub CI door. The shots go to the scratchpad the task named.
 */
const { css } = pageParts(libraryHtml, "article.card:hover");
const SHOTS = "__screenshots__/repo-sheet-ci";
const SECRET = "hunter2-token-value";

const WRITTEN = [".demoman/flows/checkout.json", "docs/demos/checkout.mp4"];

const plan = {
  repo: { slug: "o/r", defaultBranch: "main", remote: "origin" },
  trigger: "push",
  offers: [
    { trigger: "push", label: "Every push", offered: true, why: "" },
    { trigger: "release", label: "Every release", offered: true, why: "" },
    { trigger: "daily", label: "Daily", offered: false, why: "no" },
  ],
  route: "pr",
  artifact: true,
  app: null,
  deployment: null,
  check: {
    passed: true,
    flow: "Checkout",
    outcome: "recorded in 12 s",
    recordSeconds: 12,
    appSeconds: 3,
    lines: [],
  },
  secrets: [],
  actionsSetting: "alreadyOn",
  files: [],
  scriptOnly: [],
  branch: "demoman/ci",
  title: "Set up CI",
  pushCost: null,
  offBase: null,
};
const planned = {
  planId: "p1",
  plan,
  lines: ["Runs on every push.", "Opens a pull request with 2 files."],
};
const applied = (watched: object) => ({
  pr: {
    opened: {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      branch: "b",
      sha: "s",
    },
  },
  secrets: { set: [], kept: [], failed: [] },
  setting: null,
  watched,
  lines: [],
});

interface Stub {
  door: RepoCiDoor;
  send: (e: Record<string, unknown>) => void;
  plans: Array<{ secrets: Record<string, string> }>;
  prs: unknown[];
}
function stub(state: CiState): Stub {
  let fn: (e: CiEvent) => void = () => {};
  const plans: Stub["plans"] = [];
  const prs: unknown[] = [];
  return {
    plans,
    prs,
    send: (e) => fn({ type: "ci", jobId: "j", ...e } as CiEvent),
    door: {
      state: async () => state,
      plan: async (b) => {
        plans.push(b);
        return { jobId: "j" };
      },
      apply: async () => ({ jobId: "j" }),
      openPr: async (b) => {
        prs.push(b);
        return {
          opened: {
            number: 1,
            url: "https://github.com/o/r/pull/1",
            branch: b.branch,
            sha: "s",
          },
        };
      },
      onCi: (_job, f) => {
        fn = f;
        return () => {};
      },
    },
  };
}

let result: Promise<RepoSheetResult>;
async function openSheet(ci: RepoCiDoor): Promise<HTMLDialogElement> {
  result = openRepoSheet({
    video: { id: "v1", name: "Checkout" },
    addable: { ok: true, root: "/r", defaultPath: "docs/demos/checkout.mp4" },
    repo: {
      addable: async () => ({
        ok: false,
        reason: "x",
        label: "x",
        detail: "x",
      }),
      add: async () => ({ jobId: "a" }),
      remove: async () => ({ removed: [], exportsLeft: [], notes: [] }),
      onRepo: (_job, fn) => {
        queueMicrotask(() =>
          fn({
            type: "repo",
            videoId: "v1",
            jobId: "a",
            phase: "added",
            file: "checkout.json",
            written: WRITTEN,
            notes: [],
            root: "/r",
          }),
        );
        return () => {};
      },
    },
    ci,
  });
  const dialog = await vi.waitFor(() => {
    const d = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (d === null) throw new Error("no sheet");
    return d;
  });
  (dialog.querySelector("[data-repo-add]") as HTMLElement).click();
  await vi.waitFor(() => {
    if (dialog.querySelector("[data-repo-written]") === null)
      throw new Error("not added yet");
  });
  return dialog;
}
const el = <T extends Element>(d: ParentNode, sel: string): Promise<T> =>
  vi.waitFor(() => {
    const found = d.querySelector<T>(sel);
    if (found === null) throw new Error(`no ${sel}`);
    return found;
  });
const shot = (name: string, scheme: string) =>
  page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });

afterEach(() => {
  for (const d of document.querySelectorAll("dialog")) d.remove();
  document.querySelector("[data-toast]")?.remove();
  sessionStorage.clear();
  localStorage.clear();
});

for (const scheme of ["light", "dark"] as const) {
  describe(`Add to repo CI steps, ${scheme}, in a 700 px window`, () => {
    beforeEach(async () => {
      await page.viewport(1100, 700);
      mountShell(scheme, css);
    });

    // Red if the plan request stops being sent, or a typed secret stays in an input, in storage or in history after it is sent (Review Focus 3).
    it("clears the password inputs once sent and keeps no value anywhere", async () => {
      const s = stub({ kind: "notSetUp" });
      const dialog = await openSheet(s.door);
      (await el<HTMLElement>(dialog, "[data-ci-check]")).click();
      await vi.waitFor(() => expect(s.plans).toHaveLength(1));
      s.send({
        phase: "done",
        step: "plan",
        answer: {
          reason: "secretMissing",
          detail: "A secret is missing.",
          secrets: [{ name: "API_TOKEN", for: "app", why: "the app signs in" }],
        },
      });
      const input = await el<HTMLInputElement>(
        dialog,
        '[data-ci-secret="API_TOKEN"]',
      );
      expect(input.type).toBe("password");
      expect(input.autocomplete).toBe("off");
      expect(document.activeElement).toBe(input);
      await shot("form", scheme);
      await userEvent.type(input, SECRET);
      expect(input.value).toBe(SECRET);
      (await el<HTMLElement>(dialog, "[data-ci-check]")).click();
      await vi.waitFor(() => expect(s.plans).toHaveLength(2));
      expect(s.plans[1]?.secrets).toEqual({ API_TOKEN: SECRET });
      expect(input.value).toBe("");
      for (const i of document.querySelectorAll("input")) {
        expect(i.value).not.toContain(SECRET);
      }
      const kept = JSON.stringify([
        { ...sessionStorage },
        { ...localStorage },
        history.state,
      ]);
      expect(kept).not.toContain(SECRET);
      expect(dialog.textContent).not.toContain(SECRET);
    });

    // Red if the check's progress stops showing in a status panel, or the plan stops offering Open pull request and its lines.
    it("shows the check, then the plan with Open pull request", async () => {
      const s = stub({ kind: "notSetUp" });
      const dialog = await openSheet(s.door);
      (await el<HTMLElement>(dialog, "[data-ci-check]")).click();
      await vi.waitFor(() => expect(s.plans).toHaveLength(1));
      s.send({ phase: "progress", line: "Starting the app…" });
      s.send({ phase: "progress", line: "Recording Checkout…" });
      const panel = await el(dialog, "[data-ci-status]");
      await vi.waitFor(() =>
        expect(panel.textContent).toContain("Recording Checkout…"),
      );
      await shot("check-status", scheme);
      s.send({ phase: "done", step: "plan", answer: planned });
      await el(dialog, "[data-ci-apply]");
      expect(dialog.textContent).toContain("Check passed");
      expect(dialog.textContent).toContain("Runs on every push.");
      expect(dialog.textContent).toContain("Every release");
      expect(dialog.textContent).not.toContain("Daily");
      await shot("plan", scheme);
    });

    // Red if a finished run stops ending on the pull request's link and the run's verdict.
    it("ends the watch on the pull request link and the verdict", async () => {
      const s = stub({ kind: "notSetUp" });
      const dialog = await openSheet(s.door);
      (await el<HTMLElement>(dialog, "[data-ci-check]")).click();
      await vi.waitFor(() => expect(s.plans).toHaveLength(1));
      s.send({ phase: "done", step: "plan", answer: planned });
      (await el<HTMLElement>(dialog, "[data-ci-apply]")).click();
      await vi.waitFor(() =>
        expect(dialog.querySelector("[data-ci-status]")).not.toBeNull(),
      );
      s.send({ phase: "progress", line: "Waiting for the run…" });
      s.send({
        phase: "done",
        step: "apply",
        answer: applied({
          passed: {
            runUrl: "https://github.com/o/r/actions/runs/1",
            artifactUrl: "https://github.com/o/r/actions/runs/1#a",
            lines: [],
          },
        }),
      });
      const pr = await el<HTMLAnchorElement>(
        dialog,
        'a[href="https://github.com/o/r/pull/7"]',
      );
      expect(pr.textContent).toBe("Pull request #7");
      expect(dialog.querySelector("[data-ci-verdict]")?.textContent).toBe(
        "The run passed.",
      );
      await shot("watch-done", scheme);
    });

    // Red if an unknown outcome stops saying "unknown" with the run's address, or is called failed.
    it("says unknown for an unknown outcome and never failed", async () => {
      const s = stub({ kind: "notSetUp" });
      const dialog = await openSheet(s.door);
      (await el<HTMLElement>(dialog, "[data-ci-check]")).click();
      await vi.waitFor(() => expect(s.plans).toHaveLength(1));
      s.send({ phase: "done", step: "plan", answer: planned });
      (await el<HTMLElement>(dialog, "[data-ci-apply]")).click();
      await vi.waitFor(() =>
        expect(dialog.querySelector("[data-ci-status]")).not.toBeNull(),
      );
      s.send({
        phase: "done",
        step: "apply",
        answer: applied({
          unknown: {
            runUrl: "https://github.com/o/r/actions/runs/2",
            why: "GitHub stopped answering.",
          },
        }),
      });
      await vi.waitFor(() => expect(dialog.textContent).toContain("unknown"));
      expect(dialog.textContent).not.toMatch(/fail/i);
      await el(dialog, 'a[href="https://github.com/o/r/actions/runs/2"]');
      await shot("watch-unknown", scheme);
    });

    // Red if the setUp last step stops offering Open pull request, or its click stops reaching the pull request link.
    it("offers Open pull request when CI is already set up", async () => {
      const s = stub({ kind: "setUp" });
      const dialog = await openSheet(s.door);
      const open = await el<HTMLElement>(dialog, "[data-repo-pr]");
      await shot("set-up-last", scheme);
      open.click();
      await el(dialog, 'a[href="https://github.com/o/r/pull/1"]');
    });

    // Red if the noGh last step stops saying what CI setup needs, or offers setup anyway.
    it("says what CI needs when gh is unusable", async () => {
      const s = stub({
        kind: "noGh",
        detail: "GitHub's gh is not signed in. Run gh auth login.",
      });
      const dialog = await openSheet(s.door);
      await vi.waitFor(() =>
        expect(dialog.textContent).toContain("gh auth login"),
      );
      expect(dialog.querySelector("[data-ci-check]")).toBeNull();
      expect(dialog.querySelector("[data-repo-pr]")).toBeNull();
      await shot("no-gh-last", scheme);
    });

    // Red if a tall plan clips instead of scrolling in a window of 500 px.
    it("scrolls a tall plan in a short window", async () => {
      await page.viewport(1100, 500);
      const s = stub({ kind: "notSetUp" });
      const dialog = await openSheet(s.door);
      (await el<HTMLElement>(dialog, "[data-ci-check]")).click();
      await vi.waitFor(() => expect(s.plans).toHaveLength(1));
      s.send({
        phase: "done",
        step: "plan",
        answer: {
          ...planned,
          lines: Array.from(
            { length: 14 },
            (_, i) => `Line ${i + 1} of the plan.`,
          ),
        },
      });
      await el(dialog, "[data-ci-apply]");
      expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight);
      expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        window.innerHeight,
      );
      dialog.scrollTop = dialog.scrollHeight;
      await shot("plan-short", scheme);
    });

    // Red if Not now stops closing the sheet and toasting that CI is not set up.
    it("Not now closes and toasts", async () => {
      const s = stub({ kind: "notSetUp" });
      const dialog = await openSheet(s.door);
      (await el<HTMLElement>(dialog, "[data-ci-not-now]")).click();
      expect((await result).prOpened).toBeNull();
      await vi.waitFor(() =>
        expect(document.querySelector("[data-toast-text]")?.textContent).toBe(
          'Added "Checkout" to the repo. CI is not set up',
        ),
      );
    });
  });
}
