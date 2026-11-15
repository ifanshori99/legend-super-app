// legend-xdlxa / 863: the push status shown in the UI must come from the
// server, and a browser that holds a push subscription the server no longer
// counts is registered again automatically. Written from the design contract
// (push-sync.ts: isRegisteredOnServer / syncPushRegistration), not from the
// engineer's code.
//
// ASSUMPTIONS where the design is silent:
//  - "Never throws out" also covers a listDevices that throws synchronously
//    (not only a rejected promise) and a register that throws synchronously.
//  - The device list is only compared by `id`; extra fields are ignored.
//  - A non-"active" browser state means skipped, for EVERY other PushState
//    value (including the two new ones); no dependency is touched.
//  - The catalog check only covers the four new notification.push.* keys:
//    present, non-empty Indonesian text, and the two new state labels differ
//    from the existing "Aktif di perangkat ini".
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MESSAGE_KEYS,
  createTranslator,
} from "../packages/shared/src/i18n/index.ts";

const {
  PUSH_RENEW_AFTER_MS,
  isRegisteredOnServer,
  isRenewalDue,
  syncPushRegistration,
} = await import("../apps/web/src/features/ws05-notifications/push-sync.ts");

/** Dependencies that record every call and never settle on their own. */
function harness({
  browserState = "active",
  storedId = "sub-1",
  devices = [{ id: "sub-1" }],
  listError,
  registerError,
} = {}) {
  const calls = { list: 0, register: 0 };
  const deps = {
    browserState,
    storedId,
    listDevices: async () => {
      calls.list += 1;
      if (listError) throw listError;
      return devices;
    },
    register: async () => {
      calls.register += 1;
      if (registerError) throw registerError;
    },
  };
  return { deps, calls };
}

describe("isRegisteredOnServer (863)", () => {
  test("true only when the stored id is in the server list", () => {
    assert.equal(isRegisteredOnServer([{ id: "a" }, { id: "b" }], "b"), true);
    assert.equal(isRegisteredOnServer([{ id: "a" }], "b"), false);
  });

  test("an empty server list never matches", () => {
    assert.equal(isRegisteredOnServer([], "a"), false);
  });

  test("a null stored id is never registered, even next to other rows", () => {
    assert.equal(isRegisteredOnServer([{ id: "a" }], null), false);
    assert.equal(isRegisteredOnServer([], null), false);
  });

  test("extra fields on the device rows are ignored", () => {
    assert.equal(
      isRegisteredOnServer(
        [{ id: "a", current: true, deviceLabel: "HP", sessionActive: true }],
        "a",
      ),
      true,
    );
  });
});

describe("syncPushRegistration (863)", () => {
  test("browser not active: skipped and nothing is called", async () => {
    for (const browserState of [
      "inactive",
      "blocked",
      "unsupported",
      "unavailable",
      "ios-install",
      "checking",
      "reregistering",
      "needs-reregister",
    ]) {
      const { deps, calls } = harness({ browserState });
      assert.equal(await syncPushRegistration(deps), "skipped", browserState);
      assert.deepEqual(calls, { list: 0, register: 0 }, browserState);
    }
  });

  test("server already lists the stored id: confirmed, no register", async () => {
    const { deps, calls } = harness({
      storedId: "sub-2",
      devices: [{ id: "sub-1" }, { id: "sub-2" }],
    });
    assert.equal(await syncPushRegistration(deps), "confirmed");
    assert.equal(calls.list, 1);
    assert.equal(calls.register, 0);
  });

  test("server does not list the stored id: registers again", async () => {
    const { deps, calls } = harness({
      storedId: "old",
      devices: [{ id: "other" }],
    });
    assert.equal(await syncPushRegistration(deps), "reregistered");
    assert.equal(calls.register, 1);
  });

  test("server list empty (legacy row hidden): registers again", async () => {
    const { deps, calls } = harness({ devices: [] });
    assert.equal(await syncPushRegistration(deps), "reregistered");
    assert.equal(calls.register, 1);
  });

  test("browser has a subscription but no stored id: registers again", async () => {
    const { deps, calls } = harness({
      storedId: null,
      devices: [{ id: "sub-1" }],
    });
    assert.equal(await syncPushRegistration(deps), "reregistered");
    assert.equal(calls.register, 1);
  });

  test("listing the devices fails: registers again instead of trusting the browser", async () => {
    const { deps, calls } = harness({ listError: new Error("offline") });
    assert.equal(await syncPushRegistration(deps), "reregistered");
    assert.equal(calls.list, 1);
    assert.equal(calls.register, 1);
  });

  test("register fails after a missing id: failed, does not throw", async () => {
    const { deps, calls } = harness({
      devices: [],
      registerError: new Error("500"),
    });
    assert.equal(await syncPushRegistration(deps), "failed");
    assert.equal(calls.register, 1);
  });

  test("both listing and register fail: failed, does not throw", async () => {
    const { deps, calls } = harness({
      listError: new Error("offline"),
      registerError: new Error("offline"),
    });
    assert.equal(await syncPushRegistration(deps), "failed");
    assert.equal(calls.register, 1);
  });

  test("synchronous throws from the dependencies are swallowed too", async () => {
    const throwingList = {
      browserState: "active",
      storedId: "sub-1",
      listDevices: () => {
        throw new Error("sync list");
      },
      register: async () => {},
    };
    assert.equal(await syncPushRegistration(throwingList), "reregistered");

    const throwingRegister = {
      browserState: "active",
      storedId: null,
      listDevices: async () => [],
      register: () => {
        throw new Error("sync register");
      },
    };
    assert.equal(await syncPushRegistration(throwingRegister), "failed");
  });

  test("a confirmed run never registers even when called repeatedly", async () => {
    const { deps, calls } = harness();
    assert.equal(await syncPushRegistration(deps), "confirmed");
    assert.equal(await syncPushRegistration(deps), "confirmed");
    assert.equal(calls.register, 0);
  });
});

// 863 delta 2: proactive renewal. A device the server lists, but whose
// registeredAt is older than 7 days, is registered again. ASSUMPTION: "older
// than 7 days" is strict (exactly 7 days is not yet due).
describe("isRenewalDue (863 delta 2)", () => {
  const NOW = Date.parse("2026-11-15T00:00:00.000Z");
  const ago = (ms) => new Date(NOW - ms).toISOString();

  test("the renewal window is 7 days", () => {
    assert.equal(PUSH_RENEW_AFTER_MS, 7 * 24 * 60 * 60 * 1000);
  });

  test("exactly 7 days old is not due", () => {
    const devices = [{ id: "a", registeredAt: ago(PUSH_RENEW_AFTER_MS) }];
    assert.equal(isRenewalDue(devices, "a", NOW), false);
  });

  test("7 days and 1 ms old is due", () => {
    const devices = [{ id: "a", registeredAt: ago(PUSH_RENEW_AFTER_MS + 1) }];
    assert.equal(isRenewalDue(devices, "a", NOW), true);
  });

  test("a fresh registration is not due", () => {
    const devices = [{ id: "a", registeredAt: ago(1000) }];
    assert.equal(isRenewalDue(devices, "a", NOW), false);
  });

  test("a missing or invalid registeredAt is not due", () => {
    assert.equal(isRenewalDue([{ id: "a" }], "a", NOW), false);
    assert.equal(
      isRenewalDue([{ id: "a", registeredAt: "not a date" }], "a", NOW),
      false,
    );
    assert.equal(
      isRenewalDue([{ id: "a", registeredAt: "" }], "a", NOW),
      false,
    );
  });

  test("an id that is not in the list is not due", () => {
    const devices = [{ id: "b", registeredAt: ago(PUSH_RENEW_AFTER_MS * 3) }];
    assert.equal(isRenewalDue(devices, "a", NOW), false);
    assert.equal(isRenewalDue([], "a", NOW), false);
  });

  test("a null stored id is not due", () => {
    const devices = [{ id: "a", registeredAt: ago(PUSH_RENEW_AFTER_MS * 3) }];
    assert.equal(isRenewalDue(devices, null, NOW), false);
  });

  test("only the stored device's age counts, not other rows", () => {
    const devices = [
      { id: "old", registeredAt: ago(PUSH_RENEW_AFTER_MS * 3) },
      { id: "mine", registeredAt: ago(1000) },
    ];
    assert.equal(isRenewalDue(devices, "mine", NOW), false);
  });
});

describe("syncPushRegistration renewal (863 delta 2)", () => {
  const NOW = Date.parse("2026-11-15T00:00:00.000Z");
  const dueDevices = [
    {
      id: "sub-1",
      registeredAt: new Date(NOW - 8 * 24 * 3600 * 1000).toISOString(),
    },
  ];
  const freshDevices = [
    {
      id: "sub-1",
      registeredAt: new Date(NOW - 2 * 24 * 3600 * 1000).toISOString(),
    },
  ];

  test("listed but older than 7 days: registers again and reports reregistered", async () => {
    const { deps, calls } = harness({ devices: dueDevices });
    assert.equal(
      await syncPushRegistration({ ...deps, now: () => NOW }),
      "reregistered",
    );
    assert.equal(calls.register, 1);
  });

  test("due but register throws: still confirmed, not failed", async () => {
    const { deps, calls } = harness({
      devices: dueDevices,
      registerError: new Error("409"),
    });
    assert.equal(
      await syncPushRegistration({ ...deps, now: () => NOW }),
      "confirmed",
    );
    assert.equal(calls.register, 1);
  });

  test("due but register throws synchronously: still confirmed", async () => {
    const { deps } = harness({ devices: dueDevices });
    const throwing = {
      ...deps,
      now: () => NOW,
      register: () => {
        throw new Error("sync");
      },
    };
    assert.equal(await syncPushRegistration(throwing), "confirmed");
  });

  test("listed and younger than 7 days: confirmed and register is not called", async () => {
    const { deps, calls } = harness({ devices: freshDevices });
    assert.equal(
      await syncPushRegistration({ ...deps, now: () => NOW }),
      "confirmed",
    );
    assert.equal(calls.register, 0);
  });

  test("not listed: old behaviour, a failing register is failed", async () => {
    const { deps, calls } = harness({
      devices: [],
      registerError: new Error("500"),
    });
    assert.equal(
      await syncPushRegistration({ ...deps, now: () => NOW }),
      "failed",
    );
    assert.equal(calls.register, 1);
  });

  test("listing fails: old behaviour, register is called and reregistered", async () => {
    const { deps, calls } = harness({ listError: new Error("offline") });
    assert.equal(
      await syncPushRegistration({ ...deps, now: () => NOW }),
      "reregistered",
    );
    assert.equal(calls.register, 1);
  });
});

describe("push re-register texts (863)", () => {
  const t = createTranslator();
  const NEW_KEYS = [
    "stateReregistering",
    "stateNeedsReregister",
    "reregisterAction",
    "reregisterHint",
  ];

  test("every new key is a catalog key with non-empty text", () => {
    for (const name of NEW_KEYS) {
      const key = `notification.push.${name}`;
      assert.ok(MESSAGE_KEYS.includes(key), `${key} is not a catalog key`);
      const text = t(key);
      assert.ok(
        typeof text === "string" && text.trim().length > 0,
        `${key} is empty`,
      );
      assert.notEqual(text, key, `${key} resolves to its own key`);
    }
  });

  test("the new state labels are distinct from the active label", () => {
    const active = t("notification.push.stateActive");
    assert.notEqual(t("notification.push.stateReregistering"), active);
    assert.notEqual(t("notification.push.stateNeedsReregister"), active);
    assert.notEqual(
      t("notification.push.stateReregistering"),
      t("notification.push.stateNeedsReregister"),
    );
  });
});
