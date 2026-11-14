// legend-806 (second-opinion fixes for the panic alarm push, web side):
//   P0-3  a timed-out sign-out of user A must not unsubscribe / forget what
//         user B registered afterwards (revoke.ts + ownerGen);
//   P1-3  a browser subscription that belongs to another user is dropped and
//         re-created, never reused (push.ts owner binding);
//   P0-4  the facility alarm control only says "active" after the server
//         confirmed the save for the CURRENT outlet; a failed save shows a
//         warning with a retry, and online / visible events retry.
// Written from docs/briefs/806-panic-second-opinion-fix.md ("Desain"), not from
// the engineer's code. Module loading follows tests/push-registration-web.test.mjs.
//
// ASSUMPTIONS where the brief is silent:
//  - localStorage keys: legend.push.subscriptionId (existing), legend.push.owner,
//    legend.push.ownerGen (brief). ownerGen is only checked to be a number that
//    grows on every saved registration.
//  - Signatures: subscribeThisBrowser(vapidKey, outletId, ownerUserId) and
//    rememberSubscriptionId(id, ownerUserId). revoke.ts keeps
//    revokePushOnSignOut() and the 2000 ms timeout.
//  - "Abandoned" means: after the 2 s timeout won, nothing the run still does
//    may touch the browser subscription or the stored id (also with no B).
//  - The control has no DOM here: a tiny hook runtime renders it and the tree
//    is read as text. Texts come from the real i18n catalog keys
//    facilityStaff.alarmPush.{enabled,unbound,retry}. The warning is found as a
//    node with role "status" or "alert"; the retry as a "Button" with the
//    retry text. Where the control gets the user id from is not fixed by the
//    brief, so any unknown module is answered with a permissive stand-in
//    session ({ user: { id: "user-1" } } like) and the user id is not asserted.
//  - Retry on `online` and on `visibilitychange` (document visible) must call
//    the save again; `hidden` must not. Exact save counts are not asserted
//    (">= 2"), only that a retry happened and the result is shown.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { afterEach, describe, mock, test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const require = createRequire(import.meta.url);
const ts = require("typescript");
const read = (relative) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

/** Transpile one source file to CommonJS and run it with controlled requires. */
function load(relative, dependencies, fallback = () => ({})) {
  const source = read(relative).replaceAll("import.meta.env", "({})");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const exports = {};
  new Function("require", "exports", outputText)((name) => {
    if (name in dependencies) return dependencies[name];
    return fallback(name);
  }, exports);
  return exports;
}

const { facilityStaffMessages } =
  await import("../packages/shared/src/i18n/messages/facility-staff.ts");
/** Resolve "facilityStaff.alarmPush.x" against the real catalog (fallback: the key). */
function catalogText(key) {
  let node = facilityStaffMessages;
  for (const part of key.replace(/^facilityStaff\./, "").split(".")) {
    node = node?.[part];
  }
  return typeof node === "string" ? node : key;
}

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------- browser fakes
const ID_KEY = "legend.push.subscriptionId";
const OWNER_KEY = "legend.push.owner";
const GEN_KEY = "legend.push.ownerGen";
// A real-shaped VAPID public key so keyToBytes (atob) accepts it.
const VAPID_KEY =
  "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const OUTLET = "2b9e5a4e-6f77-4c7c-9f36-2f6a1d4c8e11";

const storage = new Map();
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
const originals = {
  Notification: Object.getOwnPropertyDescriptor(globalThis, "Notification"),
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
};
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}
function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

/** localStorage + a push service that hands out a new endpoint per subscribe. */
function installBrowser() {
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const listeners = { window: new Map(), document: new Map() };
  const target = (name, extra) => ({
    ...extra,
    addEventListener(type, fn) {
      const set = listeners[name].get(type) ?? new Set();
      set.add(fn);
      listeners[name].set(type, set);
    },
    removeEventListener(type, fn) {
      listeners[name].get(type)?.delete(fn);
    },
  });
  const fakeWindow = target("window", {
    localStorage,
    isSecureContext: true,
    matchMedia: () => ({ matches: false }),
  });
  const fakeDocument = target("document", { visibilityState: "visible" });
  setGlobal("window", fakeWindow);
  setGlobal("document", fakeDocument);
  setGlobal("localStorage", localStorage);
  setGlobal("Notification", { permission: "granted" });

  let counter = 0;
  let current = null;
  const log = { subscribe: 0, unsubscribe: [] };
  const makeSubscription = () => {
    counter += 1;
    const endpoint = `https://push.example.test/ep-${counter}`;
    const subscription = {
      endpoint,
      toJSON: () => ({
        endpoint,
        keys: { p256dh: `p256dh-${counter}`, auth: `auth-${counter}` },
      }),
      unsubscribe: async () => {
        log.unsubscribe.push(endpoint);
        if (current === subscription) current = null;
        return true;
      },
    };
    return subscription;
  };
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async () => {
      log.subscribe += 1;
      current = makeSubscription();
      return current;
    },
  };
  const registration = { pushManager };
  setGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537",
    maxTouchPoints: 5,
    onLine: true,
    serviceWorker: {
      register: async () => registration,
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
    },
  });

  return {
    log,
    /** A subscription that already exists in the browser (from an earlier session). */
    seed() {
      current = makeSubscription();
      return current.endpoint;
    },
    currentEndpoint: () => current?.endpoint ?? null,
    /** Fire a DOM event the way the browser would (document first, then window). */
    fire(type, { visibility } = {}) {
      if (visibility) fakeDocument.visibilityState = visibility;
      if (type === "visibilitychange")
        for (const fn of [...(listeners.document.get(type) ?? [])])
          fn({ type });
      for (const fn of [...(listeners.window.get(type) ?? [])]) fn({ type });
    },
    listenerCount: (type) =>
      (listeners.window.get(type)?.size ?? 0) +
      (listeners.document.get(type)?.size ?? 0),
  };
}

afterEach(() => {
  mock.timers.reset();
  storage.clear();
  delete globalThis.window;
  delete globalThis.localStorage;
  restoreGlobal("navigator", originalNavigator);
  restoreGlobal("Notification", originals.Notification);
  restoreGlobal("document", originals.document);
});

const PUSH = "apps/web/src/features/ws05-notifications/push.ts";
const REVOKE = "apps/web/src/features/ws05-notifications/revoke.ts";
const GUARD =
  "apps/web/src/features/ws05-notifications/components/push-owner-guard.tsx";

function loadPush() {
  return load(PUSH, { "@/lib/api/mock-flag": { API_MOCK: false } });
}
function loadRevoke(push, api) {
  return load(REVOKE, { "./api": api, "./push": push });
}

// ------------------------------------------------------------- P0-3 (revoke.ts)
describe("legend-806 P0-3 a timed-out sign-out never touches the next user's push", () => {
  function setup() {
    const browser = installBrowser();
    const push = loadPush();
    const gate = deferred();
    const deleted = [];
    const api = {
      deletePushSubscription: async (id) => {
        deleted.push(id);
        await gate.promise;
      },
    };
    const revoke = loadRevoke(push, api);
    return { browser, push, revoke, gate, deleted };
  }

  test("a sign-out that finishes in time removes the row, the browser subscription and the stored id", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const deleted = [];
    const revoke = loadRevoke(push, {
      deletePushSubscription: async (id) => {
        deleted.push(id);
      },
    });
    browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A");
    await revoke.revokePushOnSignOut();
    assert.deepEqual(deleted, ["sub-A"]);
    assert.equal(browser.currentEndpoint(), null, "browser subscription gone");
    assert.equal(storage.has(ID_KEY), false, "stored id forgotten");
  });

  test("after the timeout won, the late run does not unsubscribe or forget (no one else registered)", async () => {
    const { browser, push, revoke, gate, deleted } = setup();
    const endpoint = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A");
    mock.timers.enable({ apis: ["setTimeout"] });
    const done = revoke.revokePushOnSignOut();
    await settle();
    assert.deepEqual(deleted, ["sub-A"], "the API delete was attempted");
    mock.timers.tick(2000);
    await done; // sign-out goes on without waiting for the slow network
    gate.resolve(); // the slow DELETE finally answers
    await settle();
    assert.deepEqual(
      browser.log.unsubscribe,
      [],
      "late run must not unsubscribe",
    );
    assert.equal(browser.currentEndpoint(), endpoint);
    assert.equal(
      storage.get(ID_KEY),
      "sub-A",
      "late run must not forget the id",
    );
  });

  test("B registers after A's timeout: A's late delete answer leaves B's subscription and id alone", async () => {
    const { browser, push, revoke, gate } = setup();
    browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A");
    mock.timers.enable({ apis: ["setTimeout"] });
    const done = revoke.revokePushOnSignOut();
    await settle();
    mock.timers.tick(2000);
    await done;

    // B signs in on the same browser and registers (P1-3 gives B a fresh endpoint).
    const input = await push.subscribeThisBrowser(VAPID_KEY, OUTLET, "user-B");
    push.rememberSubscriptionId("sub-B", "user-B");
    const unsubscribedBefore = [...browser.log.unsubscribe];

    gate.resolve(); // A's slow DELETE finally answers
    await settle();

    assert.deepEqual(
      browser.log.unsubscribe,
      unsubscribedBefore,
      "A's late run must not unsubscribe anything more",
    );
    assert.equal(
      browser.currentEndpoint(),
      input.endpoint,
      "B's subscription lives",
    );
    assert.equal(storage.get(ID_KEY), "sub-B", "B's id is kept");
    assert.equal(storage.get(OWNER_KEY), "user-B");
  });

  test("same endpoint case: B keeps the very endpoint A had; A's late run still leaves it and B's id alone", async () => {
    const { browser, push, revoke, gate } = setup();
    const endpoint = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A");
    mock.timers.enable({ apis: ["setTimeout"] });
    const done = revoke.revokePushOnSignOut();
    await settle();
    mock.timers.tick(2000);
    await done;

    // B's registration was saved against the same endpoint (e.g. an upsert).
    push.rememberSubscriptionId("sub-B", "user-B");
    gate.resolve();
    await settle();

    assert.deepEqual(browser.log.unsubscribe, []);
    assert.equal(browser.currentEndpoint(), endpoint);
    assert.equal(storage.get(ID_KEY), "sub-B");
  });

  test("a new registration while the run is still waiting (before the timeout) cancels the remaining steps", async () => {
    const { browser, push, revoke, gate, deleted } = setup();
    const endpoint = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A");
    const done = revoke.revokePushOnSignOut();
    await settle();
    assert.deepEqual(deleted, ["sub-A"]);

    // The owner generation moves on: someone saved a registration meanwhile.
    push.rememberSubscriptionId("sub-B", "user-B");
    gate.resolve();
    await done;
    await settle();

    assert.deepEqual(
      browser.log.unsubscribe,
      [],
      "no unsubscribe after the owner changed",
    );
    assert.equal(browser.currentEndpoint(), endpoint);
    assert.equal(storage.get(ID_KEY), "sub-B");
  });

  test("every saved registration records its owner and raises the owner generation", () => {
    installBrowser();
    const push = loadPush();
    push.rememberSubscriptionId("sub-A", "user-A");
    assert.equal(storage.get(OWNER_KEY), "user-A");
    assert.equal(storage.get(ID_KEY), "sub-A");
    const first = Number(storage.get(GEN_KEY));
    assert.ok(Number.isFinite(first), "ownerGen is a number");
    push.rememberSubscriptionId("sub-A2", "user-A");
    assert.ok(
      Number(storage.get(GEN_KEY)) > first,
      "ownerGen grows on every save",
    );
  });
});

// ------------------------------------------- owner guard (push-owner-guard.tsx)
describe("legend-806 owner guard: a run overtaken by a newer registration is abandoned", () => {
  /** Runs the component's effect once; `wrap` may intercept unsubscribeThisBrowser. */
  function runGuard(push, userId, wrap = (fn) => fn) {
    const guard = load(GUARD, {
      react: { useEffect: (effect) => effect() },
      "../push": {
        ...push,
        unsubscribeThisBrowser: wrap(push.unsubscribeThisBrowser),
      },
    });
    guard.PushOwnerGuard({ userId });
  }

  test("another user's subscription is dropped and the stored id forgotten", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const old = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A");
    runGuard(push, "user-B");
    await settle();
    assert.deepEqual(browser.log.unsubscribe, [old]);
    assert.equal(storage.has(ID_KEY), false);
  });

  test("a registration saved during the unsubscribe keeps its stored id", async () => {
    const browser = installBrowser();
    const push = loadPush();
    browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A");
    runGuard(push, "user-B", (unsubscribe) => async () => {
      await unsubscribe();
      // The owner generation moves on while the unsubscribe was running.
      push.rememberSubscriptionId("sub-B", "user-B");
    });
    await settle();
    assert.equal(storage.get(ID_KEY), "sub-B", "B's id must not be forgotten");
    assert.equal(storage.get(OWNER_KEY), "user-B");
  });

  test("the owner is the signed-in user or nobody: nothing is touched", async () => {
    const browser = installBrowser();
    const push = loadPush();
    browser.seed();
    runGuard(push, "user-B");
    push.rememberSubscriptionId("sub-B", "user-B");
    runGuard(push, "user-B");
    await settle();
    assert.deepEqual(browser.log.unsubscribe, []);
    assert.equal(storage.get(ID_KEY), "sub-B");
  });
});

// ------------------------------------------------------- P1-3 web (push.ts owner)
describe("legend-806 P1-3 web: another user's browser subscription is never reused", () => {
  test("stored owner differs: unsubscribe the old one and subscribe a new endpoint", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const old = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A");
    const input = await push.subscribeThisBrowser(VAPID_KEY, OUTLET, "user-B");
    assert.deepEqual(browser.log.unsubscribe, [old]);
    assert.equal(browser.log.subscribe, 1);
    assert.notEqual(input.endpoint, old, "B gets an endpoint A never had");
    assert.equal(input.outletId, OUTLET);
  });

  test("a subscription with no stored owner is not trusted either", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const old = browser.seed();
    const input = await push.subscribeThisBrowser(VAPID_KEY, OUTLET, "user-B");
    assert.deepEqual(browser.log.unsubscribe, [old]);
    assert.equal(browser.log.subscribe, 1);
    assert.notEqual(input.endpoint, old);
  });

  test("same owner keeps the existing subscription (no churn on every visit)", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const old = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A");
    const input = await push.subscribeThisBrowser(VAPID_KEY, OUTLET, "user-A");
    assert.deepEqual(browser.log.unsubscribe, []);
    assert.equal(browser.log.subscribe, 0);
    assert.equal(input.endpoint, old);
  });

  test("no subscription yet: subscribes once", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const input = await push.subscribeThisBrowser(VAPID_KEY, OUTLET, "user-B");
    assert.equal(browser.log.subscribe, 1);
    assert.deepEqual(browser.log.unsubscribe, []);
    assert.equal(input.endpoint, browser.currentEndpoint());
  });
});

// ------------------------------------------------------ A3 (owner endpoint)
// docs/briefs/806-architect-fix.md A3 / T-A3. Written from the brief: the
// registration remembers WHICH endpoint the owner saved
// (legend.push.ownerEndpoint); cleanup (owner guard, sign-out revoke) only
// unsubscribes that endpoint, so a fresh endpoint the next user is still saving
// is not dropped. No stored endpoint (legacy) -> unsubscribe as before.
// ASSUMPTION: the stored endpoint is read back through push.readOwnerEndpoint()
// (named in the task) and the localStorage key is legend.push.ownerEndpoint.
describe("legend-806 A3: cleanup only drops the endpoint the previous owner registered", () => {
  const ENDPOINT_KEY = "legend.push.ownerEndpoint";

  function runGuard(push, userId) {
    const guard = load(GUARD, {
      react: { useEffect: (effect) => effect() },
      "../push": push,
    });
    guard.PushOwnerGuard({ userId });
  }

  /** A saved A (endpoint E1) and a browser that has since moved on to E2. */
  function aSavedE1BrowserHoldsE2(push, browser) {
    const e1 = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A", e1);
    const e2 = browser.seed(); // B subscribed, has not saved yet
    return { e1, e2 };
  }

  test("rememberSubscriptionId stores the endpoint; without one the stored endpoint is cleared; forgetting clears it", () => {
    installBrowser();
    const push = loadPush();
    assert.equal(push.readOwnerEndpoint(), null, "nothing stored yet");
    push.rememberSubscriptionId("sub-A", "user-A", "https://e.test/e1");
    assert.equal(push.readOwnerEndpoint(), "https://e.test/e1");
    assert.equal(storage.get(ENDPOINT_KEY), "https://e.test/e1");
    push.rememberSubscriptionId("sub-B", "user-B");
    assert.equal(push.readOwnerEndpoint(), null, "no stale endpoint of user A");
    push.rememberSubscriptionId("sub-B", "user-B", "https://e.test/e2");
    push.forgetSubscriptionId();
    assert.equal(push.readOwnerEndpoint(), null, "forgotten with the id");
  });

  test("unsubscribeThisBrowser(onlyEndpoint) drops a matching subscription and leaves a different one alone", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const e1 = browser.seed();
    await push.unsubscribeThisBrowser("https://push.example.test/other");
    assert.deepEqual(browser.log.unsubscribe, [], "different endpoint kept");
    assert.equal(browser.currentEndpoint(), e1);
    await push.unsubscribeThisBrowser(e1);
    assert.deepEqual(browser.log.unsubscribe, [e1]);
    assert.equal(browser.currentEndpoint(), null);
  });

  test("unsubscribeThisBrowser without an endpoint (or with null) drops the current subscription as before", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const first = browser.seed();
    await push.unsubscribeThisBrowser();
    assert.deepEqual(browser.log.unsubscribe, [first]);
    const second = browser.seed();
    await push.unsubscribeThisBrowser(null);
    assert.deepEqual(browser.log.unsubscribe, [first, second]);
  });

  test("owner guard for user B: browser already holds B's fresh E2 -> A's E1 is not the current one, E2 is not unsubscribed", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const { e2 } = aSavedE1BrowserHoldsE2(push, browser);
    runGuard(push, "user-B");
    await settle();
    assert.deepEqual(browser.log.unsubscribe, [], "E2 must not be dropped");
    assert.equal(browser.currentEndpoint(), e2);
  });

  test("owner guard for user B: the browser still holds A's endpoint E1 -> it is dropped", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const e1 = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A", e1);
    runGuard(push, "user-B");
    await settle();
    assert.deepEqual(browser.log.unsubscribe, [e1]);
    assert.equal(browser.currentEndpoint(), null);
  });

  test("owner guard, legacy registration without a stored endpoint: the current subscription is dropped like before", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const old = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A"); // no endpoint
    assert.equal(push.readOwnerEndpoint(), null);
    runGuard(push, "user-B");
    await settle();
    assert.deepEqual(browser.log.unsubscribe, [old]);
    assert.equal(storage.has(ID_KEY), false);
  });

  test("sign-out revoke: stored endpoint E1 but the browser holds E2 -> A's row is deleted, E2 is not unsubscribed", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const deleted = [];
    const revoke = loadRevoke(push, {
      deletePushSubscription: async (id) => {
        deleted.push(id);
      },
    });
    const { e2 } = aSavedE1BrowserHoldsE2(push, browser);
    await revoke.revokePushOnSignOut();
    assert.deepEqual(deleted, ["sub-A"], "A's API row is still revoked");
    assert.deepEqual(browser.log.unsubscribe, [], "E2 must not be dropped");
    assert.equal(browser.currentEndpoint(), e2);
  });

  test("sign-out revoke: stored endpoint equals the browser's endpoint -> row deleted, subscription and id removed", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const deleted = [];
    const revoke = loadRevoke(push, {
      deletePushSubscription: async (id) => {
        deleted.push(id);
      },
    });
    const e1 = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A", e1);
    await revoke.revokePushOnSignOut();
    assert.deepEqual(deleted, ["sub-A"]);
    assert.deepEqual(browser.log.unsubscribe, [e1]);
    assert.equal(browser.currentEndpoint(), null);
    assert.equal(storage.has(ID_KEY), false, "stored id forgotten");
    assert.equal(push.readOwnerEndpoint(), null, "stored endpoint forgotten");
  });

  test("sign-out revoke, legacy registration without a stored endpoint: unsubscribes the current subscription like before", async () => {
    const browser = installBrowser();
    const push = loadPush();
    const deleted = [];
    const revoke = loadRevoke(push, {
      deletePushSubscription: async (id) => {
        deleted.push(id);
      },
    });
    browser.seed();
    const current = browser.seed();
    push.rememberSubscriptionId("sub-A", "user-A"); // no endpoint
    await revoke.revokePushOnSignOut();
    assert.deepEqual(deleted, ["sub-A"]);
    assert.deepEqual(browser.log.unsubscribe, [current]);
    assert.equal(browser.currentEndpoint(), null);
    assert.equal(storage.has(ID_KEY), false);
  });
});

// ------------------------------------------------- P0-4 (panic-push-control.tsx)
/**
 * Minimal hook runtime: state, refs, effects (with deps and cleanup), memo.
 * Enough to render the control without a DOM and to drive it by events.
 */
function createRuntime() {
  let component = null;
  let slots = [];
  let cursor = 0;
  let output = null;
  let dirty = false;
  let flushing = false;
  let pendingEffects = [];
  let unmounted = false;

  const depsChanged = (a, b) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = {
          value: typeof initial === "function" ? initial() : initial,
        };
        slot.set = (next) => {
          const value = typeof next === "function" ? next(slot.value) : next;
          if (Object.is(value, slot.value) || unmounted) return;
          slot.value = value;
          schedule();
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const slot = (slots[index] ??= {
        deps: undefined,
        cleanup: null,
        ran: false,
      });
      if (!slot.ran || depsChanged(slot.deps, deps)) {
        pendingEffects.push({ slot, fn, deps });
      }
    },
    // Stable function that always calls the latest render's callback.
    useEffectEvent(fn) {
      const index = cursor++;
      const slot = (slots[index] ??= {
        latest: fn,
        stable: (...args) => slot.latest(...args),
      });
      slot.latest = fn;
      return slot.stable;
    },
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useId: () => "id",
  };
  hooks.useLayoutEffect = hooks.useEffect;

  function renderOnce() {
    cursor = 0;
    pendingEffects = [];
    output = component();
    for (const { slot, fn, deps } of pendingEffects) {
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.ran = true;
      slot.deps = deps;
      slot.cleanup = fn() ?? null;
    }
  }
  function schedule() {
    dirty = true;
    if (flushing) return;
    flushing = true;
    try {
      let guard = 0;
      while (dirty && guard++ < 50) {
        dirty = false;
        renderOnce();
      }
    } finally {
      flushing = false;
    }
  }

  return {
    hooks,
    mount(fn) {
      component = fn;
      schedule();
    },
    rerender: () => schedule(),
    unmount() {
      unmounted = true;
      for (const slot of slots)
        if (slot && typeof slot.cleanup === "function") slot.cleanup();
    },
    output: () => output,
  };
}

const nodeText = (node) => {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(" ");
  return nodeText(node.props?.children);
};
const nodes = (node, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child) => nodes(child, out));
    return out;
  }
  out.push(node);
  nodes(node.props?.children, out);
  return out;
};

/** Answers anything an unknown module might be asked for (user/session hooks). */
function standIn() {
  const proxy = new Proxy(function standIn() {}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === "id") return "user-1";
      if (prop === Symbol.toPrimitive) return () => "user-1";
      return proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

function mountControl({ detect = "active", saveImpl } = {}) {
  const browser = installBrowser();
  const runtime = createRuntime();
  const world = {
    outlet: { id: OUTLET },
    saveCalls: [],
    subscribeCalls: [],
    remembered: [],
    saveImpl:
      saveImpl ??
      (async () => ({ data: { id: `sub-${world.saveCalls.length}` } })),
  };
  const t = catalogText;
  const { PanicPushControl } = load(
    "apps/web/src/features/facility-staff/components/panic-push-control.tsx",
    {
      react: runtime.hooks,
      "react/jsx-runtime": {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
        Fragment: "fragment",
      },
      "@tanstack/react-query": {
        useQueryClient: (() => {
          const client = {
            fetchQuery: async () => ({ data: { vapidPublicKey: VAPID_KEY } }),
          };
          return () => client;
        })(),
      },
      "@/components/i18n": { useT: () => t },
      "@/components/ui/button": { Button: "Button" },
      "@/components/ui/toast": { useToast: () => () => {} },
      "@/lib/device-token-store": { getDeviceToken: () => null },
      "@/lib/tenant-context": {
        useTenantContext: () => ({ outlet: world.outlet }),
      },
      "@/features/ws05-notifications/hooks": {
        useSavePushSubscription: () => ({
          mutateAsync: async (input) => {
            world.saveCalls.push({ input, outletId: world.outlet?.id });
            return world.saveImpl(input);
          },
        }),
      },
      "@/features/ws05-notifications/queries": {
        pushPublicKeyQuery: () => ({}),
      },
      "@/features/ws05-notifications/push": {
        detectPushState: async () => detect,
        requestPushPermission: async () => "granted",
        rememberMockSubscriptionId() {},
        rememberSubscriptionId: (...args) => world.remembered.push(args),
        subscribeThisBrowser: async (...args) => {
          world.subscribeCalls.push(args);
          return {
            endpoint: "https://push.example.test/ep-control",
            keys: { p256dh: "p", auth: "a" },
            deviceLabel: "Chrome · Android",
            ...(args[1] ? { outletId: args[1] } : {}),
          };
        },
      },
    },
    (name) =>
      name === "lucide-react"
        ? new Proxy({}, { get: (_t, p) => String(p) })
        : standIn(),
  );
  runtime.mount(PanicPushControl);

  const view = {
    browser,
    world,
    runtime,
    text: () => nodeText(runtime.output()),
    shows: (key) => view.text().includes(t(key)),
    retryButton: () =>
      nodes(runtime.output()).find(
        (node) =>
          node.type === "Button" &&
          nodeText(node).includes(t("facilityStaff.alarmPush.retry")),
      ),
    warning: () =>
      nodes(runtime.output()).find(
        (node) =>
          ["status", "alert"].includes(node.props?.role) &&
          nodeText(node).includes(t("facilityStaff.alarmPush.unbound")),
      ),
    changeOutlet(id) {
      world.outlet = { id };
      runtime.rerender();
    },
  };
  return view;
}

const ENABLED = "facilityStaff.alarmPush.enabled";
const UNBOUND = "facilityStaff.alarmPush.unbound";

describe("legend-806 P0-4 the alarm control is only 'active' once the server confirmed this outlet", () => {
  test("while the save is still pending it does not claim the alarm is active", async () => {
    const gate = deferred();
    const view = mountControl({ saveImpl: () => gate.promise });
    await settle();
    assert.ok(
      view.world.saveCalls.length >= 1,
      "the existing subscription is re-saved with the outlet",
    );
    assert.equal(view.shows(ENABLED), false, `got: ${view.text()}`);
    gate.resolve({ data: { id: "sub-1" } });
    await settle();
    assert.equal(view.shows(ENABLED), true, `got: ${view.text()}`);
    assert.equal(view.shows(UNBOUND), false);
    assert.ok(
      view.world.remembered.length >= 1,
      "the confirmed id is remembered",
    );
    assert.equal(view.world.remembered[0][0], "sub-1");
  });

  test("the save is made for the active outlet (no device token)", async () => {
    const view = mountControl();
    await settle();
    assert.equal(view.world.subscribeCalls[0][1], OUTLET);
  });

  test("a failed re-save shows a warning with a retry and no 'active' label", async () => {
    const view = mountControl({
      saveImpl: async () => {
        throw new Error("network down");
      },
    });
    await settle();
    assert.equal(view.shows(ENABLED), false, `got: ${view.text()}`);
    assert.ok(
      view.warning(),
      `warning with role status/alert expected, got: ${view.text()}`,
    );
    assert.ok(view.retryButton(), "a retry button is offered");
  });

  test("the retry button saves again and then shows active", async () => {
    let fail = true;
    const view = mountControl({
      saveImpl: async () => {
        if (fail) throw new Error("network down");
        return { data: { id: "sub-ok" } };
      },
    });
    await settle();
    const before = view.world.saveCalls.length;
    fail = false;
    await view.retryButton().props.onClick();
    await settle();
    assert.ok(view.world.saveCalls.length > before, "retry made a new save");
    assert.equal(view.shows(ENABLED), true, `got: ${view.text()}`);
    assert.equal(view.shows(UNBOUND), false);
    assert.equal(view.retryButton(), undefined, "no retry once bound");
  });

  test("the browser coming back online retries on its own and ends active", async () => {
    let fail = true;
    const view = mountControl({
      saveImpl: async () => {
        if (fail) throw new Error("offline");
        return { data: { id: "sub-ok" } };
      },
    });
    await settle();
    assert.equal(view.shows(ENABLED), false);
    const before = view.world.saveCalls.length;
    fail = false;
    view.browser.fire("online");
    await settle();
    assert.ok(view.world.saveCalls.length > before, "online triggered a retry");
    assert.equal(view.shows(ENABLED), true, `got: ${view.text()}`);
    assert.equal(view.shows(UNBOUND), false);
  });

  test("the tab becoming visible retries; becoming hidden does not", async () => {
    let fail = true;
    const view = mountControl({
      saveImpl: async () => {
        if (fail) throw new Error("offline");
        return { data: { id: "sub-ok" } };
      },
    });
    await settle();
    const before = view.world.saveCalls.length;
    fail = false;
    view.browser.fire("visibilitychange", { visibility: "hidden" });
    await settle();
    assert.equal(
      view.world.saveCalls.length,
      before,
      "hidden tab does not retry",
    );
    assert.equal(view.shows(ENABLED), false);
    view.browser.fire("visibilitychange", { visibility: "visible" });
    await settle();
    assert.ok(view.world.saveCalls.length > before, "visible tab retries");
    assert.equal(view.shows(ENABLED), true, `got: ${view.text()}`);
  });

  test("switching to another outlet is not 'active' until the server confirmed that outlet", async () => {
    const OTHER = "9d0c6b1a-2f3e-4a5b-8c7d-1e2f3a4b5c6d";
    const view = mountControl();
    await settle();
    assert.equal(view.shows(ENABLED), true, "confirmed for the first outlet");

    const gate = deferred();
    view.world.saveImpl = () => gate.promise;
    view.changeOutlet(OTHER);
    await settle();
    assert.ok(
      view.world.saveCalls.some((call) => call.outletId === OTHER),
      "the new outlet is saved",
    );
    assert.equal(view.shows(ENABLED), false, `got: ${view.text()}`);

    gate.resolve({ data: { id: "sub-other" } });
    await settle();
    assert.equal(view.shows(ENABLED), true, `got: ${view.text()}`);
  });

  test("switching outlet and failing to save it shows the warning, not the old 'active'", async () => {
    const OTHER = "9d0c6b1a-2f3e-4a5b-8c7d-1e2f3a4b5c6d";
    const view = mountControl();
    await settle();
    assert.equal(view.shows(ENABLED), true);
    view.world.saveImpl = async () => {
      throw new Error("server error");
    };
    view.changeOutlet(OTHER);
    await settle();
    assert.equal(view.shows(ENABLED), false, `got: ${view.text()}`);
    assert.ok(view.warning(), "warning shown for the unbound outlet");
    assert.ok(view.retryButton(), "retry offered");
  });

  test("the warning and retry texts come from the i18n catalog", () => {
    assert.notEqual(
      catalogText(UNBOUND),
      UNBOUND,
      "unbound text exists in the catalog",
    );
    assert.notEqual(
      catalogText("facilityStaff.alarmPush.retry"),
      "facilityStaff.alarmPush.retry",
    );
    const source = read(
      "apps/web/src/features/facility-staff/components/panic-push-control.tsx",
    ).replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(
      source,
      /belum tersambung|Coba lagi/,
      "no literal UI text",
    );
  });
});
