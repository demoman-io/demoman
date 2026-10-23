/**
 * Watch where a page navigates, under jsdom.
 *
 * `vi.spyOn(location, "assign")` does not work: jsdom defines `assign` and
 * `replace` as read-only, non-configurable data properties, so redefining
 * either throws `Cannot redefine property`. A `Proxy` over the real
 * `Location` fails for the same reason one step later — a proxy may not
 * report a value other than the target's for a non-configurable property.
 *
 * `window.location` ITSELF is configurable, so the whole object is swapped
 * for a plain stand-in. Everything a page reads off it — `search`, `href`,
 * `origin` and the rest — is a live getter onto the real `Location`, so
 * `history.replaceState` before or after this call still decides what the
 * page under test sees. Only the two methods that would navigate are
 * replaced, and they record instead.
 *
 * `assign` and `replace` are kept apart on purpose. The editor uses
 * `replace` for one thing only — seeding a fixture, where the point is that
 * Back must not walk into the `?fixture=` URL — and a helper that pooled
 * them would let a test asserting "went to the library" pass against a
 * navigation that also broke that.
 */
export type Navigations = {
  /** URLs passed to `location.assign`, in order. */
  assigned: string[];
  /** URLs passed to `location.replace`, in order. */
  replaced: string[];
  /**
   * Make the next and every following `location.assign` throw this, so a
   * test can drive the refusal branch. `assign` throws synchronously where
   * `chrome.tabs.create` rejected, which is why the code under test needs a
   * `try` rather than a `.catch` — a test that cannot make it throw cannot
   * tell the two apart.
   */
  failAssignWith: (error: Error | null) => void;
  /** Put the real `window.location` back. */
  restore: () => void;
};

/** The fields a page reads off `location`, forwarded live to the real one. */
const READ_THROUGH = [
  "href",
  "origin",
  "protocol",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const;

export function captureNavigations(): Navigations {
  const real = window.location;
  const before = Object.getOwnPropertyDescriptor(window, "location");
  if (before === undefined) {
    throw new Error("window.location has no descriptor — jsdom is not set up");
  }
  const assigned: string[] = [];
  const replaced: string[] = [];
  let assignError: Error | null = null;

  const stub: Record<string, unknown> = {
    assign: (url: string | URL) => {
      assigned.push(String(url));
      if (assignError !== null) throw assignError;
    },
    replace: (url: string | URL) => {
      replaced.push(String(url));
    },
    reload: () => undefined,
    toString: () => real.href,
  };
  for (const key of READ_THROUGH) {
    Object.defineProperty(stub, key, {
      get: () => real[key],
      enumerable: true,
    });
  }

  Object.defineProperty(window, "location", {
    configurable: true,
    value: stub,
  });

  return {
    assigned,
    replaced,
    failAssignWith: (error: Error | null) => {
      assignError = error;
    },
    restore: () => {
      Object.defineProperty(window, "location", before);
    },
  };
}
