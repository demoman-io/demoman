import { describe, expect, it } from "vitest";
import { replayPolicy } from "../../src/index.js";
import { scene } from "../helpers/replay-scene";

const withNetwork = (
  mutating: boolean,
  entries: { url: string; method: string; classification: string }[],
) => {
  const base = scene();
  return {
    ...base,
    flags: { ...base.flags, mutating },
    sideChannels: {
      ...base.sideChannels,
      network: entries.map((e, i) => ({
        t: i,
        url: e.url,
        method: e.method,
        resourceType: "xmlhttprequest",
        classification: e.classification,
        reclassified: false,
      })),
    },
  } as unknown as Parameters<typeof replayPolicy>[0];
};

describe("replayPolicy", () => {
  it("always permits a read-only scene", () => {
    const readOnly = withNetwork(false, []);
    expect(
      replayPolicy(readOnly, {
        attended: true,
        allowMutating: false,
        targetUrl: "https://shop.example.com/",
      }).mayReplay,
    ).toBe(true);
    expect(
      replayPolicy(readOnly, {
        attended: true,
        allowMutating: true,
        targetUrl: "https://shop.example.com/",
      }).mayReplay,
    ).toBe(true);
  });

  it("permits a mutating scene when the setting is on", () => {
    const doc = withNetwork(true, []);
    expect(
      replayPolicy(doc, {
        attended: true,
        allowMutating: true,
        targetUrl: "https://shop.example.com/",
      }).mayReplay,
    ).toBe(true);
  });

  it("refuses a mutating scene when the setting is off", () => {
    const doc = withNetwork(true, []);
    expect(
      replayPolicy(doc, {
        attended: true,
        allowMutating: false,
        targetUrl: "https://shop.example.com/",
      }).mayReplay,
    ).toBe(false);
  });

  // What the cancel window names. Analytics is what the allowlist already
  // forgave, so showing it would misreport why the scene is tagged.
  it("reports only the requests classified as mutations", () => {
    const doc = withNetwork(true, [
      {
        url: "https://api.example.com/orders",
        method: "POST",
        classification: "mutation",
      },
      {
        url: "https://api.segment.io/v1/t",
        method: "POST",
        classification: "analytics",
      },
      {
        url: "https://api.example.com/cart",
        method: "DELETE",
        classification: "mutation",
      },
    ]);
    const { writes } = replayPolicy(doc, {
      attended: true,
      allowMutating: true,
      targetUrl: "https://shop.example.com/",
    });
    expect(writes.map((w) => w.url)).toEqual([
      "https://api.example.com/orders",
      "https://api.example.com/cart",
    ]);
  });

  it("reports no writes for a read-only scene", () => {
    const doc = withNetwork(false, [
      {
        url: "https://api.segment.io/v1/t",
        method: "POST",
        classification: "analytics",
      },
    ]);
    expect(
      replayPolicy(doc, {
        attended: true,
        allowMutating: true,
        targetUrl: "https://shop.example.com/",
      }).writes,
    ).toEqual([]);
  });

  // v8 §12's amendment: `session.ts`'s `hadNoLog` tags a scene `mutating`
  // with nothing in its network log when the author declined the
  // permission prompt during capture, so the writes were never observable.
  // `writes: []` alone cannot distinguish that scene from a read-only one —
  // only `mutating` can, which is the entire reason the field exists. A
  // reader who trusted `writes.length === 0` to mean "nothing to warn
  // about" would silently skip the loudest warning this policy owes.
  it("reports mutating with unknown writes when the log could not be captured", () => {
    const doc = withNetwork(true, []);
    const policy = replayPolicy(doc, {
      attended: true,
      allowMutating: true,
      targetUrl: "https://shop.example.com/",
    });
    expect(policy.mutating).toBe(true);
    expect(policy.writes).toEqual([]);
  });

  it("reports mutating: false for a read-only scene", () => {
    const doc = withNetwork(false, []);
    expect(
      replayPolicy(doc, {
        attended: true,
        allowMutating: true,
        targetUrl: "https://shop.example.com/",
      }).mutating,
    ).toBe(false);
  });
});

describe("replayPolicy for an unattended caller", () => {
  it("refuses a mutating scene against a published target", () => {
    const policy = replayPolicy(withNetwork(true, []), {
      attended: false,
      targetUrl: "https://shop.example.com/checkout",
    });
    expect(policy.mayReplay).toBe(false);
    // The reason, not just the refusal: an author told only "refused" cannot
    // tell "flip the setting" from "point at a preview deploy".
    expect(policy.mayReplay === false && policy.refusal).toBe(
      "publishedTargetUnattended",
    );
  });

  // One test per matcher in the gate's own `GATE_DEPLOY_MATCHERS`, each fed
  // a realistic fully-qualified hostname, awkward cases included. A matcher
  // with no such test is dead code: the badge's list carried two regexes that
  // could not match a real host at all, and they survived precisely because
  // nothing ever fed them one. A matcher fed only the tidy hostname is the
  // same defect one step in — that is how a hyphenated team slug, and then a
  // project NAMED `next-git-blog`, walked past the Vercel matcher that used
  // to be here. The prefix is what permits, never the platform suffix — the
  // bare-suffix cases below are the same platforms, refused.

  // Netlify deploy previews. The separator before the site name is a DOUBLE
  // DASH on the netlify.app apex; `deploy-preview-42.netlify.app` is not a
  // hostname Netlify ever issues, which is why the badge's dot-separated
  // pattern matched nothing.
  it("allows a mutating scene against a Netlify deploy preview", () => {
    expect(
      replayPolicy(withNetwork(true, []), {
        attended: false,
        targetUrl:
          "https://deploy-preview-42--demoman-demo.netlify.app/checkout",
      }).mayReplay,
    ).toBe(true);
  });

  // Vercel has no matcher, and cannot have one. A branch alias is
  // `<project>-git-<branch>-<scope>.vercel.app`, but the PROJECT NAME may
  // itself contain `-git-`, so a branch alias and an ordinary production host
  // are the same string shape. The first three below are the production hosts
  // of projects plausibly named `next-git-blog`, `awesome-git-client` and
  // `docs-git-book-acme`; the fourth is an IDN whose punycode form grows a
  // `-git-` it never had; the fifth is a genuine branch alias, refused with
  // the rest because nothing in the hostname tells it apart from the first
  // three. Every one of these was ADMITTED until 2026-09-08.
  //
  // These are the pins on the refusal. Any future attempt to recognise a
  // Vercel branch deploy from the hostname turns them red, which is the point:
  // the problem is undecidable, not unimplemented, and a real branch deploy
  // wants an explicit opt-in flag naming the target the author chose.
  it.each([
    "next-git-blog.vercel.app",
    "awesome-git-client.vercel.app",
    "docs-git-book-acme.vercel.app",
    // DO NOT rename the `rookie` inside this one. It is not a product
    // reference that the 2026-09-15 demoman rename missed — it is the literal
    // punycode encoding of an IDN label, and the trailing `1op` encodes where
    // the non-ASCII character is reinserted. Substituting a longer word into
    // the ASCII half leaves a string that decodes to nothing, which would
    // silently falsify the one fixture here whose premise is that it IS
    // punycode. If this host ever needs to change, re-encode it with a real
    // IDN encoder rather than editing the characters.
    "xn--rookie-git-min-acme-1op.vercel.app",
    "demoman-git-feat-headless-acme.vercel.app",
  ])("refuses every .vercel.app host, branch alias or not: %s", (host) => {
    const policy = replayPolicy(withNetwork(true, []), {
      attended: false,
      targetUrl: `https://${host}/checkout`,
    });
    expect(policy.mayReplay).toBe(false);
    // Not `publishedTargetUnattended`. The last host in the list is a REAL
    // branch deploy, and "point at a preview deploy" is what its author
    // already did — a refusal naming no action they can take. The reason has
    // to say the shape cannot be verified.
    expect(policy.mayReplay === false && policy.refusal).toBe(
      "unverifiableTargetUnattended",
    );
  });

  // A per-PR subdomain on a team's own domain is a naming convention with no
  // platform anchor: nothing in `pr-17.preview.acme.com` shows that anybody
  // at acme.com issues per-PR hosts, and the same pattern reads `pr-1.bank.com`
  // as a throwaway. That is strictly weaker evidence than the bare
  // `myapp.vercel.app` this gate already refuses, so it refuses too.
  it.each(["pr-17.preview.acme.com", "pr-1.bank.com", "pr-1.com"])(
    "refuses an unanchored pr-N convention host: %s",
    (host) => {
      const policy = replayPolicy(withNetwork(true, []), {
        attended: false,
        targetUrl: `https://${host}/checkout`,
      });
      expect(policy.mayReplay).toBe(false);
      expect(policy.mayReplay === false && policy.refusal).toBe(
        "unverifiableTargetUnattended",
      );
    },
  );

  // The narrowing the badge's classifier cannot express. `classifyOrigin`
  // calls a bare platform suffix "preview" because a false preview only
  // costs the badge coverage; here it would grant writes, and a great many
  // teams serve production from `*.vercel.app` — exactly the reasoning that
  // already keeps `herokuapp.com` and `fly.dev` published.
  it("refuses a mutating scene against a bare platform suffix", () => {
    const policy = replayPolicy(withNetwork(true, []), {
      attended: false,
      targetUrl: "https://myapp.vercel.app/checkout",
    });
    expect(policy.mayReplay).toBe(false);
    expect(policy.mayReplay === false && policy.refusal).toBe(
      "unverifiableTargetUnattended",
    );
  });

  // A name is not a claim about disposability: `staging.bank.com` is
  // somebody's real environment with a real database behind it.
  it("refuses a mutating scene against a host merely labelled staging", () => {
    const policy = replayPolicy(withNetwork(true, []), {
      attended: false,
      targetUrl: "https://staging.bank.com/",
    });
    expect(policy.mayReplay).toBe(false);
    expect(policy.mayReplay === false && policy.refusal).toBe(
      "unverifiableTargetUnattended",
    );
  });

  // v8 §491's table is a binary between a safe environment and a production
  // domain. The author's own machine is not a production domain, and the
  // runner's first consumer is a developer sitting at one. Every admitted
  // shape is here: the loopback set including the rest of 127/8 (only the
  // `127.0.0.1` literal is in `DEV_HOSTS`), `file:` (no origin server to
  // write to), and the two TLDs the IETF reserved so they could never be a
  // deployment — RFC 6761 requires `.localhost` to resolve to loopback and
  // says `.test` must never enter the global DNS, which is what Valet and
  // dnsmasq map onto 127.0.0.1.
  it.each([
    "http://localhost:3000/checkout",
    "http://127.0.0.1:8080/checkout",
    "http://127.10.0.1:8080/checkout",
    "http://[::1]:3000/checkout",
    "http://0.0.0.0:3000/checkout",
    "http://app.localhost:3000/checkout",
    "http://shop.test/checkout",
    "file:///Users/x/build/index.html",
  ])("allows a mutating scene against the author's own machine: %s", (url) => {
    expect(
      replayPolicy(withNetwork(true, []), { attended: false, targetUrl: url })
        .mayReplay,
    ).toBe(true);
  });

  // The gate's "local" is NARROWER than the badge's `development` class, and
  // these four hosts are the whole of the difference. `classifyOrigin` calls
  // every one of them development — correct for the badge, which never checks
  // that class, so a fold there costs only coverage. Down here development is
  // the class that PERMITS WRITES, and RFC1918 space is where intranet
  // production lives: a headless runner's natural home is a CI box inside a
  // VPC, where `10.20.30.40` is the internal order system. `.local` is the
  // same shape one step along — mDNS names a machine on the link, but a great
  // many Active Directory estates run `company.local` as their internal
  // domain. All four were ADMITTED until 2026-09-08, and only `localhost` had
  // a test, so nothing here was ever asked.
  it.each([
    "http://10.20.30.40/checkout",
    "http://192.168.1.50:8080/checkout",
    "http://172.20.4.9/checkout",
    "http://intranet.local/checkout",
  ])("refuses an intranet host the badge classifies development: %s", (url) => {
    const policy = replayPolicy(withNetwork(true, []), {
      attended: false,
      targetUrl: url,
    });
    expect(policy.mayReplay).toBe(false);
    // Not `publishedTargetUnattended` — the classifier does not call these
    // production either. What is wrong is that nothing in the hostname
    // shows the target is disposable.
    expect(policy.mayReplay === false && policy.refusal).toBe(
      "unverifiableTargetUnattended",
    );
  });

  // The gate must not inherit `classifyOrigin`'s fold. That function answers
  // an unparseable string with "development" — safe for the badge, which
  // never checks that class, and the wrong direction here, where it is the
  // class that permits writes. A typo in the runner's --url must buy a
  // refusal, not a mutating replay.
  it("refuses a mutating scene when the target is not a URL at all", () => {
    const policy = replayPolicy(withNetwork(true, []), {
      attended: false,
      targetUrl: "htp://not a url",
    });
    expect(policy.mayReplay).toBe(false);
    // Its own reason: the author's move is to check the URL they passed,
    // not to point at a preview deploy.
    expect(policy.mayReplay === false && policy.refusal).toBe(
      "unparseableTargetUnattended",
    );
  });

  it("replays a read-only scene against a published target", () => {
    expect(
      replayPolicy(withNetwork(false, []), {
        attended: false,
        targetUrl: "https://shop.example.com/",
      }).mayReplay,
    ).toBe(true);
  });
});

// The one part of "are these writes safe" that is checkable from the take.
// `mayWriteUnattended` reads a hostname, so its `true` means "this host is
// shaped like a throwaway deploy" and never "these writes are safe" — a
// preview deploy is a separate FRONTEND, and without per-branch databases it
// talks to the backend production talks to. That much is uncheckable, but the
// take carries the requests that made it mutating, and a published write
// origin is the one piece of evidence in hand.
describe("replayPolicy checks where an admitted target's writes went", () => {
  const PREVIEW =
    "https://deploy-preview-42--demoman-demo.netlify.app/checkout";
  const publishedWrite = {
    url: "https://api.shop.com/orders",
    method: "POST",
    classification: "mutation",
  };

  it("refuses a preview target whose writes reached a published origin", () => {
    const policy = replayPolicy(withNetwork(true, [publishedWrite]), {
      attended: false,
      targetUrl: PREVIEW,
    });
    expect(policy.mayReplay).toBe(false);
    // Its own reason: the target is fine and the writes are not, so neither
    // target refusal names the author's move.
    expect(policy.mayReplay === false && policy.refusal).toBe(
      "publishedWritesUnattended",
    );
  });

  it("allows a preview target whose writes stayed on the preview", () => {
    expect(
      replayPolicy(
        withNetwork(true, [
          {
            url: "https://deploy-preview-42--demoman-demo.netlify.app/api/orders",
            method: "POST",
            classification: "mutation",
          },
        ]),
        { attended: false, targetUrl: PREVIEW },
      ).mayReplay,
    ).toBe(true);
  });

  // The gate reads `writes`, which is already filtered to mutations. Reading
  // the raw network log instead would refuse on exactly the requests the
  // allowlist told the author did not count.
  it("does not gate on an analytics request that reached production", () => {
    expect(
      replayPolicy(
        withNetwork(true, [
          {
            url: "https://api.segment.io/v1/t",
            method: "POST",
            classification: "analytics",
          },
        ]),
        { attended: false, targetUrl: PREVIEW },
      ).mayReplay,
    ).toBe(true);
  });

  // Deliberately exempt, and not in the direction this module usually errs.
  // A local app is rebuilt from local configuration, so the URL recorded at
  // capture says nothing about where the replay will write — the same take
  // against `localhost:3000` may post to a local API or to production, and
  // the log cannot tell them apart. Refusing on it would refuse every
  // mutating take ever captured against a real site, on the developer's own
  // machine: that deletes §491's carve-out rather than narrowing it.
  it("still allows a local target whose writes reached a published origin", () => {
    expect(
      replayPolicy(withNetwork(true, [publishedWrite]), {
        attended: false,
        targetUrl: "http://localhost:3000/checkout",
      }).mayReplay,
    ).toBe(true);
  });

  // A human is watching the five-second hold that names these requests and
  // can press Cancel, which is the entire axis `ReplayRequest` splits on.
  it("does not gate an attended caller on the write origin", () => {
    expect(
      replayPolicy(withNetwork(true, [publishedWrite]), {
        attended: true,
        allowMutating: true,
        targetUrl: PREVIEW,
      }).mayReplay,
    ).toBe(true);
  });
});

describe("replayPolicy for an attended caller is unchanged", () => {
  it("honours the setting against a published target", () => {
    expect(
      replayPolicy(withNetwork(true, []), {
        attended: true,
        allowMutating: true,
        targetUrl: "https://shop.example.com/checkout",
      }).mayReplay,
    ).toBe(true);
  });

  it("refuses with the setting off, and says which refusal it is", () => {
    const policy = replayPolicy(withNetwork(true, []), {
      attended: true,
      allowMutating: false,
      targetUrl: "https://deploy-preview-42.netlify.app/checkout",
    });
    expect(policy.mayReplay).toBe(false);
    expect(policy.mayReplay === false && policy.refusal).toBe("settingOff");
  });
});
